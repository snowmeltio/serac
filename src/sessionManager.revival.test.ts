/**
 * Completed-subagent revival.
 *
 * Claude Code keeps completed subagents addressable: the lead can revive one
 * with `SendMessage({to})` or `Agent({resume})`, the agent keeps appending to
 * the same `subagents/agent-<id>.jsonl`, and completes again via another
 * `<task-notification>`. Found live 2026-09-14 (session 102c2b73): the card
 * read DONE while a twice-revived agent was still working, and a resume
 * created a duplicate roster row. These tests pin the revival model:
 *   - SendMessage tool_result (`pin.id` / `resumedAgentId`) revives a done
 *     agent as background; running targets and unknown ids are no-ops
 *   - Agent({resume}) retargets the existing row instead of creating one
 *   - revival rebuilds torn-down state (tools, tracker, tailer at the
 *     completion watermark) and the second notification completes it again
 *   - the growth backstop (sweepRevivedSubagents) catches revivals Serac
 *     never saw inline, gated on registry liveness and a 6-poll cadence
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';
import { HookEventRouter } from './hookEventRouter.js';
import { makeCachedSessionState } from './__fixtures__/replayCache.js';

// `fs` is a sealed ES module namespace — vi.spyOn(fs, 'statSync') can't
// redefine it (see writerActivity.test.ts), so the observable wrappers are
// installed at vi.mock() time. Everything else passes through unchanged.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    promises: { ...actual.promises, stat: vi.fn(actual.promises.stat) },
  };
});

// The main-session tailer is mocked so records can be fed without a file;
// a tailer opened on a `/subagents/` path wraps the REAL JsonlTailer so the
// revival paths (reopen at the completion watermark, growth backstop) read
// genuine agent JSONL from a tmp dir. Constructions are logged with their
// offsets, as in sessionManager.hydrate.test.ts.
let mockRecords: JsonlRecord[] = [];
let tailerConstructions: Array<{ filePath: string; initialOffset: number }> = [];
vi.mock('./jsonlTailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jsonlTailer.js')>();
  class MockTailer {
    truncated = false;
    lastSize = 0;
    lastMtimeMs = 0;
    private offset: number;
    private readonly real: InstanceType<typeof actual.JsonlTailer> | null;
    constructor(public filePath: string, initialOffset = 0) {
      this.offset = initialOffset;
      tailerConstructions.push({ filePath, initialOffset });
      this.real = filePath.includes('/subagents/') ? new actual.JsonlTailer(filePath, initialOffset) : null;
    }
    async readNewRecords() {
      if (this.real) {
        const r = await this.real.readNewRecords();
        this.lastSize = this.real.lastSize;
        this.lastMtimeMs = this.real.lastMtimeMs;
        return r;
      }
      const r = mockRecords;
      mockRecords = [];
      if (r.length > 0) { this.offset++; }
      this.lastSize = this.offset;
      this.lastMtimeMs = 999;
      return r;
    }
    getOffset() { return this.real ? this.real.getOffset() : this.offset; }
    getFilePath() { return this.filePath; }
    reset() { this.offset = 0; }
  }
  return { JsonlTailer: MockTailer };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const { SessionManager, revivalSweepSeed, REVIVAL_SWEEP_EVERY } = await import('./sessionManager.js');

type Manager = InstanceType<typeof SessionManager>;

const SID = 'rev-session';
const AGENT_ID = 'ab3df77ff4bafb73c';
const TOOL_ID = 'toolu_bg_1';
const LAUNCH_BANNER = 'Async agent launched successfully.\n'
  + `agentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}' to continue this agent.)\n`
  + 'The agent is working in the background. You will be notified automatically when it completes.';

/** Real SendMessage result shapes (captured 2026-09-14). Both carry pin.id. */
function queuedResult(id = AGENT_ID): string {
  return JSON.stringify({ success: true, message: 'Message queued for delivery to worker at its next tool round.', pin: { id, name: 'worker' } });
}
function resumedResult(id = AGENT_ID): string {
  return JSON.stringify({ success: true, message: 'Resuming agent worker', resumedAgentId: id, pin: { id, name: 'worker' } });
}
/** Teammate inbox send — no pin. */
const TEAMMATE_RESULT = JSON.stringify({ success: true, message: "Message sent to reviewer's inbox" });

