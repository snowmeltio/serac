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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { JsonlRecord } from './types.js';
import { HookEventRouter } from './hookEventRouter.js';

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

function makeManagerWithHooks(router: HookEventRouter, sessionId = 'test-session-id'): InstanceType<typeof SessionManager> {
  return new SessionManager(sessionId, '/tmp/test.jsonl', 'test-workspace', { hookRouter: router });
}

async function feed(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

function user(text: string, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] }, ...extras };
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

/** A tool_result delivered via the agent_progress relay channel — the wrapped
 *  shape processProgressRecord unpacks at data.message.message.content. */
function agentProgressToolResult(toolUseId: string, parentToolUseID: string): JsonlRecord {
  return {
    type: 'progress', parentToolUseID,
    timestamp: new Date().toISOString(),
    data: {
      type: 'agent_progress',
      message: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] } },
    },
  };
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

  it('blocked subagent unblocks via agent_progress relay → parent recovers to running', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1')]);
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-1')]);
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');

    // The tool_result arrives via the agent_progress relay — once relay works
    // it is the ONLY delivery channel (onProgress disposes the targeted
    // tailer), so parent recovery must run on this path too, not just the
    // sidechain one. Regression: the relay copy rescheduled the permission
    // timer instead of cancelling and never recovered the parent.
    await feed(mgr, [agentProgressToolResult('sc-1', 'agent-1')]);
    expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
    expect(mgr.getStatus()).toBe('running');

    // And the cancelled timer must not re-fire and re-block the subagent.
    vi.advanceTimersByTime(30_000);
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

  // FP-backlog option 2: auto-accept mode covers the whole session tree, so a
  // subagent's tool call can't be blocked on permission either — neither the
  // subagent's own badge nor the parent bubble should flip to waiting.
  it('auto-accept mode suppresses the subagent bubble entirely', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go', { permissionMode: 'auto' })]);
    await feed(mgr, [spawnAgent('agent-1')]);
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-1')]);

    vi.advanceTimersByTime(3_001);

    expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  // Regression pin for a critical review finding: a subagent's HookPermissionTracker
  // shares the same onWaitingFired callback for its timer AND its ground-truth
  // PermissionRequest subscription (attached when agentId is known at spawn — a
  // resumed subagent). Auto-accept mode must suppress only the ambiguous timer,
  // never a hook-confirmed prompt for that specific subagent.
  it('a ground-truth PermissionRequest hook fire for a subagent still bubbles the parent in auto-accept mode', async () => {
    const router = new HookEventRouter();
    const mgr = makeManagerWithHooks(router);
    await feed(mgr, [user('go', { permissionMode: 'auto' })]);
    // Resumed subagent: agentId ('agent-77') is known at spawn time, so
    // createSubagent attaches the hook variant (see trackerOpts in
    // sessionManager.ts's createSubagent()).
    await feed(mgr, [{
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent-resume-1', input: { description: 'worker', resume: 'agent-77' } }] },
    }]);
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-resume-1')]);

    router.onHookEvent('test-session-id', 'PermissionRequest', { tool_name: 'SomeTool', agent_id: 'agent-77' });

    expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
  });

  // Symmetry fix: bubbleSubagentWaitingIfAllBlocked() previously gated on
  // isAutoAcceptMode() alone, with no needsUserInput exemption — unlike the
  // session-level callback. A subagent's AskUserQuestion must still bubble.
  it('AskUserQuestion on a subagent is not suppressed by auto-accept mode (genuine prompt, not a permission gate)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go', { permissionMode: 'auto' })]);
    await feed(mgr, [spawnAgent('agent-1')]);
    await feed(mgr, [sidechainToolUse('AskUserQuestion', 'sc-1', 'agent-1')]);

    vi.advanceTimersByTime(3_001); // AskUserQuestion is non-exempt, non-slow

    expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
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
    // Agent 2's completion was a tool_result moments ago, so the permission
    // delay is recency-DOUBLED (3s → 6s) to absorb sequential auto-approvals.
    vi.advanceTimersByTime(3_001);
    expect(mgr.getSnapshot().subagents.find(s => s.parentToolUseId === 'agent-1')?.waitingOnPermission).toBe(false);
    vi.advanceTimersByTime(3_000); // past the doubled delay

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

  // Regression pin for the 2026-07-11 parallel fan-out FP: a session fanned
  // out two Agent (Explore) calls plus a Bash call in one turn; the Bash
  // tool_result landed ~157s after its tool_use (0.25s after the slower
  // Agent's) because a blocking subagent explained the silence, not a stuck
  // permission prompt. The timer had no equivalent to computeDemotion's
  // hasBlockingSubagents() guard and flipped the card to a false "Waiting
  // for permission" for ~2 minutes until the subagents resolved.
  it('timer stays suppressed while a blocking subagent explains a sibling tool\'s silence (parallel fan-out FP)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1'), sessionToolUse('Bash', 'tu-bash')]);
    expect(mgr.getStatus()).toBe('running');

    vi.advanceTimersByTime(16_000); // past Bash's slow 15s delay
    expect(mgr.getStatus()).toBe('running');
  });

  it('the same slow tool still fires the timer normally with no blocking subagent present (regression guard)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [sessionToolUse('Bash', 'tu-bash')]);
    vi.advanceTimersByTime(16_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  // Regression pin: processUserRecord must RESCHEDULE (not just cancel) the
  // session timer on every tool_result. A bare cancel() (the pre-2026-07-11
  // behaviour) left tu-bash with no live timer at all once agent-1 stopped
  // being a blocking subagent — the Claude Code tool-use protocol forbids a
  // fresh top-level tool_use arriving while tu-bash is still unresolved, so
  // no other path would get a second chance to flag it. Without the
  // reschedule, a genuinely-blocked tu-bash would sit at 'running'
  // indefinitely (past the 3-min hard ceiling, silently to 'done').
  it('resolving the blocking subagent re-arms the timer for a sibling tool still pending', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1'), sessionToolUse('Bash', 'tu-bash')]);
    vi.advanceTimersByTime(16_000);
    expect(mgr.getStatus()).toBe('running'); // suppressed while agent-1 is blocking

    // agent-1 resolves — tu-bash (Bash) is still unresolved and active.
    await feed(mgr, [{
      type: 'user', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1' }] },
    }]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);

    // No blocking subagent left; the tool_result's reschedule gives tu-bash a
    // fresh window — doubled to 30s since agent-1's tool_result just landed
    // (recency window, mirrors "completed subagent does not count toward all
    // blocked" above).
    vi.advanceTimersByTime(31_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('a ground-truth PermissionRequest hook fire still flips to waiting despite a blocking subagent', async () => {
    const router = new HookEventRouter();
    const mgr = makeManagerWithHooks(router);
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1'), sessionToolUse('Bash', 'tu-bash')]);
    expect(mgr.getStatus()).toBe('running');

    router.onHookEvent('test-session-id', 'PermissionRequest', { tool_name: 'Bash' });
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toBe('Waiting for permission');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Stale-'waiting' reconciliation — permission-FP backstop.
//
// A permission-typed 'waiting' must stay backed by a live wait (a non-exempt
// active tool, or a running subagent blocked on permission). When the backing
// vanishes without a reopening record — the demonstrable reachable case is a
// background subagent that bubbled the parent to 'waiting' and is then
// force-completed by the dormant sweep (completeSubagent does NOT reopen the
// parent) — demoteIfStale re-opens the session so the card can't grow
// "Waiting · Nm". Live waits must be preserved.
// ─────────────────────────────────────────────────────────────────────────

describe('Stale-waiting reconciliation', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  /** Verbatim launch banner — flags the Agent tool_result as a background spawn. */
  const LAUNCH_BANNER = 'Async agent launched successfully.\n'
    + "agentId: agent-bg-1 (internal ID - do not mention to user. Use SendMessage with to: 'agent-bg-1' to continue this agent.)\n"
    + 'The agent is working in the background. You will be notified automatically when it completes.';

  function bgToolResult(toolUseId: string, text: string): JsonlRecord {
    return { type: 'user', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } };
  }

  it('background bubble force-completed by the sweep no longer sticks on waiting', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    // Spawn a BACKGROUND agent — its launch-banner tool_result clears the parent's
    // activeTools, so the parent holds no non-exempt tool while the agent runs.
    await feed(mgr, [{ type: 'assistant', timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent-bg-1',
        input: { description: 'bg', prompt: 'go', run_in_background: true } }] } }]);
    await feed(mgr, [bgToolResult('agent-bg-1', LAUNCH_BANNER)]);
    expect(mgr.getSnapshot().subagents[0].background).toBe(true);

    // Subagent blocks → bubbles the parent to waiting (empty parent activeTools).
    // The launch-banner tool_result was recent, so the permission delay is
    // recency-DOUBLED (3s → 6s).
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-bg-1')]);
    vi.advanceTimersByTime(6_001);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toContain('Subagent waiting for permission');

    // The agent's JSONL never updates; past its 15-min ceiling the dormant sweep
    // force-completes it via completeSubagent (which does not reopen the parent).
    vi.advanceTimersByTime(16 * 60 * 1000);
    mgr.sweepBackgroundWork(Date.now());
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);

    // Without reconciliation the parent would sit on 'waiting' until the 10-min
    // waiting ceiling. demoteIfStale must resolve the now-unbacked wait instead.
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).not.toBe('waiting');
    expect(mgr.getSnapshot().activity).not.toBe('Subagent waiting for permission');
  });

  it('does NOT reconcile a live session-level permission wait (non-exempt tool active)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [sessionToolUse('SomeTool', 'tu-1')]);
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');

    // The tool is genuinely pending (still in activeTools) — must stay waiting.
    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toContain('Waiting for permission');
  });

  it('does NOT reconcile a live subagent bubble (subagent still blocked)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [spawnAgent('agent-1')]);
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', 'agent-1')]);
    vi.advanceTimersByTime(3_001);
    expect(mgr.getStatus()).toBe('waiting');

    // The subagent is still blocked on permission — a real wait, keep it.
    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(true);
  });

  it('does NOT reconcile a needs_user_input wait (AskUserQuestion)', async () => {
    const mgr = makeManager();
    await feed(mgr, [user('go')]);
    await feed(mgr, [sessionToolUse('AskUserQuestion', 'ask-1')]);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toContain('Waiting for your response');

    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  // [L6 — H-7] Reconcile-only return path: computeDemotion returns null (age
  // still under threshold) after the stale-'waiting' reconciliation flips
  // waiting→running. `demoteIfStale` must still report `true` — the
  // reconciliation itself is a real status change the poll loop has to push
  // to the webview — even though no further demotion (done/waiting) fires.
  // Unlike the sibling test above (which advances the clock 16 minutes so
  // BOTH the subagent AND the parent go stale, landing on the hard-ceiling
  // 'done' branch), this forces the subagent stale via a BACKDATED FILE
  // MTIME while the fake clock only moves the ~6s needed to fire the
  // permission bubble — keeping the parent's own lastActivity fresh and
  // well under the 30s threshold, so computeDemotion falls through to null.
  it('reconcile-only branch: stale-waiting reopens to running with no further demotion when lastActivity is still fresh', async () => {
    // Isolated temp session dir (not the shared '/tmp/test.jsonl' used by
    // makeManager()) so writing a real, backdated subagent file can't collide
    // with any other test in this file or run in parallel.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-bubble-l6-'));
    const jsonlPath = path.join(tmpDir, 'test.jsonl');
    const mgr = new SessionManager('test-session-id-l6', jsonlPath, 'test-workspace');
    const AGENT_ID = 'agent-bg-l6';
    const BANNER = 'Async agent launched successfully.\n'
      + `agentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}' to continue this agent.)\n`
      + 'The agent is working in the background. You will be notified automatically when it completes.';

    try {
      await feed(mgr, [user('go')]);
      await feed(mgr, [{ type: 'assistant', timestamp: new Date().toISOString(),
        message: { content: [{ type: 'tool_use', name: 'Agent', id: AGENT_ID,
          input: { description: 'bg', prompt: 'go', run_in_background: true } }] } }]);
      await feed(mgr, [bgToolResult(AGENT_ID, BANNER)]);
      expect(mgr.getSnapshot().subagents[0].background).toBe(true);

      // Subagent blocks → bubbles the parent to waiting (recency-doubled 3s → 6s,
      // same as the launch-banner recency window in the sibling test above).
      await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', AGENT_ID)]);
      vi.advanceTimersByTime(6_001);
      expect(mgr.getStatus()).toBe('waiting');
      expect(mgr.getSnapshot().activity).toBe('Subagent waiting for permission');

      // Force-complete the subagent via its JSONL file's mtime, NOT the clock —
      // the parent's lastActivity (anchored to the sidechain record above) stays
      // ~6s old throughout, unlike the sibling test which advances the clock
      // 16 minutes and stales BOTH the subagent and the parent.
      const subagentFile = path.join(tmpDir, 'test', 'subagents', `agent-${AGENT_ID}.jsonl`);
      fs.mkdirSync(path.dirname(subagentFile), { recursive: true });
      fs.writeFileSync(subagentFile, '');
      const staleMtime = new Date(Date.now() - 16 * 60 * 1000); // past the 15-min sweep ceiling
      fs.utimesSync(subagentFile, staleMtime, staleMtime);

      mgr.sweepBackgroundWork(Date.now());
      expect(mgr.getSnapshot().subagents[0].running).toBe(false);

      // Age here is ~6s (well under the 30s threshold), so once reconciliation
      // flips waiting→running, computeDemotion has nothing left to do and
      // returns null — demoteIfStale must still report the reconciliation.
      const changed = mgr.demoteIfStale(30_000);
      expect(changed).toBe(true);
      expect(mgr.getStatus()).toBe('running');
      expect(mgr.getSnapshot().activity).toBe('Processing');

      // A second, immediate call has nothing left to reconcile (already
      // 'running') and is still well under threshold — must return false.
      expect(mgr.demoteIfStale(30_000)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
