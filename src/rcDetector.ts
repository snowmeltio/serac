/**
 * Is a Claude Code Remote Control server serving this workspace?
 *
 * `claude rc` bridges the local machine to the mobile app: the phone can then
 * start NEW sessions here. (Sessions already started in this window are
 * reachable from the phone regardless — the server is only needed for the
 * spawn direction.) The panel shows the answer as a top-bar indicator so the
 * user knows whether "start a session from my phone" will work right now.
 *
 * Detection is a pure filter over the live process registry, so it costs
 * nothing beyond the rescan that already happens. Each session the server
 * hosts is a child process that registers `~/.claude/sessions/<pid>.json`
 * with `entrypoint: "sdk-cli"` and a real cwd: the workspace root for the
 * session pre-created in the serving directory, or
 * `<workspace>/.claude/worktrees/bridge-cse_<id>` for each phone-spawned one
 * (verified against a live server, 2026-08-20).
 *
 * Known blind spots, deliberate in v1 (see ARCHITECTURE.md):
 *   - The server process itself never registers. We infer it from its
 *     children, so a server running with `--no-create-session-in-dir` and no
 *     spawned sessions yet is invisible.
 *   - Reading it truthfully: a positive means "RC-hosted sessions are live
 *     under this workspace", which is the state the user actually cares about.
 *   - No `ps -ax` enumeration is introduced to close the gap; the codebase has
 *     never scanned the full process table, and one indicator doesn't justify
 *     starting.
 */

import * as path from 'path';
import type { LiveProcess } from './processRegistry.js';
import { CLAUDE_WORKTREE_SUBDIR, isAtOrUnder } from './gitWorktreeUtil.js';

/** Registry `entrypoint` value stamped by an RC-hosted session process. */
export const RC_ENTRYPOINT = 'sdk-cli';

/**
 * Is this registered process a headless SDK-driven writer (`entrypoint:
 * "sdk-cli"`) rather than a candidate VS Code window's session? In practice
 * these are Remote Control-hosted sessions — the phone drives them through
 * the `claude rc` server, which parents every one of them.
 *
 * The writer-ownership paths use this to exclude such processes from the
 * externalWriter aggregate entirely: the one-hop ppid check would otherwise
 * confirm them 'external' (parent = the rc server, never this window's
 * Extension Host), producing an unfulfillable "open in another VS Code
 * window" mark and block. Deliberate consequence: a phone-driven session
 * neither marks nor blocks, and CAN be resumed locally — Claude Code itself
 * reconciles the concurrent writers for server-backed (`cse_`) sessions, so
 * Serac stepping in front of that was pure false positive (decided
 * 2026-09-01).
 */
export function isRcHostedProcess(p: Pick<LiveProcess, 'entrypoint'>): boolean {
  return p.entrypoint === RC_ENTRYPOINT;
}

/**
 * True when any live registry entry looks like an RC-hosted session rooted at
 * this workspace — either the session pre-created in the serving directory
 * (cwd === workspace root) or one spawned into `<workspace>/.claude/worktrees/`.
 *
 * Pure over the passed snapshot: the caller owns rescan cadence. An empty or
 * degraded registry reads as "not serving", matching the rest of the codebase's
 * treatment of registry absence as a soft negative rather than proof.
 */
export function isRcServing(processes: readonly LiveProcess[], workspacePath: string): boolean {
  if (!workspacePath) { return false; }
  const wsRoot = path.resolve(workspacePath);
  const spawnDir = path.join(wsRoot, CLAUDE_WORKTREE_SUBDIR);
  return processes.some(p => {
    if (p.entrypoint !== RC_ENTRYPOINT) { return false; }
    if (!p.cwd) { return false; }
    const cwd = path.resolve(p.cwd);
    return cwd === wsRoot || isAtOrUnder(cwd, spawnDir);
  });
}
