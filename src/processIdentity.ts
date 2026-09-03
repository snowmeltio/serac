/**
 * Before Serac signals a process it did not start, confirm the OS agrees
 * about WHO that pid is. The process registry (`~/.claude/sessions/<pid>.json`)
 * is a file a Claude process writes at start and removes at exit; a crashed or
 * SIGKILLed child leaves its file behind, and once the kernel recycles the pid
 * the entry reads as live to `kill(pid, 0)`. The transfer flow would then send
 * SIGTERM to a stranger. So: ask `ps` for the process's elapsed time and
 * command line, require a Claude CLI command, and require the implied start
 * time to sit within a few seconds of the registry's own start stamp.
 * Anything short of that is "not verified" and the caller refuses to signal.
 *
 * Elapsed time (`etime`) rather than `lstart`: it is digits only, so it is
 * immune to the locale of the exthost's `LANG` and to the DST fall-back hour
 * that makes a local wall-clock start ambiguous. `LC_ALL=C` is set anyway so
 * the column layout is fixed.
 *
 * Pure apart from the injected `exec`, so every branch is unit-testable.
 */

import { execFile } from 'child_process';
import type { LiveProcess } from './processRegistry.js';

export const PS_TIMEOUT_MS = 2000;
/** `etime` has one-second granularity and the registry's `startedAt` is
 *  stamped up to ~1.2 s after the process actually started (measured on 15
 *  live entries); `procStart` matches ps to the second. */
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

/** Parse `ps -o etime=` — `[[dd-]hh:]mm:ss` — into milliseconds. */
export function parseEtime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) { return null; }
  const days = Number(m[1] ?? 0), hours = Number(m[2] ?? 0), mins = Number(m[3]), secs = Number(m[4]);
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

/** Split one `ps -o etime=,command=` line: etime is the first field, the rest
 *  is the command (whitespace-collapsed; only ever pattern-matched). */
export function splitPsLine(line: string): { etime: string; command: string } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) { return null; }
  return { etime: parts[0]!, command: parts.slice(1).join(' ') };
}

/** The registry's best start stamp: `procStart` (ps-accurate, UTC) when the
 *  entry carries it, else `startedAt` (ms, stamped slightly late). */
export function registryStartMs(p: Pick<LiveProcess, 'startedAt' | 'procStartMs'>): number | null {
  return p.procStartMs ?? p.startedAt;
}

export async function verifyClaudeProcess(
  pid: number,
  registryStart: number | null,
  exec: ExecPs = execPsEtimeCommand,
  nowMs: () => number = Date.now,
): Promise<ProcessIdentity> {
  if (registryStart === null) { return { kind: 'no-started-at' }; }
  const out = await exec(pid);
  if (!out) { return { kind: 'unknown' }; }
  const line = out.split('\n').find(l => l.trim().length > 0);
  const split = line ? splitPsLine(line) : null;
  if (!split) { return { kind: 'unknown' }; }
  if (!looksLikeClaudeCommand(split.command)) { return { kind: 'not-claude', command: split.command }; }
  const elapsed = parseEtime(split.etime);
  if (elapsed === null) { return { kind: 'unknown' }; }
  const psStartMs = nowMs() - elapsed;
  if (Math.abs(psStartMs - registryStart) > START_TOLERANCE_MS) {
    return { kind: 'start-mismatch', psStartMs, registryStartMs: registryStart };
  }
  return { kind: 'verified' };
}

/** Same invocation contract as writerOwnership's execPs: timeout, settle
 *  guard (execFile's timeout only SENDS SIGTERM), null on any failure. */
function execPsEtimeCommand(pid: number): Promise<string | null> {
  if (process.platform === 'win32') { return Promise.resolve(null); }
  return new Promise(resolve => {
    const guard = setTimeout(() => resolve(null), PS_TIMEOUT_MS + 1000);
    execFile('ps', ['-o', 'etime=,command=', '-p', String(pid)],
      { timeout: PS_TIMEOUT_MS, encoding: 'utf-8', env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => {
        clearTimeout(guard);
        resolve(err || !stdout || !stdout.trim() ? null : stdout);
      });
  });
}
