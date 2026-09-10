import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseReplayCache, isHydratable, pruneEntries, mergeEntries, serialiseReplayCache,
  makeReplayCacheStore, REPLAY_CACHE_VERSION, REPLAY_CACHE_QUIET_MS,
  type ReplayCacheEntry, type ReplayCacheStore,
} from './replayCache.js';
import type { Logger } from './sessionDiscovery.js';
import type { CachedSessionState } from './types.js';

const silentLog: Logger = {
  trace: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

function cachedState(overrides: Partial<CachedSessionState> = {}): CachedSessionState {
  return {
    sessionId: 'sess-1',
    slug: 'sess-1',
    workspaceKey: '-Users-foo-bar',
    cwd: '/Users/foo/bar',
    initialCwd: '/Users/foo/bar',
    topic: 'A topic',
    activity: '',
    status: 'done',
    lastActivity: Date.now() - REPLAY_CACHE_QUIET_MS - 1000,
    firstActivity: Date.now() - 60_000,
    enqueuedAt: 0,
    contextTokens: 100,
    modelId: 'claude-sonnet-5',
    modelConfirmed: true,
    customTitle: '',
    aiTitle: '',
    userTurnCount: 1,
    subagents: [],
    ...overrides,
  };
}

function entry(overrides: Partial<ReplayCacheEntry> = {}): ReplayCacheEntry {
  return {
    size: 1000,
    mtimeMs: 123456,
    cachedAt: Date.now(),
    state: cachedState(),
    ...overrides,
  };
}

describe('parseReplayCache', () => {
  it('returns an empty map for null/undefined/empty input', () => {
    expect(parseReplayCache(undefined).size).toBe(0);
    expect(parseReplayCache(null).size).toBe(0);
    expect(parseReplayCache('').size).toBe(0);
  });

  it('tolerates garbage (unparseable JSON)', () => {
    expect(parseReplayCache('not json {{{').size).toBe(0);
  });

  it('rejects a wrong/missing version', () => {
    const wrongVersion = JSON.stringify({ version: REPLAY_CACHE_VERSION + 1, entries: { a: entry() } });
    expect(parseReplayCache(wrongVersion).size).toBe(0);

    const noVersion = JSON.stringify({ entries: { a: entry() } });
    expect(parseReplayCache(noVersion).size).toBe(0);
  });

  it('tolerates partial/malformed entries without discarding the rest of the file', () => {
    const raw = JSON.stringify({
      version: REPLAY_CACHE_VERSION,
      entries: {
        good: entry(),
        missingFields: { size: 1 }, // no mtimeMs/cachedAt/state
        badState: { size: 1, mtimeMs: 1, cachedAt: 1, state: { sessionId: 'x' } }, // no status, no subagents
        notAnObject: 'nope',
      },
    });
    const parsed = parseReplayCache(raw);
    expect(parsed.size).toBe(1);
    expect(parsed.has('good')).toBe(true);
  });

  it('round-trips through serialiseReplayCache', () => {
    const entries = new Map([['/path/a.jsonl', entry()]]);
    const raw = serialiseReplayCache(entries);
    const parsed = parseReplayCache(raw);
    expect(parsed).toEqual(entries);
  });

  it('refuses an oversized file', () => {
    const huge = 'x'.repeat(17 * 1024 * 1024);
    const raw = JSON.stringify({ version: REPLAY_CACHE_VERSION, entries: { a: entry() } }) + huge;
    expect(parseReplayCache(raw).size).toBe(0);
  });
});

describe('isHydratable', () => {
  const now = Date.now();
  const stat = { size: 1000, mtimeMs: 123456 };

  it('true for an exact stat match, done status, not live, quiet window elapsed', () => {
    expect(isHydratable(entry(), stat, undefined, now)).toBe(true);
    expect(isHydratable(entry(), stat, false, now)).toBe(true);
    expect(isHydratable(entry(), stat, null, now)).toBe(true);
  });

  it('false on any size or mtime mismatch', () => {
    expect(isHydratable(entry(), { size: 999, mtimeMs: 123456 }, undefined, now)).toBe(false);
    expect(isHydratable(entry(), { size: 1000, mtimeMs: 1 }, undefined, now)).toBe(false);
  });

  it('false when the registry confirms the process is live', () => {
    expect(isHydratable(entry(), stat, true, now)).toBe(false);
  });

  it('false when status is not done', () => {
    expect(isHydratable(entry({ state: cachedState({ status: 'running' }) }), stat, undefined, now)).toBe(false);
    expect(isHydratable(entry({ state: cachedState({ status: 'waiting' }) }), stat, undefined, now)).toBe(false);
  });

  it('false when the quiet window has not elapsed', () => {
    const recent = entry({ state: cachedState({ lastActivity: now - 1000 }) });
    expect(isHydratable(recent, stat, undefined, now)).toBe(false);
  });

  it('honours a custom quietMs', () => {
    const recent = entry({ state: cachedState({ lastActivity: now - 5000 }) });
    expect(isHydratable(recent, stat, undefined, now, 10_000)).toBe(false);
    expect(isHydratable(recent, stat, undefined, now, 1000)).toBe(true);
  });
});

describe('pruneEntries', () => {
  const now = Date.now();
  const alwaysExists = () => true;

  it('drops entries whose backing file is missing', () => {
    const entries = new Map([
      ['/a.jsonl', entry()],
      ['/b.jsonl', entry()],
    ]);
    const pruned = pruneEntries(entries, now, {
      maxAgeMs: 999_999_999, maxEntries: 100, exists: (p) => p === '/a.jsonl',
    });
    expect([...pruned.keys()]).toEqual(['/a.jsonl']);
  });

  it('drops entries older than maxAgeMs', () => {
    const entries = new Map([
      ['/fresh.jsonl', entry({ cachedAt: now - 1000 })],
      ['/stale.jsonl', entry({ cachedAt: now - 100_000 })],
    ]);
    const pruned = pruneEntries(entries, now, { maxAgeMs: 10_000, maxEntries: 100, exists: alwaysExists });
    expect([...pruned.keys()]).toEqual(['/fresh.jsonl']);
  });

  it('caps maxAgeMs at the 60-day hard ceiling regardless of caller input', () => {
    const veryOld = now - 61 * 24 * 60 * 60 * 1000;
    const entries = new Map([['/ancient.jsonl', entry({ cachedAt: veryOld })]]);
    // Caller asks for an effectively unbounded age — the hard ceiling still applies.
    const pruned = pruneEntries(entries, now, { maxAgeMs: Number.MAX_SAFE_INTEGER, maxEntries: 100, exists: alwaysExists });
    expect(pruned.size).toBe(0);
  });

  it('caps entry count, keeping the newest cachedAt first', () => {
    const entries = new Map([
      ['/oldest.jsonl', entry({ cachedAt: now - 3000 })],
      ['/middle.jsonl', entry({ cachedAt: now - 2000 })],
      ['/newest.jsonl', entry({ cachedAt: now - 1000 })],
    ]);
    const pruned = pruneEntries(entries, now, { maxAgeMs: 999_999_999, maxEntries: 2, exists: alwaysExists });
    expect([...pruned.keys()].sort()).toEqual(['/middle.jsonl', '/newest.jsonl'].sort());
  });
});

describe('mergeEntries', () => {
  it('newest cachedAt wins per key', () => {
    const disk = new Map([['/a.jsonl', entry({ cachedAt: 1000, state: cachedState({ topic: 'disk' }) })]]);
    const memory = new Map([['/a.jsonl', entry({ cachedAt: 2000, state: cachedState({ topic: 'memory' }) })]]);
    const merged = mergeEntries(disk, memory);
    expect(merged.get('/a.jsonl')!.state.topic).toBe('memory');

    const merged2 = mergeEntries(
      new Map([['/a.jsonl', entry({ cachedAt: 2000, state: cachedState({ topic: 'disk-newer' }) })]]),
      new Map([['/a.jsonl', entry({ cachedAt: 1000, state: cachedState({ topic: 'memory-older' }) })]]),
    );
    expect(merged2.get('/a.jsonl')!.state.topic).toBe('disk-newer');
  });

  it('keeps entries unique to either side', () => {
    const disk = new Map([['/disk-only.jsonl', entry()]]);
    const memory = new Map([['/memory-only.jsonl', entry()]]);
    const merged = mergeEntries(disk, memory);
    expect([...merged.keys()].sort()).toEqual(['/disk-only.jsonl', '/memory-only.jsonl']);
  });

  it('a tie on cachedAt keeps memory', () => {
    const disk = new Map([['/a.jsonl', entry({ cachedAt: 1000, state: cachedState({ topic: 'disk' }) })]]);
    const memory = new Map([['/a.jsonl', entry({ cachedAt: 1000, state: cachedState({ topic: 'memory' }) })]]);
    expect(mergeEntries(disk, memory).get('/a.jsonl')!.state.topic).toBe('memory');
  });
});

describe('FileReplayCacheStore', () => {
  let tmpDir: string;
  let cachePath: string;
  let store: ReplayCacheStore;
  // pruneEntries() (wired into every save) drops an entry whose backing file
  // no longer exists — exactly the real-world case where a session's JSONL
  // was deleted between caching and flushing. So entries in these tests are
  // keyed by REAL (if empty) files under tmpDir, not fictional paths — a
  // fictional path would be silently pruned away on the very first save,
  // which is correct behaviour but not what these tests are exercising.
  let pathA: string;
  let pathB: string;
  let pathMine: string;
  let pathOther: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cache-'));
    cachePath = path.join(tmpDir, 'serac-replay-cache.json');
    store = makeReplayCacheStore(cachePath, silentLog, { minFlushIntervalMs: 30_000 });
    pathA = path.join(tmpDir, 'a.jsonl');
    pathB = path.join(tmpDir, 'b.jsonl');
    pathMine = path.join(tmpDir, 'mine.jsonl');
    pathOther = path.join(tmpDir, 'other.jsonl');
    for (const p of [pathA, pathB, pathMine, pathOther]) { fs.writeFileSync(p, ''); }
  });

  afterEach(() => {
    // Restore FIRST: a failed assertion above throws before reaching any
    // mockRestore() call further down in the same test, and an unrestored
    // spy would otherwise leak its call count into the next test.
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readDiskEntries(): Record<string, ReplayCacheEntry> {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')).entries;
  }

  it('load() on a missing file leaves the store empty, not an error', async () => {
    await store.load();
    expect(store.size()).toBe(0);
  });

  it('put() then flush() writes to disk via tmp-then-rename', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    store.put(pathA, entry());
    await store.flush(Date.now());

    expect(writeSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();
    const writeCallOrder = writeSpy.mock.invocationCallOrder[0];
    const renameCallOrder = renameSpy.mock.invocationCallOrder[0];
    expect(writeCallOrder).toBeLessThan(renameCallOrder);
    // The write target was a .tmp path, not the real cache file.
    expect(writeSpy.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(readDiskEntries()[pathA]).toBeDefined();
    // No orphaned tmp file left behind.
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('flush() no-ops when not dirty', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    await store.flush(Date.now());
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('flush() rate-limits to one write per configured interval', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    const t0 = Date.now();
    store.put(pathA, entry());
    await store.flush(t0);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // A second put() shortly after — flush() within the interval is a no-op.
    store.put(pathB, entry());
    await store.flush(t0 + 1000);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    // Past the interval — flush() writes again.
    await store.flush(t0 + 30_001);
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('flush() re-reads and merges another window\'s entries before writing', async () => {
    // Simulate another window's write landing on disk between this window's
    // load() and its own flush() — its own put() must not clobber it.
    const otherWindowEntry = entry({ state: cachedState({ sessionId: 'other-session' }) });
    fs.writeFileSync(cachePath, serialiseReplayCache(new Map([[pathOther, otherWindowEntry]])));

    store.put(pathMine, entry({ state: cachedState({ sessionId: 'my-session' }) }));
    await store.flush(Date.now());

    const onDisk = readDiskEntries();
    expect(Object.keys(onDisk).sort()).toEqual([pathMine, pathOther].sort());
  });

  it('a save failure re-arms dirty so the next flush retries', async () => {
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EPERM'));
    store.put(pathA, entry());
    await store.flush(Date.now());
    expect(fs.existsSync(cachePath)).toBe(false);
    // No orphaned tmp file after the failed rename.
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'))).toEqual([]);

    renameSpy.mockRestore();
    await store.flush(Date.now() + 40_000); // past the rate limit — retries and succeeds
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it('get() returns undefined for an unknown path and the loaded entry otherwise', async () => {
    fs.writeFileSync(cachePath, serialiseReplayCache(new Map([['/known.jsonl', entry()]])));
    await store.load();
    expect(store.get('/unknown.jsonl')).toBeUndefined();
    expect(store.get('/known.jsonl')).toBeDefined();
  });
});
