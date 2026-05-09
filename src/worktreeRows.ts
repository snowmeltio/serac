/**
 * Build the Worktrees pane row list from worktree enumeration + session
 * snapshots. Pure: no I/O, no fs, no time. Tested independently.
 *
 * One row per discovered worktree (including the main checkout). Counts come
 * from sessions: local sessions whose `worktreeRoot` is unset belong to the
 * current worktree; sibling-worktree sessions carry `worktreeRoot` and bucket
 * to that path. Worktrees with no CC history still get a row — the pane is a
 * faithful map of `git worktree list`, not a list of "places I've chatted."
 */

import * as path from 'path';
import type { SessionSnapshot, WorktreeRow, StatusConfidence } from './types.js';
import type { WorktreeInfo } from './gitWorktreeUtil.js';

const CONFIDENCE_RANK: Record<StatusConfidence, number> = { high: 3, medium: 2, low: 1 };

/** Normalise a path for comparison: trim trailing slash, resolve relative segments. */
function normalisePath(p: string): string {
  return path.resolve(p);
}

/** Bucket sessions into a map keyed by their worktree path. Returns counts +
 *  highest confidence per bucket. Sessions without a worktreeRoot use the
 *  fallback path (i.e. the local cwd). Dismissed sessions are skipped — the
 *  pane shows live activity, not archive depth. */
function bucketSessions(
  sessions: SessionSnapshot[],
  localPath: string,
): Map<string, { counts: Record<string, number>; confidence: StatusConfidence }> {
  const buckets = new Map<string, { counts: Record<string, number>; confidence: StatusConfidence }>();
  const localKey = normalisePath(localPath);

  for (const s of sessions) {
    if (s.dismissed) { continue; }
    const key = s.worktreeRoot ? normalisePath(s.worktreeRoot) : localKey;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { counts: {}, confidence: 'low' };
      buckets.set(key, bucket);
    }
    bucket.counts[s.status] = (bucket.counts[s.status] ?? 0) + 1;
    const sessConf = (s.confidence ?? 'medium') as StatusConfidence;
    if (CONFIDENCE_RANK[sessConf] > CONFIDENCE_RANK[bucket.confidence]) {
      bucket.confidence = sessConf;
    }
  }
  return buckets;
}

/** Build the Worktrees pane payload. Returns undefined when there's nothing
 *  meaningful to show (no repo, no linked worktrees) so the panel can hide
 *  the section entirely. */
export function buildWorktreeRows(
  worktrees: WorktreeInfo[],
  sessions: SessionSnapshot[],
  localCwd: string,
): WorktreeRow[] | undefined {
  if (worktrees.length <= 1) { return undefined; }

  const buckets = bucketSessions(sessions, localCwd);
  const localKey = normalisePath(localCwd);

  const rows: WorktreeRow[] = worktrees.map((wt) => {
    const key = normalisePath(wt.path);
    const bucket = buckets.get(key);
    const isCurrent = key === localKey;
    const displayName = wt.branch ?? path.basename(wt.path);
    return {
      path: wt.path,
      branch: wt.branch,
      displayName,
      counts: bucket?.counts ?? {},
      confidence: bucket?.confidence ?? 'high',
      isCurrent,
      isMain: wt.isMain,
    };
  });

  // Stable sort: current first, then main, then by displayName.
  rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) { return a.isCurrent ? -1 : 1; }
    if (a.isMain !== b.isMain) { return a.isMain ? -1 : 1; }
    return a.displayName.localeCompare(b.displayName);
  });

  return rows;
}
