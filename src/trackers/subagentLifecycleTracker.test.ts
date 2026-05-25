import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JsonlDerivedSubagentLifecycleTracker,
  makeSubagentLifecycleTracker,
  type SubagentLifecycleTrackerHost,
} from './subagentLifecycleTracker.js';
import type { SubagentInfo } from '../types.js';

function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    parentToolUseId: 'tu1',
    description: 'test',
    running: true,
    waitingOnPermission: false,
    lastActivity: new Date(),
    activeTools: new Map(),
    permissionTracker: undefined,
    acknowledged: false,
    tailer: null,
    silenceTimerId: undefined,
    agentId: null,
    startedAt: new Date(),
    resultPreview: null,
    toolsCompleted: 0,
    ...overrides,
  };
}

function makeHost(opts: {
  sessionFilePath?: string;
  allSubagents?: SubagentInfo[];
} = {}): SubagentLifecycleTrackerHost {
  return {
    isDisposed: () => false,
    getSessionFilePath: () => opts.sessionFilePath ?? '/tmp/session.jsonl',
    getAllSubagents: () => opts.allSubagents ?? [],
  };
}

describe('JsonlDerivedSubagentLifecycleTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('onSpawn starts a silence timer on the subagent', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent();
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
  });

  it('onProgress cancels silence timer (no tailer to dispose)', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent();
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
    t.onProgress(sub);
    expect(sub.silenceTimerId).toBeUndefined();
  });

  it('onComplete releases agentId and silence timer', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    t.onSpawn(sub);
    t.onComplete(sub);
    expect(sub.silenceTimerId).toBeUndefined();
    expect(sub.agentId).toBeNull();
  });

  it('getActiveTailerCount starts at 0 and stays 0 with no progress-silent subagents', async () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    expect(t.getActiveTailerCount()).toBe(0);
    const sub = makeSubagent();
    t.onSpawn(sub);
    // Silence timer scheduled but not yet fired
    expect(t.getActiveTailerCount()).toBe(0);
  });

  it('pollDirect returns empty when no subagents have tailers', async () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const batches = await t.pollDirect([makeSubagent()]);
    expect(batches).toEqual([]);
  });

  it('disposeAll clears silence timers and agentIds on each subagent', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const a = makeSubagent({ parentToolUseId: 'tu-a', agentId: 'aid-a' });
    const b = makeSubagent({ parentToolUseId: 'tu-b', agentId: 'aid-b' });
    t.onSpawn(a);
    t.onSpawn(b);
    expect(a.silenceTimerId).toBeDefined();
    expect(b.silenceTimerId).toBeDefined();
    t.disposeAll([a, b]);
    expect(a.silenceTimerId).toBeUndefined();
    expect(b.silenceTimerId).toBeUndefined();
    expect(a.agentId).toBeNull();
    expect(b.agentId).toBeNull();
    expect(t.getActiveTailerCount()).toBe(0);
  });

  it('factory returns a working JSONL-derived tracker', () => {
    const t = makeSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent();
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
    t.onComplete(sub);
    expect(sub.silenceTimerId).toBeUndefined();
  });
});
