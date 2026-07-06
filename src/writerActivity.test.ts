import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Wraps statSync in a real vi.fn() so the walk-budget tests below can
// observe/instrument call counts and inject artificial latency. `fs` is a
// sealed ES module namespace — vi.spyOn(fs, 'statSync') can't redefine it
// in place ("Cannot redefine property"), so the wrap has to happen at
// vi.mock() time instead, before writerActivity.ts's own `import * as fs`
// resolves. Every other export passes through to the real implementation
// unchanged.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionLastWriteMtime, isWithinActivityWindow, EXTERNAL_WRITER_QUIET_MS } from './writerActivity.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-activity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Set a file's mtime to `ms` ago, so ordering between files is deterministic
 *  regardless of how fast the test runs. */
function writeWithAge(filePath: string, msAgo: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x');
  const when = new Date(Date.now() - msAgo);
  fs.utimesSync(filePath, when, when);
}

describe('getSessionLastWriteMtime', () => {
  it('returns the main file mtime when only the main file exists', () => {
    const main = path.join(tmpDir, 'sess.jsonl');
    const subagentsDir = path.join(tmpDir, 'sess', 'subagents');
    writeWithAge(main, 5_000);

    const result = getSessionLastWriteMtime(main, subagentsDir);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(fs.statSync(main).mtimeMs, -1);
  });

  it('returns the max subagent file mtime when only flat subagent files exist (no main file)', () => {
    const main = path.join(tmpDir, 'sess.jsonl'); // never created
    const subagentsDir = path.join(tmpDir, 'sess', 'subagents');
    writeWithAge(path.join(subagentsDir, 'agent-aaa.jsonl'), 20_000);
    writeWithAge(path.join(subagentsDir, 'agent-bbb.jsonl'), 2_000); // most recent

    const result = getSessionLastWriteMtime(main, subagentsDir);
    expect(result).not.toBeNull();
    const expected = fs.statSync(path.join(subagentsDir, 'agent-bbb.jsonl')).mtimeMs;
    expect(result).toBeCloseTo(expected, -1);
  });

  it('recurses into nested workflows/<runId>/ directories and includes them in the max', () => {
    const main = path.join(tmpDir, 'sess.jsonl');
    const subagentsDir = path.join(tmpDir, 'sess', 'subagents');
    writeWithAge(main, 60_000); // oldest
    writeWithAge(path.join(subagentsDir, 'agent-aaa.jsonl'), 30_000);
    // Nested workflow-run files — must be found by recursion, not a flat readdir.
    writeWithAge(path.join(subagentsDir, 'workflows', 'wf_1', 'agent-ccc.jsonl'), 10_000);
    writeWithAge(path.join(subagentsDir, 'workflows', 'wf_1', 'journal.jsonl'), 1_000); // most recent overall

    const result = getSessionLastWriteMtime(main, subagentsDir);
    expect(result).not.toBeNull();
    const expected = fs.statSync(path.join(subagentsDir, 'workflows', 'wf_1', 'journal.jsonl')).mtimeMs;
    expect(result).toBeCloseTo(expected, -1);
  });

  it('returns null when neither the main file nor the subagents dir exists', () => {
    const main = path.join(tmpDir, 'nope.jsonl');
    const subagentsDir = path.join(tmpDir, 'nope', 'subagents');
    expect(getSessionLastWriteMtime(main, subagentsDir)).toBeNull();
  });

  it('resolves correctly with an early-exit recency floor when a recent file exists', () => {
    const main = path.join(tmpDir, 'sess.jsonl');
    const subagentsDir = path.join(tmpDir, 'sess', 'subagents');
    writeWithAge(main, 20_000); // old
    writeWithAge(path.join(subagentsDir, 'agent-recent.jsonl'), 500); // recent
    const now = Date.now();

    const result = getSessionLastWriteMtime(main, subagentsDir, { recentEnoughMs: 5_000, nowMs: now });
    expect(result).not.toBeNull();
    expect(now - (result as number)).toBeLessThan(5_000);
  });

  it('caps the number of stat calls even when the subagents tree is very large [perf]', () => {
    const main = path.join(tmpDir, 'sess.jsonl'); // doesn't exist
    const subagentsDir = path.join(tmpDir, 'sess', 'subagents');
    const FILE_COUNT = 2_500; // exceeds the internal walk budget
    for (let i = 0; i < FILE_COUNT; i++) {
      writeWithAge(path.join(subagentsDir, `agent-${i}.jsonl`), 1_000);
    }
    const mocked = vi.mocked(fs.statSync);
    mocked.mockClear();
    getSessionLastWriteMtime(main, subagentsDir);
    // A regression back to an unbounded walk would call statSync once per
    // file (2,500+). The entry-count cap must stop it well short of that,
    // regardless of readdir's iteration order.
    expect(mocked.mock.calls.length).toBeLessThan(FILE_COUNT);
  });

  it('stops within a bounded time even against a slow filesystem, rather than walking every entry [perf]', () => {
    const main = path.join(tmpDir, 'sess.jsonl'); // doesn't exist
    const subagentsDir = path.join(tmpDir, 'sess', 'subagents');
    const FILE_COUNT = 300;
    for (let i = 0; i < FILE_COUNT; i++) {
      writeWithAge(path.join(subagentsDir, `agent-${i}.jsonl`), 1_000);
    }
    const mocked = vi.mocked(fs.statSync);
    // Captured before this test overrides the implementation below — this is
    // the real statSync the vi.mock() factory at the top of the file wrapped.
    const realStatSync = mocked.getMockImplementation()!;
    mocked.mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      // Simulate a slow underlying filesystem (e.g. a cloud-synced mount) —
      // a couple of ms of synchronous work per stat call.
      const end = Date.now() + 2;
      while (Date.now() < end) { /* busy-wait */ }
      return realStatSync(...args);
    });
    try {
      const start = Date.now();
      getSessionLastWriteMtime(main, subagentsDir);
      const elapsed = Date.now() - start;
      // Without a time budget, 300 files * ~2ms/stat would take 600ms+. The
      // walk must bail out well before that.
      expect(elapsed).toBeLessThan(300);
    } finally {
      mocked.mockImplementation(realStatSync);
    }
  });
});

