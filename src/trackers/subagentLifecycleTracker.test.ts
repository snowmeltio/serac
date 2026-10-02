import { describe, it, expect, vi } from 'vitest';
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
    progressRelayed: false,
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

/** Give a subagent an open tailer through the public revive path (preopened
 *  adoption is synchronous). Requires an agentId. Returns the mock tailer. */
function attachTailer(t: { onRevive(s: SubagentInfo, p?: any): void }, sub: SubagentInfo): unknown {
  const tailer = { readNewRecords: vi.fn().mockResolvedValue([]), getFilePath: () => '/tmp/a.jsonl' } as any;
  t.onRevive(sub, tailer);
  return tailer;
}

describe('JsonlDerivedSubagentLifecycleTracker', () => {
  it('onSpawn arms nothing: no tailer until the next pollDirect', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent();
    t.onSpawn(sub);
    expect(sub.tailer).toBeNull();
    expect(t.getActiveTailerCount()).toBe(0);
    expect(t.needsPoll([sub])).toBe(true);
  });

  it('onProgress releases the tailer and suppresses reopening', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    attachTailer(t, sub);
    expect(t.getActiveTailerCount()).toBe(1);
    t.onProgress(sub);
    expect(sub.tailer).toBeNull();
    expect(sub.progressRelayed).toBe(true);
    expect(t.getActiveTailerCount()).toBe(0);
    expect(t.needsPoll([sub])).toBe(false);
  });

  it('onComplete releases the tailer but PRESERVES agentId', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    attachTailer(t, sub);
    t.onComplete(sub);
    expect(sub.tailer).toBeNull();
    expect(t.getActiveTailerCount()).toBe(0);
    // agentId is kept so a completed subagent stays resolvable in the drill-in;
    // it is only cleared on disposeAll (session teardown).
    expect(sub.agentId).toBe('abc');
  });

  it('releaseTailer releases the tailer but PRESERVES agentId', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    attachTailer(t, sub);
    t.releaseTailer(sub);
    expect(sub.tailer).toBeNull();
    expect(sub.agentId).toBe('abc');
  });

  it('pollDirect returns empty when no subagent file exists to tail', async () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const batches = await t.pollDirect([makeSubagent()]);
    expect(batches).toEqual([]);
  });

  it('disposeAll clears tailers and agentIds on each subagent', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const a = makeSubagent({ parentToolUseId: 'tu-a', agentId: 'aid-a' });
    const b = makeSubagent({ parentToolUseId: 'tu-b', agentId: 'aid-b' });
    attachTailer(t, a);
    attachTailer(t, b);
    expect(t.getActiveTailerCount()).toBe(2);
    t.disposeAll([a, b]);
    expect(a.tailer).toBeNull();
    expect(b.tailer).toBeNull();
    expect(a.agentId).toBeNull();
    expect(b.agentId).toBeNull();
    expect(t.getActiveTailerCount()).toBe(0);
  });

  it('factory returns a working JSONL-derived tracker', () => {
    const t = makeSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    attachTailer(t, sub);
    t.onComplete(sub);
    expect(sub.tailer).toBeNull();
  });
});

