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
const { SessionManager, setConfidenceThresholds } = await import('./sessionManager.js');
import { BACKGROUND_SHELL_CEILING_MS } from './trackers/backgroundShellTracker.js';

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

  it('uses longer timer for slow tools (15s)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('Bash', 'tool-1')]);
    expect(mgr.getStatus()).toBe('running');
    vi.advanceTimersByTime(14_000);
    expect(mgr.getStatus()).toBe('running'); // still running below the 15s slow delay
    vi.advanceTimersByTime(2_000);
    expect(mgr.getStatus()).toBe('waiting'); // fires past 15s
  });

  it('uses longer timer for MCP tools', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('mcp__slack__send_message', 'tool-1')]);
    expect(mgr.getStatus()).toBe('running');
    vi.advanceTimersByTime(4_000);
    expect(mgr.getStatus()).toBe('running'); // still running — MCP is slow
  });

  // ── Permission timer: auto-accept mode gate (FP-backlog option 2) ──
  // A slow MCP call in an auto-accept session (e.g. "Auto mode" in the native
  // panel) can never be blocked on a real prompt — the JSONL `permissionMode`
  // field disambiguates it from a genuine block, which a timer alone cannot.

  it('does not flag waiting for a slow MCP tool when permissionMode is auto', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'auto' })]);
    await feedRecords(mgr, [assistantToolUseRecord('mcp__google_workspace__manage_deployment', 'tool-1')]);
    vi.advanceTimersByTime(16_000); // past the 15s slow delay
    expect(mgr.getStatus()).toBe('running');
  });

  it('still flags waiting for the same slow MCP tool in default mode (regression guard)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'default' })]);
    await feedRecords(mgr, [assistantToolUseRecord('mcp__google_workspace__manage_deployment', 'tool-1')]);
    vi.advanceTimersByTime(16_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('still flags waiting when permissionMode is unset (no regression for un-enriched sessions)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('mcp__google_workspace__manage_deployment', 'tool-1')]);
    vi.advanceTimersByTime(16_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('does not suppress in acceptEdits mode — only edits are auto-accepted, other tools can still prompt', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'acceptEdits' })]);
    await feedRecords(mgr, [assistantToolUseRecord('Bash', 'tool-1')]);
    vi.advanceTimersByTime(16_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('still transitions to waiting for AskUserQuestion in auto mode — a genuine prompt, not a permission gate', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'auto' })]);
    await feedRecords(mgr, [assistantToolUseRecord('AskUserQuestion', 'tool-1')]);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('an auto-accept session recovers to running once the tool_result arrives', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'auto' })]);
    await feedRecords(mgr, [assistantToolUseRecord('mcp__google_workspace__manage_deployment', 'tool-1')]);
    vi.advanceTimersByTime(16_000);
    expect(mgr.getStatus()).toBe('running');
    await feedRecords(mgr, [toolResultRecord('tool-1')]);
    expect(mgr.getStatus()).toBe('running');
  });

  // The poll-based backstop (demoteIfStale → computeDemotion) is a second,
  // independent path to the same permission-typed 'waiting' — isolated here
  // from the in-process timer (a slow tool's 15s timer is still pending at
  // the 6s mark, so calling demoteIfStale directly with a smaller threshold
  // exercises ONLY the poll path).
  it('demoteIfStale (poll-based backstop) does not flip to waiting in auto mode', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'auto' })]);
    await feedRecords(mgr, [assistantToolUseRecord('Bash', 'tool-1')]);
    vi.advanceTimersByTime(6_000); // well under the 15s in-process timer
    expect(mgr.getStatus()).toBe('running');

    expect(mgr.demoteIfStale(5_000)).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('demoteIfStale still flags waiting in default mode (regression guard, poll-based backstop)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'default' })]);
    await feedRecords(mgr, [assistantToolUseRecord('Bash', 'tool-1')]);
    vi.advanceTimersByTime(6_000);
    expect(mgr.getStatus()).toBe('running');

    expect(mgr.demoteIfStale(5_000)).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
  });

  // ── Display pill: JSONL primes it ahead of the PreToolUse hook ──
  // Regression guard for the pill lagging until the model responded: the
  // JSONL `permissionMode` field on the `user` record must reach the display
  // pill directly, not just the internal auto-accept gate.

  it('updates the display permissionMode pill from the JSONL field immediately, before any tool runs', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'plan' })]);
    // No assistant/tool_use record yet — PreToolUse could not have fired.
    expect(mgr.getSnapshot().permissionMode).toBe('plan');
  });

  it('updates the pill again when a later message switches mode', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { permissionMode: 'auto' })]);
    expect(mgr.getSnapshot().permissionMode).toBe('auto');
    await feedRecords(mgr, [assistantTextRecord('Done')]);
    await feedRecords(mgr, [userRecord('do something else', { permissionMode: 'plan' })]);
    expect(mgr.getSnapshot().permissionMode).toBe('plan');
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

  it('stamps lastActivity from the sidechain record\'s own timestamp, not wall-clock', async () => {
    // Regression: updateSubagentActivity() used to call new Date() instead of
    // using the record's timestamp. A JSONL replay (e.g. on window reopen)
    // processes every historical record synchronously, so new Date() would
    // re-stamp lastActivity to "now" (replay time) for any session that ever
    // ran a subagent — even a subagent that finished long ago. All records
    // here share one historical timestamp (as a real replayed JSONL would),
    // isolating the assertion to whether the sidechain path uses that
    // timestamp rather than wall-clock at processing time.
    const oldTimestamp = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something', { timestamp: oldTimestamp })]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Research' }, { timestamp: oldTimestamp })]);
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: oldTimestamp,
      isSidechain: true,
      parentToolUseID: 'agent-1',
      message: { content: [{ type: 'text', text: 'still working' }] },
    }]);

    const snap = mgr.getSnapshot();
    expect(snap.lastActivity).toBe(new Date(oldTimestamp).getTime());
    expect(Date.now() - snap.lastActivity).toBeGreaterThan(1000 * 60 * 60 * 24 * 365);
  });

  it('clamps a future-stamped sidechain record so lastActivity cannot pin ahead of now (regression: unclamped corrupt/clock-skewed timestamps stalled demoteIfStale)', async () => {
    // L7: updateSubagentActivity() trusted the record's own timestamp with only
    // a monotonic max guard — nothing capped it at wall-clock "now". A future
    // timestamp (corrupt data or clock skew) pinned lastActivity ahead of now,
    // so computeDemotion's age (now - lastActivity) went negative and stayed
    // negative as real time passed, permanently defeating the hard-ceiling
    // demotion. The fix clamps every stamped timestamp to Math.min(ts, now).
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('do something')]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Research task' })]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);

    const futureTimestamp = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: futureTimestamp,
      isSidechain: true,
      parentToolUseID: 'agent-1',
      message: { content: [{ type: 'text', text: 'still working' }] },
    }]);

    // lastActivity must not have jumped into the future.
    expect(mgr.getSnapshot().lastActivity).toBeLessThanOrEqual(Date.now());

    // Go silent past the hard ceiling (3 min). Without the clamp, age stays
    // deeply negative and demoteIfStale never fires.
    vi.advanceTimersByTime(180_001);
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });

  // ── L3: updateSubagentActivity's four call sites + monotonic guard ─────
  // The bundled test above ("stamps lastActivity from the sidechain record's
  // own timestamp") only exercises the sidechain-assistant path
  // (applySubagentAssistantRecord, :1630). The launch-banner site (:1101) is
  // pinned indirectly by the L8 sweepBackgroundAgents fallback tests below
  // (subagent.lastActivity isn't exposed on SubagentSnapshot, so its only
  // observable surface is the sweep's force-complete timing). These two
  // isolate the remaining two: the agent_progress relay (:1267) and
  // applySubagentUserRecord (:1637), plus the guard itself.

  it('agent_progress relay updates lastActivity from the record\'s own timestamp, not wall-clock at processing', async () => {
    const mgr = makeManager();
    const t0 = Date.now();
    await feedRecords(mgr, [userRecord('go')]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);

    // Advance wall-clock well past the timestamp the progress record will
    // carry — isolates "uses record.timestamp" from "uses Date.now()".
    vi.advanceTimersByTime(50_000);
    const recordTs = new Date(t0 + 20_000).toISOString();
    await feedRecords(mgr, [{
      type: 'progress',
      timestamp: recordTs,
      parentToolUseID: 'agent-1',
      data: { type: 'agent_progress' },
    }]);

    expect(mgr.getSnapshot().lastActivity).toBe(new Date(recordTs).getTime());
    expect(mgr.getSnapshot().lastActivity).not.toBe(Date.now());
  });

  it('sidechain tool_result (applySubagentUserRecord) updates lastActivity from the record\'s own timestamp, not wall-clock at processing', async () => {
    const mgr = makeManager();
    const t0 = Date.now();
    await feedRecords(mgr, [userRecord('go')]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);

    vi.advanceTimersByTime(50_000);
    const recordTs = new Date(t0 + 20_000).toISOString();
    await feedRecords(mgr, [{
      type: 'user',
      timestamp: recordTs,
      isSidechain: true,
      parentToolUseID: 'agent-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'sub-tool-1' }] },
    }]);

    expect(mgr.getSnapshot().lastActivity).toBe(new Date(recordTs).getTime());
    expect(mgr.getSnapshot().lastActivity).not.toBe(Date.now());
  });

  it('monotonic guard: an older subagent record after a newer one does not roll state.lastActivity backward (T2-then-T1 keeps T2)', async () => {
    // Only uniform timestamps were ever fed through the bundled test, so the
    // guard's rejection branch (updateSubagentActivity's `>` comparison) was
    // never forced to reject anything. This sends T2 (agent_progress) then an
    // older T1 (sidechain assistant) for the same subagent and asserts the
    // session-level lastActivity does not regress to T1.
    const base = Date.now();
    const spawnTs = new Date(base - 60_000).toISOString();
    const t2 = new Date(base - 20_000).toISOString(); // newer
    const t1 = new Date(base - 40_000).toISOString(); // older than t2, newer than spawn

    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('go', { timestamp: spawnTs })]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' }, { timestamp: spawnTs })]);

    // T2 arrives first via the agent_progress relay.
    await feedRecords(mgr, [{
      type: 'progress',
      timestamp: t2,
      parentToolUseID: 'agent-1',
      data: { type: 'agent_progress' },
    }]);
    expect(mgr.getSnapshot().lastActivity).toBe(new Date(t2).getTime());

    // T1 (older) arrives second via a sidechain assistant record for the same
    // subagent. The guard must reject it: lastActivity stays at T2.
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: t1,
      isSidechain: true,
      parentToolUseID: 'agent-1',
      message: { content: [{ type: 'text', text: 'still working' }] },
    }]);

    expect(mgr.getSnapshot().lastActivity).toBe(new Date(t2).getTime());
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
    expect(mgr.getSnapshot().modelLabel).toBe('Opus 4.6');
  });

  it('ignores a trailing synthetic-sentinel record, keeping the last real model', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('hello')]);
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-fable-5',
        usage: { input_tokens: 100 },
      } as Record<string, unknown>,
    } as JsonlRecord]);
    // Claude Code's own locally-synthesized turn (no real API call) — must
    // not clobber the real model just read above.
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [{ type: 'text', text: 'No response requested.' }],
        model: '<synthetic>',
        usage: { input_tokens: 0 },
      } as Record<string, unknown>,
    } as JsonlRecord]);
    expect(mgr.getSnapshot().modelLabel).toBe('Fable 5');
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

  it('setConfidenceThresholds shifts the decay boundary (serac.sessions.*)', async () => {
    // Widen the high-confidence window to 20s. At 6s silence — past the 5s
    // default, but inside the new 20s window — confidence should stay high.
    setConfidenceThresholds(20_000, 60_000);
    try {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('hello')]);
      await feedRecords(mgr, [assistantToolUseRecord('Edit', 'e1')]);
      vi.advanceTimersByTime(6_000);
      expect(mgr.getSnapshot().confidence).toBe('high');
    } finally {
      // Restore defaults so global state doesn't bleed into other tests.
      setConfidenceThresholds(5_000, 30_000);
    }
  });
});

