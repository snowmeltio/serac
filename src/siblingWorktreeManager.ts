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
import { pollTrackedSessions, hasActiveTrackedSessions, trackJsonlSessions, jsonlSessionId, makeRescanGate } from './sessionPolling.js';
import { readSettings, ageGateMsFor } from './settings.js';


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
  private localRepoRoot: string | null = null;

  constructor(
    private readonly projectsDir: string,
    private readonly localWorkspaceKey: string,
    private readonly log: Logger,
  ) {}

  /** Per-session registry liveness probe factory, injected by SessionDiscovery
   *  (freshness parity: sibling cards get the same death gate as primary). */
  private probeFactory?: (sessionId: string) => () => boolean | null;

  setLivenessProbeFactory(factory: (sessionId: string) => () => boolean | null): void {
    this.probeFactory = factory;
  }

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

  /** Whether it's time for a full rescan (every Nth poll cycle). No active
   *  fast-path: a rescan walks the whole projectsDir, too costly per cycle. */
  private readonly rescanGate = makeRescanGate();
  shouldRescan(): boolean {
    return this.rescanGate();
  }

  /** Scan all non-local workspace directories. For each candidate that
   *  hasn't already been classified, peek at a session to discover its CWD
   *  and decide whether it's a sibling worktree of the local repo. Returns
   *  true when the tracked set changed (sessions added or pruned) so the
   *  caller can trigger a re-render. */
  async scan(): Promise<boolean> {
    if (this.inert) { return false; }
    if (!readSettings().show.worktrees) { return false; }
    const now = Date.now();
    const ageGate = ageGateMsFor('worktrees');
    // Drop siblings whose worktree directory has been removed (e.g. `git
    // worktree remove`). Their JSONLs linger in ~/.claude/projects, but the
    // worktree is gone — without this they'd persist as undismissable zombie
    // cards until the extension restarts.
    let changed = await this.pruneRemovedWorktrees();
    let dirs: string[];
    try {
      dirs = await fs.promises.readdir(this.projectsDir);
    } catch {
      return changed;
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
      if (await trackJsonlSessions({
        wsPath, workspaceKey: dir, files,
        sessions: this.sessions, now,
        withinWindow: (_sessionId, lastActivityMs) => now - lastActivityMs <= ageGate,
        makeManager: (sessionId, filePath) => {
          const manager = new SessionManager(sessionId, filePath, dir, { livenessProbe: this.probeFactory?.(sessionId) });
          manager.setWorktreeOrigin(wtRoot, wtLabel);
          return manager;
        },
        warn: (compositeId, err) => this.log.warn(`Sibling session update failed (${compositeId}):`, err),
      })) {
        changed = true;
      }
    }
    return changed;
  }

  /** Drop tracked siblings whose worktree CWD no longer exists on disk.
   *  Returns true when anything was pruned. A pruned dir is fully forgotten
   *  (not added to nonSiblingKeys) so that if the worktree is recreated later
   *  a subsequent scan re-classifies and re-adds it. */
  private async pruneRemovedWorktrees(): Promise<boolean> {
    let changed = false;
    for (const dir of [...this.siblingKeys]) {
      const cwd = this.worktreeRootForKey.get(dir);
      if (cwd) {
        try {
          await fs.promises.access(cwd);
          continue; // worktree still present — keep it
        } catch {
          // CWD gone — fall through to prune
        }
      }
      // Drop every session originating from this worktree.
      for (const [compositeId, session] of this.sessions) {
        if (compositeId.startsWith(dir + '/')) {
          session.dispose();
          this.sessions.delete(compositeId);
          changed = true;
        }
      }
      this.siblingKeys.delete(dir);
      this.worktreeRootForKey.delete(dir);
      this.worktreeLabelForKey.delete(dir);
      this.log.info('[sibling] pruned removed worktree: %s', dir);
      changed = true;
    }
    return changed;
  }

  /** Read enough of a JSONL in `wsPath` to extract a CWD. We try the most
   *  recently-modified file first because old files may pre-date the cwd
   *  field or have been compacted in ways that strip it. */
  private async peekCwdInDir(
    wsPath: string,
    files: string[],
    now: number,
  ): Promise<string | null> {
    const ageGate = ageGateMsFor('worktrees');
    const candidates: { file: string; mtimeMs: number }[] = [];
    for (const file of files) {
      if (jsonlSessionId(file) === null) { continue; }
      try {
        const stat = await fs.promises.stat(path.join(wsPath, file));
        if (now - stat.mtimeMs > ageGate) { continue; }
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      } catch { /* skip */ }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { file } of candidates) {
      const sessionId = jsonlSessionId(file)!;
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

  /** Poll active sibling sessions (shared loop in sessionPolling.ts). */
  async poll(): Promise<boolean> {
    if (this.inert) { return false; }
    if (!readSettings().show.worktrees) { return false; }
    let changed = false;
    const now = Date.now();
    const ageGate = ageGateMsFor('worktrees');

    if (await pollTrackedSessions(this.sessions, now,
      (_sessionId, lastActivityMs) => now - lastActivityMs <= ageGate)) {
      changed = true;
    }
    return changed;
  }

  /** Snapshots of all sibling-worktree sessions, ready to merge into the
   *  local card feed. */
  /** Sibling sessions currently waiting on input — they render as cards in
   *  the main feed, so they must bump the needs-input badge like local ones. */
  getWaitingCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.getStatus() === 'waiting') { n++; }
    }
    return n;
  }

  /** Any sibling session currently running/waiting — feeds the adaptive
   *  fast-poll so an active sibling card refreshes at the 500ms cadence. */
  hasActiveSessions(): boolean {
    return hasActiveTrackedSessions(this.sessions);
  }

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

  /** Find the JSONL file path for a sibling session by sessionId. Returns
   *  undefined if the session isn't tracked by this manager. Used so the
   *  panel can render a transcript or open the editor for a card whose
   *  origin is a sibling worktree (kept inline in the local feed). */
  getSessionFilePath(sessionId: string): string | undefined {
    for (const [compositeId, session] of this.sessions) {
      if (compositeId.endsWith('/' + sessionId)) {
        return session.getFilePath();
      }
    }
    return undefined;
  }

  /** Whether a sibling session is currently running (or waiting). */
  isSessionRunning(sessionId: string): boolean {
    for (const [compositeId, session] of this.sessions) {
      if (compositeId.endsWith('/' + sessionId)) {
        const status = session.getStatus();
        return status === 'running' || status === 'waiting';
      }
    }
    return false;
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
