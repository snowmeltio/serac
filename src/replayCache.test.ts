import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseReplayCache, sameStamp, isHydratable, pruneEntries, pruneMissingFiles, mergeEntries, serialiseReplayCache,
  makeReplayCacheStore, REPLAY_CACHE_VERSION, REPLAY_CACHE_QUIET_MS,
  type ReplayCacheEntry, type ReplayCacheStore,
} from './replayCache.js';
import type { Logger } from './sessionDiscovery.js';
import type { CachedSessionState } from './types.js';
import { makeCachedSessionState, makeReplayCacheEntry } from './__fixtures__/replayCache.js';

const silentLog: Logger = {
  trace: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

function cachedState(overrides: Partial<CachedSessionState> = {}): CachedSessionState {
  return makeCachedSessionState(overrides);
}

function entry(overrides: Partial<ReplayCacheEntry> = {}): ReplayCacheEntry {
  return makeReplayCacheEntry(overrides);
}

describe('sameStamp', () => {
  it('true when both size and mtime match', () => {
    expect(sameStamp({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 2 })).toBe(true);
  });
  it('false on any mismatch', () => {
    expect(sameStamp({ size: 1, mtimeMs: 2 }, { size: 2, mtimeMs: 2 })).toBe(false);
    expect(sameStamp({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 3 })).toBe(false);
  });
});

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

  it('tolerates structurally malformed entries without discarding the rest of the file', () => {
    const raw = JSON.stringify({
      version: REPLAY_CACHE_VERSION,
      entries: {
        good: entry(),
        missingFields: { size: 1 }, // no mtimeMs/cachedAt/state
        notAnObject: 'nope',
      },
    });
    const parsed = parseReplayCache(raw);
    expect(parsed.size).toBe(1);
    expect(parsed.has('good')).toBe(true);
  });

  // One rejected-shape case per field the reviewer flagged as previously
  // unchecked — a missing/non-numeric lastActivity used to hydrate an
  // Invalid Date (NaN lastActivity → card disposed on the next poll, or
  // zone sort silently broken); subagent fields were entirely unchecked.
  const badStateCases: Array<[string, Partial<CachedSessionState>]> = [
    ['status not done', { status: 'running' as never }],
    ['non-numeric lastActivity', { lastActivity: NaN }],
    ['missing lastActivity', { lastActivity: undefined as never }],
    ['non-numeric firstActivity', { firstActivity: 'yesterday' as never }],
    ['non-string cwd', { cwd: 42 as never }],
    ['non-string slug', { slug: null as never }],
    ['non-string workspaceKey', { workspaceKey: 7 as never }],
    ['non-string topic', { topic: {} as never }],
    ['non-string activity', { activity: [] as never }],
    ['non-numeric contextTokens', { contextTokens: 'lots' as never }],
    ['non-string modelId', { modelId: 5 as never }],
    ['non-boolean modelConfirmed', { modelConfirmed: 'yes' as never }],
    ['non-numeric userTurnCount', { userTurnCount: NaN }],
    ['invalid bridgeState', { bridgeState: 'sideways' as never }],
    ['non-array trackedFiles', { trackedFiles: 'a.ts' as never }],
    ['trackedFiles with a non-string element', { trackedFiles: [1] as never }],
    ['subagents not an array', { subagents: {} as never }],
  ];
  for (const [label, override] of badStateCases) {
    it(`rejects an entry with ${label}`, () => {
      const raw = JSON.stringify({
        version: REPLAY_CACHE_VERSION,
        entries: { bad: entry({ state: cachedState(override) }) },
      });
      expect(parseReplayCache(raw).size).toBe(0);
    });
  }

  const badSubagentCases: Array<[string, Record<string, unknown>]> = [
    ['non-string parentToolUseId', { parentToolUseId: 1 }],
    ['non-string description', { description: null }],
    ['non-finite startedAt', { startedAt: 'now' }],
    ['non-finite toolsCompleted', { toolsCompleted: NaN }],
    ['non-finite lastActivity', { lastActivity: undefined }],
    ['agentId neither string nor null', { agentId: 42 }],
    ['resultPreview neither string nor null', { resultPreview: 42 }],
    ['non-boolean background', { background: 'yes' }],
  ];
  for (const [label, override] of badSubagentCases) {
    it(`rejects an entry whose subagent has ${label}`, () => {
      const goodSubagent = {
        parentToolUseId: 'tu-1', agentId: 'agent-1', description: 'desc',
        resultPreview: null, toolsCompleted: 0, startedAt: 1000, lastActivity: 1000,
      };
      const raw = JSON.stringify({
        version: REPLAY_CACHE_VERSION,
        entries: { bad: entry({ state: cachedState({ subagents: [{ ...goodSubagent, ...override }] as never }) }) },
      });
      expect(parseReplayCache(raw).size).toBe(0);
    });
  }

  it('accepts a well-formed subagent, including background/lastActivity', () => {
    const raw = JSON.stringify({
      version: REPLAY_CACHE_VERSION,
      entries: {
        ok: entry({ state: cachedState({
          subagents: [{
            parentToolUseId: 'tu-1', agentId: 'agent-1', description: 'desc',
            resultPreview: 'done', toolsCompleted: 3, startedAt: 1000, lastActivity: 2000, background: true,
          }],
        }) }),
      },
    });
    const parsed = parseReplayCache(raw);
    expect(parsed.get('ok')!.state.subagents[0]).toMatchObject({ background: true, lastActivity: 2000 });
  });

  it('round-trips through serialiseReplayCache', () => {
    const entries = new Map([['/path/a.jsonl', entry()]]);
    const raw = serialiseReplayCache(entries);
    const parsed = parseReplayCache(raw);
    expect(parsed).toEqual(entries);
  });

  it('serialises without indentation', () => {
    const raw = serialiseReplayCache(new Map([['/a.jsonl', entry()]]));
    expect(raw).not.toContain('\n');
  });

  it('refuses an oversized file', () => {
    const huge = 'x'.repeat(17 * 1024 * 1024);
    const raw = JSON.stringify({ version: REPLAY_CACHE_VERSION, entries: { a: entry() } }) + huge;
    expect(parseReplayCache(raw).size).toBe(0);
  });
});

