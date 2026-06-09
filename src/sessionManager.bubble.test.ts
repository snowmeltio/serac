/**
 * Permission-wait integration tests for SessionManager.
 *
 * Originally added (file name "bubble") to close a /red-team gap on the
 * subagent bubble closure. Persona-panel review surfaced two more end-to-end
 * gaps: the session-level "Waiting for permission" closure had no dedicated
 * coverage, and the MCP-progress-reset path (chatty MCP tools that prevent
 * premature firing) was untested. Both groups live here now.
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

function sessionToolUse(toolName: string, toolId: string): JsonlRecord {
  return {
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: toolName, id: toolId }] },
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

function mcpProgress(): JsonlRecord {
  return { type: 'progress', timestamp: new Date().toISOString(), data: { type: 'mcp_progress' } };
}

// ─────────────────────────────────────────────────────────────────────────
// Subagent bubble policy — the /red-team-flagged seam
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// Session-level "Waiting for permission" closure — persona-panel gap (Sam)
// ─────────────────────────────────────────────────────────────────────────

describe('Session-level permission wait', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('session-level permission fire transitions running → waiting + appends activity', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    // Parent session uses a non-exempt, non-slow tool directly (no subagent).
    await feed(mgr, [sessionToolUse('SomeTool', 'tu-session-1')]);
    expect(mgr.getStatus()).toBe('running');

    vi.advanceTimersByTime(3_001);  // PERMISSION_DELAY_MS + 1ms

    const snap = mgr.getSnapshot();
    expect(mgr.getStatus()).toBe('waiting');
    expect(snap.activity).toContain('Waiting for permission');
  });

  it('session-level fire does not occur when only exempt tools are active', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [sessionToolUse('Read', 'tu-r')]);
    vi.advanceTimersByTime(20_000);
    expect(mgr.getStatus()).not.toBe('waiting');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MCP progress reset regression — persona-panel gap (Sam)
//
// A chatty MCP tool emitting sub-6s `mcp_progress` events resets the
// permission timer each tick. This pins the behaviour both ways: progress
// arriving within the window prevents premature fire, and once it stops,
// the timer eventually does fire.
// ─────────────────────────────────────────────────────────────────────────

describe('MCP progress reset', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('mcp_progress within the slow window keeps timer pending (no premature fire)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [sessionToolUse('mcp__slack__post_message', 'tu-mcp')]);
    expect(mgr.getStatus()).toBe('running');

    // Tick a progress every 2s for 10s — past both the base (3s) and slow (6s)
    // permission delays. Without progress resets, the timer would fire at 6s.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2_000);
      await feed(mgr, [mcpProgress()]);
    }

    expect(mgr.getStatus()).toBe('running');
  });

  it('mcp_progress stops arriving → permission timer eventually fires', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [sessionToolUse('mcp__slack__post_message', 'tu-mcp')]);

    // One progress, then silence.
    vi.advanceTimersByTime(1_000);
    await feed(mgr, [mcpProgress()]);
    // From the last progress, the slow delay (15s) must elapse with no further
    // events for the indicator to fire.
    vi.advanceTimersByTime(15_001);

    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toContain('Waiting for permission');
  });
});
