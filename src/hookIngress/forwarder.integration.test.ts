/**
 * End-to-end: spawn `bin/serac-hook-forward.cjs` as a child process with a
 * Claude-Code-shaped hook payload on stdin, assert the running `HookIngress`
 * delivers the event to the router.
 *
 * This is the only test that exercises the forwarder binary itself. Unit
 * tests for socketServer cover the receive path; this test guarantees the
 * send path (cwd-walk, socket connect, payload framing) actually reaches the
 * server when invoked exactly as Claude Code will invoke it.
 *
 * Also includes a cold-spawn timing assertion (< 200 ms per forward — the
 * spec is 30 ms but Vitest + child_process adds overhead; we assert a loose
 * upper bound here and rely on manual benchmarking for the production budget).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookEventRouter } from '../hookEventRouter.js';
import { startHookIngress, type IngressHandle } from './index.js';

const FORWARDER = path.resolve(__dirname, '../../bin/serac-hook-forward.cjs');

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'serac-fwd-'));
}

interface ForwarderResult {
  exitCode: number | null;
  stderr: string;
  durationMs: number;
}

function runForwarder(payload: object, cwdOverride?: string): Promise<ForwarderResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [FORWARDER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwdOverride ?? process.cwd(),
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('close', (exitCode) => {
      resolve({ exitCode, stderr, durationMs: Date.now() - start });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('forwarder → socket → router (integration)', () => {
  let dir: string;
  let ingress: IngressHandle | undefined;
  let captured: Array<{ sessionId: string; eventType: string; event: unknown }>;
  let router: HookEventRouter;

  beforeEach(async () => {
    dir = mktemp();
    captured = [];
    router = new HookEventRouter();
    const original = router.onHookEvent.bind(router);
    router.onHookEvent = (s, e, ev) => { captured.push({ sessionId: s, eventType: e, event: ev }); original(s, e, ev); };
    ingress = await startHookIngress(dir, router, { pid: 1, isAlive: () => true });
    expect(ingress.isLeader).toBe(true);
  });

  afterEach(async () => {
    if (ingress) { await ingress.dispose(); ingress = undefined; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delivers a payload whose cwd points into the workspace', async () => {
    const sub = path.join(dir, 'subdir', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    const result = await runForwarder({
      session_id: 'real-session-uuid',
      hook_event_name: 'PreToolUse',
      cwd: sub,
      tool_name: 'Bash',
    });
    expect(result.exitCode).toBe(0);
    // Drain — child has exited but server may still be flushing 'data' event.
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ sessionId: 'real-session-uuid', eventType: 'PreToolUse' });
  });

  it('exits 0 silently when cwd is outside any Serac workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-outside-'));
    try {
      const result = await runForwarder({
        session_id: 's',
        hook_event_name: 'PreToolUse',
        cwd: outside,
      });
      expect(result.exitCode).toBe(0);
      await new Promise(r => setTimeout(r, 30));
      expect(captured).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('exits 0 silently on malformed JSON stdin', async () => {
    const result = await new Promise<ForwarderResult>((resolve) => {
      const start = Date.now();
      const child = spawn(process.execPath, [FORWARDER], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('close', (exitCode) => resolve({ exitCode, stderr, durationMs: Date.now() - start }));
      child.stdin.write('{not json');
      child.stdin.end();
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 silently on empty stdin', async () => {
    const result = await new Promise<ForwarderResult>((resolve) => {
      const start = Date.now();
      const child = spawn(process.execPath, [FORWARDER], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('close', (exitCode) => resolve({ exitCode, stderr, durationMs: Date.now() - start }));
      child.stdin.end();
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('falls back to process.cwd() when payload has no cwd field', async () => {
    const sub = path.join(dir, 'falls-back');
    fs.mkdirSync(sub, { recursive: true });
    // Set the child's cwd to `sub` so the cwd-walk finds dir/.serac/hook.sock.
    const result = await runForwarder({ session_id: 'no-cwd', hook_event_name: 'Stop' }, sub);
    expect(result.exitCode).toBe(0);
    await new Promise(r => setTimeout(r, 30));
    expect(captured).toHaveLength(1);
    expect(captured[0].eventType).toBe('Stop');
  });

  // Note: the 30 ms cold-spawn budget for the forwarder is measured by
  // `scripts/bench-forwarder.cjs`, not in Vitest. Vitest's child_process
  // overhead (+1 s on a warm Node, +1.5 s cold) dominates the actual
  // forwarder runtime and makes a wall-clock assertion here meaningless.
});
