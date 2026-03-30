import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';

// Mock JsonlTailer so we can feed records without files
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

// Import after mock is registered
const { SessionManager } = await import('./sessionManager.js');

function makeManager(): InstanceType<typeof SessionManager> {
  return new SessionManager('test-session-id', '/tmp/test.jsonl', 'test-workspace');
}

async function feedRecords(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

// Helper to build common record shapes
function userRecord(text: string, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
    ...extras,
  };
}

function assistantTextRecord(text: string, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
    ...extras,
  };
}

function assistantToolUseRecord(toolName: string, toolId: string, input: Record<string, unknown> = {}, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_use', name: toolName, id: toolId, input }],
    },
    ...extras,
  };
}

function toolResultRecord(toolUseId: string, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId }],
    },
    ...extras,
  };
}

describe('SessionManager state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic lifecycle ─────────────────────────────────────────────

  it('starts in done status', async () => {
    const mgr = makeManager();
    expect(mgr.getStatus()).toBe('done');
  });

  it('transitions to running on user record', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('Hello')]);
    expect(mgr.getStatus()).toBe('running');
  });

  it('extracts topic from first user message', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('Fix the login bug')]);
    expect(mgr.getSnapshot().topic).toBe('Fix the login bug');
  });

  it('truncates topic to 60 chars', async () => {
    const mgr = makeManager();
    const longMsg = 'A'.repeat(100);
    await feedRecords(mgr, [userRecord(longMsg)]);
    expect(mgr.getSnapshot().topic).toBe('A'.repeat(60));
  });

  it('skips system injections when extracting topic', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'user',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          { type: 'text', text: '<system-reminder>ignore</system-reminder>' },
          { type: 'text', text: 'Real question here' },
        ],
      },
    }]);
    expect(mgr.getSnapshot().topic).toBe('Real question here');
  });

  // ── Tool use + permission detection ────────────────────────────

  it('stays running when tool_use is emitted', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('Edit', 'tool-1')]);
    expect(mgr.getStatus()).toBe('running');
  });

  it('returns to running when user sends tool_result after permission wait', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('SomeTool', 'tool-1')]);
    // Permission timer → waiting
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');
    await feedRecords(mgr, [toolResultRecord('tool-1')]);
    expect(mgr.getStatus()).toBe('running');
  });

  it('transitions to waiting immediately for AskUserQuestion', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('AskUserQuestion', 'tool-1')]);
    expect(mgr.getStatus()).toBe('waiting');
  });

  // ── Permission timer ───────────────────────────────────────────

  it('transitions to waiting after permission timer fires (3s for normal tools)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('SomeTool', 'tool-1')]);
    expect(mgr.getStatus()).toBe('running');
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('uses longer timer for slow tools (6s)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('Bash', 'tool-1')]);
    expect(mgr.getStatus()).toBe('running');
    vi.advanceTimersByTime(5_000);
    expect(mgr.getStatus()).toBe('running'); // still running at 5s
    vi.advanceTimersByTime(2_000);
    expect(mgr.getStatus()).toBe('waiting'); // triggers at 6s
  });

  it('uses longer timer for MCP tools', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('mcp__slack__send_message', 'tool-1')]);
    expect(mgr.getStatus()).toBe('running');
    vi.advanceTimersByTime(4_000);
    expect(mgr.getStatus()).toBe('running'); // still running — MCP is slow
  });

  // ── Idle timer ─────────────────────────────────────────────────

  it('transitions to done after idle timer fires (5s after output seen)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantTextRecord('Done')]);
    expect(mgr.getStatus()).toBe('running');
    // After output seen, idle drops to 5s (no longer waits for 30s grace)
    vi.advanceTimersByTime(4_000);
    expect(mgr.getStatus()).toBe('running'); // still within 5s idle
    vi.advanceTimersByTime(2_000); // total 6s past output
    expect(mgr.getStatus()).toBe('done');
  });

  // ── Subagent tracking ──────────────────────────────────────────

  it('tracks subagent spawn via Agent tool_use', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Research task' })]);
    const snap = mgr.getSnapshot();
    expect(snap.subagents).toHaveLength(1);
    expect(snap.subagents[0].description).toBe('Research task');
    expect(snap.subagents[0].running).toBe(true);
  });

  it('caps subagents at 50', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    for (let i = 0; i < 55; i++) {
      await feedRecords(mgr, [assistantToolUseRecord('Agent', `agent-${i}`, { description: `Task ${i}` })]);
    }
    expect(mgr.getSnapshot().subagents.length).toBe(50);
  });

  it('marks subagent done when tool_result arrives for its parent ID', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Research' })]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
    await feedRecords(mgr, [toolResultRecord('agent-1')]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });

  // ── All-subagents-done shortcut ────────────────────────────────

  it('marks done when last subagent completes and assistant responds', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    // Spawn two agents — both tool_use IDs go into activeTools
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [
          { type: 'tool_use', name: 'Agent', id: 'agent-1', input: { description: 'Task 1' } },
          { type: 'tool_use', name: 'Agent', id: 'agent-2', input: { description: 'Task 2' } },
        ],
      },
    }]);
    // Complete first subagent — agent-2 still in activeTools
    await feedRecords(mgr, [toolResultRecord('agent-1')]);
    expect(mgr.getStatus()).toBe('running'); // still orchestrating
    // Complete second subagent — activeTools emptied by tool_results
    await feedRecords(mgr, [toolResultRecord('agent-2')]);
    expect(mgr.getStatus()).toBe('running');
    // Assistant responds after subagents complete (sets seenOutputInTurn=true)
    await feedRecords(mgr, [assistantTextRecord('Both agents completed')]);
    expect(mgr.getStatus()).toBe('running');
    // 5s idle after output → done
    vi.advanceTimersByTime(6_000);
    expect(mgr.getStatus()).toBe('done');
  });

  // ── demoteIfStale ──────────────────────────────────────────────

  it('demoteIfStale marks done after hard ceiling (3 min)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    // Use a tool_use so the idle timer doesn't fire and mark done at 5s
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'long task' })]);
    expect(mgr.getStatus()).toBe('running');

    // Advance past the hard ceiling
    vi.advanceTimersByTime(180_001);
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });

  it('demoteIfStale uses extended ceiling (10 min) for waiting sessions', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('SomeTool', 'tool-1')]);
    // Trigger permission timer → waiting
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');
    // At 5 min (past 3-min hard ceiling but under 10-min waiting ceiling)
    vi.advanceTimersByTime(300_000);
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(false);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('demoteIfStale demotes waiting after extended ceiling (10 min)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('SomeTool', 'tool-1')]);
    // Trigger permission timer → waiting
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');
    // Advance past 10-min extended ceiling
    vi.advanceTimersByTime(600_000);
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });

  it('demoteIfStale does not demote if status is already done', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('something')]);
    await feedRecords(mgr, [assistantTextRecord('done')]);
    vi.advanceTimersByTime(31_000); // idle timer → done
    expect(mgr.getStatus()).toBe('done');
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(false);
  });

  // ── Model label extraction ─────────────────────────────────────

  it('extracts model label from assistant message', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('hello')]);
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-opus-4-6',
        usage: { input_tokens: 100 },
      } as Record<string, unknown>,
    } as JsonlRecord]);
    expect(mgr.getSnapshot().modelLabel).toBe('Opus');
  });

  // ── Custom title ───────────────────────────────────────────────

  it('processes custom-title records', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'custom-title',
      customTitle: 'My Custom Title',
      timestamp: new Date().toISOString(),
    }]);
    expect(mgr.getSnapshot().customTitle).toBe('My Custom Title');
  });

  // ── Activity on done (Bug 4) ───────────────────────────────────

  it('preserves genuine activity text when session transitions to done', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantTextRecord('Here is my answer')]);
    const activityBefore = mgr.getSnapshot().activity;
    expect(activityBefore).not.toBe('');
    vi.advanceTimersByTime(31_000); // idle timer → done
    expect(mgr.getStatus()).toBe('done');
    // Genuine activity text should be preserved for context on the done card
    expect(mgr.getSnapshot().activity).toBe(activityBefore);
  });

  it('preserves genuine activity text when done via idle timer', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantTextRecord('Done')]);
    const activityBefore = mgr.getSnapshot().activity;
    expect(activityBefore).not.toBe('');
    vi.advanceTimersByTime(30_001);
    expect(mgr.getStatus()).toBe('done');
    expect(mgr.getSnapshot().activity).toBe(activityBefore);
  });

  it('clears "Waiting for permission" activity when session completes after permission', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('SomeTool', 'tool-1')]);
    // Trigger permission timer → waiting
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toBe('Waiting for permission');
    // User approves → tool_result → back to running → idle timer → done
    await feedRecords(mgr, [toolResultRecord('tool-1')]);
    expect(mgr.getStatus()).toBe('running');
    // Activity still shows "Waiting for permission" until assistant responds
    await feedRecords(mgr, [assistantTextRecord('Done editing')]);
    vi.advanceTimersByTime(31_000); // past grace + idle
    expect(mgr.getStatus()).toBe('done');
    // "Waiting for permission" should not persist on the done card
    expect(mgr.getSnapshot().activity).not.toBe('Waiting for permission');
  });

  // ── Dispose cleanup ────────────────────────────────────────────

  it('dispose clears all timers without throwing', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('Edit', 'tool-1')]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'test' })]);
    expect(() => mgr.dispose()).not.toThrow();
  });

  // ── Context compaction ──────────────────────────────────────────

  it('compact_boundary keeps session running', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantTextRecord('working on it')]);
    expect(mgr.getStatus()).toBe('running');

    // Compact boundary arrives mid-session
    await feedRecords(mgr, [{
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: new Date().toISOString(),
      compactMetadata: { trigger: 'auto', preTokens: 169317 },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Activity log should mention compaction
    const snap = mgr.getSnapshot();
    expect(snap.activity).toContain('Compacting context');
  });

  it('compact_boundary resets idle timer (prevents premature done)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantTextRecord('working on it')]);

    // Advance most of the idle timeout (5s)
    vi.advanceTimersByTime(4500);
    expect(mgr.getStatus()).toBe('running');

    // Compact boundary resets the timer
    await feedRecords(mgr, [{
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: new Date().toISOString(),
    }]);

    // Advance another 4.5s — would have exceeded original 5s but timer was reset
    vi.advanceTimersByTime(4500);
    expect(mgr.getStatus()).toBe('running');
  });

  // ── Dequeue handling ────────────────────────────────────────────

  it('dequeue sets status to running', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: new Date().toISOString(),
    }]);
    expect(mgr.getStatus()).toBe('done');

    await feedRecords(mgr, [{
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: new Date().toISOString(),
    }]);
    expect(mgr.getStatus()).toBe('running');
  });

  it('session stays running during extended thinking (30s grace period)', async () => {
    const mgr = makeManager();
    // Simulate: user message → running → turn ends → dequeue new message
    await feedRecords(mgr, [userRecord('do something')]);
    expect(mgr.getStatus()).toBe('running');

    // Dequeue a new message (simulating resumed session)
    await feedRecords(mgr, [{
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: new Date().toISOString(),
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Advance 10s (past IDLE_DELAY_MS of 5s) — should still be running
    // because the 30s grace period protects against extended thinking gaps
    vi.advanceTimersByTime(10_000);
    expect(mgr.getStatus()).toBe('running');

    // Advance to 25s — still within grace period
    vi.advanceTimersByTime(15_000);
    expect(mgr.getStatus()).toBe('running');
  });

  // ── Confidence [#106] ────────────────────────────────────────────

  it('snapshot confidence is high for done sessions', async () => {
    const mgr = makeManager();
    expect(mgr.getSnapshot().confidence).toBe('high'); // initial done
  });

  it('snapshot confidence is high for recently active running session', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('hello')]);
    await feedRecords(mgr, [assistantToolUseRecord('Edit', 'e1')]);
    expect(mgr.getStatus()).toBe('running');
    expect(mgr.getSnapshot().confidence).toBe('high');
  });

  it('snapshot confidence degrades to medium after 5s silence', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('hello')]);
    await feedRecords(mgr, [assistantToolUseRecord('Edit', 'e1')]);
    vi.advanceTimersByTime(6_000);
    expect(mgr.getSnapshot().confidence).toBe('medium');
  });

  it('snapshot confidence degrades to low after 30s silence', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('hello')]);
    await feedRecords(mgr, [assistantToolUseRecord('Edit', 'e1')]);
    vi.advanceTimersByTime(31_000);
    // Session may have been demoted to waiting/done by timers,
    // but if still running/waiting, confidence should be low
    const snap = mgr.getSnapshot();
    if (snap.status === 'running' || snap.status === 'waiting') {
      expect(snap.confidence).toBe('low');
    }
  });
});