/** A REAL captured agent JSONL assistant line (2026-09-14, usage trimmed):
 *  key order is parentUuid, isSidechain, agentId, message, …, type — so
 *  "type":"assistant" sits hundreds of bytes in. Any prefix sniff misses it. */
const REAL_ASSISTANT_LINE = '{"parentUuid":"6ad212db-87cb-471d-8a3b-aed5ebfd95bc","isSidechain":true,"agentId":"ab3df77ff4bafb73c","message":{"model":"claude-opus-5","id":"msg_011Cf2YpAbFZ2PNRmoagEcf2","type":"message","role":"assistant","content":[{"type":"text","text":"I\'ll map this out with parallel searches."}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"output_tokens":1,"service_tier":"standard"},"input_transformations":[],"diagnostics":null,"context_management":null},"apiBlockIndex":0,"requestId":"req_011Cf2Yp9yYd82WTREW2jcnH","attributionAgent":"Explore","type":"assistant","uuid":"edf7aab1-bba3-4291-a9a7-29a3a854c6fe","timestamp":"2026-09-14T02:33:13.255Z","effort":"low","perTurnEffort":null,"userType":"external","entrypoint":"claude-vscode","cwd":"/Users/murraystubbs/repos/snowmeltio/serac","sessionId":"1a9957c8-11a7-4d24-b6f1-41576f6574e0","version":"2.1.270","gitBranch":"main","slug":"build-a-plan-to-silly-stonebraker"}';

function agentUserLine(toolUseId: string): string {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: true, agentId: AGENT_ID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    type: 'user', uuid: `u-${toolUseId}`, timestamp: new Date().toISOString(),
  });
}
function agentToolUseLine(toolUseId: string): string {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: true, agentId: AGENT_ID,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }] },
    type: 'assistant', uuid: `a-${toolUseId}`, timestamp: new Date().toISOString(),
  });
}
const ATTACHMENT_LINE = JSON.stringify({
  parentUuid: 'p', isSidechain: true, agentId: AGENT_ID,
  message: { role: 'user', content: 'hook attachment' },
  type: 'attachment', uuid: 'att-1', timestamp: new Date().toISOString(),
});

let tmpDir: string;
let mainFile: string;
let agentFile: string;

function makeManager(opts: ConstructorParameters<typeof SessionManager>[3] = {}): Manager {
  return new SessionManager(SID, mainFile, 'ws', opts);
}

function userRecord(text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
}
function toolUseRecord(name: string, id: string, input: Record<string, unknown> = {}): JsonlRecord {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name, id, input }] } };
}
function toolResultRecord(toolUseId: string, text: string, isError = false): JsonlRecord {
  return {
    type: 'user', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, ...(isError ? { is_error: true } : {}) }] },
  };
}
function notificationRecord(opts: { taskId?: string; toolUseId?: string; result?: string } = {}): JsonlRecord {
  const body = '<task-notification>\n'
    + `<task-id>${opts.taskId ?? AGENT_ID}</task-id>\n`
    + (opts.toolUseId ? `<tool-use-id>${opts.toolUseId}</tool-use-id>\n` : '')
    + '<status>completed</status>\n'
    + `<result>${opts.result ?? 'first pass'}</result>\n`
    + '</task-notification>';
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: body } };
}
function sidechainToolUse(toolName: string, toolId: string, parentToolUseID: string): JsonlRecord {
  return {
    type: 'assistant', isSidechain: true, parentToolUseID, timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: toolName, id: toolId }] },
  };
}