describe('SessionManager.sweepBackgroundWork (idle done-card maintenance)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  /** A tool_result record carrying the background-launch banner, so the tracker
   *  registers an outstanding shell (mirrors how a real backgrounded Bash
   *  returns immediately). */
  function launchRecord(shellId: string, toolId = 't1', timestamp = new Date().toISOString()): JsonlRecord {
    return {
      type: 'user',
      timestamp,
      message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: `Command running in background with ID: ${shellId}` }] },
    } as JsonlRecord;
  }

  it('is a no-op (returns false) when there are no outstanding shells', () => {
    const mgr = makeManager();
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
  });

  it('keeps a shell within the ceiling when death is not confirmed', async () => {
    // makeManager() passes no livenessProbe → registry signal is unknown (null).
    const mgr = makeManager();
    await feedRecords(mgr, [launchRecord('shell_a')]);
    expect(mgr.getSnapshot().backgroundShellCount).toBe(1);
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
    expect(mgr.getSnapshot().backgroundShellCount).toBe(1);
  });

  it('prunes a shell past the hard ceiling and reports the drop (fix a + b)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [launchRecord('shell_a')]);
    const past = Date.now() + BACKGROUND_SHELL_CEILING_MS + 1000;
    expect(mgr.sweepBackgroundWork(past)).toBe(true);
    expect(mgr.getSnapshot().backgroundShellCount).toBeUndefined();
  });

  it('clears every outstanding shell at once on confirmed process death, before the ceiling (fix c)', async () => {
    let live: boolean | null = true;
    const mgr = new SessionManager('dead-sess', '/tmp/dead.jsonl', 'ws', { livenessProbe: () => live });
    await feedRecords(mgr, [launchRecord('shell_a'), launchRecord('shell_b', 't2')]);
    expect(mgr.getSnapshot().backgroundShellCount).toBe(2);
    // First sweep sees the session live → latches "ever seen live", no drop.
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
    expect(mgr.getSnapshot().backgroundShellCount).toBe(2);
    // Process exits: registry now reports dead → clear both immediately, well
    // within the 15-min ceiling.
    live = false;
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(true);
    expect(mgr.getSnapshot().backgroundShellCount).toBeUndefined();
  });

  it('anchors a shell start to the record timestamp, so a reloaded old launch is pruned at once', async () => {
    // Simulates a reload replaying yesterday's JSONL: the launch record's
    // timestamp is already past the ceiling. startedAt must come from the record,
    // not wall-clock-at-processing — otherwise the age would reset to ~0 on reload.
    const mgr = makeManager();
    const oldTs = new Date(Date.now() - BACKGROUND_SHELL_CEILING_MS - 60_000).toISOString();
    await feedRecords(mgr, [launchRecord('shell_old', 't9', oldTs)]);
    expect(mgr.getSnapshot().backgroundShellCount).toBe(1);
    // Sweeping at "now" (NOT now+ceiling) already drops it: its real age exceeds
    // the ceiling because the start is anchored to the old record timestamp.
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(true);
    expect(mgr.getSnapshot().backgroundShellCount).toBeUndefined();
  });

  it('does NOT clear on a registry miss (never seen live → unknown, not dead)', async () => {
    // live=false from the start, never latched → conservative: not "confirmed
    // dead", so only the ceiling can drop it (and we are within it).
    const mgr = new SessionManager('unk-sess', '/tmp/unk.jsonl', 'ws', { livenessProbe: () => false });
    await feedRecords(mgr, [launchRecord('shell_a')]);
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
    expect(mgr.getSnapshot().backgroundShellCount).toBe(1);
  });
});

