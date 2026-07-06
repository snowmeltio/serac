import * as fs from 'fs';
import * as path from 'path';

/**
 * How long a session may sit with no observed write activity before a
 * confirmed-external `externalWriter` lock is cleared, even though the
 * owning process (in the other VS Code window) may still be alive. Without
 * this, a session sitting idle at a prompt in another window stays flagged
 * indefinitely — the product complaint this module fixes. See
 * `isWithinActivityWindow()` and `SessionDiscovery.isRecentlyActiveElsewhere()`.
 */
export const EXTERNAL_WRITER_QUIET_MS = 10 * 60_000;

/** Hard safety caps on `getSessionLastWriteMtime`'s walk. A long-lived
 *  orchestrator/team-lead session can accumulate hundreds of files under
 *  `subagents/` over its lifetime (every Task subagent, every past Workflow
 *  run's per-agent files) that nothing ever prunes — real trees with 800+
 *  files have been observed. Without a cap, a synchronous, unbounded walk of
 *  that tree blocks the single-threaded extension host for as long as the
 *  tree takes to stat, on every call. Exceeding either cap simply stops the
 *  walk early and returns whatever max mtime has been found so far — a
 *  partial, best-effort answer (matching this function's existing
 *  "best-effort signal, not an authoritative listing" contract), never a
 *  hang. `MAX_WALK_MS` in particular guards against a slow underlying
 *  filesystem (e.g. a cloud-synced mount), where per-syscall latency can be
 *  far worse than local SSD. */
const MAX_WALK_ENTRIES = 2_000;
const MAX_WALK_MS = 25;
/** Recursion depth cap — belt-and-braces alongside the entry/time caps above.
 *  The real on-disk shape never nests past `subagents/workflows/<runId>/`
 *  (depth 2), so this leaves generous headroom while still bounding a
 *  pathological (e.g. symlink-cycle) tree. */
const MAX_WALK_DEPTH = 8;

/**
 * Latest mtime (epoch ms) across a session's own top-level JSONL and every
 * file reachable under its `subagents/` directory, or `null` if nothing
 * could be stat'd at all (main file missing AND subagents dir missing/empty
 * — e.g. a session with no subagents and whose main file has vanished).
 *
 * The subagents tree can hold both flat files (`agent-<id>.jsonl`, for plain
 * Task-tool subagents) and nested directories (`workflows/<runId>/agent-
 * <id>.jsonl` plus `workflows/<runId>/journal.jsonl`, for Workflow-run
 * agents) — the walk recurses into subdirectories rather than doing a flat
 * `readdir`, or every Workflow agent's activity would be invisible here.
 * This matters because a session can be actively orchestrating subagents or
 * a Workflow run while its OWN top-level JSONL sits completely quiet (no
 * mtime wake at all) — see the comment in `sessionDiscovery.ts` near
 * `hasLiveBackgroundAgents()` documenting the same fact for the dormant-sweep
 * wake path. A recency check that only looked at the main JSONL would
 * misjudge an actively-orchestrating session as dormant.
 *
 * Every stat is wrapped in try/catch — ENOENT is completely normal here (a
 * session with no subagents at all has no subagents directory; a session
 * that hasn't written yet may lack a main file too).
 *
 * The walk is bounded by {@link MAX_WALK_ENTRIES}, {@link MAX_WALK_MS} and
 * {@link MAX_WALK_DEPTH} (see their doc comments) so a very large or
 * pathological `subagents/` tree can never block for long.
 *
 * `opts.recentEnoughMs`/`opts.nowMs` enable an early exit: as soon as ANY
 * mtime found (main file or subagents tree) is within `recentEnoughMs` of
 * `nowMs`, the walk stops immediately and returns that value rather than
 * continuing to hunt for the true global max. This is correct for every
 * current caller — they only ever feed the result into
 * {@link isWithinActivityWindow} against that same threshold, which only
 * needs to know "is there SOME write within the window", not the exact
 * latest one — and it's the single highest-value optimisation for the
 * hottest case (an actively-orchestrating session resolves fast) while the
 * genuinely-quiet case (no early exit possible) stays bounded by the caps
 * above regardless.
 */
export function getSessionLastWriteMtime(
  sessionFilePath: string,
  subagentsDir: string,
  opts?: { recentEnoughMs?: number; nowMs?: number },
): number | null {
  let max: number | null = null;
  const recentFloor = opts?.recentEnoughMs !== undefined
    ? (opts.nowMs ?? Date.now()) - opts.recentEnoughMs
    : null;
  const isRecentEnough = (): boolean => recentFloor !== null && max !== null && max > recentFloor;

  const bump = (mtimeMs: number): void => {
    if (max === null || mtimeMs > max) { max = mtimeMs; }
  };

  try {
    bump(fs.statSync(sessionFilePath).mtimeMs);
  } catch {
    // Main file missing/unreadable — not fatal, the subagents tree (if any)
    // is still checked below.
  }

  if (isRecentEnough()) { return max; }

  let visited = 0;
  const walkStarted = Date.now();
  let bailed = false;
  const budgetExceeded = (): boolean =>
    visited >= MAX_WALK_ENTRIES || (Date.now() - walkStarted) >= MAX_WALK_MS;

  // Manual recursion via readdirSync({ withFileTypes: true }) rather than the
  // Node 20.1+ `recursive: true` readdir option — written out explicitly so
  // this works on whatever Node version the extension host bundles.
  const walk = (dir: string, depth: number): void => {
    if (bailed || depth > MAX_WALK_DEPTH) { return; }
    if (budgetExceeded()) { bailed = true; return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // ENOENT is the normal case (no subagents directory at all); any other
      // read failure is treated the same way — this is a best-effort signal,
      // not an authoritative listing.
      return;
    }
    for (const entry of entries) {
      if (bailed) { return; }
      visited++;
      if (budgetExceeded()) { bailed = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      try {
        bump(fs.statSync(full).mtimeMs);
      } catch {
        // Race: file vanished between readdir and stat — skip it.
      }
      if (isRecentEnough()) { return; }
    }
  };
  walk(subagentsDir, 0);

  return max;
}

/**
 * Is `lastWriteMs` (the most recent observed write, from
 * `getSessionLastWriteMtime`) within `thresholdMs` of `nowMs`?
 *
 * The floor for the quiet window is the LATER of `lastWriteMs` and
 * `startedAtMs` (nulls filtered out first). `startedAtMs` is included as a
 * floor because a process that has just attached to an old, otherwise
 * long-quiet session (e.g. resuming a session from days ago) must still be
 * treated as active for a grace period — otherwise this would immediately
 * unlock in exactly the highest-risk window `isExternalWriterFresh()`'s own
 * docstring already calls out (a session that just started elsewhere),
 * before the resuming process has had any chance to write something new.
 *
 * If there is no usable floor at all (both `lastWriteMs` and `startedAtMs`
 * are null), this returns `true` — unknown must fail TOWARD still-locked,
 * matching this codebase's existing fail-toward-flagging-not-away-from-it
 * philosophy (see `aggregateWriterOwnership`'s docstring in
 * `writerOwnership.ts` for the precedent this stays consistent with).
 */
export function isWithinActivityWindow(
  lastWriteMs: number | null,
  startedAtMs: number | null,
  nowMs: number,
  thresholdMs: number = EXTERNAL_WRITER_QUIET_MS,
): boolean {
  const floors = [lastWriteMs, startedAtMs].filter((v): v is number => v !== null);
  if (floors.length === 0) { return true; }
  const floor = Math.max(...floors);
  return (nowMs - floor) < thresholdMs;
}
