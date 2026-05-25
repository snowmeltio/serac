import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JsonlDerivedSubagentLifecycleTracker,
  makeSubagentLifecycleTracker,
  type SubagentLifecycleTrackerHost,
} from './subagentLifecycleTracker.js';
import type { SubagentInfo } from '../types.js';
import { HookEventRouter } from '../hookEventRouter.js';

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

describe('SubagentLifecycleTracker (hook overlay)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const SID = 'parent-session-uuid';

  it('SubagentStop with matching agent_id calls onComplete via fallback', () => {
    const sub = makeSubagent({ agentId: 'agent-xyz' });
    const host = makeHost({ allSubagents: [sub] });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-xyz', agent_type: 'general-purpose' });
    expect(sub.silenceTimerId).toBeUndefined();
    expect(sub.agentId).toBeNull();   // onComplete clears it
  });

  it('SubagentStop with no agent_id is ignored', () => {
    const sub = makeSubagent({ agentId: 'agent-abc' });
    const host = makeHost({ allSubagents: [sub] });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
    t.onSpawn(sub);
    router.onHookEvent(SID, 'SubagentStop', { agent_type: 'general-purpose' });
    expect(sub.silenceTimerId).toBeDefined();   // unchanged
  });

  it('SubagentStop for unknown agent_id (not in subagents list) is a no-op', () => {
    const sub = makeSubagent({ agentId: 'agent-known' });
    const host = makeHost({ allSubagents: [sub] });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
    t.onSpawn(sub);
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-unknown' });
    expect(sub.silenceTimerId).toBeDefined();   // unchanged
  });

  it('phantom SubagentStop (agent_type === "") is filtered at the router and never fires', () => {
    const sub = makeSubagent({ agentId: 'agent-real' });
    const host = makeHost({ allSubagents: [sub] });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
    t.onSpawn(sub);
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-real', agent_type: '' });
    expect(sub.silenceTimerId).toBeDefined();   // unchanged — filtered phantom
  });

  it('SubagentStop for other sessions is ignored', () => {
    const sub = makeSubagent({ agentId: 'agent-x' });
    const host = makeHost({ allSubagents: [sub] });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
    t.onSpawn(sub);
    router.onHookEvent('different-session', 'SubagentStop', { agent_id: 'agent-x', agent_type: 'general-purpose' });
    expect(sub.silenceTimerId).toBeDefined();   // unchanged
  });

  it('delegates onSpawn/onProgress/onComplete unchanged to the JSONL fallback', () => {
    const sub = makeSubagent();
    const host = makeHost({ allSubagents: [sub] });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
    t.onProgress(sub);
    expect(sub.silenceTimerId).toBeUndefined();
  });

  it('factory without sessionId returns the JSONL-only variant (no hook subscription)', () => {
    const sub = makeSubagent({ agentId: 'agent-x' });
    const host = makeHost({ allSubagents: [sub] });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(host, { hookRouter: router });   // no sessionId
    t.onSpawn(sub);
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-x', agent_type: 'general-purpose' });
    // Hook would have cleared silenceTimerId, but the JSONL-only variant
    // didn't subscribe — timer is still in place.
    expect(sub.silenceTimerId).toBeDefined();
  });
});
