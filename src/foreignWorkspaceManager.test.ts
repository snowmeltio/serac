/**
 * Foreign worktree discovery tests.
 *
 * Verifies that ForeignWorkspaceManager enumerates worktrees per repoRoot and
 * surfaces them on `getWorkspaces()` rows. Uses real fs fixtures in tmpdir
 * (no mocking) — the manager is fs-heavy and only meaningful against real
 * `.git/worktrees/*` layouts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Required because the manager transitively imports settings.ts → 'vscode'.
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ForeignWorkspaceManager } from './foreignWorkspaceManager.js';
import { _setConfigValues, _resetConfig } from './__mocks__/vscode.js';
import { PSEUDO_TMP_REPO_ROOT } from './panelUtils.js';

const silentLog = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

let tmpDir: string;
let projectsDir: string;

function sanitiseKey(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Create a Claude Code JSONL file for a workspace key, with a `cwd` record
 *  that round-trips to that key when sanitised. */
function createForeignSession(workspaceKey: string, sessionId: string, cwd: string): void {
  const dir = path.join(projectsDir, workspaceKey);
  fs.mkdirSync(dir, { recursive: true });
  const record = JSON.stringify({
    type: 'user',
    cwd,
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text: 'Hello' }] },
  });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), record + '\n');
}

/** Create a main checkout at `repo` with linked worktrees at each path in
 *  `worktreePaths`. The main checkout has `.git` as a directory; each linked
 *  worktree has `.git` as a file pointing at `<repo>/.git/worktrees/<name>`. */
function setupRepoWithWorktrees(repo: string, worktreePaths: Array<{ path: string; name: string }>): void {
  fs.mkdirSync(path.join(repo, '.git', 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  for (const wt of worktreePaths) {
    const wtMetaDir = path.join(repo, '.git', 'worktrees', wt.name);
    fs.mkdirSync(wtMetaDir, { recursive: true });
    fs.writeFileSync(path.join(wtMetaDir, 'gitdir'), `${wt.path}/.git\n`);
    fs.writeFileSync(path.join(wtMetaDir, 'HEAD'), `ref: refs/heads/${wt.name}\n`);
    fs.mkdirSync(wt.path, { recursive: true });
    fs.writeFileSync(path.join(wt.path, '.git'), `gitdir: ${wtMetaDir}\n`);
  }
}

describe('ForeignWorkspaceManager: worktree discovery', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwm-wt-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates worktrees array on rows whose repoRoot has linked worktrees', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
    const wtA = path.join(tmpDir, 'wt-feat-a');
    const wtB = path.join(tmpDir, 'wt-feat-b');
    setupRepoWithWorktrees(repo, [
      { path: wtA, name: 'feat-a' },
      { path: wtB, name: 'feat-b' },
    ]);

    // Foreign session living in one of the linked worktrees
    const wsKey = sanitiseKey(wtA);
    createForeignSession(wsKey, 'sess-a', wtA);

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();

    const groups = manager.getWorkspaces();
    expect(groups.length).toBe(1);
    const g = groups[0];
    expect(g.repoRoot).toBe(repo);
    expect(g.worktrees).toBeDefined();
    expect(g.worktrees!.length).toBe(3); // main + 2 linked

    const paths = g.worktrees!.map(w => w.path).sort();
    expect(paths).toEqual([repo, fs.realpathSync(wtA), fs.realpathSync(wtB)].sort());
    const mainEntry = g.worktrees!.find(w => w.isMain);
    expect(mainEntry).toBeDefined();
    expect(mainEntry!.path).toBe(repo);
  });

  it('omits worktrees field when the workspace has no git repoRoot', async () => {
    const stray = path.join(tmpDir, 'no-git');
    fs.mkdirSync(stray, { recursive: true });
    const wsKey = sanitiseKey(stray);
    createForeignSession(wsKey, 'sess-x', stray);

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();

    const groups = manager.getWorkspaces();
    expect(groups.length).toBe(1);
    expect(groups[0].repoRoot).toBeNull();
    expect(groups[0].worktrees).toBeUndefined();
  });

  it('refreshWorktreesForKnownRepos picks up newly-added worktrees', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
    const wtA = path.join(tmpDir, 'wt-feat-a');
    setupRepoWithWorktrees(repo, [{ path: wtA, name: 'feat-a' }]);

    const wsKey = sanitiseKey(wtA);
    createForeignSession(wsKey, 'sess-a', wtA);

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();
    expect(manager.getWorkspaces()[0].worktrees!.length).toBe(2);

    // Add a second worktree on disk without re-scanning
    const wtB = path.join(tmpDir, 'wt-feat-b');
    const wtMetaDir = path.join(repo, '.git', 'worktrees', 'feat-b');
    fs.mkdirSync(wtMetaDir, { recursive: true });
    fs.writeFileSync(path.join(wtMetaDir, 'gitdir'), `${wtB}/.git\n`);
    fs.writeFileSync(path.join(wtMetaDir, 'HEAD'), `ref: refs/heads/feat-b\n`);
    fs.mkdirSync(wtB, { recursive: true });
    fs.writeFileSync(path.join(wtB, '.git'), `gitdir: ${wtMetaDir}\n`);

    const changed = await manager.refreshWorktreesForKnownRepos();
    expect(changed).toBe(true);
    expect(manager.getWorkspaces()[0].worktrees!.length).toBe(3);
  });

  it('refreshWorktreesForKnownRepos returns false when nothing changed', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
    const wtA = path.join(tmpDir, 'wt-feat-a');
    setupRepoWithWorktrees(repo, [{ path: wtA, name: 'feat-a' }]);

    createForeignSession(sanitiseKey(wtA), 'sess-a', wtA);

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();
    const changed = await manager.refreshWorktreesForKnownRepos();
    expect(changed).toBe(false);
  });
});

