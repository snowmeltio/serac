/**
 * Worktree chip derivation — pure, no I/O.
 *
 * Identity source is the worktree PATH BASENAME, never the branch: branches
 * rename/rebase away while the worktree persists, and the chip's whole value
 * is "I recognise that green DP chip" — churn kills it (design session
 * 4c72e22f; mockups/worktree-chip-rc.html).
 *
 * Remote-spawned worktrees (`bridge-cse_<id>` — created by a `claude rc`
 * server for phone-spawned sessions) skip derivation entirely: hashing a
 * one-shot cse id would fake a stable identity, and a monogram of a hash is
 * noise. They take a fixed 📡 treatment instead (Murray's pick, 2026-08-20).
 */

/** Prefix stamped on worktrees the Remote Control server creates per
 *  phone-spawned session. The sole reliable "remotely spawned" marker —
 *  spawned transcripts carry no bridge-session records, and enrolment
 *  records mark every session under account-wide RC (v1.20.0 decision
 *  record: that's why no chip keys on bridgeSessionId). */
export const REMOTE_WORKTREE_PREFIX = 'bridge-cse_';

/** True when a worktree basename identifies a Remote Control-spawned
 *  (phone-initiated) worktree. */
export function isRemoteWorktree(basename: string): boolean {
  return basename.startsWith(REMOTE_WORKTREE_PREFIX);
}

/** Hue for a worktree chip: djb2 hash spread by the golden angle — the exact
 *  fallback recipe `modelHue()` uses for unknown model families, so one hash
 *  algorithm serves both pills. Same input → same hue, every build. */
export function chipHue(basename: string): number {
  let h = 5381;
  for (let i = 0; i < basename.length; i++) { h = ((h << 5) + h + basename.charCodeAt(i)) >>> 0; }
  return Math.round((h * 137.508) % 360);
}

/** 2-char monogram from the distinctive TAIL of the basename: initials of the
 *  last two hyphen-words (`fix-workflow-resume-liveness` → "RL"), because
 *  sibling worktrees tend to share their leading words and naive first-letters
 *  would all collide. A repo-name prefix is stripped first when present
 *  (`serac-spike-detail-pane` with repo "serac" → "DP" not "SP"). Single-word
 *  names take their first two letters ("main" → "MA"). */
export function chipMonogram(basename: string, repoName?: string): string {
  let name = basename;
  if (repoName && name.startsWith(repoName + '-')) { name = name.slice(repoName.length + 1); }
  const words = name.split('-').filter(w => w.length > 0);
  if (words.length === 0) { return '?'; }
  if (words.length === 1) { return words[0].slice(0, 2).toUpperCase(); }
  return words.slice(-2).map(w => w[0].toUpperCase()).join('');
}
