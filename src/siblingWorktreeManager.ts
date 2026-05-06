/**
 * Discovers and tails sessions from sibling worktrees of the local repo so
 * they appear inline in the main card list (rather than buried under "Other
 * workspaces"). Mirrors ForeignWorkspaceManager's structure but emits full
 * SessionSnapshots tagged with the originating worktree's root + label.
 *
 * When the local CWD is not part of a git repo, the manager is inert.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import { resolveRepoRoot } from './gitWorktreeUtil.js';
import type { SessionSnapshot } from './types.js';
import type { Logger } from './sessionDiscovery.js';

/** Age gate for sibling-worktree session tracking (matches foreign manager). */
const SIBLING_AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Full rescan every Nth poll cycle. */
const SIBLING_SCAN_INTERVAL = 10;

export class SiblingWorktreeManager {
  private sessions: Map<string, SessionManager> = new Map();
  private siblingKeys: Set<string> = new Set();
  /** workspaceKey → CWD of that worktree (resolved on first session). */
  private worktreeRootForKey: Map<string, string> = new Map();
  /** workspaceKey → display label (basename of CWD). */
  private worktreeLabelForKey: Map<string, string> = new Map();
  /** Workspace keys we've already determined are NOT sibling worktrees so
   *  subsequent scans can skip them without re-reading JSONLs. */
  private nonSiblingKeys: Set<string> = new Set();
  private scanCounter = 0;
  private localRepoRoot: string | null = null;

  constructor(
    private readonly projectsDir: string,
    private readonly localWorkspaceKey: string,
    private readonly log: Logger,
  ) {}

  /** Resolve and cache the local CWD's repoRoot. Until this resolves to a
   *  non-null value the manager stays inert. Re-callable if the workspace
   *  root changes (rare). */
  setLocalRepoRoot(repoRoot: string | null): void {
    if (this.localRepoRoot === repoRoot) { return; }
    this.localRepoRoot = repoRoot;
    // Reset classification — the answer to "is this a sibling?" changes when
    // the local repo root changes.
    this.nonSiblingKeys.clear();
    this.siblingKeys.clear();
    for (const session of this.sessions.values()) { session.dispose(); }
    this.sessions.clear();
    this.worktreeRootForKey.clear();
    this.worktreeLabelForKey.clear();
  }

  /** True when there's nothing to do (local CWD isn't in a git repo). */
  private get inert(): boolean {
    return this.localRepoRoot === null;
  }

  /** Workspace keys of sibling worktrees. ForeignWorkspaceManager queries
   *  this so it can exclude these from its foreign session list. */
  getSiblingKeys(): Set<string> {
    return this.siblingKeys;
  }

  /** Whether it's time for a full rescan (every Nth poll cycle). */
  shouldRescan(): boolean {
    this.scanCounter++;
    if (this.scanCounter >= SIBLING_SCAN_INTERVAL) {
      this.scanCounter = 0;
      return true;
    }
    return false;
  }

