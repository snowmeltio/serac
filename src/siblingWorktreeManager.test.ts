/**
 * Sibling-worktree discovery tests.
 *
 * Verifies that SiblingWorktreeManager tracks sessions from sibling worktrees
 * of the local repo and — crucially — prunes them when the worktree directory
 * is removed (`git worktree remove`). Without pruning, the leftover JSONLs in
 * ~/.claude/projects keep surfacing as undismissable zombie cards until the
 * extension restarts. Uses real fs fixtures (no mocking) since the manager is
 * fs-heavy and only meaningful against real `.git/worktrees/*` layouts.
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
import { SiblingWorktreeManager } from './siblingWorktreeManager.js';
import { _setConfigValues } from './__mocks__/vscode.js';
import { resolveRepoRoot } from './gitWorktreeUtil.js';
import { JsonlTailer } from './jsonlTailer.js';

const silentLog = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, trace: () => {} };

let tmpDir: string;
let projectsDir: string;

function sanitiseKey(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Create a Claude Code JSONL for a workspace key with a `cwd` record. */
function createSession(workspaceKey: string, sessionId: string, cwd: string): void {
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

/** Same as createSession but with no `cwd` field on the record — a
 *  transcript whose head can't be peeked for a worktree CWD. */
function createSessionNoCwd(workspaceKey: string, sessionId: string): void {
  const dir = path.join(projectsDir, workspaceKey);
  fs.mkdirSync(dir, { recursive: true });
  const record = JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text: 'Hello' }] },
  });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), record + '\n');
}

/** Main checkout at `repo` with a single linked worktree at `wtPath`. */
function setupRepoWithWorktree(repo: string, wtPath: string, name: string): void {
  const wtMetaDir = path.join(repo, '.git', 'worktrees', name);
  fs.mkdirSync(wtMetaDir, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(wtMetaDir, 'gitdir'), `${wtPath}/.git\n`);
  fs.writeFileSync(path.join(wtMetaDir, 'HEAD'), `ref: refs/heads/${name}\n`);
  fs.mkdirSync(wtPath, { recursive: true });
  fs.writeFileSync(path.join(wtPath, '.git'), `gitdir: ${wtMetaDir}\n`);
}