async function feed(mgr: Manager, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

/** Let the un-awaited reopen (stat) and any pending tailer reads settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) { await new Promise(r => setImmediate(r)); }
}

function writeAgentFile(lines: string[]): void {
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.writeFileSync(agentFile, lines.map(l => l + '\n').join(''));
}
function appendAgentFile(lines: string[]): void {
  fs.appendFileSync(agentFile, lines.map(l => l + '\n').join(''));
}
function agentFileSize(): number { return fs.statSync(agentFile).size; }
function agentTailerConstructions() { return tailerConstructions.filter(c => c.filePath === agentFile); }
function statSyncCallsOnAgentFile(): number {
  return (fs.statSync as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === agentFile).length;
}
function asyncStatCallsOnAgentFile(): number {
  return (fs.promises.stat as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === agentFile).length;
}

/** Spawn one background agent (banner adopted) and complete it via notification.
 *  `withFile` writes a small agent JSONL first so completion stamps a watermark. */
async function spawnAndComplete(mgr: Manager, withFile = true): Promise<void> {
  await feed(mgr, [userRecord('go')]);
  await feed(mgr, [toolUseRecord('Agent', TOOL_ID, { description: 'worker', prompt: 'work', run_in_background: true })]);
  await feed(mgr, [toolResultRecord(TOOL_ID, LAUNCH_BANNER)]);
  if (withFile) { writeAgentFile([agentToolUseLine('t0'), agentUserLine('t0')]); }
  await feed(mgr, [notificationRecord()]);
  expect(mgr.getSnapshot().subagents[0].running).toBe(false);
}

async function sweepN(mgr: Manager, n: number, now = Date.now()): Promise<boolean> {
  let changed = false;
  for (let i = 0; i < n; i++) {
    if (await mgr.sweepRevivedSubagents(now)) { changed = true; }
  }
  return changed;
}

beforeEach(() => {
  mockRecords = [];
  tailerConstructions = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-revival-'));
  mainFile = path.join(tmpDir, 'sess.jsonl');
  agentFile = path.join(tmpDir, 'sess', 'subagents', `agent-${AGENT_ID}.jsonl`);
  (fs.statSync as unknown as ReturnType<typeof vi.fn>).mockClear();
  (fs.promises.stat as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseSendMessageRevival', () => {
  it('returns the id from both captured shapes', () => {
    expect(SessionManager.parseSendMessageRevival(queuedResult())).toBe(AGENT_ID);
    expect(SessionManager.parseSendMessageRevival(resumedResult('a0000000000000001'))).toBe('a0000000000000001');
  });
  it('rejects success:false, malformed JSON, name-only, and wrong message prefixes', () => {
    expect(SessionManager.parseSendMessageRevival(JSON.stringify({ success: false, message: 'Resuming agent x', pin: { id: AGENT_ID } }))).toBeNull();
    expect(SessionManager.parseSendMessageRevival('{not json')).toBeNull();
    expect(SessionManager.parseSendMessageRevival('plain text')).toBeNull();
    expect(SessionManager.parseSendMessageRevival(TEAMMATE_RESULT)).toBeNull();
    expect(SessionManager.parseSendMessageRevival(JSON.stringify({ success: true, message: 'Resuming agent x', pin: { name: 'x' } }))).toBeNull();
    expect(SessionManager.parseSendMessageRevival(JSON.stringify({ success: true, message: 'Deployed ok', pin: { id: AGENT_ID } }))).toBeNull();
    expect(SessionManager.parseSendMessageRevival(JSON.stringify({ success: true, message: 'Resuming agent x', resumedAgentId: 42, pin: { id: 7 } }))).toBeNull();
  });
});

describe('SendMessage revival', () => {
  it('1. queued result (pin.id) revives a completed background agent', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: AGENT_ID, message: 'more' })]);
    await feed(mgr, [toolResultRecord('sm1', queuedResult())]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.background).toBe(true);
    expect(sub.revivalCount).toBe(1);
    expect(mgr.hasLiveBackgroundAgents()).toBe(true);
  });

  it('2. resumedAgentId shape revives too', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: 'worker', message: 'more' })]);
    await feed(mgr, [toolResultRecord('sm1', resumedResult())]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.revivalCount).toBe(1);
  });

  it('3. a running target is untouched (regression)', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    await feed(mgr, [toolUseRecord('Agent', TOOL_ID, { description: 'worker', run_in_background: true })]);
    await feed(mgr, [toolResultRecord(TOOL_ID, LAUNCH_BANNER)]);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: AGENT_ID, message: 'hi' })]);
    await feed(mgr, [toolResultRecord('sm1', queuedResult())]);
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0].running).toBe(true);
    expect(subs[0].revivalCount).toBe(0);
  });

  it('4. unknown id / teammate result (no pin) never creates a subagent (regression)', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: 'other' })]);
    await feed(mgr, [toolResultRecord('sm1', queuedResult('a0000000000000009'))]);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm2', { to: 'reviewer' })]);
    await feed(mgr, [toolResultRecord('sm2', TEAMMATE_RESULT)]);
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0].running).toBe(false);
    expect(subs[0].revivalCount).toBe(0);
  });

  it('5. success:false, non-JSON, and a look-alike Bash result under the Stop guard are no-ops', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager({ hookRouter: router });
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('sm1', JSON.stringify({ success: false, message: 'Resuming agent worker', pin: { id: AGENT_ID } }))]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm2', { to: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('sm2', 'Error: no such agent')]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    // Stop-closed turn: a trailing Bash tool_use is skipped, so its result has
    // no tool name and reaches the parser. A non-matching message must not revive.
    router.onHookEvent(SID, 'Stop', { hook_event_name: 'Stop' });
    await feed(mgr, [toolUseRecord('Bash', 'b1', { command: 'deploy' })]);
    await feed(mgr, [toolResultRecord('b1', JSON.stringify({ success: true, message: 'deployed', pin: { id: AGENT_ID } }))]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    expect(mgr.getSnapshot().subagents[0].revivalCount).toBe(0);
  });

  it('6. a SendMessage tool_use skipped by the Stop guard still revives via its result', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager({ hookRouter: router });
    await spawnAndComplete(mgr);
    router.onHookEvent(SID, 'Stop', { hook_event_name: 'Stop' });
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('sm1', queuedResult())]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.background).toBe(true);
  });

  it('7. the next notification completes it again with the new preview; preview was null in between', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    expect(mgr.getSnapshot().subagents[0].resultPreview).toBe('first pass');
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('sm1', queuedResult())]);
    expect(mgr.getSnapshot().subagents[0].resultPreview).toBeNull();
    await feed(mgr, [notificationRecord({ result: 'second pass' })]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(false);
    expect(sub.resultPreview).toBe('second pass');
    expect(mgr.getSnapshot().subagents).toHaveLength(1);
  });
});

