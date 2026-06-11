/**
 * Git repository root resolution.
 *
 * Determines the canonical repository root for a working-tree CWD without
 * shelling out to git. Handles three cases:
 *
 *  1. `<cwd>/.git` is a directory → cwd is the main checkout; repo root = cwd.
 *  2. `<cwd>/.git` is a file (linked worktree) → parse `gitdir: <path>`,
 *     read `<gitdir>/commondir` to find the main `.git` directory, then
 *     return its parent.
 *  3. No `.git` (or unreadable) → return `null`.
 *
 * Symlinks are resolved via `realpath` so two paths that point to the same
 * physical repo collapse to a single key. All errors are swallowed and
 * surfaced as `null` — callers should not have to wrap this in try/catch.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Resolve the repository root for a working-tree CWD. Returns null when
 *  the path isn't part of a git repo (or any fs error occurs). */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
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
