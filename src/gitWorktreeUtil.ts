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
