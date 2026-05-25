#!/usr/bin/env node
/**
 * Serac hook forwarder — invoked by Claude Code per hook event.
 *
 * Reads a JSON payload from stdin, locates the nearest `.serac/hook.sock`
 * walking up from the payload's `cwd`, and writes one newline-terminated
 * JSON line to that socket. Exits 0 unconditionally — fail-open is mandatory
 * because Claude Code's tool loop blocks until this script returns.
 *
 * Performance target: < 30 ms cold (measured wall-clock from `node` exec to
 * `socket.end()` complete). Achieved by:
 *   - Pure stdlib (no `require` of any npm package).
 *   - Synchronous filesystem walks (no async overhead for a max-depth-N loop).
 *   - Single socket write, no handshake, no read.
 *
 * No logging anywhere — stderr would noise up Claude Code's output, and a
 * non-zero exit would interpret as a hook failure. Diagnostics live on the
 * server side (the SocketServer's `onError` callback surfaces parse errors
 * in the Serac output channel).
 *
 * Behaviour matrix:
 *   - stdin empty / unparseable JSON → exit 0, no write.
 *   - cwd field missing → fall back to process.cwd().
 *   - no .serac/hook.sock in any ancestor → exit 0 (session is outside any
 *     Serac workspace; nothing to do).
 *   - socket exists but refuses connection (server crashed) → exit 0.
 *   - any other error → exit 0.
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const MAX_STDIN_BYTES = 256 * 1024;
const SOCKET_TIMEOUT_MS = 1_000;  // forwarder upper bound; well inside Claude's hook timeout

function readStdinSync() {
  // Read up to MAX_STDIN_BYTES. Synchronous read via fs.readSync on fd 0.
  const chunks = [];
  let totalBytes = 0;
  const buf = Buffer.alloc(16 * 1024);
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); }
    catch (err) {
      // Some platforms throw EAGAIN on a non-ready stdin. Treat as EOF.
      if (err && (err.code === 'EAGAIN' || err.code === 'EOF')) { break; }
      return '';  // give up; fail-open
    }
    if (n === 0) { break; }
    totalBytes += n;
    if (totalBytes > MAX_STDIN_BYTES) { return ''; }
    chunks.push(buf.slice(0, n).toString('utf8'));
  }
  return chunks.join('');
}

function findNearestSocket(startDir) {
  // Walk up from startDir until we find .serac/hook.sock or hit the filesystem
  // root. Symlinks are followed by stat; we cap depth at 50 as a safety net
  // against any pathological symlink loops.
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 50; depth++) {
    const candidate = path.join(current, '.serac', 'hook.sock');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isSocket()) { return candidate; }
    } catch (err) {
      // ENOENT is expected; anything else we ignore too (fail-open).
    }
    const parent = path.dirname(current);
    if (parent === current) { return undefined; }  // reached root
    current = parent;
  }
  return undefined;
}

function writeToSocket(socketPath, line) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    let settled = false;
    const done = () => {
      if (settled) { return; }
      settled = true;
      try { conn.destroy(); } catch (e) {}
      resolve();
    };
    conn.setTimeout(SOCKET_TIMEOUT_MS, done);
    conn.once('error', done);
    conn.once('connect', () => {
      conn.end(line, () => done());
    });
  });
}

(async function main() {
  try {
    const raw = readStdinSync();
    if (!raw) { process.exit(0); }

    let payload;
    try { payload = JSON.parse(raw); }
    catch { process.exit(0); }

    if (typeof payload !== 'object' || payload === null) { process.exit(0); }

    const startDir = (typeof payload.cwd === 'string' && payload.cwd.length > 0)
      ? payload.cwd
      : process.cwd();

    const socketPath = findNearestSocket(startDir);
    if (!socketPath) { process.exit(0); }

    const line = raw.endsWith('\n') ? raw : raw + '\n';
    await writeToSocket(socketPath, line);
    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