describe('Agent({resume}) revival', () => {
  it('8. resume on a completed agent retargets the one row (new parentToolUseId), running foreground', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('Agent', 'tu2', { description: 'again', resume: AGENT_ID })]);
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0].parentToolUseId).toBe('tu2');
    expect(subs[0].running).toBe(true);
    expect(subs[0].background).toBeUndefined();
    expect(subs[0].revivalCount).toBe(1);
  });

  it('9. foreground resume: a plain result on the new id completes with its preview', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('Agent', 'tu2', { description: 'again', resume: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('tu2', 'all done')]);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(false);
    expect(sub.resultPreview).toBe('all done');
    expect(mgr.getSnapshot().subagents).toHaveLength(1);
  });

  it('10. background resume: banner on the new id → background+running; notification by <tool-use-id> completes', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('Agent', 'tu2', { description: 'again', resume: AGENT_ID, run_in_background: true })]);
    await feed(mgr, [toolResultRecord('tu2', LAUNCH_BANNER)]);
    let sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.background).toBe(true);
    await feed(mgr, [notificationRecord({ taskId: 'not-this-one', toolUseId: 'tu2', result: 'round two' })]);
    sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(false);
    expect(sub.resultPreview).toBe('round two');
  });

  it('11. resume on a RUNNING agent is a no-op: an is_error result on the new id cannot kill it', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    await feed(mgr, [toolUseRecord('Agent', TOOL_ID, { description: 'worker', run_in_background: true })]);
    await feed(mgr, [toolResultRecord(TOOL_ID, LAUNCH_BANNER)]);
    await feed(mgr, [toolUseRecord('Agent', 'tu2', { description: 'again', resume: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('tu2', 'Error: agent is already running', true)]);
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0].running).toBe(true);
    expect(subs[0].parentToolUseId).toBe(TOOL_ID);
    expect(subs[0].revivalCount).toBe(0);
  });

  it('12. the same resume record fed twice yields one row, revivalCount 1 (regression)', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    const resume = toolUseRecord('Agent', 'tu2', { description: 'again', resume: AGENT_ID });
    await feed(mgr, [resume]);
    await feed(mgr, [resume]);
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0].revivalCount).toBe(1);
  });
});

