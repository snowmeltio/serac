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
 * released. If reversed, a follower window's election could see the lock
 * released and try to bind the socket while we're still closing it.
 */

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
}

export interface HookIngressOptions {
  /** Inject a logger; the orchestrator forwards both setup failures and
   *  per-connection protocol errors through this. */
  onError?: (err: Error, context: string) => void;
  /** Override the PID written to the leader lock (tests). */
  pid?: number;
  /** Override the liveness probe used for stale-lock recovery (tests). */
  isAlive?: (pid: number) => boolean;
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

  const lock = tryAcquireLeader(workspaceDir, { pid: opts.pid, isAlive: opts.isAlive });
  if (!lock.isLeader) {
    return followerHandle(lock);
  }

  const socketPath = path.join(workspaceDir, '.serac', 'hook.sock');
  let socket: SocketServerHandle;
  try {
    socket = await startSocketServer(socketPath, router, { onError });
  } catch (err) {
    // Surrender the lock so a future activation can retry.
    lock.dispose();
    onError(err as Error, 'socket-bind');
    return followerHandle({ isLeader: false, dispose() {} });
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
  };
}

function followerHandle(lock: LeaderHandle): IngressHandle {
  return {
    isLeader: false,
    socketPath: undefined,
    async dispose() { lock.dispose(); },
  };
}
