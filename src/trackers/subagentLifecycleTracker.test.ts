import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JsonlDerivedSubagentLifecycleTracker,
  makeSubagentLifecycleTracker,
  type SubagentLifecycleTrackerHost,
} from './subagentLifecycleTracker.js';
import type { SubagentInfo } from '../types.js';
import { HookEventRouter } from '../hookEventRouter.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    parentToolUseId: 'tu1',
    description: 'test',
    running: true,
    waitingOnPermission: false,
    lastActivity: new Date(),
    activeTools: new Map(),
    permissionTracker: { reschedule: () => {}, cancel: () => {}, dispose: () => {} },
    acknowledged: false,
    tailer: null,
    silenceTimerId: undefined,
    agentId: null,
    startedAt: new Date(),
    resultPreview: null,
    toolsCompleted: 0,
    background: false,
    revivalCount: 0,
    completedFileSize: null,
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

  it('onComplete releases the silence timer but PRESERVES agentId', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    t.onSpawn(sub);
    t.onComplete(sub);
    expect(sub.silenceTimerId).toBeUndefined();
    // agentId is kept so a completed subagent stays resolvable in the drill-in;
    // it is only cleared on disposeAll (session teardown).
    expect(sub.agentId).toBe('abc');
  });

  it('disposeTailerAndTimer releases the silence timer but PRESERVES agentId', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    t.onSpawn(sub);
    t.disposeTailerAndTimer(sub);
    expect(sub.silenceTimerId).toBeUndefined();
    expect(sub.agentId).toBe('abc');
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
    // Silence timer cleared proves onComplete fired; agentId is now preserved
    // (only disposeAll clears it), so a completed subagent stays resolvable.
    expect(sub.silenceTimerId).toBeUndefined();
    expect(sub.agentId).toBe('agent-xyz');
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

describe('revival (onRevive + late SubagentStop)', () => {
  const SID = 'parent-session-uuid';

  it('onRevive cancels the silence timer and reopens the tailer at completedFileSize', async () => {
    vi.useRealTimers();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-lifecycle-'));
    try {
      const sessionFile = path.join(tmpRoot, 'session.jsonl');
      const agentFile = path.join(tmpRoot, 'session', 'subagents', 'agent-rev.jsonl');
      fs.mkdirSync(path.dirname(agentFile), { recursive: true });
      fs.writeFileSync(agentFile, 'x'.repeat(49) + '\n');
      const sub = makeSubagent({ agentId: 'rev', completedFileSize: 30 });
      const t = new JsonlDerivedSubagentLifecycleTracker(makeHost({ sessionFilePath: sessionFile, allSubagents: [sub] }));
      t.onSpawn(sub);
      expect(sub.silenceTimerId).toBeDefined();
      t.onRevive(sub);
      expect(sub.silenceTimerId).toBeUndefined();
      for (let i = 0; i < 3; i++) { await new Promise(r => setImmediate(r)); }
      expect(t.getActiveTailerCount()).toBe(1);
      expect(sub.tailer!.getOffset()).toBe(30);
      t.disposeAll([sub]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('hook overlay: a late SubagentStop for a subagent that is NOT running is a no-op', () => {
    vi.useFakeTimers();
    try {
      const sub = makeSubagent({ agentId: 'agent-late', running: false });
      sub.silenceTimerId = setTimeout(() => {}, 100_000); // a live timer that a real stop would clear
      const host = makeHost({ allSubagents: [sub] });
      const router = new HookEventRouter();
      const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
      router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-late', agent_type: 'general-purpose' });
      expect(sub.silenceTimerId).toBeDefined();
      clearTimeout(sub.silenceTimerId);
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hook overlay: SubagentStop on a running subagent still tears its timer down', () => {
    vi.useFakeTimers();
    try {
      const sub = makeSubagent({ agentId: 'agent-live', running: true });
      const host = makeHost({ allSubagents: [sub] });
      const router = new HookEventRouter();
      const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
      t.onSpawn(sub);
      expect(sub.silenceTimerId).toBeDefined();
      router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-live', agent_type: 'general-purpose' });
      expect(sub.silenceTimerId).toBeUndefined();
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hook overlay delegates onRevive (preopened adoption) to the JSONL fallback', () => {
    const sub = makeSubagent({ agentId: 'agent-x' });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(makeHost({ allSubagents: [sub] }), { hookRouter: router, sessionId: SID });
    const preopened = { readNewRecords: vi.fn().mockResolvedValue([]), getFilePath: () => '/tmp/a.jsonl' } as any;
    t.onRevive(sub, preopened);
    expect(sub.tailer).toBe(preopened);
    expect(t.getActiveTailerCount()).toBe(1);
    t.disposeAll([sub]);
    t.dispose();
  });
});