describe('revival rebuilds torn-down state', () => {
  it('13. tools cleared, not waiting, un-acknowledged, preview null, tailer reopened at the watermark (never 0)', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    const watermark = agentFileSize();
    const toolsBefore = mgr.getSnapshot().subagents[0].toolsCompleted;
    mgr.acknowledgeSubagents();
    expect(mgr.getSnapshot().subagents).toHaveLength(0);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('sm1', queuedResult())]);
    await flush();
    const subs = mgr.getSnapshot().subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0].running).toBe(true);
    expect(subs[0].waitingOnPermission).toBe(false);
    expect(subs[0].resultPreview).toBeNull();
    expect(subs[0].blocking).toBe(false);
    expect(subs[0].toolsCompleted).toBe(toolsBefore); // history kept, not reset
    const opened = agentTailerConstructions();
    expect(opened).toHaveLength(1);
    expect(opened[0].initialOffset).toBe(watermark);
    expect(watermark).toBeGreaterThan(0);
    expect(mgr.getActiveSubagentTailerCount()).toBe(1);
  });

  it('14. with a hook router, the revived tracker is the hook variant (PermissionRequest for its agent_id bubbles)', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager({ hookRouter: router });
    await spawnAndComplete(mgr);
    await feed(mgr, [toolUseRecord('SendMessage', 'sm1', { to: AGENT_ID })]);
    await feed(mgr, [toolResultRecord('sm1', queuedResult())]);
    await feed(mgr, [sidechainToolUse('SomeTool', 'sc-1', TOOL_ID)]);
    router.onHookEvent(SID, 'PermissionRequest', { tool_name: 'SomeTool', agent_id: AGENT_ID });
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.waitingOnPermission).toBe(true);
  });

  it('15. revive → notification → revive in ONE batch leaves exactly one active tailer', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    await feed(mgr, [
      toolResultRecord('sm1', queuedResult()),
      notificationRecord({ result: 'mid' }),
      toolResultRecord('sm2', queuedResult()),
    ]);
    await flush();
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.revivalCount).toBe(2);
    expect(mgr.getActiveSubagentTailerCount()).toBe(1);
  });

  it('16. the completion watermark is stamped once: repeated turn-ends do not re-stat a done agent', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager({ hookRouter: router });
    await spawnAndComplete(mgr);
    expect(statSyncCallsOnAgentFile()).toBe(1);
    for (let i = 0; i < 5; i++) {
      await feed(mgr, [userRecord(`turn ${i}`)]);
      router.onHookEvent(SID, 'Stop', { hook_event_name: 'Stop' });
    }
    expect(statSyncCallsOnAgentFile()).toBe(1);
  });
});

