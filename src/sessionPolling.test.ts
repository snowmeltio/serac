import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  jsonlSessionId,
  makeRescanGate,
  pollTrackedSessions,
  hasActiveTrackedSessions,
  trackJsonlSessions,
  type PollableSession,
} from './sessionPolling.js';
import { SessionManager } from './sessionManager.js';

function fakeSession(overrides: Partial<PollableSession> = {}): PollableSession {
  return {
    getStatus: () => 'done',
    getLastActivity: () => new Date(0),
    checkMtime: async () => false,
    update: async () => false,
    demoteIfStale: () => false,
    sweepBackgroundWork: () => false,
    dispose: vi.fn(),
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
});
