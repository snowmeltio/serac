/**
 * Timer-free subagent rows (PR 3 of the registry-primary status plan).
 *
 * A row is done when any of these holds, and running otherwise:
 *   D1 its foreground Agent tool_result (unchanged; see backgroundAgent tests)
 *   D2 a <task-notification> in any carrier (PR 1; see backgroundAgent tests)
 *   D3 a BACKGROUND agent's own transcript ends on a clean end_turn
 *   D4 the session's registry process is gone (every running row)
 * Supporting changes pinned here: the tailer opens on the first poll (no 8 s
 * silence timer), files pair by the meta.json toolUseId, the 15-min quiet
 * ceiling only runs while liveness is unknown, interim notices don't
 * complete, and a parent result reaching a D3-closed row fills its preview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';
import { HookEventRouter } from './hookEventRouter.js';

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
    hasPartialLine() { return this.real ? this.real.hasPartialLine() : false; }
    getFilePath() { return this.filePath; }
    reset() { this.offset = 0; }
  }
  return { JsonlTailer: MockTailer };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const { SessionManager } = await import('./sessionManager.js');

type Manager = InstanceType<typeof SessionManager>;

const SID = 'rows-session';
const AGENT_ID = 'ab3df77ff4bafb73c';
const BG_TOOL = 'toolu_bg_1';
const FG_TOOL = 'toolu_fg_1';
const LAUNCH_BANNER = 'Async agent launched successfully.\n'
  + `agentId: ${AGENT_ID} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT_ID}' to continue this agent.)\n`
  + 'The agent is working in the background. You will be notified automatically when it completes.';

let tmpDir: string;
let mainFile: string;
let subagentsDir: string;

function makeManager(opts: ConstructorParameters<typeof SessionManager>[3] = {}): Manager {
  return new SessionManager(SID, mainFile, 'ws', opts);
}

function userRecord(text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
}
function toolUseRecord(name: string, id: string, input: Record<string, unknown> = {}): JsonlRecord {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name, id, input }] } };
}
function toolResultRecord(toolUseId: string, text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } };
}
function enqueue(body: string): JsonlRecord {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: body };
}
function notification(opts: { status?: string; summary?: string; result?: string } = {}): string {
  return '<task-notification>\n'
    + `<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${BG_TOOL}</tool-use-id>\n`
    + `<status>${opts.status ?? 'completed'}</status>\n`
    + `<summary>${opts.summary ?? 'Agent "worker" finished'}</summary>\n`
    + (opts.result !== undefined ? `<result>${opts.result}</result>\n` : '')
    + '</task-notification>';
}

/** Agent transcript lines. */
function agentToolUse(id: string, stopReason: string | null = null): string {
  return JSON.stringify({ isSidechain: true, type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }], stop_reason: stopReason } });
}
function agentToolResult(id: string): string {
  return JSON.stringify({ isSidechain: true, type: 'user', timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
}
function agentText(text: string, stopReason: string | null): string {
  return JSON.stringify({ isSidechain: true, type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason } });
}

function writeAgent(agentId: string, lines: string[], toolUseId?: string): string {
  fs.mkdirSync(subagentsDir, { recursive: true });
  const file = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, lines.map(l => l + '\n').join(''));
  if (toolUseId) {
    fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', toolUseId, spawnDepth: 1 }));
  }
  return file;
}

