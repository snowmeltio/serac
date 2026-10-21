/**
 * Registry-primary status (serac.experimental.registryStatus): while Claude
 * Code's own status gives a verdict, inference may only move the card to the
 * status the registry already says, and syncRegistryStatus() applies it.
 * Scenarios are from the 2026-10-21 shadow log: auto-mode permission prompts
 * Serac never saw, long silent steps it read as done or low confidence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';
import type { RegistryStatusProbe, RegistryStatusVerdict } from './registryStatus.js';

let mockRecords: JsonlRecord[] = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
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

const { SessionManager } = await import('./sessionManager.js');
type SM = InstanceType<typeof SessionManager>;

const BUSY: RegistryStatusVerdict = { status: 'running', raw: 'busy', waitingFor: null, since: 1 };
const IDLE: RegistryStatusVerdict = { status: 'done', raw: 'idle', waitingFor: null, since: 2 };
const PERMISSION: RegistryStatusVerdict = { status: 'waiting', raw: 'waiting', waitingFor: 'permission prompt', since: 3 };
const INPUT: RegistryStatusVerdict = { status: 'waiting', raw: 'waiting', waitingFor: 'input needed', since: 4 };

function probe(initial: RegistryStatusVerdict | null, enabled = true) {
  let v = initial;
  const p: RegistryStatusProbe = { enabled: () => enabled, verdict: () => (enabled ? v : null) };
  return { p, set: (next: RegistryStatusVerdict | null) => { v = next; } };
}

function make(p?: RegistryStatusProbe, transitions?: string[]): SM {
  return new SessionManager('reg-session', '/tmp/reg.jsonl', 'ws', {
    registryStatus: p,
    onTransition: transitions ? (f, t, r) => { transitions.push(`${f}->${t} (${r})`); } : undefined,
  });
}

async function feed(mgr: SM, records: JsonlRecord[]): Promise<void> {
  mockRecords = records;
  await mgr.update();
}

const ts = () => new Date().toISOString();
const user = (text: string, extra: Partial<JsonlRecord> = {}): JsonlRecord =>
  ({ type: 'user', timestamp: ts(), message: { content: [{ type: 'text', text }] }, ...extra });
const say = (text: string): JsonlRecord =>
  ({ type: 'assistant', timestamp: ts(), message: { content: [{ type: 'text', text }] } });
const toolUse = (name: string, id: string, input: Record<string, unknown> = {}): JsonlRecord =>
  ({ type: 'assistant', timestamp: ts(), message: { content: [{ type: 'tool_use', name, id, input }] } });
const toolResult = (id: string, text: string): JsonlRecord =>
  ({ type: 'user', timestamp: ts(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

beforeEach(() => { vi.useFakeTimers(); mockRecords = []; });
afterEach(() => { vi.useRealTimers(); });

describe('registry busy holds the card running', () => {
  it('a quiet stretch after output does not end the turn while the registry says busy', async () => {
    const { p } = probe(BUSY);
    const mgr = make(p);
    await feed(mgr, [user('go'), say('Thinking out loud first.')]);
    vi.advanceTimersByTime(60_000);
    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('running');
  });

  it('without a verdict the same stretch ends the turn, as before', async () => {
    const mgr = make(probe(null).p);
    await feed(mgr, [user('go'), say('Thinking out loud first.')]);
    vi.advanceTimersByTime(60_000);
    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('done');
  });

  it('vetoes the permission timer on a slow tool', async () => {
    const mgr = make(probe(BUSY).p);
    await feed(mgr, [user('go'), toolUse('Bash', 'tu-1', { command: 'npm test' })]);
    vi.advanceTimersByTime(40_000);
    expect(mgr.getStatus()).toBe('running');
    expect(mgr.getSnapshot().activity).not.toBe('Waiting for permission');
  });

  it('reads high confidence through a long silence', async () => {
    const mgr = make(probe(BUSY).p);
    await feed(mgr, [user('go'), toolUse('Bash', 'tu-1', { command: 'cat <<EOF > big' })]);
    vi.advanceTimersByTime(90_000);
    expect(mgr.getSnapshot().confidence).toBe('high');
  });
});

describe('registry waiting', () => {
  it('surfaces an auto-mode permission prompt inference never sees', async () => {
    const reg = probe(BUSY);
    const mgr = make(reg.p);
    await feed(mgr, [user('go', { permissionMode: 'auto' }), toolUse('mcp__plane__project', 'tu-1')]);
    reg.set(PERMISSION);
    expect(mgr.syncRegistryStatus()).toBe(true);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toBe('Waiting for permission');
  });

  it('labels an input wait as waiting for your response', async () => {
    const reg = probe(BUSY);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'), toolUse('AskUserQuestion', 'tu-q')]);
    reg.set(INPUT);
    mgr.syncRegistryStatus();
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toBe('Waiting for your response');
  });

  it('back to busy reopens running with a neutral subtitle', async () => {
    const reg = probe(PERMISSION);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'), toolUse('Bash', 'tu-1')]);
    mgr.syncRegistryStatus();
    reg.set(BUSY);
    mgr.syncRegistryStatus();
    expect(mgr.getStatus()).toBe('running');
    expect(mgr.getSnapshot().activity).not.toMatch(/^Waiting/);
  });
});

describe('registry idle ends the turn', () => {
  it('done with reason registry_idle; a trailing record does not reopen it', async () => {
    const transitions: string[] = [];
    const reg = probe(BUSY);
    const mgr = make(reg.p, transitions);
    await feed(mgr, [user('go'), say('All done.')]);
    reg.set(IDLE);
    mgr.syncRegistryStatus();
    expect(mgr.getStatus()).toBe('done');
    expect(transitions).toContain('running->done (registry_idle)');
    await feed(mgr, [say('(trailing record of the same turn)')]);
    expect(mgr.getStatus()).toBe('done');
  });

  it('closes a foreground agent row and keeps a background one', async () => {
    const reg = probe(BUSY);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'),
      toolUse('Agent', 'tu-fg', { description: 'fg', prompt: 'x' }),
      toolUse('Agent', 'tu-bg', { description: 'bg', prompt: 'y', run_in_background: true })]);
    await feed(mgr, [toolResult('tu-bg', 'Async agent launched successfully.\nagentId: abcdef0123456789a (internal ID)')]);
    reg.set(IDLE);
    mgr.syncRegistryStatus();
    const rows = mgr.getSnapshot().subagents;
    expect(rows.find(r => r.parentToolUseId === 'tu-fg')!.running).toBe(false);
    expect(rows.find(r => r.parentToolUseId === 'tu-bg')!.running).toBe(true);
  });

  it('a transcript-only dequeue cannot reopen a session the registry says is idle', async () => {
    const reg = probe(IDLE);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'), say('done')]);
    mgr.syncRegistryStatus();
    await feed(mgr, [{ type: 'queue-operation', operation: 'dequeue', timestamp: ts() }]);
    expect(mgr.getStatus()).toBe('done');
  });

  it('an interrupt while busy leaves the turn to the registry', async () => {
    const reg = probe(BUSY);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'), toolUse('Bash', 'tu-1')]);
    await feed(mgr, [user('[Request interrupted by user]')]);
    expect(mgr.getStatus()).toBe('running');
    reg.set(IDLE);
    mgr.syncRegistryStatus();
    expect(mgr.getStatus()).toBe('done');
  });
});

describe('hand-back and parity', () => {
  it('a verdict that goes away hands control back to inference', async () => {
    const reg = probe(BUSY);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'), say('done for now')]);
    vi.advanceTimersByTime(60_000);
    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('running'); // vetoed while busy
    reg.set(null);
    vi.advanceTimersByTime(31_000);
    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('done');
  });

  it('a replay under a busy verdict does not keep a dead turn\'s leftovers', async () => {
    // A turn interrupted mid-Agent, then a new turn: the old foreground row and
    // its tool must close at the interrupt even though the registry says busy.
    const mgr = make(probe(BUSY).p);
    await feed(mgr, [
      user('go'),
      toolUse('Agent', 'tu-old', { description: 'old', prompt: 'x' }),
      user('[Request interrupted by user]'),
      user('next'),
      say('working on next'),
    ]);
    expect(mgr.getSnapshot().subagents.find(r => r.parentToolUseId === 'tu-old')!.running).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('a vetoed reopen leaves the waiting subtitle alone', async () => {
    const reg = probe(PERMISSION);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'), toolUse('Bash', 'tu-1')]);
    mgr.syncRegistryStatus();
    await feed(mgr, [{ type: 'queue-operation', operation: 'dequeue', timestamp: ts() }]);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().activity).toBe('Waiting for permission');
  });

  it('flag off is identical to no probe at all', async () => {
    async function run(p?: RegistryStatusProbe): Promise<string[]> {
      const t: string[] = [];
      const mgr = make(p, t);
      await feed(mgr, [user('go'), toolUse('Bash', 'tu-1')]);
      vi.advanceTimersByTime(20_000);
      await feed(mgr, [toolResult('tu-1', 'ok'), say('Finished.')]);
      vi.advanceTimersByTime(10_000);
      mgr.demoteIfStale(30_000);
      await feed(mgr, [{ type: 'queue-operation', operation: 'dequeue', timestamp: ts() }]);
      await feed(mgr, [user('[Request interrupted by user]')]);
      return t;
    }
    expect(await run(probe(BUSY, false).p)).toEqual(await run(undefined));
  });

  it('records the last live running transition for the acknowledgement reset', async () => {
    const reg = probe(IDLE);
    const mgr = make(reg.p);
    await feed(mgr, [user('go'), say('x')]);
    mgr.syncRegistryStatus();
    expect(mgr.getStatus()).toBe('done');
    vi.advanceTimersByTime(1_000);
    reg.set(BUSY);
    mgr.syncRegistryStatus();
    expect(mgr.getLastLiveRunningAt()).toBe(Date.now());
  });
});
