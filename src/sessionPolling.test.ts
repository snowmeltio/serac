import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  jsonlSessionId,
  makeRescanGate,
  pollTrackedSessions,
  hasActiveTrackedSessions,
  trackJsonlSessions,
  offerSessionToReplayCache,
  type PollableSession,
} from './sessionPolling.js';
import { SessionManager } from './sessionManager.js';
import { JsonlTailer } from './jsonlTailer.js';
import type { ReplayCacheEntry, ReplayCacheStore } from './replayCache.js';
import type { CachedSessionState } from './types.js';

function fakeSession(overrides: Partial<PollableSession> = {}): PollableSession {
  return {
    getStatus: () => 'done',
    getLastActivity: () => new Date(0),
    checkMtime: async () => false,
    update: async () => false,
    demoteIfStale: () => false,
    sweepBackgroundWork: () => false,
    dispose: vi.fn(),
    // Replay-cache-era members (PR D) — unused by most tests in this file,
    // which predate the cache; stubbed so fakeSession() still satisfies the
    // interface without every call site having to supply them.
    getFilePath: () => '/fake/session.jsonl',
    getReadStamp: () => ({ size: 0, mtimeMs: 0, caughtUp: true }),
    exportCachedState: () => null,
    isHydrated: () => false,
    ...overrides,
  };
}

describe('makeRescanGate', () => {
  it('passes every Nth call when dormant', () => {
    const gate = makeRescanGate();
    const results = Array.from({ length: 20 }, () => gate());
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results[9]).toBe(true);
    expect(results[19]).toBe(true);
  });

  it('passes every call while the active predicate holds, without consuming the counter', () => {
    let active = true;
    const gate = makeRescanGate(() => active);
    expect(gate()).toBe(true);
    expect(gate()).toBe(true);
    active = false;
    // Counter starts fresh: nine misses, then the tenth passes.
    const results = Array.from({ length: 10 }, () => gate());
    expect(results.slice(0, 9).every(r => r === false)).toBe(true);
    expect(results[9]).toBe(true);
  });

  it('honours a custom interval', () => {
    const gate = makeRescanGate(undefined, 3);
    expect([gate(), gate(), gate()]).toEqual([false, false, true]);
  });
});

describe('jsonlSessionId', () => {
  it('strips the extension from a .jsonl name', () => {
    expect(jsonlSessionId('abc-123.jsonl')).toBe('abc-123');
  });

  it('returns null for non-jsonl names', () => {
    expect(jsonlSessionId('session-meta.json')).toBeNull();
    expect(jsonlSessionId('subagents')).toBeNull();
  });

  it('strips only the final extension, not interior matches', () => {
    expect(jsonlSessionId('a.jsonl.bak')).toBeNull();
    expect(jsonlSessionId('a.jsonl.jsonl')).toBe('a.jsonl');
  });
});