describe('SiblingWorktreeManager', () => {
  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swm-')));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    _setConfigValues({});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tracks a sibling-worktree session, then prunes it when the worktree is removed', async () => {
    const repo = path.join(tmpDir, 'repo');
    const wt = path.join(tmpDir, 'repo-feature');
    fs.mkdirSync(repo, { recursive: true });
    setupRepoWithWorktree(repo, wt, 'feature');

    // Both sides resolve to the same canonical repo root → classified as sibling.
    const repoRoot = await resolveRepoRoot(wt);
    expect(repoRoot).toBeTruthy();

    createSession(sanitiseKey(wt), 'sib-1', wt);

    const manager = new SiblingWorktreeManager(projectsDir, sanitiseKey(repo), silentLog);
    manager.setLocalRepoRoot(repoRoot);

    // First scan: the sibling session is discovered.
    const addedChanged = await manager.scan();
    expect(addedChanged).toBe(true);
    expect(manager.getSnapshots().map(s => s.sessionId)).toContain('sib-1');

    // Worktree directory is removed (the JSONL still lingers in projectsDir).
    fs.rmSync(wt, { recursive: true, force: true });

    // Next scan: the now-orphaned session is pruned and the change is reported.
    const prunedChanged = await manager.scan();
    expect(prunedChanged).toBe(true);
    expect(manager.getSnapshots()).toHaveLength(0);

    manager.dispose();
  });

  it('keeps the sibling session while the worktree still exists', async () => {
    const repo = path.join(tmpDir, 'repo');
    const wt = path.join(tmpDir, 'repo-feature');
    fs.mkdirSync(repo, { recursive: true });
    setupRepoWithWorktree(repo, wt, 'feature');

    const repoRoot = await resolveRepoRoot(wt);
    createSession(sanitiseKey(wt), 'sib-1', wt);

    const manager = new SiblingWorktreeManager(projectsDir, sanitiseKey(repo), silentLog);
    manager.setLocalRepoRoot(repoRoot);

    await manager.scan();
    expect(manager.getSnapshots().map(s => s.sessionId)).toContain('sib-1');

    // A second scan with the worktree intact must NOT prune it.
    await manager.scan();
    expect(manager.getSnapshots().map(s => s.sessionId)).toContain('sib-1');

    manager.dispose();
  });

  describe('discovery gate', () => {
    /** Repo + one sibling worktree carrying a session, ready to scan. */
    async function seed(): Promise<SiblingWorktreeManager> {
      const repo = path.join(tmpDir, 'repo');
      const wt = path.join(tmpDir, 'repo-feature');
      fs.mkdirSync(repo, { recursive: true });
      setupRepoWithWorktree(repo, wt, 'feature');
      const repoRoot = await resolveRepoRoot(wt);
      createSession(sanitiseKey(wt), 'sib-1', wt);
      const manager = new SiblingWorktreeManager(projectsDir, sanitiseKey(repo), silentLog);
      manager.setLocalRepoRoot(repoRoot);
      return manager;
    }

    it('discovers siblings when the Worktrees pane is on (squash off)', async () => {
      _setConfigValues({ 'serac.show.worktrees': true, 'serac.worktrees.squash': false });
      const manager = await seed();
      await manager.scan();
      expect(manager.getSnapshots().map(s => s.sessionId)).toContain('sib-1');
      manager.dispose();
    });

    it('skips discovery when neither consumer wants it', async () => {
      _setConfigValues({ 'serac.show.worktrees': false, 'serac.worktrees.squash': false });
      const manager = await seed();
      expect(await manager.scan()).toBe(false);
      expect(manager.getSnapshots()).toHaveLength(0);
      expect(await manager.poll()).toBe(false);
      manager.dispose();
    });

    it('discovers siblings for squash even with the pane off', async () => {
      // Squash renders these sessions as cards in the main list, so gating
      // discovery on the pane toggle alone would make the setting silently do
      // nothing — the failure mode this gate exists to prevent.
      _setConfigValues({ 'serac.show.worktrees': false, 'serac.worktrees.squash': true });
      const manager = await seed();
      await manager.scan();
      expect(manager.getSnapshots().map(s => s.sessionId)).toContain('sib-1');
      manager.dispose();
    });
  });

  describe('head-only cwd peek (PR B)', () => {
    it('classifies a sibling dir through a single readNewRecords() call, not two', async () => {
      const repo = path.join(tmpDir, 'repo');
      const wt = path.join(tmpDir, 'repo-feature');
      fs.mkdirSync(repo, { recursive: true });
      setupRepoWithWorktree(repo, wt, 'feature');
      const repoRoot = await resolveRepoRoot(wt);
      createSession(sanitiseKey(wt), 'sib-1', wt);

      const manager = new SiblingWorktreeManager(projectsDir, sanitiseKey(repo), silentLog);
      manager.setLocalRepoRoot(repoRoot);

      const spy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords');
      await manager.scan();
      expect(manager.getSnapshots().map(s => s.sessionId)).toContain('sib-1');
      // Before PR B: peekCwdInDir() classified the dir by fully replaying the
      // file through a throwaway SessionManager (1 readNewRecords() call),
      // then trackJsonlSessions constructed its OWN manager to actually track
      // the session and replayed the same file again (2nd call) — the exact
      // double-replay this change removes. peekCwd() (jsonlPeek.ts) reads the
      // head directly with a plain file read, bypassing JsonlTailer entirely,
      // so only the tracked manager's update() touches readNewRecords now.
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
      manager.dispose();
    });

    it('falls through to the next-newest file when the newest one has no cwd in its head', async () => {
      const repo = path.join(tmpDir, 'repo');
      const wt = path.join(tmpDir, 'repo-feature');
      fs.mkdirSync(repo, { recursive: true });
      setupRepoWithWorktree(repo, wt, 'feature');
      const repoRoot = await resolveRepoRoot(wt);

      const key = sanitiseKey(wt);
      createSession(key, 'sib-old', wt);        // carries cwd
      createSessionNoCwd(key, 'sib-new');        // no cwd — this is the newest file
      const dir = path.join(projectsDir, key);
      const oldTime = new Date(Date.now() - 60_000);
      const newTime = new Date();
      fs.utimesSync(path.join(dir, 'sib-old.jsonl'), oldTime, oldTime);
      fs.utimesSync(path.join(dir, 'sib-new.jsonl'), newTime, newTime);

      const manager = new SiblingWorktreeManager(projectsDir, sanitiseKey(repo), silentLog);
      manager.setLocalRepoRoot(repoRoot);

      await manager.scan();
      // The dir still gets classified as a sibling (via the older file's cwd)
      // and, once classified, every session in it — including the one whose
      // own head had no cwd — is tracked.
      const ids = manager.getSnapshots().map(s => s.sessionId);
      expect(ids).toEqual(expect.arrayContaining(['sib-old', 'sib-new']));

      manager.dispose();
    });
  });
});
