/**
 * Hook ingress orchestrator.
 *
 * Composes leader election + Unix-socket server. Called once per VS Code
 * window from `extension.ts` during activation. The flow:
 *
 *   1. Attempt to acquire the per-workspace leader lock
 *      (`<ws>/.serac/hook.lock`). Only one window per workspace wins.
 *   2. If leader, bind a Unix socket at `<ws>/.serac/hook.sock` and route
 *      inbound payloads into the provided `HookEventRouter`.
 *   3. If follower (another window already owns ingress for this workspace),
 *      return an inert handle. The follower window still receives state via
 *      JSONL tailing; hooks are an enhancement, not a requirement.
 *
 * Failure handling:
 *   - Lock acquired but socket server fails to bind → release the lock and
 *     return inert. This lets a follower window retry leader election later
 *     without us holding the lock forever. (No retry loop here; the next
 *     window's activation will probe.)
 *   - All errors after successful startup are routed through `onError` so
 *     the extension can surface them in the Serac output channel without
 *     crashing the ingress path.
 *
 * Dispose order: socket server closes + unlinks socket, then leader lock is
 * released. The hazard is a late unlink: an async close that finishes after a
 * successor has bound would delete the successor's socket. releaseSync()
 * (what extension teardown uses) unlinks the socket only while the lock is
 * still ours, and removes the lock only if it still names this process.
 *
 * A workspace whose socket path exceeds the platform's sun_path limit (a deep
 * Google Drive folder: 144 bytes) cannot bind (`listen EINVAL`), so ingress is
 * skipped there before anything is written into the folder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryAcquireLeader, type LeaderHandle } from './leaderElection.js';
import { startSocketServer, type SocketServerHandle } from './socketServer.js';
import type { HookEventRouter } from '../hookEventRouter.js';

export interface IngressHandle {
  /** True if this window owns hook ingress for the workspace. False = follower. */
  readonly isLeader: boolean;
  /** Absolute path of the bound socket (leaders only). Undefined for followers. */
  readonly socketPath: string | undefined;
  /** Stop ingress, close socket, release lock. Idempotent. */
  dispose(): Promise<void>;
  /** The same, synchronously, for extension teardown (see module doc). */
  releaseSync(): void;
  /** Set when ingress never started because the socket path is too long. */
  readonly skipped?: 'socket-path-too-long';
}

export interface HookIngressOptions {
  /** Inject a logger; the orchestrator forwards both setup failures and
   *  per-connection protocol errors through this. */
  onError?: (err: Error, context: string) => void;
  /** Override the PID written to the leader lock (tests). */
  pid?: number;
  /** Override the liveness probe used for stale-lock recovery (tests). */
  isAlive?: (pid: number) => boolean;
  /** Override the platform for the socket-path limit (tests). */
  platform?: NodeJS.Platform;
}

/**
 * Start hook ingress for a workspace. Always returns a disposable handle —
 * the `isLeader` flag indicates whether this window actually bound the socket.
 *
 * Promise rejects only on programmer error (bad workspaceDir, fs corruption);
 * routine "another window owns ingress" produces a resolved follower handle.
 */
export async function startHookIngress(
  workspaceDir: string,
  router: HookEventRouter,
  opts: HookIngressOptions = {},
): Promise<IngressHandle> {
  const onError = opts.onError ?? (() => {});

  const socketPath = path.join(workspaceDir, '.serac', 'hook.sock');
  if (Buffer.byteLength(socketPath) > maxSocketPathBytes(opts.platform ?? process.platform)) {
    // An earlier build left an empty .serac/ in the synced folder; tidy it.
    try { fs.rmdirSync(path.dirname(socketPath)); } catch { /* absent or not empty */ }
    return { ...followerHandle(inertLock()), skipped: 'socket-path-too-long' };
  }

  const lock = tryAcquireLeader(workspaceDir, { pid: opts.pid, isAlive: opts.isAlive });
  if (!lock.isLeader) {
    return followerHandle(lock);
  }

  let socket: SocketServerHandle;
  try {
    socket = await startSocketServer(socketPath, router, { onError });
  } catch (err) {
    // Surrender the lock so a future activation can retry.
    lock.dispose();
    onError(err as Error, 'socket-bind');
    return followerHandle(inertLock());
  }

  let disposed = false;
  return {
    isLeader: true,
    socketPath: socket.socketPath,
    async dispose() {
      if (disposed) { return; }
      disposed = true;
      await socket.dispose();
      lock.dispose();
    },
    releaseSync() {
      if (disposed) { return; }
      disposed = true;
      socket.closeSync(lock.ownsLock());
      lock.dispose();
    },
  };
}

/** sun_path is 104 bytes on macOS/BSD and 108 on Linux, including the NUL. */
export function maxSocketPathBytes(platform: NodeJS.Platform): number {
  return platform === 'linux' ? 107 : 103;
}

function inertLock(): LeaderHandle {
  return { isLeader: false, ownsLock: () => false, dispose() {} };
}

function followerHandle(lock: LeaderHandle): IngressHandle {
  return {
    isLeader: false,
    socketPath: undefined,
    async dispose() { lock.dispose(); },
    releaseSync() { lock.dispose(); },
  };
}
