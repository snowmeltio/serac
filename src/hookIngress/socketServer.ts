/**
 * Unix-socket server that receives Claude Code hook payloads from
 * `bin/serac-hook-forward` and routes each one into a `HookEventRouter`.
 *
 * Wire protocol: newline-delimited JSON. The forwarder typically opens a fresh
 * connection per hook event and writes one line, but the server tolerates
 * multiple lines per connection so a future batching forwarder needs no change
 * here.
 *
 * Each line is parsed as `{ session_id: string, hook_event_name: string, ... }`
 * (the full Claude Code hook payload — see spike captures). The whole payload
 * is forwarded to `router.onHookEvent(session_id, hook_event_name, payload)`;
 * defensive parsing of the *other* fields happens at the subscriber's edge,
 * not here.
 *
 * Failure handling — every error path is fail-open:
 *   - Malformed JSON → dropped silently. The forwarder is dependency-free and
 *     trusted; corrupt input means a bug we want to find in dev, not a crash
 *     in prod.
 *   - Missing `session_id` or `hook_event_name` → dropped.
 *   - Connection error / oversize line → connection dropped, server continues.
 *   - `listen()` failure (e.g. socket path collides with a non-socket file) →
 *     thrown up to the orchestrator, which falls back to JSONL-only.
 *
 * Size cap: per-connection buffer is capped at MAX_LINE_BYTES. The largest
 * payload seen in spike captures is ~3 KB (PreToolUse on a long Bash command).
 * 256 KB is ~85× headroom and still trivially below any DoS threshold.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { HookEventRouter } from '../hookEventRouter.js';

/** Per-connection buffer cap. Connections that exceed this are dropped. */
export const MAX_LINE_BYTES = 256 * 1024;

export interface SocketServerHandle {
  /** Absolute path of the bound socket (also what the forwarder connects to). */
  readonly socketPath: string;
  /** Close the server and unlink the socket file. Idempotent. */
  dispose(): Promise<void>;
}

export interface SocketServerOptions {
  /** Inject a logger for parse/protocol errors (tests + production observability). */
  onError?: (err: Error, context: string) => void;
}

/**
 * Bind a Unix socket at `socketPath` and route inbound lines into `router`.
 *
 * The caller (orchestrator) is responsible for choosing the path —
 * conventionally `<workspace>/.serac/hook.sock` — and for ensuring its parent
 * directory exists.
 *
 * If a stale socket file is present (previous VS Code crashed), it is unlinked
 * before binding. The leader-election lock already ensures only one window
 * reaches this code, so the unlink is safe.
 */
export async function startSocketServer(
  socketPath: string,
  router: HookEventRouter,
  opts: SocketServerOptions = {},
): Promise<SocketServerHandle> {
  const onError = opts.onError ?? (() => {});
  await unlinkIfExists(socketPath);

  const server = net.createServer((conn) => {
    handleConnection(conn, router, onError);
  });
  server.on('error', (err) => onError(err, 'server'));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      // Restrict to current user — hook payloads contain session contents.
      try { fs.chmodSync(socketPath, 0o600); } catch (err) { onError(err as Error, 'chmod'); }
      resolve();
    });
  });

  let disposed = false;
  return {
    socketPath,
    async dispose() {
      if (disposed) { return; }
      disposed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await unlinkIfExists(socketPath);
    },
  };
}

function handleConnection(
  conn: net.Socket,
  router: HookEventRouter,
  onError: (err: Error, context: string) => void,
): void {
  let buffer = '';
  let dropped = false;

  conn.setEncoding('utf8');
  conn.on('data', (chunk: string) => {
    if (dropped) { return; }
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      dropped = true;
      onError(new Error(`line exceeded ${MAX_LINE_BYTES} bytes`), 'oversize');
      conn.destroy();
      return;
    }
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) { dispatchLine(line, router, onError); }
    }
  });
  conn.on('end', () => {
    if (!dropped && buffer.length > 0) { dispatchLine(buffer, router, onError); }
  });
  conn.on('error', (err) => onError(err, 'connection'));
}

function dispatchLine(
  line: string,
  router: HookEventRouter,
  onError: (err: Error, context: string) => void,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    onError(err as Error, 'json-parse');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    onError(new Error('payload is not an object'), 'shape');
    return;
  }
  const obj = parsed as Record<string, unknown>;
  const sessionId = obj.session_id;
  const eventType = obj.hook_event_name;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    onError(new Error('missing session_id'), 'shape');
    return;
  }
  if (typeof eventType !== 'string' || eventType.length === 0) {
    onError(new Error('missing hook_event_name'), 'shape');
    return;
  }
  router.onHookEvent(sessionId, eventType, parsed);
}

async function unlinkIfExists(socketPath: string): Promise<void> {
  try { await fs.promises.unlink(socketPath); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
  }
  // Sanity: ensure parent dir exists. The orchestrator should have created it,
  // but doing it here makes the function safe to use in tests too.
  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
}