describe('isHydratable', () => {
  const stat = { size: 1000, mtimeMs: 123456 };

  it('true for an exact stat match, not live', () => {
    expect(isHydratable(entry(), stat, undefined)).toBe(true);
    expect(isHydratable(entry(), stat, false)).toBe(true);
    expect(isHydratable(entry(), stat, null)).toBe(true);
  });

  it('false on any size or mtime mismatch', () => {
    expect(isHydratable(entry(), { size: 999, mtimeMs: 123456 }, undefined)).toBe(false);
    expect(isHydratable(entry(), { size: 1000, mtimeMs: 1 }, undefined)).toBe(false);
  });

  it('false when the registry confirms the process is live', () => {
    expect(isHydratable(entry(), stat, true)).toBe(false);
  });

  // No quiet-window/status re-check here — both were already enforced once,
  // at export time; status is a compile-time 'done' literal by the time an
  // entry reaches here (tryNormaliseState rejects anything else at parse
  // time), and re-checking the quiet window against a different wall clock
  // would only ever make hydration needlessly MORE conservative.
});

describe('pruneEntries', () => {
  const now = Date.now();

  it('drops entries older than maxAgeMs', () => {
    const entries = new Map([
      ['/fresh.jsonl', entry({ cachedAt: now - 1000 })],
      ['/stale.jsonl', entry({ cachedAt: now - 100_000 })],
    ]);
    const pruned = pruneEntries(entries, now, { maxAgeMs: 10_000, maxEntries: 100 });
    expect([...pruned.keys()]).toEqual(['/fresh.jsonl']);
  });

  it('caps maxAgeMs at the 60-day hard ceiling regardless of caller input', () => {
    const veryOld = now - 61 * 24 * 60 * 60 * 1000;
    const entries = new Map([['/ancient.jsonl', entry({ cachedAt: veryOld })]]);
    const pruned = pruneEntries(entries, now, { maxAgeMs: Number.MAX_SAFE_INTEGER, maxEntries: 100 });
    expect(pruned.size).toBe(0);
  });

  it('caps entry count, keeping the newest cachedAt first', () => {
    const entries = new Map([
      ['/oldest.jsonl', entry({ cachedAt: now - 3000 })],
      ['/middle.jsonl', entry({ cachedAt: now - 2000 })],
      ['/newest.jsonl', entry({ cachedAt: now - 1000 })],
    ]);
    const pruned = pruneEntries(entries, now, { maxAgeMs: 999_999_999, maxEntries: 2 });
    expect([...pruned.keys()].sort()).toEqual(['/middle.jsonl', '/newest.jsonl'].sort());
  });

  it('is synchronous and pure — no I/O, no missing-file check', () => {
    // pruneEntries takes no `exists` parameter any more — missing-file
    // eviction is pruneMissingFiles()'s job (async, batched, applied only to
    // the keys worth checking). A fictional path is kept by pruneEntries
    // regardless of whether it exists on disk.
    const entries = new Map([['/does/not/exist.jsonl', entry()]]);
    const pruned = pruneEntries(entries, Date.now(), { maxAgeMs: 999_999_999, maxEntries: 100 });
    expect(pruned.size).toBe(1);
  });
});