describe('growth backstop (sweepRevivedSubagents)', () => {
  it('17. an assistant record past the watermark (real captured line) revives; tailer adopted post-delta; delta counted', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    const watermark = agentFileSize();
    const toolsBefore = mgr.getSnapshot().subagents[0].toolsCompleted;
    appendAgentFile([REAL_ASSISTANT_LINE, agentToolUseLine('t1'), agentUserLine('t1')]);
    expect(await sweepN(mgr, 6)).toBe(true);
    const sub = mgr.getSnapshot().subagents[0];
    expect(sub.running).toBe(true);
    expect(sub.background).toBe(true);
    expect(sub.revivalCount).toBe(1);
    expect(sub.toolsCompleted).toBe(toolsBefore + 1); // the delta's one tool_result, counted once
    const opened = agentTailerConstructions();
    expect(opened).toHaveLength(1);
    expect(opened[0].initialOffset).toBe(watermark);
    expect(mgr.getActiveSubagentTailerCount()).toBe(1);
    // The adopted tailer is pumped from the post-delta offset: no double count.
    appendAgentFile([agentToolUseLine('t2'), agentUserLine('t2')]);
    expect(await mgr.update()).toBe(true);
    expect(mgr.getSnapshot().subagents[0].toolsCompleted).toBe(toolsBefore + 2);
    expect(agentTailerConstructions()).toHaveLength(1);
  });

  it('18. an attachment-only delta does not revive; the watermark advances so the next sweep does not re-read', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    appendAgentFile([ATTACHMENT_LINE]);
    expect(await sweepN(mgr, 6)).toBe(false);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    expect(agentTailerConstructions()).toHaveLength(1);
    expect(await sweepN(mgr, 6)).toBe(false);
    expect(agentTailerConstructions()).toHaveLength(1);
  });

  it('19. a file whose mtime is past the ceiling is never read, and its watermark advances', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    appendAgentFile([REAL_ASSISTANT_LINE]);
    const old = new Date(Date.now() - 16 * 60 * 1000);
    fs.utimesSync(agentFile, old, old);
    expect(await sweepN(mgr, 6)).toBe(false);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    expect(agentTailerConstructions()).toHaveLength(0);
    // Touch it fresh with no growth: watermark already covers the old delta.
    const now = new Date();
    fs.utimesSync(agentFile, now, now);
    expect(await sweepN(mgr, 6)).toBe(false);
    expect(agentTailerConstructions()).toHaveLength(0);
  });

  it('20. an unknown watermark (no file at completion) never stats', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr, false);
    writeAgentFile([REAL_ASSISTANT_LINE]);
    (fs.promises.stat as unknown as ReturnType<typeof vi.fn>).mockClear();
    expect(await sweepN(mgr, 12)).toBe(false);
    expect(asyncStatCallsOnAgentFile()).toBe(0);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });

  it('21. skipped when the registry says dead; otherwise runs only every 6th poll', async () => {
    let live: boolean | null = true;
    const mgr = makeManager({ livenessProbe: () => live });
    await spawnAndComplete(mgr);
    appendAgentFile([REAL_ASSISTANT_LINE]);
    (fs.promises.stat as unknown as ReturnType<typeof vi.fn>).mockClear();
    // The cadence is seeded per session (revivalSweepSeed) so the first firing
    // lands within the first six polls at a sessionId-determined beat; the
    // beats after that are exactly six apart.
    const firstBeat = REVIVAL_SWEEP_EVERY - revivalSweepSeed(SID);
    await sweepN(mgr, firstBeat - 1);
    expect(asyncStatCallsOnAgentFile()).toBe(0);
    await sweepN(mgr, 1);
    expect(asyncStatCallsOnAgentFile()).toBe(1);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
    await feed(mgr, [notificationRecord({ result: 'again' })]);
    appendAgentFile([REAL_ASSISTANT_LINE]);
    (fs.promises.stat as unknown as ReturnType<typeof vi.fn>).mockClear();
    await sweepN(mgr, REVIVAL_SWEEP_EVERY - 1);
    expect(asyncStatCallsOnAgentFile()).toBe(0);
    await sweepN(mgr, 1);
    expect(asyncStatCallsOnAgentFile()).toBe(1);

    // Dead process: a completed agent cannot be resumed, so nothing is stat'ed.
    await feed(mgr, [notificationRecord({ result: 'again' })]);
    appendAgentFile([REAL_ASSISTANT_LINE]);
    live = false;
    (fs.promises.stat as unknown as ReturnType<typeof vi.fn>).mockClear();
    expect(await sweepN(mgr, 12)).toBe(false);
    expect(asyncStatCallsOnAgentFile()).toBe(0);
    expect(mgr.getSnapshot().subagents[0].running).toBe(false);
  });

  it('22. a hydrated (fromCache) card revived by the backstop pumps agent records with the main stamp unchanged', async () => {
    fs.writeFileSync(mainFile, 'x'.repeat(200));
    const st = fs.statSync(mainFile);
    const stamp = { size: st.size, mtimeMs: st.mtimeMs };
    writeAgentFile([agentToolUseLine('t0'), agentUserLine('t0')]);
    const watermark = agentFileSize();
    const cached = makeCachedSessionState({
      sessionId: SID, workspaceKey: 'ws',
      subagents: [{
        parentToolUseId: TOOL_ID, agentId: AGENT_ID, description: 'worker', resultPreview: 'first pass',
        toolsCompleted: 1, startedAt: Date.now() - 60_000, lastActivity: Date.now() - 50_000, background: true,
        completedFileSize: watermark,
      }],
    });
    const mgr = SessionManager.fromCache(SID, mainFile, 'ws', {}, cached, stamp);
    expect(mgr.isHydrated()).toBe(true);

    appendAgentFile([REAL_ASSISTANT_LINE, agentToolUseLine('t1'), agentUserLine('t1')]);
    expect(await sweepN(mgr, 6)).toBe(true);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
    expect(mgr.getSnapshot().subagents[0].toolsCompleted).toBe(2);

    appendAgentFile([agentToolUseLine('t2'), agentUserLine('t2')]);
    expect(await mgr.update()).toBe(true);
    expect(mgr.getSnapshot().subagents[0].toolsCompleted).toBe(3);
    expect(mgr.isHydrated()).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });
});

