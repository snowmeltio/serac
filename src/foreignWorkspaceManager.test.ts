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

const silentLog = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, trace: () => {} };

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

describe('ForeignWorkspaceManager: dismissed sessions stay out of the strips', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwm-dis-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
  });
  afterEach(() => {
    _resetConfig();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getRunningSnapshots excludes a dismissed session (badge/strip parity with rows)', async () => {
    const cwd = path.join(tmpDir, 'other-ws');
    const key = sanitiseKey(cwd);
    createForeignSession(key, '11111111-1111-4111-8111-111111111111', cwd);
    createForeignSession(key, '22222222-2222-4222-8222-222222222222', cwd);
    // Dismiss session 1 in the foreign workspace's own session-meta.json —
    // rows already honour this; the strips and badge must too.
    fs.writeFileSync(path.join(projectsDir, key, 'session-meta.json'), JSON.stringify({
      sessions: { '11111111-1111-4111-8111-111111111111': {
        title: null, dismissed: true, acknowledged: false, acknowledgedAt: null, firstSeen: Date.now(),
      } },
    }));
    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    await manager.scan();
    const running = manager.getRunningSnapshots();
    expect(running.map(s => s.sessionId)).toEqual(['22222222-2222-4222-8222-222222222222']);
  });
});

describe('ForeignWorkspaceManager: live-only visibility window', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwm-live-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    _setConfigValues({ 'serac.discovery.foreignWorkspacesWindow': 'live-only' });
  });
  afterEach(() => {
    _resetConfig();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const SID_LIVE = '33333333-3333-4333-8333-333333333333';
  const SID_DEAD = '44444444-4444-4444-8444-444444444444';

  /** A foreign session whose JSONL activity (and file mtime) is `ageMs` old. */
  function createAgedSession(workspaceKey: string, sessionId: string, cwd: string, ageMs: number): void {
    const dir = path.join(projectsDir, workspaceKey);
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date(Date.now() - ageMs);
    const record = JSON.stringify({
      type: 'user', cwd, timestamp: at.toISOString(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, record + '\n');
    fs.utimesSync(file, at, at);
  }

  function probeMap(map: Record<string, boolean | null>): (sessionId: string) => () => boolean | null {
    return (sessionId: string) => () => map[sessionId] ?? null;
  }

  it('includes a live session even when it is far older than the time gate', async () => {
    const cwd = path.join(tmpDir, 'old-ws');
    const key = sanitiseKey(cwd);
    createAgedSession(key, SID_LIVE, cwd, 30 * 24 * 60 * 60 * 1000); // 30d old, 7d gate
    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    manager.setLivenessProbeFactory(probeMap({ [SID_LIVE]: true }));
    await manager.scan();
    expect(manager.getWorkspaces().length).toBe(1);
  });

  it('excludes a registry-confirmed-absent session even when it is young', async () => {
    const cwd = path.join(tmpDir, 'dead-ws');
    const key = sanitiseKey(cwd);
    createAgedSession(key, SID_DEAD, cwd, 60_000); // 1 minute old
    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    manager.setLivenessProbeFactory(probeMap({ [SID_DEAD]: false }));
    await manager.scan();
    expect(manager.getWorkspaces().length).toBe(0);
  });

  it('falls back to the time gate when the registry cannot answer (probe null / unwired)', async () => {
    const cwdYoung = path.join(tmpDir, 'young-ws');
    const cwdOld = path.join(tmpDir, 'stale-ws');
    createAgedSession(sanitiseKey(cwdYoung), SID_LIVE, cwdYoung, 60_000);
    createAgedSession(sanitiseKey(cwdOld), SID_DEAD, cwdOld, 30 * 24 * 60 * 60 * 1000);
    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    // No probe factory wired at all → both resolve via the 7d fallback window.
    await manager.scan();
    const keys = manager.getWorkspaces().map(g => g.workspaceKey);
    expect(keys).toEqual([sanitiseKey(cwdYoung)]);
  });

  it('poll() evicts a dormant session once its process goes away', async () => {
    const cwd = path.join(tmpDir, 'evict-ws');
    const key = sanitiseKey(cwd);
    createAgedSession(key, SID_LIVE, cwd, 60_000);
    const liveness: Record<string, boolean | null> = { [SID_LIVE]: true };
    const manager = new ForeignWorkspaceManager(projectsDir, 'local-key', silentLog);
    manager.setLivenessProbeFactory(probeMap(liveness));
    await manager.scan();
    expect(manager.getWorkspaces().length).toBe(1);

    // Active sessions are never window-evicted directly: the sequence is
    // latch seen-live → registry death-gate demotes running→done → the
    // dormant branch evicts on the following cycle.
    // Eviction sequencing: an active session is first resolved by the
    // registry death-gate, then the dormant branch window-evicts it — at
    // most two cycles after the process disappears, with `changed` flagged
    // on the cycle that evicts (so the UI repaints).
    await manager.poll();       // probe true: latches seen-live
    liveness[SID_LIVE] = false; // process exits
    const c1 = await manager.poll();
    const c2 = await manager.poll();
    expect(c1 || c2).toBe(true);
    expect(manager.getWorkspaces().length).toBe(0);
  });
});
