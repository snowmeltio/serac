/**
 * Replay harness — proves SessionManager's transition stream is reproducible
 * from a JSONL fixture. Foundation for Phase 2c real-world capture/regression.
 *
 * Mechanism:
 *   1. Write a JSONL fixture to a tmp file (synthetic for now; Phase 2c will
 *      add captured real-session fixtures).
 *   2. Construct SessionManager pointing at that file, with onTransition
 *      capturing every (from, to, reason) tuple.
 *   3. Run update() to drain the file; assert the transition stream.
 *
 * Adding a real-session fixture later: drop the .jsonl into a stable
 * location and call replayFixture(path) — the harness is fixture-agnostic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import type { SessionStatus } from './types.js';

interface Transition {
  from: SessionStatus;
  to: SessionStatus;
  reason: string;
}

interface ReplayResult {
  transitions: Transition[];
  finalStatus: SessionStatus;
}

/** Write a JSONL fixture and replay it through a fresh SessionManager.
 *  Returns the captured transition stream. */
async function replayFixture(records: object[]): Promise<ReplayResult> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'replay-'));
  const file = path.join(dir, 'session.jsonl');
  const body = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.promises.writeFile(file, body);

  const transitions: Transition[] = [];
  const mgr = new SessionManager('replay-sid', file, 'replay-ws', {
    onTransition: (from, to, reason) => transitions.push({ from, to, reason }),
  });
  await mgr.update();
  const finalStatus = mgr.getStatus();
  mgr.dispose();
  await fs.promises.rm(dir, { recursive: true, force: true });

  return { transitions, finalStatus };
}

function ts(): string { return new Date().toISOString(); }