describe('SessionManager.sweepBackgroundAgents — mtime-unavailable fallback (L8)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  // Launch banner with no agentId captured (BACKGROUND_AGENT_LAUNCH_PATTERN's
  // group 1 is optional) — backgroundAgentFileMtime() has no path to stat and
  // returns null, forcing the sweep onto the subagent.lastActivity fallback.
  const AGENTLESS_LAUNCH_BANNER = 'Async agent launched successfully.\n'
    + 'The agent is working in the background. You will be notified automatically when it completes.';

  it('force-completes on the first sweep after reopen, not after a fresh 15-min grace (subagent.lastActivity now replays to the record\'s own timestamp, per the updated sweepBackgroundAgents docstring)', async () => {
    // A JSONL reload (window reopen) replays every historical record. Before
    // the A-1/A-2 change, updateSubagentActivity() wall-clock-stamped every
    // replayed record, so this fallback branch always saw a fresh "now" and
    // granted another full BACKGROUND_AGENT_CEILING_MS (15 min) of grace on
    // every reopen. It now sees the record's true (20-min-old) timestamp, so
    // a single sweep right after reopen force-completes immediately.
    const oldTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('go', { timestamp: oldTs })]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-nomt', { description: 'bg task' }, { timestamp: oldTs })]);
    await feedRecords(mgr, [{
      type: 'user',
      timestamp: oldTs,
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent-nomt', content: AGENTLESS_LAUNCH_BANNER }] },
    }]);

    const subagent = mgr.getSnapshot().subagents[0];
    expect(subagent.background).toBe(true);
    expect(subagent.agentId).toBeFalsy();

    // Sweep at "now" — no timer advance needed; the record is already stale.
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(true);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });

  it('within the 15-min ceiling of its true (replayed) timestamp, an agentless-banner agent stays live', async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('go', { timestamp: recentTs })]);
    await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-nomt2', { description: 'bg task' }, { timestamp: recentTs })]);
    await feedRecords(mgr, [{
      type: 'user',
      timestamp: recentTs,
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent-nomt2', content: AGENTLESS_LAUNCH_BANNER }] },
    }]);

    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
  });
});

describe('SessionManager.getSnapshot — externalWriter (writerOwnershipProbe)', () => {
  it('is undefined when no writerOwnershipProbe is injected', () => {
    const mgr = makeManager();
    expect(mgr.getSnapshot().externalWriter).toBeUndefined();
  });

  it('reflects the probe\'s current value', () => {
    let external: boolean | undefined = true;
    const mgr = new SessionManager('ext-sess', '/tmp/ext.jsonl', 'ws', {
      writerOwnershipProbe: () => external,
    });
    expect(mgr.getSnapshot().externalWriter).toBe(true);
    external = false;
    expect(mgr.getSnapshot().externalWriter).toBe(false);
    external = undefined;
    expect(mgr.getSnapshot().externalWriter).toBeUndefined();
  });
});
