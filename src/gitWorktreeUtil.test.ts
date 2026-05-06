/**
 * Tests for resolveRepoRoot. Uses real fs fixtures in tmpdir to avoid
 * mocking — the helper is fs-heavy and only meaningful against real layouts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveRepoRoot } from './gitWorktreeUtil.js';

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

describe('resolveRepoRoot', () => {
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