  /** Scan all non-local workspace directories. For each candidate that
   *  hasn't already been classified, peek at a session to discover its CWD
   *  and decide whether it's a sibling worktree of the local repo. */
  async scan(): Promise<void> {
    if (this.inert) { return; }
    const now = Date.now();
    let dirs: string[];
    try {
      dirs = await fs.promises.readdir(this.projectsDir);
    } catch {
      return;
    }

    for (const dir of dirs) {
      if (dir === this.localWorkspaceKey) { continue; }
      if (this.nonSiblingKeys.has(dir)) { continue; }

      const wsPath = path.join(this.projectsDir, dir);
      try {
        const stat = await fs.promises.stat(wsPath);
        if (!stat.isDirectory()) { continue; }
      } catch { continue; }

      let files: string[];
      try {
        files = await fs.promises.readdir(wsPath);
      } catch { continue; }

      // If we've already accepted this dir as a sibling, just pick up new sessions.
      const isKnownSibling = this.siblingKeys.has(dir);
      if (!isKnownSibling) {
        // Attempt classification by peeking at any recent JSONL to extract CWD.
        const cwd = await this.peekCwdInDir(wsPath, files, now);
        if (!cwd) {
          // No usable CWD yet — leave dir unclassified so a later scan can retry.
          continue;
        }
        let repoRoot: string | null;
        try {
          repoRoot = await resolveRepoRoot(cwd);
        } catch {
          repoRoot = null;
        }
        if (repoRoot !== this.localRepoRoot) {
          this.nonSiblingKeys.add(dir);
          continue;
        }
        this.siblingKeys.add(dir);
        this.worktreeRootForKey.set(dir, cwd);
        this.worktreeLabelForKey.set(dir, path.basename(cwd) || dir);
      }

      // Track all unread JSONLs in this sibling dir.
      const wtRoot = this.worktreeRootForKey.get(dir) ?? '';
      const wtLabel = this.worktreeLabelForKey.get(dir) ?? dir;
      for (const file of files) {
        if (!file.endsWith('.jsonl')) { continue; }
        const sessionId = file.replace('.jsonl', '');
        const compositeId = `${dir}/${sessionId}`;
        if (this.sessions.has(compositeId)) { continue; }

        const filePath = path.join(wsPath, file);
        try {
          const fstat = await fs.promises.stat(filePath);
          if (now - fstat.mtimeMs > SIBLING_AGE_GATE_MS) { continue; }
        } catch { continue; }

        const manager = new SessionManager(sessionId, filePath, dir);
        manager.setWorktreeOrigin(wtRoot, wtLabel);
        try {
          await manager.update();
        } catch (err) {
          this.log.warn(`Sibling session update failed (${compositeId}):`, err);
        }
        if (now - manager.getLastActivity().getTime() > SIBLING_AGE_GATE_MS) {
          manager.dispose();
          continue;
        }
        this.sessions.set(compositeId, manager);
      }
    }
  }

  /** Read enough of a JSONL in `wsPath` to extract a CWD. We try the most
   *  recently-modified file first because old files may pre-date the cwd
   *  field or have been compacted in ways that strip it. */
  private async peekCwdInDir(
    wsPath: string,
    files: string[],
    now: number,
  ): Promise<string | null> {
    const candidates: { file: string; mtimeMs: number }[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) { continue; }
      try {
        const stat = await fs.promises.stat(path.join(wsPath, file));
        if (now - stat.mtimeMs > SIBLING_AGE_GATE_MS) { continue; }
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      } catch { /* skip */ }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { file } of candidates) {
      const sessionId = file.replace('.jsonl', '');
      const probe = new SessionManager(sessionId, path.join(wsPath, file), path.basename(wsPath));
      try {
        await probe.update();
      } catch { /* skip */ }
      const cwd = probe.getSnapshot().cwd;
      probe.dispose();
      if (cwd) { return cwd; }
    }
    return null;
  }

  /** Poll active sibling sessions. Mirrors ForeignWorkspaceManager.poll(). */
  async poll(): Promise<boolean> {
    if (this.inert) { return false; }
    let changed = false;
    const now = Date.now();

    for (const [compositeId, session] of this.sessions) {
      const status = session.getStatus();
      if (status !== 'running' && status !== 'waiting') {
        if (now - session.getLastActivity().getTime() > SIBLING_AGE_GATE_MS) {
          session.dispose();
          this.sessions.delete(compositeId);
          changed = true;
          continue;
        }
        try {
          const mtimeChanged = await session.checkMtime();
          if (mtimeChanged) {
            const hadData = await session.update();
            if (hadData) { changed = true; }
          }
        } catch { /* skip */ }
        continue;
      }
      try {
        const hadData = await session.update();
        if (hadData) { changed = true; }
        if (!hadData && session.demoteIfStale(30_000)) {
          changed = true;
        }
      } catch { /* skip */ }
    }
    return changed;
  }

  /** Snapshots of all sibling-worktree sessions, ready to merge into the
   *  local card feed. */
  getSnapshots(): SessionSnapshot[] {
    const out: SessionSnapshot[] = [];
    for (const session of this.sessions.values()) {
      out.push(session.getSnapshot());
    }
    return out;
  }

  /** Resolve a CWD for a sibling workspace key (used when the panel passes
   *  back a workspaceKey for "open in VS Code"). */
  getCwdForWorkspace(workspaceKey: string): string | null {
    return this.worktreeRootForKey.get(workspaceKey) ?? null;
  }

  /** Drop all sibling sessions and clear state. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.siblingKeys.clear();
    this.worktreeRootForKey.clear();
    this.worktreeLabelForKey.clear();
    this.nonSiblingKeys.clear();
  }
}
