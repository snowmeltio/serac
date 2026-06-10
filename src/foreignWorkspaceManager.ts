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
import { resolveRepoRoot, discoverWorktrees, type WorktreeInfo } from './gitWorktreeUtil.js';
import { PSEUDO_TMP_REPO_ROOT, isTmpScratchPath } from './panelUtils.js';
import type { SessionSnapshot, SessionMeta, SessionMetaFile, StatusConfidence, WorkspaceGroup } from './types.js';
import type { Logger } from './sessionDiscovery.js';
import { readSettings, foreignWindowGate } from './settings.js';

/** Resolved visibility gate for this section (live-only flag + time window in
 *  ms). Read at the top of each scan / housekeeping pass so the value is
 *  always current; reactive to settings changes without restart. */
type WindowGate = ReturnType<typeof foreignWindowGate>;
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
  /** Enumerated worktrees per repoRoot. Populated alongside repoRootCache and
   *  refreshed by SessionDiscovery on the same 60s cadence as the local
   *  worktree set. Drives the inline picker on aggregated rows. */
  private worktreesByRepoRoot: Map<string, WorktreeInfo[]> = new Map();
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

  /** Per-session registry liveness probe factory, injected by SessionDiscovery
   *  (freshness parity: foreign cards get the same death gate as primary). */
  private probeFactory?: (sessionId: string) => () => boolean | null;

  setLivenessProbeFactory(factory: (sessionId: string) => () => boolean | null): void {
    this.probeFactory = factory;
  }

  /** Whether a session falls inside the visibility window. In live-only mode
   *  the registry answer wins outright (live = in, gone = out, regardless of
   *  age); a degraded/unwired registry falls back to the time gate so a
   *  transient scan problem can't blank the whole section. */
  private withinWindow(sessionId: string, lastActivityMs: number, now: number, gate: WindowGate): boolean {
    if (gate.liveOnly) {
      const live = this.probeFactory ? this.probeFactory(sessionId)() : null;
      if (live === true) { return true; }
      if (live === false) { return false; }
    }
    return now - lastActivityMs <= gate.ageGateMs;
  }

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
    if (!readSettings().show.foreignWorkspaces) { return; }
    const now = Date.now();
    const gate = foreignWindowGate();
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
              if (!this.withinWindow(sessionId, fstat.mtimeMs, now, gate)) { continue; }
            } catch { continue; }

            const manager = new SessionManager(sessionId, filePath, dir, { livenessProbe: this.probeFactory?.(sessionId) });
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
            if (!this.withinWindow(sessionId, manager.getLastActivity().getTime(), now, gate)) {
              manager.dispose();
              continue;
            }
            this.sessions.set(compositeId, manager);
          }
        } catch { /* unreadable directory */ }
      }
      // Cache cwd per workspace key (stable display names). Prefer
      // `initialCwd` — the first cwd that round-trips to the workspaceKey —
      // so the row label and click-through anchor to the workspace dir even
      // if the agent `cd`-ed into a subfolder mid-session. Fall back to
      // `cwd` only when no record has matched yet (older sessions, edge
      // cases) so we never end up with a blank label.
      for (const session of this.sessions.values()) {
        const snapshot = session.getSnapshot();
        if (this.cwdCache.has(snapshot.workspaceKey)) { continue; }
        const cwd = snapshot.initialCwd || snapshot.cwd;
        if (cwd) {
          this.cwdCache.set(snapshot.workspaceKey, cwd);
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
      // Enumerate worktrees for every distinct repoRoot we now track. Reads
      // only `.git/worktrees/*` dirents — no shell-out. Used for the inline
      // picker on aggregated rows.
      await this.refreshWorktreesForKnownRepos();
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
    this.pruneWorktreesByRepoRoot();
  }

  /** Re-enumerate worktrees for every distinct non-null repoRoot we currently
   *  track. Returns true when the set changed for any repo. Safe to call from
   *  scan() (after repoRootCache is populated) or from a 60s refresh timer. */
  async refreshWorktreesForKnownRepos(): Promise<boolean> {
    const wantedRoots = new Set<string>();
    for (const root of this.repoRootCache.values()) {
      if (root) { wantedRoots.add(root); }
    }
    let changed = false;
    for (const root of wantedRoots) {
      let next: WorktreeInfo[] = [];
      try {
        next = await discoverWorktrees(root);
      } catch (err) {
        this.log.warn(`discoverWorktrees failed for ${root}:`, err);
        continue;
      }
      const prev = this.worktreesByRepoRoot.get(root);
      if (!prev || worktreeListChanged(prev, next)) {
        changed = true;
      }
      this.worktreesByRepoRoot.set(root, next);
    }
    // Drop entries for repos we no longer track
    for (const root of [...this.worktreesByRepoRoot.keys()]) {
      if (!wantedRoots.has(root)) {
        this.worktreesByRepoRoot.delete(root);
        changed = true;
      }
    }
    return changed;
  }

  /** Drop worktree entries for repoRoots no longer tracked. Called on
   *  workspace eviction so the cache doesn't leak. */
  private pruneWorktreesByRepoRoot(): void {
    const live = new Set<string>();
    for (const root of this.repoRootCache.values()) {
      if (root) { live.add(root); }
    }
    for (const root of [...this.worktreesByRepoRoot.keys()]) {
      if (!live.has(root)) { this.worktreesByRepoRoot.delete(root); }
    }
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
    if (!readSettings().show.foreignWorkspaces) { return false; }
    let changed = false;
    const now = Date.now();
    const gate = foreignWindowGate();
    const siblingKeys = this.getSiblingKeys();

    // Evict any sessions that have migrated into the sibling set since the
    // last poll — the sibling manager owns them now.
    if (siblingKeys.size > 0) {
      let siblingsEvicted = false;
      for (const [compositeId, session] of this.sessions) {
        const key = compositeId.split('/', 1)[0];
        if (siblingKeys.has(key)) {
          session.dispose();
          this.sessions.delete(compositeId);
          this.cwdCache.delete(key);
          this.repoRootCache.delete(key);
          this.metaCache.delete(key);
          changed = true;
          siblingsEvicted = true;
        }
      }
      if (siblingsEvicted) { this.pruneWorktreesByRepoRoot(); }
    }

    for (const [compositeId, session] of this.sessions) {
      const status = session.getStatus();
      // Active sessions are never window-evicted (mirrors the never-downgrade
      // rule): demoteIfStale resolves a genuinely dead one first, then the
      // dormant branch evicts it on a later cycle.
      if (status !== 'running' && status !== 'waiting') {
        const sessionId = compositeId.slice(compositeId.indexOf('/') + 1);
        if (!this.withinWindow(sessionId, session.getLastActivity().getTime(), now, gate)) {
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
        // Freshness parity: dormant foreign sessions get the same
        // background-shell sweep (15-min ceiling + registry death-clear) as
        // dormant local sessions, so a stuck shell badge clears here too.
        if (session.sweepBackgroundShells(now)) { changed = true; }
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

  /** Any foreign session currently running/waiting — feeds the adaptive
   *  fast-poll so an active foreign card refreshes at the 500ms cadence. */
  hasActiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      const status = session.getStatus();
      if (status === 'running' || status === 'waiting') { return true; }
    }
    return false;
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

      // Stale rollover: prefer the source workspace's acknowledgedAt when the
      // user has actually acknowledged. Fall back to lastActivity so unattended
      // workspaces (closed VSCode, headless agent) still decay instead of
      // sticking on `done` indefinitely.
      let status = snapshot.status;
      if (status === 'done') {
        if (meta?.acknowledged) {
          const ackTime = meta.acknowledgedAt ?? 0;
          if (now - ackTime > STALE_PROMOTION_MS) {
            status = 'stale';
          }
        } else if (now - snapshot.lastActivity > STALE_PROMOTION_MS) {
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

    // Pseudo-repo overlay: when enabled, scratch sessions under /private/tmp
    // (and /tmp) that aren't real git repos get the shared PSEUDO_TMP_REPO_ROOT
    // so groupForeignWorkspaces folds them into a single "tmp" row. Applied at
    // read time (not baked into repoRootCache) so toggling the setting takes
    // effect on the next poll without a cache flush.
    const consolidateTmp = readSettings().worktrees.consolidateTmp;

    const result: WorkspaceGroup[] = [];
    for (const [key, counts] of groups) {
      let repoRoot = this.repoRootCache.get(key) ?? null;
      if (!repoRoot && consolidateTmp && isTmpScratchPath(this.cwdCache.get(key))) {
        repoRoot = PSEUDO_TMP_REPO_ROOT;
      }
      // Pseudo roots have no .git, so worktreesByRepoRoot never holds them —
      // the synthetic row is driven by `members`, not enumerated worktrees.
      const worktrees = repoRoot ? this.worktreesByRepoRoot.get(repoRoot) : undefined;
      result.push({
        workspaceKey: key,
        displayName: ForeignWorkspaceManager.workspaceDisplayName(key, this.cwdCache.get(key)),
        cwd: this.cwdCache.get(key) ?? null,
        counts,
        confidence: confidences.get(key) ?? 'low',
        repoRoot,
        worktrees: worktrees && worktrees.length > 0
          ? worktrees.map(w => ({ path: w.path, branch: w.branch, isMain: w.isMain }))
          : undefined,
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
      // Dismissed sessions are excluded from row counts (getWorkspaces) —
      // they must not surface in the waiting strip or bump the badge either.
      if (this.metaCache.get(snapshot.workspaceKey)?.get(snapshot.sessionId)?.dismissed) { continue; }
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
      if (this.metaCache.get(snapshot.workspaceKey)?.get(snapshot.sessionId)?.dismissed) { continue; }
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
    this.worktreesByRepoRoot.clear();
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

/** Compare two worktree lists for set equality (order-insensitive, branch-aware).
 *  Mirrors the helper in sessionDiscovery.ts so foreign worktree refresh can
 *  detect change without depending on local discovery internals. */
function worktreeListChanged(a: WorktreeInfo[], b: WorktreeInfo[]): boolean {
  if (a.length !== b.length) { return true; }
  const key = (w: WorktreeInfo): string => `${w.path}\0${w.branch ?? ''}`;
  const aKeys = new Set(a.map(key));
  for (const w of b) {
    if (!aKeys.has(key(w))) { return true; }
  }
  return false;
}