describe('pruneMissingFiles', () => {
  it('drops an entry only on a confirmed ENOENT', async () => {
    const entries = new Map([['/gone.jsonl', entry()]]);
    const enoent = async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    const pruned = await pruneMissingFiles(entries, ['/gone.jsonl'], () => enoent().then(() => true, () => false));
    expect(pruned.size).toBe(0);
  });

  it('keeps an entry on any OTHER error (can\'t tell != gone)', async () => {
    const entries = new Map([['/degraded.jsonl', entry()]]);
    const flaky = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    // Mirror existsOrUnknown's own policy via a custom exists fn for this test.
    const existsOrUnknown = async () => {
      try { await flaky(); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ENOENT'; }
    };
    const pruned = await pruneMissingFiles(entries, ['/degraded.jsonl'], existsOrUnknown);
    expect(pruned.size).toBe(1);
  });

  it('only checks the requested keys, not the whole map', async () => {
    const entries = new Map([
      ['/checked.jsonl', entry()],
      ['/unchecked.jsonl', entry()],
    ]);
    const checked: string[] = [];
    const exists = async (p: string) => { checked.push(p); return p !== '/checked.jsonl'; };
    const pruned = await pruneMissingFiles(entries, ['/checked.jsonl'], exists);
    expect(checked).toEqual(['/checked.jsonl']);
    expect([...pruned.keys()].sort()).toEqual(['/unchecked.jsonl']);
  });

  it('batches checks in chunks (does not fire all at once beyond the batch size)', async () => {
    const keys = Array.from({ length: 120 }, (_, i) => `/f${i}.jsonl`);
    const entries = new Map(keys.map(k => [k, entry()]));
    let concurrentInFlight = 0;
    let maxConcurrent = 0;
    const exists = async () => {
      concurrentInFlight++;
      maxConcurrent = Math.max(maxConcurrent, concurrentInFlight);
      await new Promise(r => setTimeout(r, 0));
      concurrentInFlight--;
      return true;
    };
    await pruneMissingFiles(entries, keys, exists);
    expect(maxConcurrent).toBeLessThanOrEqual(50);
  });

  it('returns the same map reference when there is nothing to check', async () => {
    const entries = new Map([['/a.jsonl', entry()]]);
    const result = await pruneMissingFiles(entries, [], async () => true);
    expect(result).toBe(entries);
  });

  it('ignores keys not present in the map', async () => {
    const entries = new Map([['/a.jsonl', entry()]]);
    let called = false;
    await pruneMissingFiles(entries, ['/not-in-map.jsonl'], async () => { called = true; return true; });
    expect(called).toBe(false);
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
  // pruneMissingFiles() (wired into load(), and into save() for entries
  // newly seen from another window) drops an entry whose backing file is
  // CONFIRMED gone — exactly the real-world case where a session's JSONL was
  // deleted between caching and flushing. Entries a test wants to simulate
  // as coming from ANOTHER window's disk write therefore need a REAL (if
  // empty) backing file; entries this store already knows about before a
  // merge (its own put()s) are never existence-checked, so those may use
  // fictional paths freely.
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
    expect(store.get(pathA)).toBeUndefined();
  });

  it('load() drops an entry whose backing file is confirmed gone', async () => {
    const goneEntry = entry({ state: cachedState({ sessionId: 'gone' }) });
    fs.writeFileSync(cachePath, serialiseReplayCache(new Map([
      ['/definitely/does/not/exist.jsonl', goneEntry],
      [pathA, entry({ state: cachedState({ sessionId: 'still-here' }) })],
    ])));
    await store.load();
    expect(store.get('/definitely/does/not/exist.jsonl')).toBeUndefined();
    expect(store.get(pathA)).toBeDefined();
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

  it('flush(now, { force: true }) bypasses the interval', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    const t0 = Date.now();
    store.put(pathA, entry());
    await store.flush(t0);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    store.put(pathB, entry());
    await store.flush(t0 + 1000, { force: true });
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('force flush() still no-ops when not dirty', async () => {
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    await store.flush(Date.now(), { force: true });
    expect(writeSpy).not.toHaveBeenCalled();
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

  it('flush() skips the re-read when the cache file\'s own stat is unchanged', async () => {
    store.put(pathA, entry());
    await store.flush(Date.now()); // first write establishes diskStamp

    const readSpy = vi.spyOn(fs.promises, 'readFile');
    store.put(pathB, entry());
    await store.flush(Date.now() + 40_000, { force: true });
    // Only the initial load-less path's OWN write updates diskStamp; nothing
    // else touched the file between the two flushes, so the merge re-read
    // must have been skipped.
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('flush() only existence-checks entries newly seen from disk, not ones it already knew', async () => {
    // pathMine is already known (our own put()) — must NOT be existence
    // checked even though it's a real file we could stat.
    const statSpy = vi.spyOn(fs.promises, 'access');
    store.put(pathMine, entry());
    await store.flush(Date.now());
    // No other window's entries landed on disk between load and flush, and
    // pathMine was already known before the merge — no access() calls
    // expected for the missing-file check.
    expect(statSpy).not.toHaveBeenCalled();
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

  it('refuses (stats before reading) an oversized cache file without reading its content', async () => {
    fs.writeFileSync(cachePath, 'x'.repeat(17 * 1024 * 1024));
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    await store.load();
    expect(readSpy).not.toHaveBeenCalled();
    expect(store.get(pathA)).toBeUndefined();
  });

  it('get() returns undefined for an unknown path and the loaded entry otherwise', async () => {
    fs.writeFileSync(cachePath, serialiseReplayCache(new Map([[pathA, entry()]])));
    await store.load();
    expect(store.get('/unknown.jsonl')).toBeUndefined();
    expect(store.get(pathA)).toBeDefined();
  });
});
