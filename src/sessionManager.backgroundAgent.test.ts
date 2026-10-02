/**
 * Background (run_in_background) agent lifecycle.
 *
 * A detached agent's Agent tool_result is only the launch banner — mistaking it
 * for completion made cards read DONE while the agents kept working (found live
 * 2026-06-11 on the VP-matrix session). These tests pin the corrected model:
 *   - launch banner → background flag + agentId adoption, subagent stays running
 *   - parent turn-end (markSessionDone) leaves the detached agent running
 *   - <task-notification> user record is the genuine completion signal
 *   - sweepBackgroundWork backstops: registry-confirmed death and quiet-file ceiling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';

// Mock JsonlTailer so we can feed records without files
let mockRecords: JsonlRecord[] = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    // Bumped only when a read actually returns records; lastSize mirrors it
    // so updateInner()'s internal drain loop (caught up, OR offset stops
    // advancing → stop) sees exactly one productive iteration per
    // feedRecords() call, then exits — same net effect as the pre-loop
    // single-read behaviour these mocks were built for.
    private offset = 0;
    lastSize = 0;
    async readNewRecords() {
      const r = mockRecords;
      mockRecords = [];
      if (r.length > 0) { this.offset++; }
      this.lastSize = this.offset;
      return r;
    }
    getOffset() { return this.offset; }
  },
}));

// Import after mock is registered
const { SessionManager } = await import('./sessionManager.js');

const AGENT_ID = 'a14975e12a105f04f';
const TOOL_ID = 'toolu_bg_1';
/** Verbatim shape of the real launch banner (captured 2026-06-11). */
const LAUNCH_BANNER = 'Async agent launched successfully.\n'
  + `agentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}' to continue this agent.)\n`
  + 'The agent is working in the background. You will be notified automatically when it completes.';

function makeManager(): InstanceType<typeof SessionManager> {
  return new SessionManager('bg-session', '/tmp/bg-test.jsonl', 'test-workspace');
}

function userRecord(text: string): JsonlRecord {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
  };
}

function agentSpawnRecord(toolId = TOOL_ID, description = 'Build VP matrix end-to-end'): JsonlRecord {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_use', name: 'Agent', id: toolId, input: { description, prompt: 'build it', run_in_background: true } }],
    },
  };
}

function toolResultRecord(toolUseId: string, text: string): JsonlRecord {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  };
}

/** Real notifications arrive as a user record whose content is a plain string. */
function taskNotificationRecord(opts: { taskId?: string; toolUseId?: string; status?: string; result?: string }): JsonlRecord {
  const body = '<task-notification>\n'
    + (opts.taskId ? `<task-id>${opts.taskId}</task-id>\n` : '')
    + (opts.toolUseId ? `<tool-use-id>${opts.toolUseId}</tool-use-id>\n` : '')
    + '<output-file>/tmp/tasks/x.output</output-file>\n'
    + `<status>${opts.status ?? 'completed'}</status>\n`
    + `<summary>Agent completed</summary>\n`
    + (opts.result !== undefined ? `<result>${opts.result}</result>\n` : '')
    + '</task-notification>';
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: body },
  };
}

/** Spawn one background agent and deliver its launch banner. */
async function spawnBackgroundAgent(mgr: InstanceType<typeof SessionManager>): Promise<void> {
  await feedRecords(mgr, [userRecord('kick off the build')]);
  await feedRecords(mgr, [agentSpawnRecord()]);
  await feedRecords(mgr, [toolResultRecord(TOOL_ID, LAUNCH_BANNER)]);
}