describe('SessionManager replay harness', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('user record produces a single done→running transition', async () => {
    const { transitions, finalStatus } = await replayFixture([
      { type: 'user', timestamp: ts(),
        message: { content: [{ type: 'text', text: 'hello' }] } },
    ]);
    expect(transitions).toEqual([
      { from: 'done', to: 'running', reason: 'set_running' },
    ]);
    expect(finalStatus).toBe('running');
  });

  it('AskUserQuestion tool_use transitions running → waiting', async () => {
    const { transitions, finalStatus } = await replayFixture([
      { type: 'user', timestamp: ts(),
        message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', timestamp: ts(),
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'tu1' }] } },
    ]);
    expect(transitions).toEqual([
      { from: 'done', to: 'running', reason: 'set_running' },
      { from: 'running', to: 'waiting', reason: 'needs_user_input' },
    ]);
    expect(finalStatus).toBe('waiting');
  });

  it('enqueue → dequeue flips done → done (no-op) → running', async () => {
    // enqueue lands first (state already 'done' on a fresh session → no transition)
    // dequeue then sets running.
    const { transitions } = await replayFixture([
      { type: 'queue-operation', operation: 'enqueue', timestamp: ts() },
      { type: 'queue-operation', operation: 'dequeue', timestamp: ts() },
    ]);
    // No done→done transition is emitted (setStatus is a no-op when prev === next).
    expect(transitions).toEqual([
      { from: 'done', to: 'running', reason: 'set_running' },
    ]);
  });

  it('compact_boundary on a fresh session transitions done → running', async () => {
    const { transitions, finalStatus } = await replayFixture([
      { type: 'system', subtype: 'compact_boundary', timestamp: ts() },
    ]);
    expect(transitions).toEqual([
      { from: 'done', to: 'running', reason: 'set_running' },
    ]);
    expect(finalStatus).toBe('running');
  });

  it('default onTransition is a no-op (constructor without opts)', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'replay-noop-'));
    const file = path.join(dir, 'session.jsonl');
    await fs.promises.writeFile(file,
      JSON.stringify({ type: 'user', timestamp: ts(),
        message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const mgr = new SessionManager('sid', file, 'ws');  // no opts
    await expect(mgr.update()).resolves.toBe(true);
    expect(mgr.getStatus()).toBe('running');
    mgr.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});

describe('Background-shell completion replay (e2e, BACKLOG item)', () => {
  // The full lifecycle the tracker unit tests cover only in pieces: launch
  // banner → turn ends (badge on a done card) → CC re-invokes the model when
  // the shell finishes → terminal retrieval clears the badge → cold replay of
  // the SAME file never resurrects it.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function rec(type: string, content: object[], at: number): object {
    return { type, timestamp: new Date(at).toISOString(), message: { content } };
  }
  const LAUNCH_TEXT = 'Command running in background with ID: bash_42. Output is being written to /tmp/x.out.';
  const RETRIEVAL_TEXT = '<task_id>bash_42</task_id>\n<status>completed</status>\n<stdout>finished</stdout>';

  function launchTurn(t0: number): object[] {
    return [
      rec('user', [{ type: 'text', text: 'deploy it' }], t0),
      rec('assistant', [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { run_in_background: true } }], t0 + 1000),
      rec('user', [{ type: 'tool_result', tool_use_id: 'tu-bash', content: [{ type: 'text', text: LAUNCH_TEXT }] }], t0 + 2000),
      rec('assistant', [{ type: 'text', text: 'Stand by — the deploy keeps running in the background.' }], t0 + 3000),
    ];
  }

  async function makeLive(records: object[]): Promise<{ mgr: SessionManager; file: string; dir: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bgshell-e2e-'));
    const file = path.join(dir, 'session.jsonl');
    await fs.promises.writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const mgr = new SessionManager('bg-sid', file, 'bg-ws');
    await mgr.update();
    return { mgr, file, dir };
  }

  it('badge rides the done card after the turn ends, while the shell is outstanding', async () => {
    const t0 = Date.now() - 30_000;
    const { mgr, dir } = await makeLive(launchTurn(t0));
    await vi.advanceTimersByTimeAsync(6_000); // 5s idle demote (output was seen)
    expect(mgr.getStatus()).toBe('done');
    expect(mgr.getSnapshot().backgroundShellCount).toBe(1);
    mgr.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('completion replay: re-invocation flips running, terminal retrieval clears the badge', async () => {
    const t0 = Date.now() - 30_000;
    const { mgr, file, dir } = await makeLive(launchTurn(t0));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mgr.getSnapshot().backgroundShellCount).toBe(1);

    // Shell finishes → CC re-invokes the model → assistant record arrives.
    const t1 = Date.now();
    await fs.promises.appendFile(file, JSON.stringify(
      rec('assistant', [{ type: 'tool_use', id: 'tu-check', name: 'TaskOutput', input: {} }], t1)) + '\n');
    await mgr.update();
    expect(mgr.getStatus()).toBe('running'); // normal path, no special-casing

    // The terminal retrieval lands as an ordinary tool_result.
    await fs.promises.appendFile(file, JSON.stringify(
      rec('user', [{ type: 'tool_result', tool_use_id: 'tu-check', content: [{ type: 'text', text: RETRIEVAL_TEXT }] }], t1 + 500)) + '\n');
    await mgr.update();
    expect(mgr.getSnapshot().backgroundShellCount).toBeUndefined(); // cleared (0 → undefined)

    // Model closes the re-invocation turn with a normal reply.
    await fs.promises.appendFile(file, JSON.stringify(
      rec('assistant', [{ type: 'text', text: 'Deploy finished cleanly.' }], t1 + 1000)) + '\n');
    await mgr.update();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mgr.getStatus()).toBe('done'); // settles back with no badge
    expect(mgr.getSnapshot().backgroundShellCount).toBeUndefined();
    mgr.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('cold replay of the completed lifecycle never resurrects the badge', async () => {
    const t0 = Date.now() - 30_000;
    const all = [
      ...launchTurn(t0),
      rec('assistant', [{ type: 'tool_use', id: 'tu-check', name: 'TaskOutput', input: {} }], t0 + 10_000),
      rec('user', [{ type: 'tool_result', tool_use_id: 'tu-check', content: [{ type: 'text', text: RETRIEVAL_TEXT }] }], t0 + 11_000),
    ];
    const { mgr, dir } = await makeLive(all); // fresh manager = window reload replay
    expect(mgr.getSnapshot().backgroundShellCount).toBeUndefined();
    mgr.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});

describe('file-history-snapshot → SessionSnapshot.trackedFiles', () => {
  async function withRecords(records: object[]): Promise<{ mgr: SessionManager; dir: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fhs-'));
    const file = path.join(dir, 's.jsonl');
    await fs.promises.writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    const mgr = new SessionManager('fhs-sid', file, 'ws');
    await mgr.update();
    return { mgr, dir };
  }
  const ts = () => new Date().toISOString();
  const snap = (files: string[]) => ({
    type: 'file-history-snapshot', timestamp: ts(),
    snapshot: { messageId: 'm1', trackedFileBackups: Object.fromEntries(files.map(f => [f, { backupId: 'b' }])), timestamp: ts() },
  });

  it('exposes the tracked paths, latest snapshot wins', async () => {
    const { mgr, dir } = await withRecords([
      { type: 'user', timestamp: ts(), message: { content: [{ type: 'text', text: 'go' }] } },
      snap(['/r/a.ts', '/r/b.ts']),
      snap(['/r/b.ts']),
    ]);
    expect(mgr.getSnapshot().trackedFiles).toEqual(['/r/b.ts']);
    mgr.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('absent/empty/malformed snapshots leave trackedFiles undefined', async () => {
    const { mgr, dir } = await withRecords([
      { type: 'user', timestamp: ts(), message: { content: [{ type: 'text', text: 'go' }] } },
      { type: 'file-history-snapshot', timestamp: ts(), snapshot: { trackedFileBackups: [] } },
      { type: 'file-history-snapshot', timestamp: ts() },
    ]);
    expect(mgr.getSnapshot().trackedFiles).toBeUndefined();
    mgr.dispose();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});
