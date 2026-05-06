/**
 * Manages discovery and polling of foreign (non-current) workspace sessions.
 *
 * Extracted from SessionDiscovery to separate cross-workspace monitoring
 * from local session management. A workspace appears in the panel as soon as
 * it has any tracked JSONL file within the age gate; counts (running/waiting/
 * done/stale) are aggregated for display but a workspace with all-idle sessions
 * is still listed (with empty counts). Dismissed sessions are filtered out of
 * the counts entirely.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import { resolveRepoRoot } from './gitWorktreeUtil.js';
import type { SessionSnapshot, SessionMeta, SessionMetaFile, StatusConfidence, WorkspaceGroup } from './types.js';
import type { Logger } from './sessionDiscovery.js';

/** Age gate for foreign workspace tracking */
const FOREIGN_AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Full rescan every Nth poll cycle */
const FOREIGN_SCAN_INTERVAL = 10;
/** Confidence ranking for max-confidence aggregation */
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
/** done → stale promotion delay (mirrors SessionDiscovery) */
const STALE_PROMOTION_MS = 10_000;

export class ForeignWorkspaceManager {
  private sessions: Map<string, SessionManager> = new Map();
  private cwdCache: Map<string, string> = new Map();
  private repoRootCache: Map<string, string | null> = new Map();
  /** Cached per-workspace session meta (dismissed/acknowledged), refreshed during scan(). */
  private metaCache: Map<string, Map<string, SessionMeta>> = new Map();
  private scanCounter = 0;
  /** Returns the workspace keys that are sibling worktrees of the local repo
   *  and should therefore NOT be tracked here as foreign. Provided by
   *  SiblingWorktreeManager (defaults to an empty set). */
  private getSiblingKeys: () => Set<string> = () => new Set();

  constructor(
    private readonly projectsDir: string,
    private readonly localWorkspaceKey: string,
    private readonly log: Logger,
  ) {}

  /** Wire in the sibling-key provider. Called by SessionDiscovery once the
   *  SiblingWorktreeManager has been constructed. */
  setSiblingKeysProvider(provider: () => Set<string>): void {
    this.getSiblingKeys = provider;
  }

  /** Whether it's time for a full rescan (every Nth poll cycle). */
  shouldRescan(): boolean {
    this.scanCounter++;
    if (this.scanCounter >= FOREIGN_SCAN_INTERVAL) {
      this.scanCounter = 0;
      return true;
    }
    return false;
  }

