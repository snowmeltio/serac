/**
 * Bubble policy test — exercises the 13-line closure at the subagent spawn site
 * in sessionManager.ts that bubbles "Subagent waiting for permission" up to the
 * parent session ONLY when *all* running subagents are blocked.
 *
 * Pre-PermissionTracker, this logic lived in `resetSubagentPermissionTimer`.
 * Post-extraction, it's a closure passed as `onWaitingFired` to each subagent's
 * PermissionTracker. The unit tests for the tracker prove the tracker fires;
 * these tests prove the bubble-vs-no-bubble decision at the host level still
 * matches pre-refactor behaviour.
 *
 * Closes a gap surfaced by red-team review of PR #5: the 17 new tracker tests
 * cover the tracker in isolation, but the bubble-policy seam had no dedicated
 * coverage. A regression here (e.g. condition flipped, status check wrong)
 * would have been missed by tracker tests and easy to miss in sidechain tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';

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

function makeManager(): InstanceType<typeof SessionManager> {
  return new SessionManager('test-session-id', '/tmp/test.jsonl', 'test-workspace');
}

async function feed(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

function user(text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
}

function spawnAgent(toolId: string, description: string = 'worker'): JsonlRecord {
  return {
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: 'Agent', id: toolId, input: { description } }] },
  };
}

function sidechainToolUse(toolName: string, toolId: string, parentToolUseID: string): JsonlRecord {
  return {
    type: 'assistant', isSidechain: true, parentToolUseID,
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: toolName, id: toolId }] },
  };
}

function sidechainToolResult(toolUseId: string, parentToolUseID: string): JsonlRecord {
  return {
    type: 'user', isSidechain: true, parentToolUseID,
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  };
}

describe('Bubble policy: subagent permission wait → parent session', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('single blocked subagent bubbles to parent (status → waiting)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1')]);
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-1')]);

    vi.advanceTimersByTime(3_001);  // PERMISSION_DELAY_MS + 1ms

    const snap = mgr.getSnapshot();
    expect(snap.subagents[0].waitingOnPermission).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
    expect(snap.activity).toContain('Subagent waiting for permission');
  });

  it('one blocked, one still running → parent stays running (no bubble)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1'), spawnAgent('agent-2')]);
    expect(mgr.getSnapshot().subagents).toHaveLength(2);

    // Agent 1 blocks on a tool; agent 2 stays idle (no tool yet)
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-1')]);
    vi.advanceTimersByTime(3_001);

    const snap = mgr.getSnapshot();
    const a1 = snap.subagents.find(s => s.parentToolUseId === 'agent-1');
    const a2 = snap.subagents.find(s => s.parentToolUseId === 'agent-2');
    expect(a1?.waitingOnPermission).toBe(true);
    expect(a2?.waitingOnPermission).toBe(false);
    // Parent NOT yet bubbled — agent-2 still running and unblocked
    expect(mgr.getStatus()).toBe('running');
  });

  it('all running subagents blocked → parent bubbles to waiting', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1'), spawnAgent('agent-2')]);

    // Both subagents block on tools
    await feed(mgr, [
      sidechainToolUse('SomeTool', 'sc-1', 'agent-1'),
      sidechainToolUse('SomeTool', 'sc-2', 'agent-2'),
    ]);
    vi.advanceTimersByTime(3_001);

    const snap = mgr.getSnapshot();
    expect(snap.subagents.every(s => s.waitingOnPermission)).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
    expect(snap.activity).toContain('Subagent waiting for permission');
  });

  it('blocked subagent unblocks → parent does not get stuck waiting', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1')]);
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-1')]);
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');

    // Tool result arrives — subagent unblocks
    await feed(mgr, [sidechainToolResult('sc-1', 'agent-1')]);
    expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('exempt tool (Read) on a subagent never triggers bubble', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1')]);
    await feed(mgr, [sidechainToolUse('Read', 'sc-1', 'agent-1')]);

    // Even after a long wait, exempt tools don't fire the timer
    vi.advanceTimersByTime(20_000);

    expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('completed subagent does not count toward "all blocked"', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1'), spawnAgent('agent-2')]);

    // Agent 2 completes; agent 1 still spinning, then blocks on permission.
    await feed(mgr, [{
      type: 'user', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent-2' }] },
    }]);
    expect(mgr.getSnapshot().subagents.find(s => s.parentToolUseId === 'agent-2')?.running).toBe(false);

    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-1')]);
    vi.advanceTimersByTime(3_001);

    // Agent 1 is the only running subagent AND it's blocked — bubble.
    expect(mgr.getSnapshot().subagents.find(s => s.parentToolUseId === 'agent-1')?.waitingOnPermission).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
  });
});
