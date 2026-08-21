/**
 * Git repository root resolution.
 *
 * Determines the canonical repository root for a working-tree CWD without
 * shelling out to git. Handles four cases:
 *
 *  1. `<cwd>/.git` is a directory → cwd is the main checkout; repo root = cwd.
 *  2. `<cwd>/.git` is a file (linked worktree) → parse `gitdir: <path>`,
 *     read `<gitdir>/commondir` to find the main `.git` directory, then
 *     return its parent.
 *  3. No `.git` (or unreadable) → derive the owning repo from the
 *     `<repo>/.claude/worktrees/<name>` path shape and resolve that instead.
 *     This is the removed-worktree case: Remote Control spawns a one-shot
 *     worktree per phone session and it is gone by the time we look, but the
 *     session's JSONL lives on. Without the fallback such a session resolves
 *     to `null`, drops out of sibling classification, and resurfaces as a flat
 *     "Other workspaces" row named after the dead worktree.
 *  4. Nothing else matches → return `null`.
 *
 * Symlinks are resolved via `realpath` so two paths that point to the same
 * physical repo collapse to a single key. All errors are swallowed and
 * surfaced as `null` — callers should not have to wrap this in try/catch.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Subdirectory (relative to a repo root) that Claude Code spawns its
 *  per-session worktrees into. Remote Control puts one `bridge-cse_*` child
 *  here per phone-spawned session. */
export const CLAUDE_WORKTREE_SUBDIR = path.join('.claude', 'worktrees');

/** Is `child` the same path as `parent`, or contained by it? Compares resolved
 *  paths segment-wise so `/repo/serac-old` is not read as inside `/repo/serac`. */
export function isAtOrUnder(child: string, parent: string): boolean {
  if (!child || !parent) { return false; }
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') { return true; }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Derive the owning repo root from the `<repo>/.claude/worktrees/<name>` shape
 *  by path alone. Deliberately does no fs work — the whole point is that it
 *  still answers after the worktree directory has been removed. Only the
 *  immediate child of the spawn dir qualifies: a deeper path is a subfolder of
 *  a worktree, not the worktree itself. Returns null for any other shape. */
export function repoRootFromClaudeWorktreePath(cwd: string): string | null {
  if (!cwd || !path.isAbsolute(cwd)) { return null; }
  const norm = path.resolve(cwd);
  const spawnDir = path.dirname(norm);
  // <repo>/.claude/worktrees → <repo>
  const repoRoot = path.dirname(path.dirname(spawnDir));
  if (repoRoot === spawnDir) { return null; }
  if (path.join(repoRoot, CLAUDE_WORKTREE_SUBDIR) !== spawnDir) { return null; }
  return repoRoot;
}

/** Resolve the repository root for a working-tree CWD. Returns null when
 *  the path isn't part of a git repo (or any fs error occurs).
 *
 *  Two passes: read the CWD's own `.git`, and — when that can't answer, which
 *  includes the CWD no longer existing — derive the owning repo from a Claude
 *  worktree path shape and read *its* `.git`. The result is always backed by a
 *  real `.git`, never a guess. The second pass resolves directly, so a nested
 *  `.claude/worktrees` path cannot recurse. */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  const direct = await resolveRepoRootDirect(cwd);
  if (direct) { return direct; }
  const derived = repoRootFromClaudeWorktreePath(cwd);
  if (!derived) { return null; }
  return resolveRepoRootDirect(derived);
}

/** Single-pass resolution: read `<cwd>/.git` and nothing else. */
async function resolveRepoRootDirect(cwd: string): Promise<string | null> {
  if (!cwd) { return null; }

  let realCwd: string;
  try {
    realCwd = await fs.promises.realpath(cwd);
  } catch {
    realCwd = cwd;
  }

  const dotGit = path.join(realCwd, '.git');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(dotGit);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    return realCwd;
  }

  if (!stat.isFile()) {
    return null;
  }

  let contents: string;
  try {
    contents = await fs.promises.readFile(dotGit, 'utf-8');
  } catch {
    return null;
  }

  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!match) { return null; }

  const gitDirRaw = match[1];
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(realCwd, gitDirRaw);

  let commonDir = gitDir;
  let commonResolved = false;
  try {
    const commonRaw = (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf-8')).trim();
    if (commonRaw) {
      commonDir = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(gitDir, commonRaw);
      commonResolved = true;
    }
  } catch {
    // No commondir file — fall through to the heuristic below.
  }

  // Standard layout: gitDir = <commonDir>/worktrees/<name>. If commondir wasn't
  // explicitly provided, derive it from this pattern.
  if (!commonResolved) {
    const parent = path.dirname(gitDir);
    if (path.basename(parent) === 'worktrees') {
      commonDir = path.dirname(parent);
    }
  }

  try {
    const realCommon = await fs.promises.realpath(commonDir);
    return path.dirname(realCommon);
  } catch {
    return null;
  }
}

export interface WorktreeInfo {
  /** Absolute path of the worktree's working tree (canonical/realpath). */
  path: string;
  /** Branch name if HEAD is a symbolic ref (`refs/heads/<branch>`); null when detached. */
  branch: string | null;
  /** True for the main checkout (where `.git` is a directory). */
  isMain: boolean;
}

/** Enumerate every worktree of the repo rooted at `repoRoot` by reading
 *  `<repoRoot>/.git/worktrees/*`. Includes the main checkout itself. Returns
 *  empty when `repoRoot` isn't a git repo or `.git` isn't a directory (i.e.
 *  caller passed a linked worktree path; resolveRepoRoot first). */
export async function discoverWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  if (!repoRoot) { return []; }

  const gitDir = path.join(repoRoot, '.git');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(gitDir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) { return []; }

  const mainBranch = await readHeadBranch(path.join(gitDir, 'HEAD'));
  const result: WorktreeInfo[] = [{ path: repoRoot, branch: mainBranch, isMain: true }];

  const worktreesDir = path.join(gitDir, 'worktrees');
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(worktreesDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    const wtMetaDir = path.join(worktreesDir, entry.name);
    const gitdirFile = path.join(wtMetaDir, 'gitdir');
    let wtPath: string;
    try {
      const raw = (await fs.promises.readFile(gitdirFile, 'utf-8')).trim();
      // gitdir contents: <wt-path>/.git — the working tree is its parent.
      wtPath = path.dirname(raw);
    } catch {
      continue;
    }
    try {
      wtPath = await fs.promises.realpath(wtPath);
    } catch {
      // Worktree dir was removed but the metadata stub remains — skip it.
      continue;
    }
    const branch = await readHeadBranch(path.join(wtMetaDir, 'HEAD'));
    result.push({ path: wtPath, branch, isMain: false });
  }

  return result;
}

async function readHeadBranch(headPath: string): Promise<string | null> {
  try {
    const raw = (await fs.promises.readFile(headPath, 'utf-8')).trim();
    const m = /^ref:\s+refs\/heads\/(.+)$/.exec(raw);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Compare two worktree lists for set equality (order-insensitive,
 *  branch-aware). Shared by local and foreign discovery so both detect
 *  worktree refresh the same way. */
export function worktreeSetChanged(a: WorktreeInfo[], b: WorktreeInfo[]): boolean {
  if (a.length !== b.length) { return true; }
  const key = (w: WorktreeInfo): string => `${w.path}\0${w.branch ?? ''}`;
  const aKeys = new Set(a.map(key));
  for (const w of b) {
    if (!aKeys.has(key(w))) { return true; }
  }
  return false;
}
