/**
 * Before Serac signals a process it did not start, confirm the OS agrees
 * about WHO that pid is. The process registry (`~/.claude/sessions/<pid>.json`)
 * is a file a Claude process writes at start and removes at exit; a crashed or
 * SIGKILLed child leaves its file behind, and once the kernel recycles the pid
 * the entry reads as live to `kill(pid, 0)`. The transfer flow would then send
 * SIGTERM to a stranger. So: ask `ps` for the process's start time and command
 * line, require a Claude CLI command, and require the start time to sit within
 * a few seconds of the registry's `startedAt`. Anything short of that is
 * "not verified" and the caller refuses to signal.
 *
 * Pure apart from the injected `exec`, so every branch is unit-testable.
 */

import { execFile } from 'child_process';

export const PS_TIMEOUT_MS = 2000;
/** How far the ps start time may sit from the registry's `startedAt`. The
 *  registry stamps milliseconds; `ps lstart` is whole seconds in local time. */
export const START_TOLERANCE_MS = 5_000;

export type ExecPs = (pid: number) => Promise<string | null>;

export type ProcessIdentity =
  | { kind: 'verified' }
  | { kind: 'not-claude'; command: string }
  | { kind: 'start-mismatch'; psStartMs: number; registryStartMs: number }
  | { kind: 'no-started-at' }
  | { kind: 'unknown' };

/** Does a `ps -o command=` line look like a Claude Code CLI process? The
 *  native binary lives under `.../claude/versions/<v>` (or is invoked as
 *  `claude`); an RC-hosted child additionally carries `--sdk-url`. */
export function looksLikeClaudeCommand(command: string): boolean {
  const c = command.trim();
  if (!c) { return false; }
  return /(^|[\s/])claude(\s|$|\/)/.test(c) || c.includes('--sdk-url');
}

/** Parse `ps -o lstart=` ("Thu Sep  3 02:52:16 2026", local time). */
export function parseLstart(text: string): number | null {
  const t = Date.parse(text.trim().replace(/\s+/g, ' '));
  return Number.isNaN(t) ? null : t;
}

/** Split one `ps -o lstart=,command=` line: lstart is always five
 *  whitespace-separated fields (dow mon dd hh:mm:ss yyyy); the rest is the
 *  command. */
export function splitPsLine(line: string): { lstart: string; command: string } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) { return null; }
  return { lstart: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' ') };
}

export async function verifyClaudeProcess(
  pid: number,
  registryStartedAt: number | null,
  exec: ExecPs = execPsLstartCommand,
): Promise<ProcessIdentity> {
  if (registryStartedAt === null) { return { kind: 'no-started-at' }; }
  const out = await exec(pid);
  if (!out) { return { kind: 'unknown' }; }
  const line = out.split('\n').find(l => l.trim().length > 0);
  const split = line ? splitPsLine(line) : null;
  if (!split) { return { kind: 'unknown' }; }
  if (!looksLikeClaudeCommand(split.command)) { return { kind: 'not-claude', command: split.command }; }
  const psStartMs = parseLstart(split.lstart);
  if (psStartMs === null) { return { kind: 'unknown' }; }
  if (Math.abs(psStartMs - registryStartedAt) > START_TOLERANCE_MS) {
    return { kind: 'start-mismatch', psStartMs, registryStartMs: registryStartedAt };
  }
  return { kind: 'verified' };
}

/** Same invocation contract as writerOwnership's execPs: timeout, settle
 *  guard (execFile's timeout only SENDS SIGTERM), null on any failure. */
function execPsLstartCommand(pid: number): Promise<string | null> {
  if (process.platform === 'win32') { return Promise.resolve(null); }
  return new Promise(resolve => {
    const guard = setTimeout(() => resolve(null), PS_TIMEOUT_MS + 1000);
    execFile('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => {
        clearTimeout(guard);
        resolve(err || !stdout || !stdout.trim() ? null : stdout);
      });
  });
}