async function feedRecords(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

describe('background-agent launch banner', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT complete the subagent — it stays running, flagged background', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.background).toBe(true);
    // The banner is a launch receipt, not a result.
    expect(sub.resultPreview).toBeNull();
    expect(mgr.hasLiveBackgroundAgents()).toBe(true);
  });

  it('adopts the agentId from the banner (exact tailer path, no directory scan)', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    expect(mgr.getSnapshot().subagents[0].agentId).toBe(AGENT_ID);
  });

  it('a plain Agent tool_result (no banner) still completes the subagent', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [userRecord('inline work')]);
    await feedRecords(mgr, [agentSpawnRecord('toolu_inline')]);
    await feedRecords(mgr, [toolResultRecord('toolu_inline', 'All six files reviewed; no issues found.')]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(false);
    expect(sub.background).toBeUndefined();
    expect(sub.resultPreview).toContain('All six files reviewed');
    expect(mgr.hasLiveBackgroundAgents()).toBe(false);
  });

  it('the turn still goes done on the idle timer, but markSessionDone leaves the detached agent running', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    expect(mgr.getStatus()).toBe('running');
    // Closing assistant text, then idle. A background agent must not pin the
    // turn open (it is non-blocking by design) — only the chip/roster show it.
    await feedRecords(mgr, [{
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'Both agents are running in the background.' }] },
    }]);
    vi.advanceTimersByTime(6_000);
    expect(mgr.getStatus()).toBe('done');
    // done = the TURN ended; the detached agent survives the done-sweep.
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.background).toBe(true);
    expect(mgr.hasLiveBackgroundAgents()).toBe(true);
  });
});

describe('background-agent completion via <task-notification>', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('completes the agent matched by task-id, result becomes the preview', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [taskNotificationRecord({
      taskId: AGENT_ID, status: 'completed',
      result: 'Build complete. All six deliverables written,\nSTATE.md updated.',
    })]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(false);
    expect(sub.resultPreview).toBe('Build complete. All six deliverables written, STATE.md updated.');
    expect(mgr.hasLiveBackgroundAgents()).toBe(false);
    // The notification record is also a turn reopener (the harness re-invokes
    // the lead to process it).
    expect(mgr.getStatus()).toBe('running');
  });

  it('falls back to tool-use-id matching when task-id is absent', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [taskNotificationRecord({ toolUseId: TOOL_ID, result: 'done' })]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });

  it('a non-completed terminal status is prefixed into the preview', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [taskNotificationRecord({ taskId: AGENT_ID, status: 'failed', result: 'API error' })]);
    expect(mgr.getSnapshot().subagents[0].resultPreview).toBe('[failed] API error');
  });

  it('a notification for an unknown agent is ignored', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [taskNotificationRecord({ taskId: 'someone-else', result: 'n/a' })]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
  });
});

/** Mid-turn delivery shape (CLI 2.1.286): the same notification body under a
 *  queued_command attachment, with no user record written for it. */
function queuedCommandRecord(body: string | JsonlRecord['attachment'], extra: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'attachment',
    timestamp: new Date().toISOString(),
    attachment: typeof body === 'string' ? { type: 'queued_command', prompt: body } : body,
    ...extra,
  };
}

function notificationBody(taskId: string): string {
  return (taskNotificationRecord({ taskId }).message!.content as string);
}

describe('background-agent completion via mid-turn queued_command attachment', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('completes the agent matched by task-id', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [queuedCommandRecord(notificationBody(AGENT_ID))]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    expect(mgr.hasLiveBackgroundAgents()).toBe(false);
  });

  it('leaves session status untouched (the lead is mid-turn)', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    const before = mgr.getStatus();
    await feedRecords(mgr, [queuedCommandRecord(notificationBody(AGENT_ID))]);
    expect(mgr.getStatus()).toBe(before);
  });

  it('accepts a content-block array prompt', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [queuedCommandRecord({
      type: 'queued_command', prompt: [{ type: 'text', text: notificationBody(AGENT_ID) }],
    })]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });

  it('ignores other attachment types carrying the same text', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [queuedCommandRecord({ type: 'skill_listing', prompt: notificationBody(AGENT_ID) })]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
  });

  it('ignores a queued_command with no notification (a queued user prompt)', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [queuedCommandRecord('also check the appendix')]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
  });
});

/** The parent's queue-operation enqueue (CLI 2.1.286 shape): the same
 *  notification body as a plain `content` string, written as the agent ends. */
function enqueueRecord(content: string): JsonlRecord {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content };
}

const AGENT_ID_2 = 'b25086f23b216f15a';
const TOOL_ID_2 = 'toolu_bg_2';

/** Spawn a second background agent alongside the first. */
async function spawnSecondBackgroundAgent(mgr: InstanceType<typeof SessionManager>): Promise<void> {
  await feedRecords(mgr, [agentSpawnRecord(TOOL_ID_2, 'Second agent')]);
  await feedRecords(mgr, [toolResultRecord(TOOL_ID_2, LAUNCH_BANNER.replaceAll(AGENT_ID, AGENT_ID_2))]);
}

