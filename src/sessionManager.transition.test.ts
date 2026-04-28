/**
 * Transition coverage test for SessionManager.
 * Ensures every known record type/subtype produces a state change,
 * so new Claude Code record types can't silently fall through.
 *
 * This is the living spec counterpart to the state transition table
 * at the top of sessionManager.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

async function feedRecords(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

function ts(): string {
  return new Date().toISOString();
}

describe('Transition coverage: every known record type/subtype triggers a state change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  it('user record → running', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'hello' }] },
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('assistant record (text) → running', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'response' }] },
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('assistant record (tool_use) → running', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Read', id: 'tu1' }] },
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('assistant record (AskUserQuestion) → waiting', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'tu2' }] },
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('progress: agent_progress → true (resets permission timer)', async () => {
    const mgr = makeManager();
    // First set running with a tool
    await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'tu3', input: { description: 'test', prompt: 'test' } }] },
    }]);
    const changed = await feedRecords(mgr, [{
      type: 'progress', timestamp: ts(),
      data: { type: 'agent_progress' },
      parentToolUseID: 'tu3',
    }]);
    expect(changed).toBe(true);
  });

  it('progress: hook_progress → true', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Edit', id: 'tu4' }] },
    }]);
    const changed = await feedRecords(mgr, [{
      type: 'progress', timestamp: ts(),
      data: { type: 'hook_progress' },
    }]);
    expect(changed).toBe(true);
  });

  it('progress: bash_progress → true', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu5' }] },
    }]);
    const changed = await feedRecords(mgr, [{
      type: 'progress', timestamp: ts(),
      data: { type: 'bash_progress' },
    }]);
    expect(changed).toBe(true);
  });

  it('progress: mcp_progress → true', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'mcp__test', id: 'tu6' }] },
    }]);
    const changed = await feedRecords(mgr, [{
      type: 'progress', timestamp: ts(),
      data: { type: 'mcp_progress' },
    }]);
    expect(changed).toBe(true);
  });

  it('system: compact_boundary → running', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'system', subtype: 'compact_boundary', timestamp: ts(),
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('queue-operation: enqueue → done', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'queue-operation', operation: 'enqueue', timestamp: ts(),
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });

  it('queue-operation: dequeue → running', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'queue-operation', operation: 'dequeue', timestamp: ts(),
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('custom-title → true', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'custom-title', customTitle: 'My Session', timestamp: ts(),
    }]);
    expect(changed).toBe(true);
  });

  it('ai-title → true and surfaces on snapshot', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'ai-title', aiTitle: 'Build Service Architecture', timestamp: ts(),
    }]);
    expect(changed).toBe(true);
    expect(mgr.getSnapshot().aiTitle).toBe('Build Service Architecture');
  });

  it('queue-operation: remove → false (no state change)', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'queue-operation', operation: 'remove', timestamp: ts(),
    }]);
    expect(changed).toBe(false);
  });

  it('unknown record type → false (no state change)', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'summary', timestamp: ts(),
    }]);
    expect(changed).toBe(false);
  });

  it('unknown system subtype → false (no state change)', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'system', subtype: 'unknown_future_subtype', timestamp: ts(),
    }]);
    expect(changed).toBe(false);
  });

  it('unknown queue operation → false (no state change)', async () => {
    const mgr = makeManager();
    const changed = await feedRecords(mgr, [{
      type: 'queue-operation', operation: 'unknown_op', timestamp: ts(),
    }]);
    expect(changed).toBe(false);
  });
});

describe('Transition coverage: key state transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  it('done → running on new user message', async () => {
    const mgr = makeManager();
    // Get to done: user → assistant text → idle timer expires
    await feedRecords(mgr, [
      { type: 'user', timestamp: ts(), message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', timestamp: ts(), message: { content: [{ type: 'text', text: 'hello' }] } },
    ]);
    vi.advanceTimersByTime(31_000); // past 30s grace + 5s idle
    expect(mgr.getStatus()).toBe('done');

    // New user message resumes
    const changed = await feedRecords(mgr, [
      { type: 'user', timestamp: ts(), message: { content: [{ type: 'text', text: 'more' }] } },
    ]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('waiting → running on tool_result', async () => {
    const mgr = makeManager();
    // Get to waiting via AskUserQuestion
    await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'ask1' }] },
    }]);
    expect(mgr.getStatus()).toBe('waiting');

    // User provides tool_result
    const changed = await feedRecords(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'ask1' }] },
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('running → done via hard ceiling (demoteIfStale)', async () => {
    const mgr = makeManager();
    // Use a tool_use so activeTools is non-empty (prevents idle timer from marking done).
    // Use an exempt tool (Agent) so demoteIfStale doesn't take the waiting path.
    await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent1', input: { description: 'test', prompt: 'test' } }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Advance past hard ceiling (3 min). Idle timer won't fire because activeTools is non-empty.
    vi.advanceTimersByTime(200_000);
    const demoted = mgr.demoteIfStale(30_000);
    expect(demoted).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });

  it('waiting → done via waiting hard ceiling (10 min)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'ask2' }] },
    }]);
    expect(mgr.getStatus()).toBe('waiting');

    // Advance past waiting ceiling (10 min)
    vi.advanceTimersByTime(700_000);
    const demoted = mgr.demoteIfStale(30_000);
    expect(demoted).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });

  it('compact_boundary keeps running session alive', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'hi' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    const changed = await feedRecords(mgr, [{
      type: 'system', subtype: 'compact_boundary', timestamp: ts(),
    }]);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('enqueue → dequeue → running', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [
      { type: 'queue-operation', operation: 'enqueue', timestamp: ts() },
    ]);
    expect(mgr.getStatus()).toBe('done');

    await feedRecords(mgr, [
      { type: 'queue-operation', operation: 'dequeue', timestamp: ts() },
    ]);
    expect(mgr.getStatus()).toBe('running');
  });
});
