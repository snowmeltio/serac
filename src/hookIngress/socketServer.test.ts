import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookEventRouter } from '../hookEventRouter.js';
import { startSocketServer, MAX_LINE_BYTES, type SocketServerHandle } from './socketServer.js';

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'serac-sock-'));
}

function socketPathIn(dir: string): string {
  return path.join(dir, 'hook.sock');
}

function writeToSocket(socketPath: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    conn.once('connect', () => {
      conn.end(payload, () => resolve());
    });
    conn.once('error', reject);
  });
}

interface Captured {
  router: HookEventRouter;
  events: Array<{ sessionId: string; eventType: string; event: unknown }>;
  errors: Array<{ message: string; context: string }>;
}

function makeCaptured(): Captured {
  const events: Captured['events'] = [];
  const errors: Captured['errors'] = [];
  const router = new HookEventRouter();
  // Wrap onHookEvent so we observe what the server forwards. Easier than
  // registering per (sessionId, eventType) for every test variant.
  const originalOnHookEvent = router.onHookEvent.bind(router);
  router.onHookEvent = (sessionId, eventType, event) => {
    events.push({ sessionId, eventType, event });
    originalOnHookEvent(sessionId, eventType, event);
  };
  return { router, events, errors };
}

async function withServer<T>(
  dir: string,
  captured: Captured,
  body: (handle: SocketServerHandle) => Promise<T>,
): Promise<T> {
  const handle = await startSocketServer(socketPathIn(dir), captured.router, {
    onError: (err, ctx) => captured.errors.push({ message: err.message, context: ctx }),
  });
  try { return await body(handle); }
  finally { await handle.dispose(); }
}

describe('startSocketServer', () => {
  let dir: string;
  beforeEach(() => { dir = mktemp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('routes a single newline-terminated payload to the router', async () => {
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      const payload = { session_id: 's1', hook_event_name: 'PreToolUse', tool: 'Bash' };
      await writeToSocket(h.socketPath, JSON.stringify(payload) + '\n');
      // Drain Node's event loop so 'data' / 'end' run.
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events).toHaveLength(1);
    expect(c.events[0]).toMatchObject({ sessionId: 's1', eventType: 'PreToolUse' });
  });

  it('routes a payload without trailing newline (delivered on connection end)', async () => {
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      const payload = { session_id: 's2', hook_event_name: 'SessionStart' };
      await writeToSocket(h.socketPath, JSON.stringify(payload));
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events).toHaveLength(1);
    expect(c.events[0]).toMatchObject({ sessionId: 's2', eventType: 'SessionStart' });
  });

  it('routes multiple newline-delimited payloads on one connection', async () => {
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      const p1 = { session_id: 's3', hook_event_name: 'PreToolUse' };
      const p2 = { session_id: 's3', hook_event_name: 'PostToolUse' };
      await writeToSocket(h.socketPath, JSON.stringify(p1) + '\n' + JSON.stringify(p2) + '\n');
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events.map(e => e.eventType)).toEqual(['PreToolUse', 'PostToolUse']);
  });

  it('drops malformed JSON and reports via onError', async () => {
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      await writeToSocket(h.socketPath, '{not json\n');
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events).toHaveLength(0);
    expect(c.errors.some(e => e.context === 'json-parse')).toBe(true);
  });

  it('drops payloads missing session_id', async () => {
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      await writeToSocket(h.socketPath, JSON.stringify({ hook_event_name: 'X' }) + '\n');
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events).toHaveLength(0);
    expect(c.errors.some(e => e.context === 'shape')).toBe(true);
  });

  it('drops payloads missing hook_event_name', async () => {
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      await writeToSocket(h.socketPath, JSON.stringify({ session_id: 's' }) + '\n');
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events).toHaveLength(0);
    expect(c.errors.some(e => e.context === 'shape')).toBe(true);
  });

  it('drops oversize lines and continues serving', async () => {
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      const huge = 'x'.repeat(MAX_LINE_BYTES + 100);
      // Send oversize without newline. Server should reject and close conn.
      await new Promise<void>((resolve) => {
        const conn = net.createConnection(h.socketPath);
        conn.once('connect', () => conn.end(huge));
        conn.once('close', () => resolve());
        conn.once('error', () => resolve());
      });
      // Server should still respond to a follow-up valid payload.
      await writeToSocket(h.socketPath, JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }) + '\n');
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.errors.some(e => e.context === 'oversize')).toBe(true);
    expect(c.events).toHaveLength(1);
    expect(c.events[0].eventType).toBe('Stop');
  });

  it('unlinks a stale socket file before binding', async () => {
    // Pre-create a regular file at the socket path; server should unlink + bind.
    fs.writeFileSync(path.join(dir, 'hook.sock'), 'stale');
    const c = makeCaptured();
    await withServer(dir, c, async (h) => {
      await writeToSocket(h.socketPath, JSON.stringify({ session_id: 's', hook_event_name: 'X' }) + '\n');
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events).toHaveLength(1);
  });

  it('dispose() removes the socket file and is idempotent', async () => {
    const c = makeCaptured();
    const handle = await startSocketServer(socketPathIn(dir), c.router, { onError: () => {} });
    expect(fs.existsSync(handle.socketPath)).toBe(true);
    await handle.dispose();
    expect(fs.existsSync(handle.socketPath)).toBe(false);
    await handle.dispose();  // no throw
  });

  it('routes a real spike payload (SessionStart shape)', async () => {
    const c = makeCaptured();
    const spike = {
      session_id: '0acde392-2161-4b7b-b5dd-b52a7bda51c0',
      transcript_path: '/Users/x/.claude/projects/-tmp/0acde392.jsonl',
      cwd: '/private/tmp/work',
      hook_event_name: 'SessionStart',
      source: 'startup',
    };
    await withServer(dir, c, async (h) => {
      await writeToSocket(h.socketPath, JSON.stringify(spike) + '\n');
      await new Promise(r => setTimeout(r, 20));
    });
    expect(c.events).toHaveLength(1);
    expect(c.events[0].sessionId).toBe(spike.session_id);
    expect(c.events[0].eventType).toBe('SessionStart');
    expect((c.events[0].event as { source?: string }).source).toBe('startup');
  });
});