async function feed(mgr: Manager, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

async function spawnBackground(mgr: Manager): Promise<void> {
  await feed(mgr, [userRecord('go')]);
  await feed(mgr, [toolUseRecord('Agent', BG_TOOL, { description: 'worker', prompt: 'work', run_in_background: true })]);
  await feed(mgr, [toolResultRecord(BG_TOOL, LAUNCH_BANNER)]);
}

async function spawnForeground(mgr: Manager, toolId = FG_TOOL): Promise<void> {
  await feed(mgr, [toolUseRecord('Agent', toolId, { description: `fg ${toolId}`, prompt: 'work' })]);
}

function row(mgr: Manager, toolId: string) {
  return mgr.getSnapshot().subagents.find(s => s.parentToolUseId === toolId)!;
}

beforeEach(() => {
  mockRecords = [];
  tailerConstructions = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-rows-'));
  mainFile = path.join(tmpDir, 'sess.jsonl');
  subagentsDir = path.join(tmpDir, 'sess', 'subagents');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('poll-driven tailer open', () => {
  it('opens the subagent tailer on the first poll after spawn, no 8 s wait', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    writeAgent('fg1', [agentToolUse('t1')], FG_TOOL);
    await spawnForeground(mgr);
    await feed(mgr, []);
    expect(mgr.getActiveSubagentTailerCount()).toBe(1);
    expect(row(mgr, FG_TOOL).agentId).toBe('fg1');
  });

  it('pairs parallel spawns to their own files by meta toolUseId, not file age', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    // B's file is older than A's, so birthtime order would cross them.
    writeAgent('bbbb', [agentToolUse('tb')], 'toolu_B');
    await new Promise(r => setTimeout(r, 10));
    writeAgent('aaaa', [agentToolUse('ta')], 'toolu_A');
    await spawnForeground(mgr, 'toolu_A');
    await spawnForeground(mgr, 'toolu_B');
    await feed(mgr, []);
    expect(row(mgr, 'toolu_A').agentId).toBe('aaaa');
    expect(row(mgr, 'toolu_B').agentId).toBe('bbbb');
  });
});

describe('D3: own-transcript clean end_turn', () => {
  it('completes a background agent whose transcript ends on a clean end_turn', async () => {
    const mgr = makeManager();
    await spawnBackground(mgr);
    writeAgent(AGENT_ID, [agentToolUse('t1'), agentToolResult('t1'), agentText('All done.', 'end_turn')]);
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(false);
    expect(mgr.hasLiveBackgroundAgents()).toBe(false);
  });

  it('the parent notification that follows fills the result preview', async () => {
    const mgr = makeManager();
    await spawnBackground(mgr);
    writeAgent(AGENT_ID, [agentText('All done.', 'end_turn')]);
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).resultPreview).toBeNull();
    await feed(mgr, [enqueue(notification({ result: 'Matrix built' }))]);
    expect(row(mgr, BG_TOOL).resultPreview).toBe('Matrix built');
  });

  it('an end_turn that carries a tool_use is not terminal', async () => {
    const mgr = makeManager();
    await spawnBackground(mgr);
    writeAgent(AGENT_ID, [agentToolUse('t1', 'end_turn')]);
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(true);
  });

  it('a mid-turn text record (stop_reason null) is not terminal', async () => {
    const mgr = makeManager();
    await spawnBackground(mgr);
    writeAgent(AGENT_ID, [agentText('Looking now.', null)]);
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(true);
  });

  it('a foreground row waits for its Agent tool_result, even after a clean end_turn', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    writeAgent('fg1', [agentText('Report.', 'end_turn')], FG_TOOL);
    await spawnForeground(mgr);
    await feed(mgr, []);
    expect(row(mgr, FG_TOOL).running).toBe(true);
    await feed(mgr, [toolResultRecord(FG_TOOL, 'Report.')]);
    expect(row(mgr, FG_TOOL).running).toBe(false);
  });
});

describe('interim notifications', () => {
  it('a completed notice for an agent still waiting on its own background work does not complete it', async () => {
    const mgr = makeManager();
    await spawnBackground(mgr);
    await feed(mgr, [enqueue(notification({
      summary: 'Agent "worker" has not reported yet: it is waiting on its own background work',
    }))]);
    expect(row(mgr, BG_TOOL).running).toBe(true);
    await feed(mgr, [enqueue(notification())]);
    expect(row(mgr, BG_TOOL).running).toBe(false);
  });
});

describe('D4 and the quiet-file ceiling (sweepBackgroundWork)', () => {
  function probe(initial: boolean | null) {
    let live: boolean | null = initial;
    return { set: (v: boolean | null) => { live = v; }, fn: () => live };
  }

  it('registry death completes a running FOREGROUND row too', async () => {
    const p = probe(true);
    const mgr = makeManager({ livenessProbe: p.fn });
    await feed(mgr, [userRecord('go')]);
    await spawnForeground(mgr);
    expect(row(mgr, FG_TOOL).running).toBe(true);
    // Arm the seen-live latch, then the process exits.
    mgr.sweepBackgroundWork(Date.now());
    p.set(false);
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(true);
    expect(row(mgr, FG_TOOL).running).toBe(false);
  });

  it('while the registry says live, a quiet background agent is NOT force-completed', async () => {
    const mgr = makeManager({ livenessProbe: () => true });
    await spawnBackground(mgr);
    const file = writeAgent(AGENT_ID, [agentToolUse('t1')]);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(false);
    expect(row(mgr, BG_TOOL).running).toBe(true);
  });

  it('while liveness is unknown, the ceiling still force-completes a quiet background agent', async () => {
    const mgr = makeManager({ livenessProbe: () => null });
    await spawnBackground(mgr);
    const file = writeAgent(AGENT_ID, [agentToolUse('t1')]);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(true);
    expect(row(mgr, BG_TOOL).running).toBe(false);
  });
});