describe('isWithinActivityWindow', () => {
  const NOW = 1_000_000_000;

  it('is true when the last write is recent', () => {
    expect(isWithinActivityWindow(NOW - 1_000, NOW - 60_000, NOW)).toBe(true);
  });

  it('is true when the write is old but startedAt is recent (grace period for a just-attached process)', () => {
    const oldWrite = NOW - EXTERNAL_WRITER_QUIET_MS - 60_000; // long past the threshold
    const recentStart = NOW - 1_000;
    expect(isWithinActivityWindow(oldWrite, recentStart, NOW)).toBe(true);
  });

  it('is false when both the write and startedAt are old', () => {
    const old = NOW - EXTERNAL_WRITER_QUIET_MS - 1;
    expect(isWithinActivityWindow(old, old, NOW)).toBe(false);
  });

  it('is true (fails toward locked) when both lastWriteMs and startedAtMs are null', () => {
    expect(isWithinActivityWindow(null, null, NOW)).toBe(true);
  });

  it('treats the threshold boundary as no-longer-within (strict less-than)', () => {
    const floor = NOW - EXTERNAL_WRITER_QUIET_MS;
    expect(isWithinActivityWindow(floor, null, NOW)).toBe(false);
    expect(isWithinActivityWindow(floor + 1, null, NOW)).toBe(true);
  });

  it('uses the LATER of lastWriteMs and startedAtMs as the floor', () => {
    // lastWriteMs old, startedAtMs recent -> recent wins, still within window.
    expect(isWithinActivityWindow(NOW - 999_999_999, NOW - 100, NOW, 1_000)).toBe(true);
    // lastWriteMs recent, startedAtMs old -> recent wins, still within window.
    expect(isWithinActivityWindow(NOW - 100, NOW - 999_999_999, NOW, 1_000)).toBe(true);
  });

  it('respects a custom thresholdMs', () => {
    expect(isWithinActivityWindow(NOW - 5_000, null, NOW, 1_000)).toBe(false);
    expect(isWithinActivityWindow(NOW - 500, null, NOW, 1_000)).toBe(true);
  });
});
