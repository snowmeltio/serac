/**
 * Pure decision logic for the "bring this phone session here" transfer flow.
 *
 * A phone-originated session (Remote Control-hosted, `entrypoint: sdk-cli`)
 * cannot be restored by the Claude Code panel as-is. Bringing it here means:
 * if the phone's process is still alive and idle, release it (SIGTERM, never
 * escalated); then rewrite the transcript's entrypoint; then open. This module
 * decides WHICH of those applies and knows when a released process has
 * actually gone. It touches no I/O — the host injects registry snapshots and a
 * sleep so every branch is unit-testable.
 */

import type { LiveProcess } from './processRegistry.js';
import { RC_ENTRYPOINT } from './rcOrigin.js';

/** A live phone process counts as idle only when the transcript has been quiet
 *  this long. Short on purpose: the phone side's own turn structure means a
 *  session between turns goes silent within a second or two, while a mid-turn
 *  one writes continuously. */
export const TRANSFER_QUIET_MS = 8_000;
/** How long to wait for the released process to leave the registry before
 *  giving up (no SIGKILL — the user is told to try again). Spike 2 measured
 *  ~2 s from SIGTERM to registry clear. */
export const RELEASE_TIMEOUT_MS = 5_000;
/** Poll cadence while waiting for the release. */
export const RELEASE_POLL_MS = 250;
/** After the registry clears, the child's closing `last-prompt` record may
 *  still be landing; wait this long before rewriting the file. */
export const RELEASE_SETTLE_MS = 300;

export type TransferVerdict =
  /** No live process at all — rewrite and open, no confirmation. */
  | { kind: 'dead' }
  /** One (or more) phone-driven process, idle — ask, release, rewrite, open. */
  | { kind: 'rc-idle'; proc: LiveProcess }
  /** Phone-driven process mid-turn — refuse for now. */
  | { kind: 'rc-busy'; proc: LiveProcess; reason: 'active-status' | 'recent-write' }
  /** A window (non-sdk-cli) process already holds it — this is a desktop
   *  session; the ordinary open path applies. */
  | { kind: 'desktop'; procs: LiveProcess[] };

export interface ClassifyInput {
  /** Every live registered process for the session, fresh from a rescan. */
  procs: readonly LiveProcess[];
  /** Serac's own status read: running/waiting = a turn is in flight. */
  sessionRunning: boolean;
  /** Newest mtime across the transcript and its subagents tree, or null when
   *  nothing could be stat'ed. */
  lastWriteMtimeMs: number | null;
  nowMs: number;
  quietMs?: number;
}

export function classifyTransfer(input: ClassifyInput): TransferVerdict {
  const quietMs = input.quietMs ?? TRANSFER_QUIET_MS;
  const desktop = input.procs.filter(p => p.entrypoint !== RC_ENTRYPOINT);
  if (desktop.length > 0) { return { kind: 'desktop', procs: desktop }; }
  const rc = input.procs.filter(p => p.entrypoint === RC_ENTRYPOINT);
  if (rc.length === 0) { return { kind: 'dead' }; }
  // Newest-started first: if two phone processes are somehow registered, the
  // one the user is most likely still on is the one to name.
  const proc = [...rc].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]!;
  if (input.sessionRunning) { return { kind: 'rc-busy', proc, reason: 'active-status' }; }
  if (input.lastWriteMtimeMs !== null && input.nowMs - input.lastWriteMtimeMs < quietMs) {
    return { kind: 'rc-busy', proc, reason: 'recent-write' };
  }
  return { kind: 'rc-idle', proc };
}

/** Same registry entry, not merely the same pid — `startedAt` guards against
 *  pid reuse between the classify and the signal. A null startedAt on either
 *  side falls back to pid equality (older registry entries). */
export function isSameProcess(a: Pick<LiveProcess, 'pid' | 'startedAt'>, b: Pick<LiveProcess, 'pid' | 'startedAt'>): boolean {
  if (a.pid !== b.pid) { return false; }
  if (a.startedAt === null || b.startedAt === null) { return true; }
  return a.startedAt === b.startedAt;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Poll `poll()` until no returned process is the target (released), or the
 *  timeout passes. A different process reusing the pid counts as released. */
export async function waitForRelease(
  poll: () => Promise<readonly LiveProcess[]>,
  target: Pick<LiveProcess, 'pid' | 'startedAt'>,
  opts: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = { timeoutMs: RELEASE_TIMEOUT_MS, intervalMs: RELEASE_POLL_MS },
): Promise<'released' | 'timeout'> {
  const sleep = opts.sleep ?? realSleep;
  // Monotonic by default: a wall-clock step would stretch or cut the wait.
  const now = opts.now ?? (() => performance.now());
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const procs = await poll();
    if (!procs.some(p => isSameProcess(p, target))) { return 'released'; }
    if (now() >= deadline) { return 'timeout'; }
    await sleep(opts.intervalMs);
  }
}

/** Every live process that is a phone-driven (sdk-cli) writer. */
export function rcProcesses(procs: readonly LiveProcess[]): LiveProcess[] {
  return procs.filter(p => p.entrypoint === RC_ENTRYPOINT);
}
