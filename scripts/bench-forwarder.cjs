#!/usr/bin/env node
/**
 * Microbench for bin/serac-hook-forward.cjs.
 *
 * Spec: < 30 ms cold spawn. Claude Code's tool loop blocks until the hook
 * script exits, so any slowness is direct user-visible latency.
 *
 * Usage:
 *   node scripts/bench-forwarder.cjs
 *
 * Prints min / avg / p95 / max over N cold spawns. Each spawn writes a real
 * Claude Code hook payload (PreToolUse) to a Unix-socket sink (this script
 * stands up its own listener in /tmp) and measures wall-clock from
 * `child_process.spawn` start to `'close'` event.
 *
 * Why a separate script: Vitest's test isolation adds ~1 s per spawn,
 * dominating the 30 ms forwarder runtime. A standalone bench measures what
 * Claude Code will actually experience.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const FORWARDER = path.resolve(__dirname, '../bin/serac-hook-forward.cjs');
const ITERATIONS = 50;

const PAYLOAD = {
  session_id: 'bench-session-uuid-0000',
  hook_event_name: 'PreToolUse',
  transcript_path: '/Users/x/.claude/projects/-tmp/bench.jsonl',
  tool_name: 'Bash',
  tool_input: { command: 'echo bench', description: 'bench' },
};

function pctile(sorted, p) {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-bench-'));
  fs.mkdirSync(path.join(dir, '.serac'));
  const socketPath = path.join(dir, '.serac', 'hook.sock');

  // Stand up a minimal sink — counts received payloads, doesn't parse.
  let received = 0;
  const server = net.createServer((conn) => {
    conn.on('data', () => { received++; });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  const payloadWithCwd = { ...PAYLOAD, cwd: dir };
  const stdin = JSON.stringify(payloadWithCwd);

  const samples = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [FORWARDER], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', () => resolve());
      child.stdin.write(stdin);
      child.stdin.end();
    });
    const elapsedNs = process.hrtime.bigint() - start;
    samples.push(Number(elapsedNs) / 1_000_000);  // → milliseconds
  }

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  console.log(`forwarder bench — ${ITERATIONS} iterations`);
  console.log(`  min  ${samples[0].toFixed(2)} ms`);
  console.log(`  avg  ${(sum / samples.length).toFixed(2)} ms`);
  console.log(`  p50  ${pctile(samples, 0.5).toFixed(2)} ms`);
  console.log(`  p95  ${pctile(samples, 0.95).toFixed(2)} ms`);
  console.log(`  max  ${samples[samples.length - 1].toFixed(2)} ms`);
  console.log(`  received ${received}/${ITERATIONS}`);
  console.log(`  spec     < 30 ms cold (p95 target)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
