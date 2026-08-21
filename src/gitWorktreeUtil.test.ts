/**
 * Tests for resolveRepoRoot. Uses real fs fixtures in tmpdir to avoid
 * mocking — the helper is fs-heavy and only meaningful against real layouts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveRepoRoot,
  worktreeSetChanged,
  repoRootFromClaudeWorktreePath,
  isAtOrUnder,
} from './gitWorktreeUtil.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-gwt-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function realTmp(p: string): string {
  return fs.realpathSync(p);
}

describe('repoRootFromClaudeWorktreePath', () => {
  it('derives the repo from the <repo>/.claude/worktrees/<name> shape', () => {
    expect(repoRootFromClaudeWorktreePath('/repo/serac/.claude/worktrees/bridge-cse_01A'))
      .toBe('/repo/serac');
  });

  it('does no fs work, so it still answers for a removed worktree', () => {
    const gone = path.join(tmpDir, 'never-existed', '.claude', 'worktrees', 'bridge-cse_X');
    expect(repoRootFromClaudeWorktreePath(gone)).toBe(path.join(tmpDir, 'never-existed'));
  });

  it('tolerates a trailing separator', () => {
    expect(repoRootFromClaudeWorktreePath('/repo/serac/.claude/worktrees/wt/'))
      .toBe('/repo/serac');
  });

  it('rejects a subfolder of a worktree — only the immediate child qualifies', () => {
    expect(repoRootFromClaudeWorktreePath('/repo/serac/.claude/worktrees/wt/src')).toBeNull();
  });

  it('rejects unrelated shapes', () => {
    expect(repoRootFromClaudeWorktreePath('/repo/serac')).toBeNull();
    expect(repoRootFromClaudeWorktreePath('/repo/serac/.claude/agents/x')).toBeNull();
    expect(repoRootFromClaudeWorktreePath('/repo/serac/worktrees/x')).toBeNull();
    expect(repoRootFromClaudeWorktreePath('relative/.claude/worktrees/x')).toBeNull();
    expect(repoRootFromClaudeWorktreePath('')).toBeNull();
  });
});

describe('isAtOrUnder', () => {
  it('is true for the path itself and for descendants', () => {
    expect(isAtOrUnder('/repo/serac', '/repo/serac')).toBe(true);
    expect(isAtOrUnder('/repo/serac/src/a.ts', '/repo/serac')).toBe(true);
  });

  it('compares segment-wise, so a shared prefix is not containment', () => {
    expect(isAtOrUnder('/repo/serac-old', '/repo/serac')).toBe(false);
  });

  it('is false for empty inputs', () => {
    expect(isAtOrUnder('', '/repo/serac')).toBe(false);
    expect(isAtOrUnder('/repo/serac', '')).toBe(false);
  });
});

describe('resolveRepoRoot', () => {
  it('falls back to the owning repo when a Claude worktree has been removed', async () => {
    // The RC case: `<repo>/.claude/worktrees/bridge-cse_*` is created, used,
    // and deleted, but its session JSONL outlives it. Reading the worktree's
    // own `.git` cannot answer — the directory is gone.
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const gone = path.join(repo, '.claude', 'worktrees', 'bridge-cse_01A');
    expect(fs.existsSync(gone)).toBe(false);

    expect(await resolveRepoRoot(gone)).toBe(realTmp(repo));
  });

  it('still returns null for a removed path that is not a Claude worktree', async () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    expect(await resolveRepoRoot(path.join(repo, 'sub', 'dir'))).toBeNull();
    expect(await resolveRepoRoot(path.join(tmpDir, 'not-a-repo'))).toBeNull();
  });

  it('returns null when the derived parent is not a repo either', async () => {
    const gone = path.join(tmpDir, 'nowhere', '.claude', 'worktrees', 'bridge-cse_01A');

    expect(await resolveRepoRoot(gone)).toBeNull();
  });

  it('does not let the fallback override a real .git', async () => {
    // A LIVE Claude worktree resolves through its own gitdir, not the shape.
    const repo = path.join(tmpDir, 'repo');
    const wtGitDir = path.join(repo, '.git', 'worktrees', 'live');
    fs.mkdirSync(wtGitDir, { recursive: true });
    const wt = path.join(repo, '.claude', 'worktrees', 'live');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

    expect(await resolveRepoRoot(wt)).toBe(realTmp(repo));
  });

  it('returns the cwd for a main checkout (.git is a directory)', async () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    expect(await resolveRepoRoot(repo)).toBe(realTmp(repo));
  });

  it('returns the main repo for a worktree (gitdir without commondir)', async () => {
    const repo = path.join(tmpDir, 'repo');
    const wt = path.join(tmpDir, 'wt-feat');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'feat'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(
      path.join(wt, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'feat')}\n`,
    );

    expect(await resolveRepoRoot(wt)).toBe(realTmp(repo));
  });

  it('returns the main repo for a worktree that has a commondir file', async () => {
    const repo = path.join(tmpDir, 'repo');
    const wt = path.join(tmpDir, 'wt-feat');
    const wtGitDir = path.join(repo, '.git', 'worktrees', 'feat');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

    expect(await resolveRepoRoot(wt)).toBe(realTmp(repo));
  });

  it('handles relative gitdir paths', async () => {
    const repo = path.join(tmpDir, 'repo');
    const wt = path.join(tmpDir, 'wt-x');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'x'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    // Relative path from wt to gitdir
    const rel = path.relative(wt, path.join(repo, '.git', 'worktrees', 'x'));
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${rel}\n`);

    expect(await resolveRepoRoot(wt)).toBe(realTmp(repo));
  });

  it('resolves symlinked cwd via realpath', async () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const link = path.join(tmpDir, 'link');
    fs.symlinkSync(repo, link);

    expect(await resolveRepoRoot(link)).toBe(realTmp(repo));
  });

  it('returns null when there is no .git', async () => {
    const dir = path.join(tmpDir, 'plain');
    fs.mkdirSync(dir, { recursive: true });
    expect(await resolveRepoRoot(dir)).toBeNull();
  });

  it('returns null when gitdir points to a non-existent path', async () => {
    const wt = path.join(tmpDir, 'wt-stale');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/path/.git/worktrees/x\n');

    expect(await resolveRepoRoot(wt)).toBeNull();
  });

  it('returns null on a malformed .git file', async () => {
    const wt = path.join(tmpDir, 'wt-bad');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'this is not a gitdir line\n');

    expect(await resolveRepoRoot(wt)).toBeNull();
  });

  it('returns null for an empty cwd', async () => {
    expect(await resolveRepoRoot('')).toBeNull();
  });
});

describe('worktreeSetChanged', () => {
  const wt = (p: string, branch: string | null = null) => ({ path: p, branch, isMain: false });

  it('reports no change for equal sets regardless of order', () => {
    const a = [wt('/r/a', 'main'), wt('/r/b', 'fix')];
    const b = [wt('/r/b', 'fix'), wt('/r/a', 'main')];
    expect(worktreeSetChanged(a, b)).toBe(false);
  });

  it('detects added and removed worktrees', () => {
    expect(worktreeSetChanged([wt('/r/a')], [wt('/r/a'), wt('/r/b')])).toBe(true);
    expect(worktreeSetChanged([wt('/r/a'), wt('/r/b')], [wt('/r/a')])).toBe(true);
  });

  it('detects a branch change on the same path', () => {
    expect(worktreeSetChanged([wt('/r/a', 'main')], [wt('/r/a', 'fix')])).toBe(true);
  });

  it('treats null branch as distinct from a named branch', () => {
    expect(worktreeSetChanged([wt('/r/a', null)], [wt('/r/a', 'main')])).toBe(true);
  });
});