describe('pollTrackedSessions', () => {
  it('evicts a dormant session outside the window and reports change', async () => {
    const session = fakeSession();
    const sessions = new Map([['ws/sess-1', session]]);

    const changed = await pollTrackedSessions(sessions, 1000, () => false);

    expect(changed).toBe(true);
    expect(sessions.size).toBe(0);
    expect(session.dispose).toHaveBeenCalled();
  });

  it('passes the composite-stripped sessionId to the window predicate', async () => {
    const seen: string[] = [];
    const sessions = new Map([['ws-key/sess-9', fakeSession()]]);

    await pollTrackedSessions(sessions, 1000, (sessionId) => {
      seen.push(sessionId);
      return true;
    });

    expect(seen).toEqual(['sess-9']);
  });

  it('updates a dormant session only when its mtime changed', async () => {
    const update = vi.fn(async () => true);
    const sessions = new Map([
      ['ws/quiet', fakeSession({ checkMtime: async () => false, update })],
    ]);

    let changed = await pollTrackedSessions(sessions, 1000, () => true);
    expect(update).not.toHaveBeenCalled();
    expect(changed).toBe(false);

    sessions.set('ws/touched', fakeSession({ checkMtime: async () => true, update }));
    changed = await pollTrackedSessions(sessions, 1000, () => true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(changed).toBe(true);
  });

  it('sweeps background work on dormant sessions', async () => {
    const sessions = new Map([
      ['ws/swept', fakeSession({ sweepBackgroundWork: () => true })],
    ]);

    expect(await pollTrackedSessions(sessions, 1000, () => true)).toBe(true);
  });

  it('never window-evicts an active session; updates and demotes instead', async () => {
    const dispose = vi.fn();
    const demoteIfStale = vi.fn(() => true);
    const sessions = new Map([
      ['ws/live', fakeSession({ getStatus: () => 'running', dispose, demoteIfStale })],
    ]);

    // Window predicate says "out" — active sessions must survive anyway.
    const changed = await pollTrackedSessions(sessions, 1000, () => false);

    expect(dispose).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
    expect(changed).toBe(true);
  });

  // L16: the 30s demotion threshold used to be pinned only as a side effect
  // of the eviction test above (which cares about never-evict, not the
  // threshold value). Decoupled into its own assertion on the ordinary
  // no-data active path so a restructure of the eviction scenario can't
  // silently drop the only check on DEMOTE_STALE_MS.
  it('demotes a quiet active session that produced no data with the shared 30s stale threshold', async () => {
    const demoteIfStale = vi.fn(() => true);
    const sessions = new Map([
      ['ws/quiet-active', fakeSession({ getStatus: () => 'waiting', update: async () => false, demoteIfStale })],
    ]);

    // Window predicate says "in" — this is not the eviction scenario.
    const changed = await pollTrackedSessions(sessions, 1000, () => true);

    expect(demoteIfStale).toHaveBeenCalledWith(30_000);
    expect(changed).toBe(true);
  });

  it('does not demote an active session that produced data', async () => {
    const demoteIfStale = vi.fn(() => true);
    const sessions = new Map([
      ['ws/busy', fakeSession({ getStatus: () => 'waiting', update: async () => true, demoteIfStale })],
    ]);

    const changed = await pollTrackedSessions(sessions, 1000, () => true);

    expect(demoteIfStale).not.toHaveBeenCalled();
    expect(changed).toBe(true);
  });

  it('swallows update errors and keeps polling the rest', async () => {
    const update = vi.fn(async () => true);
    const sessions = new Map([
      ['ws/a-bad', fakeSession({ getStatus: () => 'running', update: async () => { throw new Error('boom'); } })],
      ['ws/b-good', fakeSession({ getStatus: () => 'running', update })],
    ]);

    const changed = await pollTrackedSessions(sessions, 1000, () => true);

    expect(update).toHaveBeenCalled();
    expect(changed).toBe(true);
    expect(sessions.size).toBe(2);
  });

  // ── PR D: replay-cache population hook ──────────────────────────
  it('calls offer for a dormant session each cycle, with the session and now', async () => {
    const offer = vi.fn();
    const session = fakeSession({ checkMtime: async () => false });
    const sessions = new Map([['ws/done', session]]);

    await pollTrackedSessions(sessions, 1000, () => true, offer);

    expect(offer).toHaveBeenCalledTimes(1);
    expect(offer).toHaveBeenCalledWith(session, 1000);
  });

  it('does not call offer for an active (running/waiting) session', async () => {
    const offer = vi.fn();
    const sessions = new Map([['ws/busy', fakeSession({ getStatus: () => 'running', update: async () => false })]]);

    await pollTrackedSessions(sessions, 1000, () => true, offer);

    expect(offer).not.toHaveBeenCalled();
  });

  it('does not call offer for a session evicted this cycle (outside the window)', async () => {
    const offer = vi.fn();
    const sessions = new Map([['ws/done', fakeSession()]]);

    await pollTrackedSessions(sessions, 1000, () => false, offer);

    expect(offer).not.toHaveBeenCalled();
  });

  it('omitting offer entirely is a no-op — the dormant branch runs exactly as before', async () => {
    const sessions = new Map([['ws/done', fakeSession({ checkMtime: async () => false })]]);
    await expect(pollTrackedSessions(sessions, 1000, () => true)).resolves.toBe(false);
  });
});

describe('offerSessionToReplayCache', () => {
  function fakeStore(): ReplayCacheStore & { entries: Map<string, ReplayCacheEntry> } {
    const entries = new Map<string, ReplayCacheEntry>();
    return {
      entries,
      load: async () => {},
      get: (p: string) => entries.get(p),
      put: (p: string, e: ReplayCacheEntry) => { entries.set(p, e); },
      flush: async () => {},
    };
  }

  it('skips a hydrated session — never even calls exportCachedState', () => {
    const store = fakeStore();
    const exportCachedState = vi.fn();
    const session = fakeSession({ isHydrated: () => true, exportCachedState });

    offerSessionToReplayCache(session, 1000, store);

    expect(exportCachedState).not.toHaveBeenCalled();
    expect(store.entries.size).toBe(0);
  });

  it('skips an ineligible session (exportCachedState refuses with null)', () => {
    const store = fakeStore();
    const session = fakeSession({ exportCachedState: () => null });

    offerSessionToReplayCache(session, 1000, store);

    expect(store.entries.size).toBe(0);
  });

  it('puts an eligible session, keyed by its file path, stamped with the read stamp and cachedAt=now', () => {
    const store = fakeStore();
    const state = { sessionId: 's1' } as unknown as CachedSessionState;
    const session = fakeSession({
      getFilePath: () => '/ws/s1.jsonl',
      getReadStamp: () => ({ size: 42, mtimeMs: 99, caughtUp: true }),
      exportCachedState: () => state,
    });

    offerSessionToReplayCache(session, 1000, store);

    expect(store.entries.get('/ws/s1.jsonl')).toEqual({ size: 42, mtimeMs: 99, cachedAt: 1000, state });
  });

  it('skips the write when the cache already holds an identical {size, mtimeMs} stamp', () => {
    const store = fakeStore();
    store.entries.set('/ws/s1.jsonl', { size: 42, mtimeMs: 99, cachedAt: 500, state: {} as CachedSessionState });
    const session = fakeSession({
      getFilePath: () => '/ws/s1.jsonl',
      getReadStamp: () => ({ size: 42, mtimeMs: 99, caughtUp: true }),
      exportCachedState: () => ({ sessionId: 's1' } as unknown as CachedSessionState),
    });

    offerSessionToReplayCache(session, 1000, store);

    // Untouched — cachedAt from the pre-existing entry, not overwritten.
    expect(store.entries.get('/ws/s1.jsonl')?.cachedAt).toBe(500);
  });

  it('re-writes when the stamp differs even though the path is the same (the file changed since it was last cached)', () => {
    const store = fakeStore();
    store.entries.set('/ws/s1.jsonl', { size: 10, mtimeMs: 20, cachedAt: 500, state: {} as CachedSessionState });
    const state = { sessionId: 's1' } as unknown as CachedSessionState;
    const session = fakeSession({
      getFilePath: () => '/ws/s1.jsonl',
      getReadStamp: () => ({ size: 11, mtimeMs: 21, caughtUp: true }),
      exportCachedState: () => state,
    });

    offerSessionToReplayCache(session, 1000, store);

    expect(store.entries.get('/ws/s1.jsonl')).toEqual({ size: 11, mtimeMs: 21, cachedAt: 1000, state });
  });
});

describe('hasActiveTrackedSessions', () => {
  it('is true when any session is running or waiting', () => {
    const sessions = new Map([
      ['ws/done', fakeSession()],
      ['ws/live', fakeSession({ getStatus: () => 'waiting' })],
    ]);
    expect(hasActiveTrackedSessions(sessions)).toBe(true);
  });

  it('is false when all sessions are dormant', () => {
    const sessions = new Map([['ws/done', fakeSession()]]);
    expect(hasActiveTrackedSessions(sessions)).toBe(false);
  });
});

describe('trackJsonlSessions', () => {
  function jsonlLine(sessionId: string, ts: number): string {
    return JSON.stringify({
      type: 'user', sessionId, timestamp: new Date(ts).toISOString(),
      cwd: '/test/ws', message: { role: 'user', content: 'hello' },
    }) + '\n';
  }

  function setup(): { wsPath: string; sessions: Map<string, SessionManager>; cleanup: () => void } {
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-polling-'));
    const sessions = new Map<string, SessionManager>();
    return {
      wsPath, sessions,
      cleanup: () => {
        for (const s of sessions.values()) { s.dispose(); }
        fs.rmSync(wsPath, { recursive: true, force: true });
      },
    };
  }

  it('tracks a fresh session and reports change', async () => {
    const { wsPath, sessions, cleanup } = setup();
    const now = Date.now();
    fs.writeFileSync(path.join(wsPath, 'sess-1.jsonl'), jsonlLine('sess-1', now));

    const changed = await trackJsonlSessions({
      wsPath, workspaceKey: 'ws', files: ['sess-1.jsonl', 'session-meta.json'],
      sessions, now, withinWindow: () => true,
      makeManager: (sessionId, filePath) => new SessionManager(sessionId, filePath, 'ws'),
      warn: () => {},
    });

    expect(changed).toBe(true);
    expect(sessions.has('ws/sess-1')).toBe(true);
    cleanup();
  });

  it('skips a zero-length JSONL — an empty file is not a done session', async () => {
    // SessionManager's initial state is `done` with lastActivity = now, so
    // tracking an empty file manufactures a permanent done-but-unseen count
    // that no acknowledgement can ever clear. Claude Code creates the file
    // before writing its first record, so this is a real transient state.
    const { wsPath, sessions, cleanup } = setup();
    const now = Date.now();
    fs.writeFileSync(path.join(wsPath, 'empty.jsonl'), '');
    const makeManager = vi.fn((sessionId: string, filePath: string) => new SessionManager(sessionId, filePath, 'ws'));

    const changed = await trackJsonlSessions({
      wsPath, workspaceKey: 'ws', files: ['empty.jsonl'],
      sessions, now, withinWindow: () => true, makeManager, warn: () => {},
    });

    expect(changed).toBe(false);
    expect(sessions.size).toBe(0);
    expect(makeManager).not.toHaveBeenCalled();
    cleanup();
  });

  it('picks the same file up once it has a record', async () => {
    const { wsPath, sessions, cleanup } = setup();
    const now = Date.now();
    const filePath = path.join(wsPath, 'later.jsonl');
    fs.writeFileSync(filePath, '');
    const opts = {
      wsPath, workspaceKey: 'ws', files: ['later.jsonl'],
      sessions, now, withinWindow: () => true,
      makeManager: (sessionId: string, fp: string) => new SessionManager(sessionId, fp, 'ws'),
      warn: () => {},
    };
    await trackJsonlSessions(opts);
    expect(sessions.size).toBe(0);

    fs.writeFileSync(filePath, jsonlLine('later', now));
    const changed = await trackJsonlSessions(opts);

    expect(changed).toBe(true);
    expect(sessions.has('ws/later')).toBe(true);
    cleanup();
  });

  it('skips already-tracked sessions without constructing a manager', async () => {
    const { wsPath, sessions, cleanup } = setup();
    const now = Date.now();
    fs.writeFileSync(path.join(wsPath, 'sess-1.jsonl'), jsonlLine('sess-1', now));
    const makeManager = vi.fn((sessionId: string, filePath: string) => new SessionManager(sessionId, filePath, 'ws'));
    const opts = {
      wsPath, workspaceKey: 'ws', files: ['sess-1.jsonl'],
      sessions, now, withinWindow: () => true, makeManager, warn: () => {},
    };

    await trackJsonlSessions(opts);
    const changed = await trackJsonlSessions(opts);

    expect(changed).toBe(false);
    expect(makeManager).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('age-gates on file mtime before constructing', async () => {
    const { wsPath, sessions, cleanup } = setup();
    const now = Date.now();
    fs.writeFileSync(path.join(wsPath, 'old.jsonl'), jsonlLine('old', now));
    const makeManager = vi.fn((sessionId: string, filePath: string) => new SessionManager(sessionId, filePath, 'ws'));

    const changed = await trackJsonlSessions({
      wsPath, workspaceKey: 'ws', files: ['old.jsonl'],
      sessions, now, withinWindow: () => false, makeManager, warn: () => {},
    });

    expect(changed).toBe(false);
    expect(makeManager).not.toHaveBeenCalled();
    cleanup();
  });

  it('re-gates on real activity after the initial update (mtime-backfill flicker guard)', async () => {
    const { wsPath, sessions, cleanup } = setup();
    const now = Date.now();
    const old = now - 60 * 60 * 1000;
    // Content timestamps are old; the on-disk mtime is fresh (write just happened).
    fs.writeFileSync(path.join(wsPath, 'backfilled.jsonl'), jsonlLine('backfilled', old));

    const changed = await trackJsonlSessions({
      wsPath, workspaceKey: 'ws', files: ['backfilled.jsonl'],
      sessions, now,
      // Window admits the fresh mtime but rejects the old real activity.
      withinWindow: (_id, lastActivityMs) => now - lastActivityMs < 30 * 60 * 1000,
      makeManager: (sessionId, filePath) => new SessionManager(sessionId, filePath, 'ws'),
      warn: () => {},
    });

    expect(changed).toBe(false);
    expect(sessions.size).toBe(0);
    cleanup();
  });

  it('keeps the manager and warns when the initial update throws', async () => {
    const { wsPath, sessions, cleanup } = setup();
    const now = Date.now();
    fs.writeFileSync(path.join(wsPath, 'sess-1.jsonl'), jsonlLine('sess-1', now));
    const warn = vi.fn();
    const manager = new SessionManager('sess-1', path.join(wsPath, 'sess-1.jsonl'), 'ws');
    vi.spyOn(manager, 'update').mockRejectedValueOnce(new Error('read failed'));
    vi.spyOn(manager, 'getLastActivity').mockReturnValue(new Date(now));

    const changed = await trackJsonlSessions({
      wsPath, workspaceKey: 'ws', files: ['sess-1.jsonl'],
      sessions, now, withinWindow: () => true,
      makeManager: () => manager, warn,
    });

    expect(warn).toHaveBeenCalledWith('ws/sess-1', expect.any(Error));
    expect(changed).toBe(true);
    expect(sessions.has('ws/sess-1')).toBe(true);
    cleanup();
  });

  // ── PR D: replay-cache hydration ────────────────────────────────
  describe('replay-cache hydration', () => {
    afterEach(() => { vi.restoreAllMocks(); }); // JsonlTailer.prototype spy below

    function fakeStore(entries: Map<string, ReplayCacheEntry>): ReplayCacheStore {
      return {
        load: async () => {},
        get: (p: string) => entries.get(p),
        put: () => {},
        flush: async () => {},
      };
    }

    function minimalState(sessionId: string, overrides: Partial<CachedSessionState> = {}): CachedSessionState {
      return {
        sessionId, slug: sessionId, workspaceKey: 'ws',
        cwd: '/test/ws', initialCwd: '/test/ws',
        topic: 'cached', activity: 'Idle', status: 'done',
        lastActivity: Date.now() - 1000, firstActivity: Date.now() - 1000,
        enqueuedAt: 0, contextTokens: 0, modelId: '', modelConfirmed: false,
        customTitle: '', aiTitle: '', userTurnCount: 1, subagents: [],
        ...overrides,
      };
    }

    it('hydrates via makeHydrated when eligible, and never reads the file (skips update())', async () => {
      const { wsPath, sessions, cleanup } = setup();
      const now = Date.now();
      const filePath = path.join(wsPath, 'hyd-1.jsonl');
      fs.writeFileSync(filePath, jsonlLine('hyd-1', now));
      const stat = fs.statSync(filePath);
      const entries = new Map<string, ReplayCacheEntry>([
        [filePath, { size: stat.size, mtimeMs: stat.mtimeMs, cachedAt: now, state: minimalState('hyd-1') }],
      ]);
      const makeManager = vi.fn((sessionId: string, fp: string) => new SessionManager(sessionId, fp, 'ws'));
      const readSpy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords');

      const changed = await trackJsonlSessions({
        wsPath, workspaceKey: 'ws', files: ['hyd-1.jsonl'],
        sessions, now, withinWindow: () => true,
        makeManager, warn: () => {},
        replayCache: fakeStore(entries),
        livenessOf: () => false,
        makeHydrated: (sessionId, fp, state, stamp) => SessionManager.fromCache(sessionId, fp, 'ws', {}, state, stamp),
      });

      expect(changed).toBe(true);
      expect(makeManager).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      const manager = sessions.get('ws/hyd-1');
      expect(manager?.isHydrated()).toBe(true);
      cleanup();
    });

    it('still re-gates on the restored (cached) lastActivity, not the file mtime — evicts a hydrated session already outside the window', async () => {
      const { wsPath, sessions, cleanup } = setup();
      const now = Date.now();
      const filePath = path.join(wsPath, 'hyd-2.jsonl');
      fs.writeFileSync(filePath, jsonlLine('hyd-2', now)); // fresh on-disk mtime
      const stat = fs.statSync(filePath);
      const oldActivity = now - 60 * 60 * 1000; // 1h old — restored via hydrate()
      const entries = new Map<string, ReplayCacheEntry>([
        [filePath, {
          size: stat.size, mtimeMs: stat.mtimeMs, cachedAt: now,
          state: minimalState('hyd-2', { lastActivity: oldActivity, firstActivity: oldActivity }),
        }],
      ]);

      const changed = await trackJsonlSessions({
        wsPath, workspaceKey: 'ws', files: ['hyd-2.jsonl'],
        sessions, now,
        // Admits the file's fresh mtime but rejects the restored (1h-old)
        // activity — proving the re-gate reads the HYDRATED lastActivity.
        withinWindow: (_id, lastActivityMs) => now - lastActivityMs < 30 * 60 * 1000,
        makeManager: (sessionId, fp) => new SessionManager(sessionId, fp, 'ws'),
        warn: () => {},
        replayCache: fakeStore(entries),
        livenessOf: () => false,
        makeHydrated: (sessionId, fp, state, stamp) => SessionManager.fromCache(sessionId, fp, 'ws', {}, state, stamp),
      });

      expect(changed).toBe(false);
      expect(sessions.size).toBe(0);
      cleanup();
    });

    it('falls through to an ordinary replay when the registry confirms the session is live right now', async () => {
      const { wsPath, sessions, cleanup } = setup();
      const now = Date.now();
      const filePath = path.join(wsPath, 'hyd-3.jsonl');
      fs.writeFileSync(filePath, jsonlLine('hyd-3', now));
      const stat = fs.statSync(filePath);
      const entries = new Map<string, ReplayCacheEntry>([
        [filePath, { size: stat.size, mtimeMs: stat.mtimeMs, cachedAt: now, state: minimalState('hyd-3') }],
      ]);
      const makeManager = vi.fn((sessionId: string, fp: string) => new SessionManager(sessionId, fp, 'ws'));

      const changed = await trackJsonlSessions({
        wsPath, workspaceKey: 'ws', files: ['hyd-3.jsonl'],
        sessions, now, withinWindow: () => true,
        makeManager, warn: () => {},
        replayCache: fakeStore(entries),
        livenessOf: () => true, // confirmed live — isHydratable() must refuse
        makeHydrated: (sessionId, fp, state, stamp) => SessionManager.fromCache(sessionId, fp, 'ws', {}, state, stamp),
      });

      expect(changed).toBe(true);
      expect(makeManager).toHaveBeenCalledTimes(1);
      const manager = sessions.get('ws/hyd-3');
      expect(manager?.isHydrated()).toBe(false);
      cleanup();
    });

    it('replays ordinarily when replayCache/makeHydrated are omitted entirely (kill switch off)', async () => {
      const { wsPath, sessions, cleanup } = setup();
      const now = Date.now();
      const filePath = path.join(wsPath, 'hyd-4.jsonl');
      fs.writeFileSync(filePath, jsonlLine('hyd-4', now));
      const makeManager = vi.fn((sessionId: string, fp: string) => new SessionManager(sessionId, fp, 'ws'));

      const changed = await trackJsonlSessions({
        wsPath, workspaceKey: 'ws', files: ['hyd-4.jsonl'],
        sessions, now, withinWindow: () => true,
        makeManager, warn: () => {},
        // replayCache/livenessOf/makeHydrated all omitted.
      });

      expect(changed).toBe(true);
      expect(makeManager).toHaveBeenCalledTimes(1);
      cleanup();
    });
  });
});