describe('SubagentLifecycleTracker (hook overlay)', () => {
  const SID = 'parent-session-uuid';

  function setup(agentId: string, opts: { sessionId?: string } = { sessionId: SID }) {
    const sub = makeSubagent({ agentId });
    const router = new HookEventRouter();
    const t = makeSubagentLifecycleTracker(makeHost({ allSubagents: [sub] }), { hookRouter: router, sessionId: opts.sessionId });
    attachTailer(t, sub);
    return { sub, router, t };
  }

  it('SubagentStop with matching agent_id calls onComplete via fallback', () => {
    const { sub, router } = setup('agent-xyz');
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-xyz', agent_type: 'general-purpose' });
    // Tailer released proves onComplete fired; agentId is preserved (only
    // disposeAll clears it), so a completed subagent stays resolvable.
    expect(sub.tailer).toBeNull();
    expect(sub.agentId).toBe('agent-xyz');
  });

  it('SubagentStop with no agent_id is ignored', () => {
    const { sub, router } = setup('agent-abc');
    router.onHookEvent(SID, 'SubagentStop', { agent_type: 'general-purpose' });
    expect(sub.tailer).not.toBeNull();   // unchanged
  });

  it('SubagentStop for unknown agent_id (not in subagents list) is a no-op', () => {
    const { sub, router } = setup('agent-known');
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-unknown' });
    expect(sub.tailer).not.toBeNull();   // unchanged
  });

  it('phantom SubagentStop (agent_type === "") is filtered at the router and never fires', () => {
    const { sub, router } = setup('agent-real');
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-real', agent_type: '' });
    expect(sub.tailer).not.toBeNull();   // unchanged — filtered phantom
  });

  it('SubagentStop for other sessions is ignored', () => {
    const { sub, router } = setup('agent-x');
    router.onHookEvent('different-session', 'SubagentStop', { agent_id: 'agent-x', agent_type: 'general-purpose' });
    expect(sub.tailer).not.toBeNull();   // unchanged
  });

  it('delegates onProgress unchanged to the JSONL fallback', () => {
    const { sub, t } = setup('agent-p');
    t.onProgress(sub);
    expect(sub.tailer).toBeNull();
    expect(sub.progressRelayed).toBe(true);
  });

  it('factory without sessionId returns the JSONL-only variant (no hook subscription)', () => {
    const { sub, router } = setup('agent-x', {});
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-x', agent_type: 'general-purpose' });
    // The hook would have released the tailer, but the JSONL-only variant
    // didn't subscribe — the tailer is still in place.
    expect(sub.tailer).not.toBeNull();
  });
});

describe('revival (onRevive + late SubagentStop)', () => {
  const SID = 'parent-session-uuid';

  it('onRevive reopens the tailer at completedFileSize', async () => {
    vi.useRealTimers();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-lifecycle-'));
    try {
      const sessionFile = path.join(tmpRoot, 'session.jsonl');
      const agentFile = path.join(tmpRoot, 'session', 'subagents', 'agent-rev.jsonl');
      fs.mkdirSync(path.dirname(agentFile), { recursive: true });
      fs.writeFileSync(agentFile, 'x'.repeat(49) + '\n');
      const sub = makeSubagent({ agentId: 'rev', completedFileSize: 30 });
      const t = new JsonlDerivedSubagentLifecycleTracker(makeHost({ sessionFilePath: sessionFile, allSubagents: [sub] }));
      t.onRevive(sub);
      // The reopen awaits a real fs.stat; a fixed tick count raced it under
      // full-suite load, so wait for the tailer instead.
      await vi.waitFor(() => expect(t.getActiveTailerCount()).toBe(1));
      expect(sub.tailer!.getOffset()).toBe(30);
      t.disposeAll([sub]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('hook overlay: a late SubagentStop for a subagent that is NOT running is a no-op', () => {
    vi.useFakeTimers();
    try {
      const sub = makeSubagent({ agentId: 'agent-late' });
      const host = makeHost({ allSubagents: [sub] });
      const router = new HookEventRouter();
      const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
      attachTailer(t, sub);
      sub.running = false; // a tailer a real stop would release
      router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-late', agent_type: 'general-purpose' });
      expect(sub.tailer).not.toBeNull();
      t.disposeAll([sub]);
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hook overlay: SubagentStop on a running subagent still releases its tailer', () => {
    vi.useFakeTimers();
    try {
      const sub = makeSubagent({ agentId: 'agent-live', running: true });
      const host = makeHost({ allSubagents: [sub] });
      const router = new HookEventRouter();
      const t = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
      attachTailer(t, sub);
      router.onHookEvent(SID, 'SubagentStop', { agent_id: 'agent-live', agent_type: 'general-purpose' });
      expect(sub.tailer).toBeNull();
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