describe('fixture integrity', () => {
  it('fixture keeps message before type (the key order that defeats a prefix sniff)', () => {
    expect(REAL_ASSISTANT_LINE.indexOf('"message"')).toBeLessThan(REAL_ASSISTANT_LINE.indexOf('"type":"assistant"'));
  });
});

describe('growth backstop hardening (review round)', () => {
  it('seed is deterministic and within the cadence', () => {
    expect(revivalSweepSeed(SID)).toBe(revivalSweepSeed(SID));
    expect(revivalSweepSeed(SID)).toBeGreaterThanOrEqual(0);
    expect(revivalSweepSeed(SID)).toBeLessThan(REVIVAL_SWEEP_EVERY);
    expect(revivalSweepSeed('')).toBe(0);
  });

  it('a resetState() landing between the sweep\'s awaits does not revive the orphaned struct', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    appendAgentFile([REAL_ASSISTANT_LINE]);
    const orphan = (mgr as any).state.subagents[0];
    const statMock = fs.promises.stat as unknown as ReturnType<typeof vi.fn>;
    const real = statMock.getMockImplementation() as (p: fs.PathLike) => Promise<fs.Stats>;
    statMock.mockImplementationOnce(async (p: fs.PathLike) => {
      const r = await real(p);
      (mgr as any).resetState();   // truncation/forceReplay replaces the array mid-sweep
      return r;
    });
    expect(await sweepN(mgr, REVIVAL_SWEEP_EVERY * 2)).toBe(false);
    expect(orphan.running).toBe(false);
    expect(mgr.getActiveSubagentTailerCount()).toBe(0);
  });

  it('a throwing delta read is isolated: the sweep returns false and a later beat still revives', async () => {
    const mgr = makeManager();
    await spawnAndComplete(mgr);
    appendAgentFile([REAL_ASSISTANT_LINE]);
    const openSpy = vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    const first = await sweepN(mgr, REVIVAL_SWEEP_EVERY);
    openSpy.mockRestore();
    if (!first) { expect(mgr.getSnapshot().subagents[0].running).toBe(false); }
    expect((await sweepN(mgr, REVIVAL_SWEEP_EVERY)) || first).toBe(true);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);
    expect(mgr.getActiveSubagentTailerCount()).toBe(1);
  });
});
