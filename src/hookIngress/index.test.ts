import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookEventRouter } from '../hookEventRouter.js';
import { startHookIngress, maxSocketPathBytes } from './index.js';

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'serac-ingress-'));
}

function writeToSocket(socketPath: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    conn.once('connect', () => { conn.end(payload, () => resolve()); });
    conn.once('error', reject);
  });
}

describe('startHookIngress', () => {
  let dir: string;
  beforeEach(() => { dir = mktemp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('first caller becomes leader and binds the socket', async () => {
    const router = new HookEventRouter();
    const ingress = await startHookIngress(dir, router, { pid: 1, isAlive: () => true });
    expect(ingress.isLeader).toBe(true);
    expect(ingress.socketPath).toBe(path.join(dir, '.serac', 'hook.sock'));
    expect(fs.existsSync(ingress.socketPath!)).toBe(true);
    await ingress.dispose();
  });

  it('second caller becomes follower and does not bind the socket', async () => {
    const r1 = new HookEventRouter();
    const r2 = new HookEventRouter();
    const a = await startHookIngress(dir, r1, { pid: 1, isAlive: () => true });
    const b = await startHookIngress(dir, r2, { pid: 2, isAlive: () => true });
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    expect(b.socketPath).toBeUndefined();
    await b.dispose();
    await a.dispose();
  });

  it('leader routes inbound payloads to its router', async () => {
    const events: Array<{ sessionId: string; eventType: string }> = [];
    const router = new HookEventRouter();
    const original = router.onHookEvent.bind(router);
    router.onHookEvent = (s, e, ev) => { events.push({ sessionId: s, eventType: e }); original(s, e, ev); };

    const ingress = await startHookIngress(dir, router, { pid: 1, isAlive: () => true });
    expect(ingress.isLeader).toBe(true);
    await writeToSocket(ingress.socketPath!, JSON.stringify({ session_id: 'abc', hook_event_name: 'PreToolUse' }) + '\n');
    await new Promise(r => setTimeout(r, 20));
    expect(events).toEqual([{ sessionId: 'abc', eventType: 'PreToolUse' }]);
    await ingress.dispose();
  });

  it('dispose() closes socket and releases lock; a fresh caller becomes new leader', async () => {
    const a = await startHookIngress(dir, new HookEventRouter(), { pid: 1, isAlive: () => true });
    expect(a.isLeader).toBe(true);
    await a.dispose();
    expect(fs.existsSync(path.join(dir, '.serac', 'hook.sock'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.serac', 'hook.lock'))).toBe(false);

    const b = await startHookIngress(dir, new HookEventRouter(), { pid: 2, isAlive: () => true });
    expect(b.isLeader).toBe(true);
    await b.dispose();
  });

  it('dispose() is idempotent', async () => {
    const h = await startHookIngress(dir, new HookEventRouter(), { pid: 1, isAlive: () => true });
    await h.dispose();
    await h.dispose();  // no throw
  });

  it('reclaims stale leader (dead PID)', async () => {
    fs.mkdirSync(path.join(dir, '.serac'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.serac', 'hook.lock'), '99999');
    const h = await startHookIngress(dir, new HookEventRouter(), { pid: 1, isAlive: () => false });
    expect(h.isLeader).toBe(true);
    await h.dispose();
  });

  it('releaseSync frees the lock and socket at once, so the next window leads', async () => {
    const a = await startHookIngress(dir, new HookEventRouter(), { pid: 1, isAlive: () => true });
    a.releaseSync();
    expect(fs.existsSync(path.join(dir, '.serac', 'hook.lock'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.serac', 'hook.sock'))).toBe(false);
    const b = await startHookIngress(dir, new HookEventRouter(), { pid: 2, isAlive: () => true });
    expect(b.isLeader).toBe(true);
    b.releaseSync();
  });

  it('releaseSync leaves a successor\'s lock and socket alone', async () => {
    // A's lock looked stale to B (A's process gone), B took over and bound.
    const a = await startHookIngress(dir, new HookEventRouter(), { pid: 1, isAlive: () => true });
    fs.unlinkSync(path.join(dir, '.serac', 'hook.lock'));
    const b = await startHookIngress(dir, new HookEventRouter(), { pid: 2, isAlive: () => false });
    expect(b.isLeader).toBe(true);
    expect(a.heldByOther()).toBe(true);
    expect(b.heldByOther()).toBe(false);
    a.releaseSync();
    expect(fs.readFileSync(path.join(dir, '.serac', 'hook.lock'), 'utf8')).toBe('2');
    expect(fs.existsSync(path.join(dir, '.serac', 'hook.sock'))).toBe(true);
    b.releaseSync();
  });

  it('a missing lock is not held by another window', async () => {
    const a = await startHookIngress(dir, new HookEventRouter(), { pid: 1, isAlive: () => true });
    fs.unlinkSync(path.join(dir, '.serac', 'hook.lock')); // e.g. git clean -fdX
    expect(a.heldByOther()).toBe(false);
    a.releaseSync();
  });

  it('skips a workspace whose socket path is too long, writing nothing there', async () => {
    const deep = path.join(dir, 'x'.repeat(120));
    fs.mkdirSync(path.join(deep, '.serac'), { recursive: true }); // left by an earlier build
    const h = await startHookIngress(deep, new HookEventRouter(), { pid: 1, isAlive: () => true, platform: 'darwin' });
    expect(h.isLeader).toBe(false);
    expect(h.skipped).toBe('socket-path-too-long');
    expect(fs.existsSync(path.join(deep, '.serac'))).toBe(false);
  });

  it('sun_path limits', () => {
    expect(maxSocketPathBytes('darwin')).toBe(103);
    expect(maxSocketPathBytes('linux')).toBe(107);
  });
});