describe('adversarial review regressions (2026-10-02)', () => {
  it('a row D3 closed early, then revived by the growth sweep on a finished delta, closes again', async () => {
    const mgr = makeManager({ livenessProbe: () => true });
    await spawnBackground(mgr);
    const file = writeAgent(AGENT_ID, [agentToolUse('t1'), agentToolResult('t1'), agentText('Started a background build; waiting on it.', 'end_turn')]);
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(false); // D3 on the interim end_turn
    // The agent wakes and finishes inside one sweep window.
    fs.appendFileSync(file, JSON.stringify({ isSidechain: true, type: 'user', timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'background build done' }] } }) + '\n');
    fs.appendFileSync(file, agentText('Build passed. Final report.', 'end_turn') + '\n');
    await feed(mgr, [enqueue(notification({ result: 'Final report' }))]);
    for (let i = 0; i < 6; i++) { await mgr.sweepRevivedSubagents(Date.now()); }
    const r = row(mgr, BG_TOOL);
    expect(r.running).toBe(false);
    expect(r.resultPreview).toBe('Final report');
    expect(mgr.hasLiveBackgroundAgents()).toBe(false);
  });

  it('with a live registry, a quiet background row whose transcript ended cleanly is healed', async () => {
    const mgr = makeManager({ livenessProbe: () => true });
    await spawnBackground(mgr);
    // No poll has read the file, standing in for any missed D3.
    const file = writeAgent(AGENT_ID, [agentToolUse('t1'), agentToolResult('t1'), agentText('Done.', 'end_turn')]);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(mgr.sweepBackgroundWork(Date.now())).toBe(true);
    expect(row(mgr, BG_TOOL).running).toBe(false);
  });

  it('a tailer released by SubagentStop resumes at its offset, not byte 0', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager({ hookRouter: router });
    await feed(mgr, [userRecord('go')]);
    writeAgent('fg1', [agentToolUse('t1'), agentToolResult('t1'), agentToolUse('t2'), agentToolResult('t2'), agentText('Report.', 'end_turn')], FG_TOOL);
    await spawnForeground(mgr);
    await feed(mgr, []);
    expect(row(mgr, FG_TOOL).toolsCompleted).toBe(2);
    router.onHookEvent(SID, 'SubagentStop', { agent_id: 'fg1', agent_type: 'general-purpose' });
    await feed(mgr, []);
    expect(row(mgr, FG_TOOL).toolsCompleted).toBe(2);
  });

  it('a revival that hit the tailer cap is opened later at its watermark, not byte 0', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    writeAgent('xx', [agentToolUse('t1'), agentToolResult('t1'), agentText('Done.', 'end_turn')], 'toolu_X');
    await spawnForeground(mgr, 'toolu_X');
    await feed(mgr, []);
    await feed(mgr, [toolResultRecord('toolu_X', 'Done.')]);
    expect(row(mgr, 'toolu_X').toolsCompleted).toBe(1);
    for (let i = 0; i < 10; i++) { writeAgent('f' + i, [agentToolUse('q' + i)], 'toolu_f' + i); await spawnForeground(mgr, 'toolu_f' + i); }
    await feed(mgr, []);
    expect(mgr.getActiveSubagentTailerCount()).toBe(10);
    await feed(mgr, [toolUseRecord('SendMessage', 'toolu_sm', { to: 'xx' }),
      toolResultRecord('toolu_sm', JSON.stringify({ success: true, message: 'Resuming agent xx', resumedAgentId: 'xx', pin: { id: 'xx' } }))]);
    await new Promise(r => setTimeout(r, 20));
    expect(row(mgr, 'toolu_X').running).toBe(true);
    await feed(mgr, [toolResultRecord('toolu_f0', 'ok')]); // frees a slot
    await feed(mgr, []);
    const offsets = tailerConstructions.filter(c => c.filePath.endsWith('agent-xx.jsonl')).map(c => c.initialOffset);
    expect(offsets.slice(1).every(o => o > 0)).toBe(true);
    expect(row(mgr, 'toolu_X').toolsCompleted).toBe(1);
    expect(row(mgr, 'toolu_X').running).toBe(true); // the old end_turn is not re-read
  });

  it('D3 waits while the read is behind the file (a partial line or a capped slice)', async () => {
    const mgr = makeManager();
    await spawnBackground(mgr);
    const file = writeAgent(AGENT_ID, [agentText('Done for now.', 'end_turn')]);
    // A record still being written: no trailing newline yet.
    const next = agentToolResult('peer');
    fs.appendFileSync(file, next.slice(0, 40));
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(true);
    fs.appendFileSync(file, next.slice(40) + '\n');
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(true); // the run went on past that end_turn
  });

  it('a skill-fork transcript (meta without toolUseId) is never claimed', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('go')]);
    writeAgent('old1', [agentText('Done.', 'end_turn')], 'toolu_OLD');
    await spawnForeground(mgr, 'toolu_OLD');
    await feed(mgr, []);
    await feed(mgr, [toolResultRecord('toolu_OLD', 'Done.')]);
    writeAgent('fork1', [agentText('Review findings.', 'end_turn')]);
    fs.writeFileSync(path.join(subagentsDir, 'agent-fork1.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: true }));
    await spawnForeground(mgr, 'toolu_NEW'); // its own file not written yet
    await feed(mgr, []);
    expect(row(mgr, 'toolu_NEW').agentId).toBeNull();
    writeAgent('new1', [agentToolUse('z')], 'toolu_NEW');
    await feed(mgr, []);
    expect(row(mgr, 'toolu_NEW').agentId).toBe('new1');
  });

  it('a later run\'s notification replaces the earlier run\'s preview on a done row', async () => {
    const mgr = makeManager({ livenessProbe: () => true });
    await spawnBackground(mgr);
    const file = writeAgent(AGENT_ID, [agentToolUse('t1')]);
    await feed(mgr, []);
    await feed(mgr, [enqueue(notification({ result: 'RUN ONE result' }))]);
    // Run 2: revived without an inline record, finished inside one sweep window.
    fs.appendFileSync(file, agentToolResult('t1') + '\n'
      + JSON.stringify({ isSidechain: true, type: 'user', timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'peer message' }] } }) + '\n'
      + agentText('RUN TWO answer', 'end_turn') + '\n');
    await feed(mgr, [enqueue(notification({ result: 'RUN TWO result' }))]);
    for (let i = 0; i < 6; i++) { await mgr.sweepRevivedSubagents(Date.now()); }
    const r = row(mgr, BG_TOOL);
    expect(r.running).toBe(false);
    expect(r.resultPreview).toBe('RUN TWO result');
  });

  it('D3 blocked by a partial line still fires when the next batch holds only that line', async () => {
    const mgr = makeManager({ livenessProbe: () => true });
    await spawnBackground(mgr);
    const file = writeAgent(AGENT_ID, [agentToolUse('t1'), agentToolResult('t1'), agentText('All done.', 'end_turn')]);
    const att = JSON.stringify({ isSidechain: true, type: 'attachment', timestamp: new Date().toISOString(),
      attachment: { type: 'hook_success', hookName: 'SubagentStop' } });
    fs.appendFileSync(file, att.slice(0, 20));
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(true);
    fs.appendFileSync(file, att.slice(20) + '\n');
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(false);
  });

  it('a revival reopen in flight across forceReplay() does not tail the orphaned row', async () => {
    const mgr = makeManager();
    await spawnBackground(mgr);
    writeAgent(AGENT_ID, [agentText('done', 'end_turn')]);
    await feed(mgr, []);
    expect(row(mgr, BG_TOOL).running).toBe(false);
    const statMock = fs.promises.stat as unknown as ReturnType<typeof vi.fn>;
    const orig = statMock.getMockImplementation()!;
    statMock.mockImplementationOnce(async (...a: unknown[]) => {
      await new Promise(r => setTimeout(r, 50));
      return (orig as (...x: unknown[]) => unknown)(...a);
    });
    await feed(mgr, [toolUseRecord('SendMessage', 'toolu_sm', { to: AGENT_ID }),
      toolResultRecord('toolu_sm', JSON.stringify({ success: true, message: `Resuming agent ${AGENT_ID}`, resumedAgentId: AGENT_ID }))]);
    await mgr.forceReplay();
    await new Promise(r => setTimeout(r, 80));
    expect(mgr.getSnapshot().subagents).toHaveLength(0);
    expect(mgr.getActiveSubagentTailerCount()).toBe(0);
  });
});