  /** Scan all workspace directories for foreign sessions within the age gate. */
  async scan(): Promise<void> {
    const now = Date.now();
    const siblingKeys = this.getSiblingKeys();
    try {
      const dirs = await fs.promises.readdir(this.projectsDir);
      for (const dir of dirs) {
        if (dir === this.localWorkspaceKey) { continue; }
        if (siblingKeys.has(dir)) {
          // Sibling worktree of the local repo — owned by SiblingWorktreeManager.
          // Drop any state we may have accumulated before the sibling set updated.
          this.evictWorkspace(dir);
          continue;
        }
        const wsPath = path.join(this.projectsDir, dir);
        try {
          const stat = await fs.promises.stat(wsPath);
          if (!stat.isDirectory()) { continue; }
        } catch { continue; }
        try {
          const files = await fs.promises.readdir(wsPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) { continue; }
            const sessionId = file.replace('.jsonl', '');
            const compositeId = `${dir}/${sessionId}`;
            if (this.sessions.has(compositeId)) { continue; }

            const filePath = path.join(wsPath, file);
            try {
              const fstat = await fs.promises.stat(filePath);
              if (now - fstat.mtimeMs > FOREIGN_AGE_GATE_MS) { continue; }
            } catch { continue; }

            const manager = new SessionManager(sessionId, filePath, dir);
            try {
              await manager.update();
            } catch (err) {
              this.log.warn(`Foreign session update failed (${compositeId}):`, err);
            }
            // Drop sessions whose meaningful activity (user/assistant turns) is past
            // the gate even though mtime is recent. Claude Code backfills `ai-title`
            // records to old sessions, bumping mtime without indicating real
            // activity — without this check, scan() keeps re-adding what poll()
            // evicts, causing the workspace to flicker.
            if (now - manager.getLastActivity().getTime() > FOREIGN_AGE_GATE_MS) {
              manager.dispose();
              continue;
            }
            this.sessions.set(compositeId, manager);
          }
        } catch { /* unreadable directory */ }
      }
      // Cache cwd per workspace key (stable display names)
      for (const session of this.sessions.values()) {
        const snapshot = session.getSnapshot();
        if (snapshot.cwd && !this.cwdCache.has(snapshot.workspaceKey)) {
          this.cwdCache.set(snapshot.workspaceKey, snapshot.cwd);
        }
      }
      // Resolve repoRoot once per cached cwd (drives repo grouping in the panel).
      for (const [key, cwd] of this.cwdCache) {
        if (this.repoRootCache.has(key)) { continue; }
        try {
          this.repoRootCache.set(key, await resolveRepoRoot(cwd));
        } catch (err) {
          this.repoRootCache.set(key, null);
          this.log.warn(`Failed to resolve repoRoot for ${cwd}:`, err);
        }
      }
      // Refresh meta caches for every workspace we now track
      const seenKeys = new Set<string>();
      for (const session of this.sessions.values()) {
        seenKeys.add(session.getSnapshot().workspaceKey);
      }
      for (const key of seenKeys) {
        await this.loadMetaForWorkspace(key);
      }
      // Drop meta caches for workspaces we no longer track
      for (const key of [...this.metaCache.keys()]) {
        if (!seenKeys.has(key)) { this.metaCache.delete(key); }
      }
    } catch { /* projectsDir doesn't exist */ }
  }

  /** Drop all session/cache state for a workspace key. Used when a key
   *  migrates into the sibling-worktree set mid-poll. */
  private evictWorkspace(workspaceKey: string): void {
    for (const [compositeId, session] of this.sessions) {
      if (compositeId.startsWith(`${workspaceKey}/`)) {
        session.dispose();
        this.sessions.delete(compositeId);
      }
    }
    this.cwdCache.delete(workspaceKey);
    this.repoRootCache.delete(workspaceKey);
    this.metaCache.delete(workspaceKey);
  }

  /** Per-workspace repo root accessor (used by SiblingWorktreeManager to
   *  determine which workspace dirs are siblings of the local repo). */
  getRepoRootForWorkspace(workspaceKey: string): string | null | undefined {
    return this.repoRootCache.get(workspaceKey);
  }

  /** Snapshot of all known (workspaceKey, cwd) pairs — exposed so the
   *  sibling manager can resolve repoRoots without re-reading JSONL. */
  getKnownWorkspaceCwds(): Array<[string, string]> {
    return Array.from(this.cwdCache.entries());
  }

  /** Read a foreign workspace's session-meta.json into the cache. Silently
   *  no-ops on missing file; warns on parse errors but leaves the prior cache
   *  entry intact so a corrupt write doesn't briefly un-dismiss sessions. */
  private async loadMetaForWorkspace(workspaceKey: string): Promise<void> {
    const metaPath = path.join(this.projectsDir, workspaceKey, 'session-meta.json');
    let content: string;
    try {
      content = await fs.promises.readFile(metaPath, 'utf-8');
    } catch {
      this.metaCache.set(workspaceKey, new Map());
      return;
    }
    try {
      const file: SessionMetaFile = JSON.parse(content);
      this.metaCache.set(workspaceKey, new Map(Object.entries(file.sessions)));
    } catch (err) {
      this.log.warn(`Foreign session-meta.json parse failed (${workspaceKey}):`, err);
    }
  }

  /** Poll active foreign sessions. Evicts entries past the age gate. */
  async poll(): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    const siblingKeys = this.getSiblingKeys();

    // Evict any sessions that have migrated into the sibling set since the
    // last poll — the sibling manager owns them now.
    if (siblingKeys.size > 0) {
      for (const [compositeId, session] of this.sessions) {
        const key = compositeId.split('/', 1)[0];
        if (siblingKeys.has(key)) {
          session.dispose();
          this.sessions.delete(compositeId);
          this.cwdCache.delete(key);
          this.repoRootCache.delete(key);
          this.metaCache.delete(key);
          changed = true;
        }
      }
    }

    for (const [compositeId, session] of this.sessions) {
      const status = session.getStatus();
      if (status !== 'running' && status !== 'waiting') {
        if (now - session.getLastActivity().getTime() > FOREIGN_AGE_GATE_MS) {
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

  /** Get foreign workspace summaries for the panel.
   *  Every workspace with at least one tracked session is included. Counts
   *  (running/waiting/done/stale) are aggregated for display; dismissed
   *  sessions are excluded from counts. `done` is promoted to `stale` once the
   *  user has acknowledged the session in its own workspace and 10s has
   *  elapsed (mirrors SessionDiscovery's local stale logic). Workspaces with
   *  no active sessions render with empty counts. */
  getWorkspaces(): WorkspaceGroup[] {
    const now = Date.now();
    const groups = new Map<string, Record<string, number>>();
    const confidences = new Map<string, StatusConfidence>();

    for (const session of this.sessions.values()) {
      const snapshot = session.getSnapshot();
      const meta = this.metaCache.get(snapshot.workspaceKey)?.get(snapshot.sessionId);

      // Ensure the workspace shows up even if every session is dismissed
      if (!groups.has(snapshot.workspaceKey)) {
        groups.set(snapshot.workspaceKey, {});
      }
      if (meta?.dismissed) { continue; }

      let status = snapshot.status;
      if (status === 'done' && meta?.acknowledged) {
        const ackTime = meta.acknowledgedAt ?? 0;
        if (now - ackTime > STALE_PROMOTION_MS) {
          status = 'stale';
        }
      }

      const counts = groups.get(snapshot.workspaceKey)!;
      counts[status] = (counts[status] || 0) + 1;

      const capped: StatusConfidence = snapshot.confidence === 'high' ? 'medium' : snapshot.confidence;
      const existing = confidences.get(snapshot.workspaceKey) ?? 'low';
      if ((CONFIDENCE_RANK[capped] ?? 0) > (CONFIDENCE_RANK[existing] ?? 0)) {
        confidences.set(snapshot.workspaceKey, capped);
      }
    }

    const result: WorkspaceGroup[] = [];
    for (const [key, counts] of groups) {
      result.push({
        workspaceKey: key,
        displayName: ForeignWorkspaceManager.workspaceDisplayName(key, this.cwdCache.get(key)),
        cwd: this.cwdCache.get(key) ?? null,
        counts,
        confidence: confidences.get(key) ?? 'low',
        repoRoot: this.repoRootCache.get(key) ?? null,
      });
    }
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return result;
  }

  /** Get a CWD for a workspace key — uses the cached cwd from any session in that workspace. */
  getCwdForWorkspace(workspaceKey: string): string | null {
    return this.cwdCache.get(workspaceKey) ?? null;
  }

  /** Foreign sessions currently waiting on user input. cwd is filled from cwdCache
   *  when the session itself doesn't carry one (older JSONL records). */
  getWaitingSnapshots(): SessionSnapshot[] {
    const result: SessionSnapshot[] = [];
    for (const session of this.sessions.values()) {
      if (session.getStatus() !== 'waiting') { continue; }
      const snapshot = session.getSnapshot();
      if (!snapshot.cwd) {
        const cached = this.cwdCache.get(snapshot.workspaceKey);
        if (cached) { snapshot.cwd = cached; }
      }
      result.push(snapshot);
    }
    // Newest waiting first so the most recent prompt sits at the top
    result.sort((a, b) => b.lastActivity - a.lastActivity);
    return result;
  }

  /** Foreign sessions currently running (model is working). Surfaced as a compact
   *  strip below local cards; click to switch to that window. */
  getRunningSnapshots(): SessionSnapshot[] {
    const result: SessionSnapshot[] = [];
    for (const session of this.sessions.values()) {
      if (session.getStatus() !== 'running') { continue; }
      const snapshot = session.getSnapshot();
      if (!snapshot.cwd) {
        const cached = this.cwdCache.get(snapshot.workspaceKey);
        if (cached) { snapshot.cwd = cached; }
      }
      result.push(snapshot);
    }
    result.sort((a, b) => b.lastActivity - a.lastActivity);
    return result;
  }

  /** Dispose all foreign sessions and clear state. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.cwdCache.clear();
    this.repoRootCache.clear();
    this.metaCache.clear();
  }

  /** Derive a human-readable name from a workspace CWD or sanitised key. */
  private static workspaceDisplayName(key: string, cwd?: string): string {
    if (cwd) {
      const trimmed = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
      const folderName = trimmed.split('/').pop();
      if (folderName) { return folderName; }
    }
    const segments = key.split('-').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^\d{4}$/.test(segments[i]) && i + 1 < segments.length && /^\d{2}$/.test(segments[i + 1])) {
        return segments.slice(i).join('-');
      }
    }
    return segments.slice(-3).join('-') || key;
  }
}
