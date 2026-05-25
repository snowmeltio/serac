/**
 * Leader election for per-workspace hook ingress.
 *
 * Multiple VS Code windows can be open on the same workspace; only one of them
 * should bind the hook-ingress socket. We use a lock file at
 * `<workspace>/.serac/hook.lock`, opened with the `wx` flag (exclusive create).
 * Whichever window wins the `openSync` is the leader; everyone else is a
 * follower and returns an inert handle.
 *
 * Stale-lock recovery: if the lock file exists but its PID is no longer alive
 * (previous VS Code crashed without dispose), we unlink and retry exactly once.
 * Single retry, no loop — a second EEXIST means a real concurrent race we
 * should lose to whoever just acquired it.
 *
 * The lock file is unlinked in `dispose()`. Crash-safe via the stale-PID
 * recovery path; if dispose() doesn't run, the next window to start cleans up.
 *
 * Cross-platform note: `process.kill(pid, 0)` works on macOS/Linux/Windows as
 * a liveness probe (no signal sent, just an existence check). We don't use
 * `flock` because it's Unix-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LeaderHandle {
  /** True if this caller acquired the lock. False if another window owns it. */
  readonly isLeader: boolean;
  /** Release the lock. Idempotent. Followers' dispose is a no-op. */
  dispose(): void;
}

export interface LeaderElectionOptions {
  /** Override the PID written to the lock (tests). Defaults to `process.pid`. */
  pid?: number;
  /** Override the liveness check (tests). Returns `true` if the PID is alive. */
  isAlive?: (pid: number) => boolean;
}

const DEFAULT_IS_ALIVE = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Attempt to acquire leader status for the given workspace. Returns
 * `{ isLeader: true, dispose }` on success, `{ isLeader: false, dispose: noop }`
 * if another window already holds the lock and its PID is alive.
 *
 * Side effect: creates `<workspaceDir>/.serac/` if missing.
 */
export function tryAcquireLeader(
  workspaceDir: string,
  opts: LeaderElectionOptions = {},
): LeaderHandle {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? DEFAULT_IS_ALIVE;

  const seracDir = path.join(workspaceDir, '.serac');
  fs.mkdirSync(seracDir, { recursive: true });
  const lockPath = path.join(seracDir, 'hook.lock');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, String(pid)); } finally { fs.closeSync(fd); }
      let disposed = false;
      return {
        isLeader: true,
        dispose() {
          if (disposed) { return; }
          disposed = true;
          try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
      if (attempt === 0 && isLockStale(lockPath, isAlive)) {
        try { fs.unlinkSync(lockPath); } catch { /* lost the race; loop will fall through */ }
        continue;
      }
      return inertHandle();
    }
  }
  return inertHandle();
}

function isLockStale(lockPath: string, isAlive: (pid: number) => boolean): boolean {
  let raw: string;
  try { raw = fs.readFileSync(lockPath, 'utf8'); } catch { return true; }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) { return true; }
  return !isAlive(pid);
}

function inertHandle(): LeaderHandle {
  return { isLeader: false, dispose() { /* no-op */ } };
}
