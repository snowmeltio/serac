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

// Mock JsonlTailer so we can feed records without files, and so hydrate()'s
// `new JsonlTailer(filePath, stamp.size)` seam is observable (initialOffset,
// reset()). Tracks read-call count so "hydrate → update() never reads" is
// directly assertable, and stamps lastMtimeMs (unlike the bare liveness-test
// mock) so getReadStamp().caughtUp can go true in these tests.
let mockRecords: JsonlRecord[] = [];
let readNewRecordsCallCount = 0;
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
  return {
    sessionId: 'cached-session',
    slug: 'cached-slug',
    workspaceKey: 'ws-key',
    cwd: '/Users/foo/bar',
    initialCwd: '/Users/foo/bar',
    topic: 'Cached topic',
    activity: 'Cached activity',
    status: 'done',
    lastActivity: Date.now() - REPLAY_CACHE_QUIET_MS - 1000,
    firstActivity: Date.now() - 60_000,
    enqueuedAt: 0,
    contextTokens: 42,
    modelId: 'claude-sonnet-5',
    modelConfirmed: true,
    customTitle: 'Cached Title',
    aiTitle: 'Cached AI Title',
    userTurnCount: 3,
    gitBranch: 'main',
    toolErrorCount: 1,
    lastAssistantText: 'Cached preview',
    trackedFiles: ['a.ts'],
    subagents: [{
      parentToolUseId: 'tu-1', agentId: 'agent-1', description: 'Do the thing',
      resultPreview: 'Done thing', toolsCompleted: 4, startedAt: Date.now() - 30_000,
    }],
    ...overrides,
  };
}

function hydratedManager(overrides: Partial<CachedSessionState> = {}): InstanceType<typeof SessionManager> {
  return SessionManager.fromCache('cached-session', FILE_PATH, 'ws-key', {}, cachedState(overrides), STAMP);
}

beforeEach(() => {
  mockRecords = [];
  readNewRecordsCallCount = 0;
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
    const mgr = hydratedManager({ status: 'waiting' });
    expect(mgr.getStatus()).toBe('done');
  });

  it('cached status "running" is also coerced to done', () => {
    const mgr = hydratedManager({ status: 'running' });
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

  it('rebuilds done subagents via the create/complete path — no live timers, correct fields', () => {
    const mgr = hydratedManager();
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      parentToolUseId: 'tu-1', agentId: 'agent-1', description: 'Do the thing',
      running: false, resultPreview: 'Done thing', toolsCompleted: 4,
    });
  });

  it('seeds the tailer at the cache stamp\'s size (initialOffset seam)', () => {
    hydratedManager();
    expect(tailerConstructions.at(-1)).toEqual({ filePath: FILE_PATH, initialOffset: STAMP.size });
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

  it('changed size: begins a full replay from byte 0, titles survive, readNewRecords is called', async () => {
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

  it('after a full replay, the tailer is RESET, not reconstructed a third time', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: STAMP.size + 100, mtimeMs: STAMP.mtimeMs } as fs.Stats);
    const before = tailerConstructions.length;
    const mgr = hydratedManager();
    // fromCache() constructs two tailers: the constructor's default (offset
    // 0, immediately discarded) and hydrate()'s stamped one — see
    // "seeds the tailer at the cache stamp's size" above.
    expect(tailerConstructions.length).toBe(before + 2);
    await mgr.update();
    // beginFullReplay() calls tailer.reset() — it must NOT construct a THIRD
    // tailer just to rewind to offset 0.
    expect(tailerConstructions.length).toBe(before + 2);
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

describe('runThenReplay/forceReplay clears hydration', () => {
  it('forceReplay() on a hydrated manager clears isHydrated()', async () => {
    const mgr = hydratedManager();
    expect(mgr.isHydrated()).toBe(true);
    await mgr.forceReplay();
    expect(mgr.isHydrated()).toBe(false);
  });
});

describe('exportCachedState()', () => {
  function freshManager(): InstanceType<typeof SessionManager> {
    return new SessionManager('live-session', FILE_PATH, 'ws-key');
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
