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
