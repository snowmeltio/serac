import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';

// Mock JsonlTailer so we can feed records without files.
let mockRecords: JsonlRecord[] = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    async readNewRecords() {
      const r = mockRecords;
      mockRecords = [];
      return r;
    }
  },
}));

const { SessionManager } = await import('./sessionManager.js');

// A mutable tri-state probe the tests flip to simulate the registry:
// true = live, false = registry active but session gone, null = registry inactive.
let probeValue: boolean | null;

function makeManager(): InstanceType<typeof SessionManager> {
  return new SessionManager('sess-live', '/tmp/test.jsonl', 'ws', {
    livenessProbe: () => probeValue,
  });
}

async function feed(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

function userRecord(text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
}

function toolUse(name: string, id: string): JsonlRecord {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name, id, input: {} }] } };
}

/** Drive a manager to 'waiting' via an AskUserQuestion tool_use. */
async function toWaiting(mgr: InstanceType<typeof SessionManager>): Promise<void> {
  await feed(mgr, [userRecord('do something')]);
  await feed(mgr, [toolUse('AskUserQuestion', 'ask-1')]);
  expect(mgr.getStatus()).toBe('waiting');
  expect(mgr.getSnapshot().activity).toBe('Waiting for your response');
}

beforeEach(() => {
  vi.useFakeTimers();
  probeValue = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionManager — registry liveness gate (permission false-positive)', () => {
  it('resolves a waiting session to done once its process is registry-confirmed dead', async () => {
    const mgr = makeManager();
    await toWaiting(mgr);

    // First demote with the process still live: latches "seen live", no change.
    probeValue = true;
    expect(mgr.demoteIfStale(30_000)).toBe(false);
    expect(mgr.getStatus()).toBe('waiting');

    // Process exits → registry drops it → next demote resolves to done at once
    // (no 10-min ceiling wait) and clears the stale "Waiting…" subtitle.
    probeValue = false;
    expect(mgr.demoteIfStale(30_000)).toBe(true);
    expect(mgr.getStatus()).toBe('done');
    expect(mgr.getSnapshot().activity).not.toBe('Waiting for your response');
  });

  it('does NOT downgrade a waiting session never seen live in the registry', async () => {
    // Registry is active but never had an entry for this session (e.g. a class
    // it does not track) → absence is "unknown", never "dead". Probe must be
    // false BEFORE any snapshot renders: getSnapshot() itself latches seen-live
    // now (processLive shares the death-gate latch).
    probeValue = false;
    const mgr = makeManager();
    await toWaiting(mgr);

    expect(mgr.demoteIfStale(30_000)).toBe(false);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('is a no-op when the registry is inactive (probe returns null)', async () => {
    const mgr = makeManager();
    await toWaiting(mgr);

    probeValue = null; // registry not in use on this machine/build
    expect(mgr.demoteIfStale(30_000)).toBe(false);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('does NOT demote a seen-live waiting session when a later scan is degraded (probe null)', async () => {
    // Safety-invariant regression: even after the session was observed live, a
    // degraded registry scan surfaces as null (unknown), never false — so a
    // transient disk error can't be misread as the process dying.
    const mgr = makeManager();
    await toWaiting(mgr);

    probeValue = true;
    mgr.demoteIfStale(30_000);            // latch "seen live"
    expect(mgr.getStatus()).toBe('waiting');

    probeValue = null;                    // degraded scan → unknown, not dead
    expect(mgr.demoteIfStale(30_000)).toBe(false);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('leaves a still-live waiting session untouched', async () => {
    const mgr = makeManager();
    await toWaiting(mgr);

    probeValue = true;
    expect(mgr.demoteIfStale(30_000)).toBe(false);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('resolves a running session to done when its process is confirmed dead', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    await feed(mgr, [toolUse('Bash', 'b-1')]);
    expect(mgr.getStatus()).toBe('running');

    probeValue = true;
    mgr.demoteIfStale(30_000);            // latch "seen live"
    expect(mgr.getStatus()).toBe('running');

    probeValue = false;
    expect(mgr.demoteIfStale(30_000)).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });

  it('permission timer does not flip a confirmed-dead session to waiting', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    await feed(mgr, [toolUse('SomeTool', 't-1')]); // arms the 3s permission timer
    expect(mgr.getStatus()).toBe('running');

    probeValue = true;
    mgr.demoteIfStale(30_000);            // latch "seen live", stays running
    expect(mgr.getStatus()).toBe('running');

    // Process dies, then the permission timer fires: the guard suppresses the
    // false 'waiting' (demoteIfStale will resolve it to done instead).
    probeValue = false;
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('running');
  });

  it('permission timer still fires for a live session (control)', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    await feed(mgr, [toolUse('SomeTool', 't-1')]);
    probeValue = true;
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');
  });
});

describe('SessionSnapshot.processLive — orphan/live annotation tri-state', () => {
  it('reports true while the registry sees the process live', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    probeValue = true;
    expect(mgr.getSnapshot().processLive).toBe(true);
  });

  it('reports undefined for an absent-but-never-seen session (no false "ended")', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    probeValue = false;            // registry active, session never registered
    expect(mgr.getSnapshot().processLive).toBeUndefined();
  });

  it('reports false only after seen-live → gone (confirmed ended)', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    probeValue = true;
    expect(mgr.getSnapshot().processLive).toBe(true);   // latches seen-live
    probeValue = false;
    expect(mgr.getSnapshot().processLive).toBe(false);
  });

  it('reports undefined on a degraded scan, even after seen-live', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    probeValue = true;
    mgr.getSnapshot();             // latch
    probeValue = null;             // degraded → unknown, never "ended"
    expect(mgr.getSnapshot().processLive).toBeUndefined();
  });

  it('reports undefined when no probe is wired at all', async () => {
    const mgr = new SessionManager('no-probe', '/tmp/np.jsonl', 'ws');
    await feed(mgr, [userRecord('go')]);
    expect(mgr.getSnapshot().processLive).toBeUndefined();
  });

  it('snapshot latch feeds the death-gate: getSnapshot alone arms later demotion', async () => {
    // The latch must be shared — seeing the process live during a snapshot
    // render is the same evidence demoteIfStale relies on.
    const mgr = makeManager();
    await toWaiting(mgr);
    probeValue = true;
    mgr.getSnapshot();             // latch via snapshot path, not demoteIfStale
    probeValue = false;
    expect(mgr.demoteIfStale(30_000)).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });
});
