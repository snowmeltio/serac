/**
 * Dormant-session replay cache hydration — SessionManager.fromCache()/
 * hydrate(), exportCachedState(), and the updateInner()/checkMtime()
 * hydrated-manager guards. See ARCHITECTURE.md "Replay cache" and
 * replayCache.ts for the eligibility contract these pair with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import type { JsonlRecord, CachedSessionState } from './types.js';
import { HookEventRouter } from './hookEventRouter.js';
import { REPLAY_CACHE_QUIET_MS } from './replayCache.js';
import { makeCachedSessionState } from './__fixtures__/replayCache.js';

// Mock JsonlTailer so we can feed records without files, and so hydrate()'s
// `new JsonlTailer(filePath, stamp.size)` seam is observable (initialOffset,
// reset()). Tracks read-call count so "hydrate → update() never reads" is
// directly assertable, and stamps lastMtimeMs (unlike the bare liveness-test
// mock) so getReadStamp().caughtUp can go true in these tests. `mockOpenFails`
// mirrors the real JsonlTailer's early-return when fs.promises.open() itself
// throws: readNewRecords() returns [] WITHOUT ever touching lastMtimeMs/
// lastSize — the exact shape of read that must not be mistaken for "replay
// completed".
let mockRecords: JsonlRecord[] = [];
let readNewRecordsCallCount = 0;
let mockOpenFails = false;
let tailerConstructions: Array<{ filePath: string; initialOffset: number }> = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    lastSize = 0;
    lastMtimeMs = 0;
    private offset: number;
    constructor(public filePath: string, initialOffset = 0) {
      this.offset = initialOffset;
      tailerConstructions.push({ filePath, initialOffset });
    }
    async readNewRecords() {
      readNewRecordsCallCount++;
      if (mockOpenFails) {
        mockOpenFails = false; // fails exactly once per arming, like a transient race
        return [];
      }
      const r = mockRecords;
      mockRecords = [];
      if (r.length > 0) { this.offset++; }
      this.lastSize = this.offset;
      this.lastMtimeMs = 999; // any >0 value — see getReadStamp().caughtUp
      return r;
    }
    getOffset() { return this.offset; }
    reset() { this.offset = 0; }
  },
}));

const { SessionManager } = await import('./sessionManager.js');

const FILE_PATH = '/tmp/hydrate-test.jsonl';
const STAMP = { size: 500, mtimeMs: 123456 };

function userRecord(text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
}

function toolUse(name: string, id: string, input: Record<string, unknown> = {}): JsonlRecord {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name, id, input }] } };
}

function toolResult(id: string, text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } };
}

function enqueue(): JsonlRecord {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString() };
}

async function feed(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

function cachedState(overrides: Partial<CachedSessionState> = {}): CachedSessionState {
  return makeCachedSessionState({
    sessionId: 'cached-session',
    slug: 'cached-slug',
    workspaceKey: 'ws-key',
    subagents: [{
      parentToolUseId: 'tu-1', agentId: 'agent-1', description: 'Do the thing',
      resultPreview: 'Done thing', toolsCompleted: 4, startedAt: Date.now() - 30_000,
      lastActivity: Date.now() - 20_000, background: true,
    }],
    ...overrides,
  });
}

function hydratedManager(overrides: Partial<CachedSessionState> = {}, opts: ConstructorParameters<typeof SessionManager>[3] = {}): InstanceType<typeof SessionManager> {
  return SessionManager.fromCache('cached-session', FILE_PATH, 'ws-key', opts, cachedState(overrides), STAMP);
}

beforeEach(() => {
  mockRecords = [];
  readNewRecordsCallCount = 0;
  mockOpenFails = false;
  tailerConstructions = [];
  vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size, mtimeMs: STAMP.mtimeMs } as fs.Stats);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fromCache/hydrate', () => {
  it('restores identity, status forced to done, and marks the manager hydrated', () => {
    const mgr = hydratedManager();
    expect(mgr.getSessionId()).toBe('cached-session');
    expect(mgr.getStatus()).toBe('done');
    expect(mgr.isHydrated()).toBe(true);
    expect(mgr.getFilePath()).toBe(FILE_PATH);
  });

  it('cached status "waiting" is coerced to done regardless of the cached value', () => {
    const mgr = hydratedManager({ status: 'waiting' as never });
    expect(mgr.getStatus()).toBe('done');
  });

  it('cached status "running" is also coerced to done', () => {
    const mgr = hydratedManager({ status: 'running' as never });
    expect(mgr.getStatus()).toBe('done');
  });

  it('restores titles, topic, and glance fields into the snapshot', () => {
    const mgr = hydratedManager();
    const snap = mgr.getSnapshot();
    expect(snap.customTitle).toBe('Cached Title');
    expect(snap.aiTitle).toBe('Cached AI Title');
    expect(snap.topic).toBe('Cached topic');
    expect(snap.cwd).toBe('/Users/foo/bar');
    expect(snap.initialCwd).toBe('/Users/foo/bar');
    expect(snap.gitBranch).toBe('main');
    expect(snap.toolErrorCount).toBe(1);
    expect(snap.lastAssistantText).toBe('Cached preview');
    expect(snap.trackedFiles).toEqual(['a.ts']);
    expect(mgr.getTitles()).toEqual({ aiTitle: 'Cached AI Title', customTitle: 'Cached Title' });
  });

  it('rebuilds done subagents directly — no live timers, correct fields, background+lastActivity round-trip', () => {
    const startedAt = Date.now() - 30_000;
    const lastActivity = Date.now() - 20_000;
    const mgr = hydratedManager({
      subagents: [{
        parentToolUseId: 'tu-1', agentId: 'agent-1', description: 'Do the thing',
        resultPreview: 'Done thing', toolsCompleted: 4, startedAt, lastActivity, background: true,
      }],
    });
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      parentToolUseId: 'tu-1', agentId: 'agent-1', description: 'Do the thing',
      running: false, resultPreview: 'Done thing', toolsCompleted: 4,
      background: true,
    });
    expect(subs[0].startedAt).toBe(startedAt);
  });

  it('a cached subagent with background: false/undefined round-trips as not backgrounded', () => {
    const mgr = hydratedManager({
      subagents: [{
        parentToolUseId: 'tu-1', agentId: null, description: 'desc',
        resultPreview: null, toolsCompleted: 0, startedAt: Date.now(), lastActivity: Date.now(),
      }],
    });
    expect(mgr.getSnapshot().subagents[0].background).toBeUndefined();
  });

  it('seeds the tailer at the cache stamp\'s size (initialOffset seam) and mirrors the stamp into its own fields', () => {
    hydratedManager();
    const last = tailerConstructions.at(-1);
    expect(last).toEqual({ filePath: FILE_PATH, initialOffset: STAMP.size });
  });

  it('modelId is restored when the cached value was confirmed', () => {
    const mgr = hydratedManager({ modelId: 'claude-opus-4-6', modelConfirmed: true });
    expect(mgr.getSnapshot().modelLabel).not.toBe('');
  });

  // Item 15: an UNCONFIRMED cached modelId is the OLD window's config-derived
  // defaultModelGuess, not a fact about the transcript. Caching it verbatim
  // would freeze a stale model pill forever on a hydrated enqueue-only
  // session (the file never changes again, so nothing ever re-derives it) —
  // even after the user changes the default model setting and reloads.
  it('an unconfirmed cached modelId is IGNORED — hydrate() re-derives from the CURRENT defaultModelGuess', () => {
    const mgr = hydratedManager(
      { modelId: 'sonnet', modelConfirmed: false },
      { defaultModelGuess: 'opus' },
    );
    const snap = mgr.getSnapshot();
    // formatModelLabel('opus') is whatever the shared label formatter
    // produces; the point is it's NOT sonnet's, and it's unconfirmed
    // ('*' suffix — see formatModelLabel() in sessionManager.ts).
    expect(snap.modelLabel).not.toContain('Sonnet');
    expect(snap.modelLabel.endsWith('*')).toBe(true);
  });

  it('an unconfirmed cached modelId with no defaultModelGuess leaves the pill blank', () => {
    const mgr = hydratedManager({ modelId: 'sonnet', modelConfirmed: false }, {});
    expect(mgr.getSnapshot().modelLabel).toBe('');
  });
});

describe('updateInner() hydrated guard', () => {
  it('unchanged stat: update() never calls readNewRecords', async () => {
    const mgr = hydratedManager();
    const changed = await mgr.update();
    expect(changed).toBe(false);
    expect(readNewRecordsCallCount).toBe(0);
    expect(mgr.isHydrated()).toBe(true); // still hydrated — nothing invalidated it
  });

  it('missing file: update() returns false without throwing, leaves hydration intact', async () => {
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('ENOENT'));
    const mgr = hydratedManager();
    const changed = await mgr.update();
    expect(changed).toBe(false);
    expect(readNewRecordsCallCount).toBe(0);
  });

  it('changed stamp: full replay from offset 0 (never an incremental read), titles survive, readNewRecords is called', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size + 100, mtimeMs: STAMP.mtimeMs } as fs.Stats);
    const mgr = hydratedManager();
    expect(mgr.isHydrated()).toBe(true);

    await mgr.update();

    expect(readNewRecordsCallCount).toBeGreaterThan(0);
    expect(mgr.isHydrated()).toBe(false);
    // Titles survive a truncation-style reset (resetState() preserves them).
    expect(mgr.getTitles()).toEqual({ aiTitle: 'Cached AI Title', customTitle: 'Cached Title' });
  });

  it('changed mtime alone also triggers a full replay', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size, mtimeMs: STAMP.mtimeMs + 1 } as fs.Stats);
    const mgr = hydratedManager();
    await mgr.update();
    expect(mgr.isHydrated()).toBe(false);
  });

  it('after a full replay, the tailer is RESET (offset 0), not reconstructed a third time', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size + 100, mtimeMs: STAMP.mtimeMs } as fs.Stats);
    const before = tailerConstructions.length;
    const mgr = hydratedManager();
    // fromCache() constructs two tailers: the constructor's default (offset
    // 0, immediately discarded) and hydrate()'s stamped one.
    expect(tailerConstructions.length).toBe(before + 2);
    mockRecords = [userRecord('replayed from the start')];
    await mgr.update();
    // beginFullReplay() calls tailer.reset() — it must NOT construct a THIRD
    // tailer just to rewind to offset 0. The mock's reset() zeroes `offset`,
    // so the drain that follows reads from the beginning, not mid-file.
    expect(tailerConstructions.length).toBe(before + 2);
  });

  // Item 2: a read whose very first fs.promises.open() fails (ENOENT, a
  // transient race) must NOT be mistaken for "the replay completed" — that
  // would silently graduate the NEXT (actually successful) read to LIVE,
  // spawning captureWriterPid()'s fuser scan for a writer that may be long
  // dead, and logging bridge transitions as real activity instead of replay.
  it('open() failing on the invalidation read: the SECOND update() still runs as a replay (captureWriterPid not called)', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size + 100, mtimeMs: STAMP.mtimeMs } as fs.Stats);
    const captureSpy = vi.spyOn(SessionManager.prototype as unknown as { captureWriterPid(): void }, 'captureWriterPid');
    const mgr = hydratedManager();

    mockOpenFails = true;
    const first = await mgr.update();
    expect(first).toBe(false); // no records, nothing changed
    expect(mgr.isHydrated()).toBe(false); // still invalidated — beginFullReplay() already ran

    // Second update(): the file is now genuinely readable. If the first
    // failed read had wrongly flipped initialReplayDone, this delivers a
    // running-transition record as LIVE and captureWriterPid() fires.
    await feed(mgr, [userRecord('now the file actually reads')]);
    expect(mgr.getStatus()).toBe('running');
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('a live record delivered on the SAME update() call after the reset is NOT treated as replay-suppressed forever — the drain completes within this call', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size + 100, mtimeMs: STAMP.mtimeMs } as fs.Stats);
    mockRecords = [userRecord('a live-looking record delivered right after invalidation')];
    const mgr = hydratedManager();
    const changed = await mgr.update();
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });
});

describe('checkMtime() when hydrated', () => {
  it('false when stat matches the cache stamp exactly', async () => {
    const mgr = hydratedManager();
    expect(await mgr.checkMtime()).toBe(false);
  });

  it('true when size differs, even with mtime unchanged', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size + 1, mtimeMs: STAMP.mtimeMs } as fs.Stats);
    const mgr = hydratedManager();
    expect(await mgr.checkMtime()).toBe(true);
  });

  it('true when mtime differs, even with size unchanged', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size, mtimeMs: STAMP.mtimeMs + 1 } as fs.Stats);
    const mgr = hydratedManager();
    expect(await mgr.checkMtime()).toBe(true);
  });

  it('false on a stat error (file gone — discovery will prune)', async () => {
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('ENOENT'));
    const mgr = hydratedManager();
    expect(await mgr.checkMtime()).toBe(false);
  });
});

describe('getReadStamp() when hydrated', () => {
  // Item 3: before hydrate() seeded tailer.lastSize/lastMtimeMs directly (not
  // just this.lastMtimeMs), getReadStamp() on a freshly hydrated, never-yet-
  // updated manager reported {size: 0, caughtUp: true} — technically
  // "caught up" by the letter of the check, but a lie about what had
  // actually been read.
  it('reports the cache stamp truthfully, not {size: 0}', () => {
    const mgr = hydratedManager();
    expect(mgr.getReadStamp()).toEqual({ size: STAMP.size, mtimeMs: STAMP.mtimeMs, caughtUp: true });
  });
});

describe('runThenReplay/forceReplay clears hydration', () => {
  it('forceReplay() on a hydrated manager clears isHydrated()', async () => {
    const mgr = hydratedManager();
    expect(mgr.isHydrated()).toBe(true);
    await mgr.forceReplay();
    expect(mgr.isHydrated()).toBe(false);
  });
});

describe('exportCachedState()', () => {
  function freshManager(opts: ConstructorParameters<typeof SessionManager>[3] = {}): InstanceType<typeof SessionManager> {
    return new SessionManager('live-session', FILE_PATH, 'ws-key', opts);
  }

  it('null on a freshly constructed (not-yet-quiet) session, even though status starts done', async () => {
    const mgr = freshManager();
    expect(mgr.getStatus()).toBe('done'); // constructor default
    expect(mgr.exportCachedState(Date.now())).toBeNull(); // quiet window not elapsed
  });

  it('null while status is not done', async () => {
    const mgr = freshManager();
    await feed(mgr, [userRecord('start working')]);
    expect(mgr.getStatus()).toBe('running');
    expect(mgr.exportCachedState(Date.now() + REPLAY_CACHE_QUIET_MS + 60_000)).toBeNull();
  });

  it('null while compacting (done forced via Stop hook mid-compaction)', async () => {
    const router = new HookEventRouter();
    const mgr = new SessionManager('live-session', FILE_PATH, 'ws-key', { hookRouter: router });
    router.onHookEvent('live-session', 'PreCompact', { trigger: 'auto' });
    router.onHookEvent('live-session', 'Stop', {});
    expect(mgr.getStatus()).toBe('done');
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    expect(mgr.exportCachedState(future)).toBeNull();
  });

  it('null with an outstanding background shell', async () => {
    const mgr = freshManager();
    await feed(mgr, [toolResult('tu-shell', 'Command running in background with ID: bfzrk3tz9. Output is being written to: /tmp/x.output.')]);
    await feed(mgr, [enqueue()]);
    expect(mgr.getStatus()).toBe('done');
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    expect(mgr.exportCachedState(future)).toBeNull();
  });

  it('null with a pending ScheduleWakeup', async () => {
    const mgr = freshManager();
    // A long delay — comfortably past the quiet-window horizon used below, so
    // the wakeup is still pending (not yet fired) at the moment of the check.
    await feed(mgr, [toolUse('ScheduleWakeup', 'tu-wake', { delaySeconds: 3600, reason: 'later' })]);
    await feed(mgr, [toolResult('tu-wake', 'scheduled')]); // clears activeTools, not the wakeup
    await feed(mgr, [enqueue()]);
    expect(mgr.getStatus()).toBe('done');
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    expect(mgr.exportCachedState(future)).toBeNull();
  });

  it('null when the registry confirms the process is live right now', async () => {
    const mgr = new SessionManager('live-session', FILE_PATH, 'ws-key', { livenessProbe: () => true });
    await feed(mgr, [enqueue()]);
    expect(mgr.getStatus()).toBe('done');
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    expect(mgr.exportCachedState(future)).toBeNull();
  });

  it('null when this manager is itself already hydrated', () => {
    const mgr = hydratedManager({ lastActivity: Date.now() - REPLAY_CACHE_QUIET_MS - 60_000 });
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    expect(mgr.exportCachedState(future)).toBeNull();
  });

  it('returns a well-formed CachedSessionState for an eligible session', async () => {
    const mgr = freshManager();
    await feed(mgr, [userRecord('Fix the flaky test')]);
    await feed(mgr, [enqueue()]);
    expect(mgr.getStatus()).toBe('done');
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    const cached = mgr.exportCachedState(future);
    expect(cached).not.toBeNull();
    expect(cached!.sessionId).toBe('live-session');
    expect(cached!.status).toBe('done');
    expect(cached!.topic).toBe('Fix the flaky test');
    expect(cached!.subagents).toEqual([]);
  });

  // Item 15: an unconfirmed model must never be exported verbatim.
  it('exports modelId empty when the model is unconfirmed', async () => {
    const mgr = freshManager({ defaultModelGuess: 'opus' });
    await feed(mgr, [enqueue()]);
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    const cached = mgr.exportCachedState(future);
    expect(cached!.modelConfirmed).toBe(false);
    expect(cached!.modelId).toBe('');
  });

  it('exports modelId verbatim once confirmed by a real assistant record', async () => {
    const mgr = freshManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { model: 'claude-opus-4-6', usage: { input_tokens: 10 }, content: [{ type: 'text', text: 'hi' }] } as Record<string, unknown>,
    }]);
    await feed(mgr, [enqueue()]);
    const future = Date.now() + REPLAY_CACHE_QUIET_MS + 60_000;
    const cached = mgr.exportCachedState(future);
    expect(cached!.modelConfirmed).toBe(true);
    expect(cached!.modelId).toBe('claude-opus-4-6');
  });

  it('caps run_in_background agents out of eligibility (still running past turn-end)', async () => {
    vi.useFakeTimers();
    try {
      const mgr = freshManager();
      await feed(mgr, [userRecord('kick off the build')]);
      await feed(mgr, [toolUse('Agent', 'tu-bg', { description: 'Build it', prompt: 'go', run_in_background: true })]);
      await feed(mgr, [toolResult('tu-bg', 'Async agent launched successfully.\nagentId: bg-agent-1 (internal ID).\nWorking in background.')]);
      await feed(mgr, [{
        type: 'assistant', timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'Working on it in the background.' }] },
      }]);
      vi.advanceTimersByTime(6_000);
      expect(mgr.getStatus()).toBe('done');
      expect(mgr.hasLiveBackgroundAgents()).toBe(true);

      vi.advanceTimersByTime(REPLAY_CACHE_QUIET_MS + 60_000);
      expect(mgr.exportCachedState(Date.now())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