function runningById(mgr: InstanceType<typeof SessionManager>): Record<string, boolean> {
  return Object.fromEntries(mgr.getSnapshot().subagents.map(s => [s.agentId, s.running]));
}

describe('background-agent completion via the queue-operation enqueue (D2)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('completes the agent named in the enqueue content, before any delivered form', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [enqueueRecord(notificationBody(AGENT_ID))]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(false);
    expect(mgr.hasLiveBackgroundAgents()).toBe(false);
  });

  it('carries the <result> into resultPreview', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    const body = (taskNotificationRecord({ taskId: AGENT_ID, result: 'Matrix built: 12 rows' }).message!.content as string);
    await feedRecords(mgr, [enqueueRecord(body)]);
    expect(mgr.getSnapshot().subagents[0].resultPreview).toBe('Matrix built: 12 rows');
  });

  it('ignores an enqueue that carries a queued user prompt', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [enqueueRecord('also check the appendix')]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
  });

  it('a later delivered copy of the same notification is a no-op', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await feedRecords(mgr, [enqueueRecord(notificationBody(AGENT_ID))]);
    await feedRecords(mgr, [queuedCommandRecord(notificationBody(AGENT_ID))]);
    await feedRecords(mgr, [taskNotificationRecord({ taskId: AGENT_ID })]);
    expect(mgr.getSnapshot().subagents).toHaveLength(1);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });
});

describe('task-notification parsing (all carriers)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('a status-less "resumed" notice does not complete the agent', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    const body = `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n`
      + '<summary>Agent "Build VP matrix" was resumed by the user</summary>\n</task-notification>';
    await feedRecords(mgr, [{ type: 'user', timestamp: new Date().toISOString(), message: { content: body } }]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
  });

  it('completes every agent when one text holds several notification blocks', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await spawnSecondBackgroundAgent(mgr);
    await feedRecords(mgr, [queuedCommandRecord(notificationBody(AGENT_ID) + '\n' + notificationBody(AGENT_ID_2))]);
    expect(runningById(mgr)).toEqual({ [AGENT_ID]: false, [AGENT_ID_2]: false });
  });

  it('completes every task-id in a resume orphan aggregate', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    await spawnSecondBackgroundAgent(mgr);
    const body = '<task-notification>\n'
      + `<task-id>${AGENT_ID}</task-id>\n<task-id>${AGENT_ID_2}</task-id>\n`
      + '<status>stopped</status>\n'
      + "<summary>2 agents didn't finish before the previous session ended</summary>\n</task-notification>";
    await feedRecords(mgr, [enqueueRecord(body)]);
    expect(runningById(mgr)).toEqual({ [AGENT_ID]: false, [AGENT_ID_2]: false });
    expect(mgr.getSnapshot().subagents[0].resultPreview).toBe('[stopped]');
  });
});

describe('background-agent sweep backstops (sweepBackgroundWork)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('registry-confirmed death completes all background agents at once', async () => {
    let live: boolean | null = true;
    const mgr = new SessionManager('bg-dead', '/tmp/bg-dead.jsonl', 'ws', { livenessProbe: () => live });
    await feedRecords(mgr, [userRecord('go')]);
    await feedRecords(mgr, [agentSpawnRecord()]);
    await feedRecords(mgr, [toolResultRecord(TOOL_ID, LAUNCH_BANNER)]);
    // Latch "seen live", then kill the process.
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
    live = false;
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(true);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    expect(mgr.hasLiveBackgroundAgents()).toBe(false);
  });

  it('force-completes an agent whose file has been quiet past the ceiling (no notification ever)', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    // No registry signal, and the agent file does not exist on disk (mock
    // tailer, no real files) → liveness falls back to subagent.lastActivity.
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
    expect(mgr.sweepBackgroundWork(Date.now() + 16 * 60 * 1000)).toBe(true);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });

  it('within the ceiling, a live-looking agent is untouched', async () => {
    const mgr = makeManager();
    await spawnBackgroundAgent(mgr);
    expect(mgr.sweepBackgroundWork(Date.now() + 60_000)).toBe(false);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
  });
});