describe('ForeignWorkspaceManager: /private/tmp pseudo-repo overlay', () => {
  beforeEach(() => {
    _resetConfig();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwm-tmp-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    _resetConfig();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The scratch cwd is a string under /private/tmp; the dir need not exist on
  // disk — resolveRepoRoot returns null for a missing path, and the overlay
  // keys off the cwd string. This mirrors real scratch dirs that aren't repos.
  function createScratch(cwd: string): void {
    createForeignSession(sanitiseKey(cwd), 'sess-' + sanitiseKey(cwd), cwd);
  }

  it('assigns the pseudo root to scratch sessions under /private/tmp when enabled', async () => {
    _setConfigValues({ 'serac.worktrees.consolidateTmp': true });
    createScratch('/private/tmp/serac-hook-spike');

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();

    const groups = manager.getWorkspaces();
    expect(groups.length).toBe(1);
    expect(groups[0].repoRoot).toBe(PSEUDO_TMP_REPO_ROOT);
    // Pseudo roots have no .git, so no enumerated worktrees are attached.
    expect(groups[0].worktrees).toBeUndefined();
  });

  it('leaves scratch repoRoot null when the setting is off (default)', async () => {
    createScratch('/private/tmp/serac-hook-spike');

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();

    const groups = manager.getWorkspaces();
    expect(groups.length).toBe(1);
    expect(groups[0].repoRoot).toBeNull();
  });

  it('does not overlay non-tmp scratch dirs even when enabled', async () => {
    _setConfigValues({ 'serac.worktrees.consolidateTmp': true });
    // A path outside the temp root. It need not exist — resolveRepoRoot returns
    // null for a missing path, and isTmpScratchPath rejects it, so no overlay.
    // (Avoid os.tmpdir()-based paths here: on this host that resolves under
    // /tmp, which would legitimately trigger the overlay.)
    const stray = '/Users/nobody/projects/no-git-elsewhere';
    createScratch(stray);

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();

    expect(manager.getWorkspaces()[0].repoRoot).toBeNull();
  });

  it('does not override a real git repoRoot with the pseudo root', async () => {
    _setConfigValues({ 'serac.worktrees.consolidateTmp': true });
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'repo-')));
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    createForeignSession(sanitiseKey(repo), 'sess-repo', repo);

    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();

    expect(manager.getWorkspaces()[0].repoRoot).toBe(repo);
  });
});
