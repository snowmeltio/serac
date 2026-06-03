import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { SessionManager } from './sessionManager.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { ForeignWorkspaceManager } from './foreignWorkspaceManager.js';
import { SiblingWorktreeManager } from './siblingWorktreeManager.js';
import { resolveRepoRoot, discoverWorktrees, type WorktreeInfo } from './gitWorktreeUtil.js';
import { TeamDiscovery } from './teamDiscovery.js';
import { WorkflowDiscovery } from './workflowDiscovery.js';
import { ProcessRegistry, type LiveProcess } from './processRegistry.js';
import { claudeStateDir } from './paths.js';
import { isValidSessionId } from './validation.js';
import type { SessionSnapshot, SessionMeta, SessionMetaFile, WorkspaceGroup, TeamSnapshot, WorkflowSnapshot } from './types.js';
import type { HookEventRouter } from './hookEventRouter.js';

/** Minimal log interface matching VS Code's LogOutputChannel */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  trace(message: string, ...args: unknown[]): void;
}

/** No-op logger for tests and when no OutputChannel is provided */
const nullLogger: Logger = {
  info() {}, warn() {}, error() {}, trace() {},
};

/**
 * Discovers and manages Claude Code sessions for the current workspace.
 * Only shows sessions from the JSONL directory matching this VS Code workspace.
 *
 * Persistent per-session metadata (dismissed, acknowledged, title) is stored
 * in a single `session-meta.json` file under `<workspace>/.claude/`.
 *
 * All file I/O uses fs.promises to avoid blocking the extension host thread.
 */
export class SessionDiscovery {
  private readonly projectsDir: string;
  private readonly workspaceKey: string;
  private readonly metaFilePath: string;
  private sessions: Map<string, SessionManager> = new Map();
  private sessionMeta: Map<string, SessionMeta> = new Map();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private onChangeCallback: (() => void) | undefined;
  /** Track whether we've written meta this cycle to avoid redundant saves */
  private metaDirty = false;
  /** Prevents timer callbacks from running after dispose */
  private disposed = false;
  /** Last known mtime of session-meta.json (ms). 0 = never loaded. */
  private metaLastMtime = 0;
  /** Guard against concurrent poll executions */
  private polling = false;
  /** Serialises fire-and-forget saveMeta() calls to prevent concurrent write races */
  private saveQueue: Promise<void> = Promise.resolve();
  /** Monotonic counter making each save's tmp path unique, so two overlapping
   *  saveMeta() writes can never share (and clobber) one tmp file. */
  private saveSeq = 0;
  /** Concurrency limit for session updates (stays under macOS ulimit -n 256) */
  private static readonly UPDATE_BATCH_SIZE = 50;
  /** Age gate: skip JSONL files older than this during scan [Phase 6] */
  private static readonly SCAN_AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
  private readonly log: Logger;
  /** Local CWD path (root of the user's VS Code workspace). */
  private readonly localCwd: string;
  /** Display label for the local worktree (basename of localCwd). */
  private readonly localWorktreeLabel: string;
  /** Resolved git repo root for the local CWD, set during initialise() once
   *  resolveRepoRoot completes. Null when the workspace isn't in a git repo. */
  private localRepoRoot: string | null = null;
  /** Cached worktree enumeration for the local repo. Refreshed on start and
   *  every WORKTREE_REFRESH_MS thereafter. Empty when no repo or no linked
   *  worktrees. Read by extension.ts to build the Worktrees pane. */
  private discoveredWorktrees: WorktreeInfo[] = [];
  private worktreeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private static readonly WORKTREE_REFRESH_MS = 60_000;
  /** Manages cross-workspace session discovery and polling */
  private foreignManager: ForeignWorkspaceManager;
  /** Manages sibling-worktree (same-repo, different CWD) session discovery */
  private siblingManager: SiblingWorktreeManager;
  /** Manages Agent Teams discovery and polling */
  private teamDiscovery: TeamDiscovery;
  /** Manages Opus 4.8 Workflow run discovery (sidecar + live tiers) */
  private workflowDiscovery: WorkflowDiscovery;
  /** Reads Claude Code's live process registry (~/.claude/sessions/<pid>.json).
   *  Exposed for consumers; no behaviour is gated on it yet. */
  private processRegistry: ProcessRegistry;
  /** Extended archive: lightweight snapshots for sessions older than SCAN_AGE_GATE_MS.
   *  Only populated when archiveRangeMs > SCAN_AGE_GATE_MS. Keyed by sessionId. */
  private extendedArchive: Map<string, SessionSnapshot> = new Map();
  /** Current archive range requested by the panel (ms). Infinity = all. */
  private archiveRangeMs = 86400000; // default 1d
  /** The range that extendedArchive was last populated for (avoids redundant rescans) */
  private extendedArchiveLoadedRange = 0;
  /** Count of JSONL files in the local workspace dir older than SCAN_AGE_GATE_MS.
   *  Surfaced to the panel so the time-range bar can be revealed even when the
   *  active scan window is empty — gives the user an affordance to expand. */
  private olderSessionCount = 0;

  /** Hook-event router for the local workspace's own sessions. Passed
   *  through to SessionManager construction at line ~670. Undefined when
   *  no router is provided (tests, foreign-only contexts). Foreign and
   *  sibling worktrees' SessionManagers do NOT receive this — those
   *  sessions are owned by their own VS Code window's leader. */
  private readonly hookRouter?: HookEventRouter;

  constructor(workspacePath: string, opts?: { projectsDir?: string; log?: Logger; hookRouter?: HookEventRouter }) {
    this.projectsDir = opts?.projectsDir ?? path.join(claudeStateDir(), 'projects');
    this.workspaceKey = sanitiseWorkspaceKey(workspacePath);
    this.metaFilePath = path.join(this.projectsDir, this.workspaceKey, 'session-meta.json');
    this.log = opts?.log ?? nullLogger;
    this.localCwd = workspacePath;
    this.localWorktreeLabel = path.basename(workspacePath) || workspacePath;
    this.hookRouter = opts?.hookRouter;
    this.foreignManager = new ForeignWorkspaceManager(this.projectsDir, this.workspaceKey, this.log);
    this.siblingManager = new SiblingWorktreeManager(this.projectsDir, this.workspaceKey, this.log);
    this.foreignManager.setSiblingKeysProvider(() => this.siblingManager.getSiblingKeys());
    this.teamDiscovery = new TeamDiscovery(this.projectsDir, this.workspaceKey, this.log);
    // Sessions registry is a sibling of projects/ under the Claude state dir.
    // Constructed before WorkflowDiscovery so the workflow live tier can use it
    // as a liveness probe (abandoned-run → 'incomplete').
    this.processRegistry = new ProcessRegistry(path.join(path.dirname(this.projectsDir), 'sessions'), this.log);
    this.workflowDiscovery = new WorkflowDiscovery(this.projectsDir, this.workspaceKey, this.log, this.processRegistry);
  }

  // ── Meta persistence ──────────────────────────────────────────────

  /** Load session metadata from disk. Migrates from legacy files on first run.
   *  Distinguishes ENOENT (expected, migrate) from parse errors (warn, preserve). */
  private async loadMeta(): Promise<void> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.metaFilePath, 'utf-8');
    } catch (err) {
      // File doesn't exist — try legacy migration
      this.sessionMeta = new Map();
      await this.migrateFromLegacy();
      return;
    }

    try {
      const file: SessionMetaFile = JSON.parse(content);
      this.sessionMeta = new Map(Object.entries(file.sessions));
      try {
        const stat = await fs.promises.stat(this.metaFilePath);
        this.metaLastMtime = stat.mtimeMs;
      } catch { /* stat failed; leave mtime as-is */ }
    } catch (err) {
      // File exists but is corrupted — warn and preserve existing in-memory state
      this.log.warn('session-meta.json is corrupted, preserving in-memory state:', err);
      if (this.sessionMeta.size === 0) {
        // No in-memory state to preserve — try legacy migration as fallback
        await this.migrateFromLegacy();
      }
    }
  }

  /** Reload meta only if the file has been modified externally since our last read [H2] */
  private async reloadMetaIfChanged(): Promise<void> {
    // Skip reload when we have unflushed in-memory mutations [C1]
    if (this.metaDirty) { return; }
    try {
      const stat = await fs.promises.stat(this.metaFilePath);
      if (stat.mtimeMs > this.metaLastMtime) {
        await this.loadMeta();
      }
    } catch {
      // File doesn't exist — nothing to reload
    }
  }

  /** Save session metadata to disk */
  private async saveMeta(): Promise<void> {
    const dir = path.dirname(this.metaFilePath);
    try {
      await fs.promises.access(dir);
    } catch {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    const file: SessionMetaFile = {
      sessions: Object.fromEntries(this.sessionMeta),
    };
    const tmpPath = `${this.metaFilePath}.${process.pid}.${++this.saveSeq}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
    await fs.promises.rename(tmpPath, this.metaFilePath);
    // Update mtime so reloadMetaIfChanged() won't re-read our own write [C1]
    try {
      const stat = await fs.promises.stat(this.metaFilePath);
      this.metaLastMtime = stat.mtimeMs;
    } catch { /* stat failed */ }
    this.metaDirty = false;
  }

  /** Flush pending meta changes if dirty. Routes through the same serialising
   *  queue as enqueueSave() so a poll-loop flush can't run a second, un-ordered
   *  saveMeta() concurrently with an in-flight enqueued save. */
  private async flushMeta(): Promise<void> {
    if (this.metaDirty) {
      this.enqueueSave();
      await this.saveQueue;
    }
  }

  /** Enqueue a save to prevent concurrent write races [audit fix] */
  private enqueueSave(): void {
    this.saveQueue = this.saveQueue
      .then(() => this.saveMeta())
      .catch((err) => { this.log.error('saveMeta failed:', err); });
  }

  /** One-time migration from legacy dismissed-sessions + acknowledged-sessions files */
  private async migrateFromLegacy(): Promise<void> {
    const claudeDir = path.dirname(this.metaFilePath);
    const dismissedPath = path.join(claudeDir, 'dismissed-sessions');
    const acknowledgedPath = path.join(claudeDir, 'acknowledged-sessions');
    let migrated = false;

    // Read legacy dismissed
    try {
      const content = await fs.promises.readFile(dismissedPath, 'utf-8');
      const ids = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const id of ids) {
        const meta = this.getOrCreateMeta(id);
        meta.dismissed = true;
        migrated = true;
      }
    } catch { /* no legacy file */ }

    // Read legacy acknowledged
    try {
      const content = await fs.promises.readFile(acknowledgedPath, 'utf-8');
      const ids = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const id of ids) {
        const meta = this.getOrCreateMeta(id);
        meta.acknowledged = true;
        // Timestamp 0 = immediately stale on reload (same as old behaviour)
        meta.acknowledgedAt = 0;
        migrated = true;
      }
    } catch { /* no legacy file */ }

    if (migrated) {
      await this.saveMeta();
    }
  }

  /** Get or create a meta entry for a session */
  private getOrCreateMeta(sessionId: string): SessionMeta {
    let meta = this.sessionMeta.get(sessionId);
    if (!meta) {
      meta = {
        title: null,
        dismissed: false,
        acknowledged: false,
        acknowledgedAt: null,
        firstSeen: Date.now(),
      };
      this.sessionMeta.set(sessionId, meta);
    }
    return meta;
  }

  // ── Public API (signatures unchanged where possible) ──────────────

  /** Dismiss a session */
  dismissSession(sessionId: string): void {
    const meta = this.getOrCreateMeta(sessionId);
    meta.dismissed = true;
    this.metaDirty = true;
    // Fire-and-forget save — UI is updated from in-memory state
    this.enqueueSave();
  }

  /** Undismiss a session */
  undismissSession(sessionId: string): void {
    const meta = this.getOrCreateMeta(sessionId);
    meta.dismissed = false;
    this.metaDirty = true;
    this.enqueueSave();
  }

  /** R4: Mark completed subagents as acknowledged so they're pruned from the card */
  acknowledgeSubagents(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) { session.acknowledgeSubagents(); }
  }

  /** Only acknowledge if the session is done (not running or waiting) */
  acknowledgeIfDone(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    const status = session.getStatus();
    if (status === 'running' || status === 'waiting') { return; }
    this.acknowledgeSession(sessionId);
  }

  /** Mark a session as acknowledged (user has focused it) */
  acknowledgeSession(sessionId: string): void {
    const meta = this.getOrCreateMeta(sessionId);
    if (meta.acknowledged) { return; }
    meta.acknowledged = true;
    meta.acknowledgedAt = Date.now();
    this.metaDirty = true;
    this.enqueueSave();
  }

  /** Start watching for sessions. Calls onChange when state changes. */
  async start(onChange: () => void): Promise<void> {
    this.onChangeCallback = onChange;

    // Load session metadata (with legacy migration)
    await this.loadMeta();

    // Resolve local repoRoot before any scanning so the sibling manager knows
    // which other workspace dirs share our repo. Failure is non-fatal — we just
    // run without sibling-worktree consolidation.
    try {
      const repoRoot = await resolveRepoRoot(this.localCwd);
      this.localRepoRoot = repoRoot;
      this.siblingManager.setLocalRepoRoot(repoRoot);
    } catch (err) {
      this.log.warn('Failed to resolve local repoRoot:', err);
    }

    // Worktree enumeration is independent of session discovery — a worktree
    // is real even when no CC chats exist in it. Initial sweep, then poll
    // periodically; cheap (just reads .git/worktrees/*).
    await this.refreshDiscoveredWorktrees();
    this.scheduleWorktreeRefresh();

    // Initial scan (local + sibling worktrees + foreign + teams).
    // Sibling scan must run before foreign scan so foreign can exclude sibling keys.
    await this.scan();
    await this.siblingManager.scan();
    await this.foreignManager.scan();
    await this.teamDiscovery.scan();
    await this.workflowDiscovery.scan();
    await this.processRegistry.scan();

    // Start adaptive poll loop
    this.schedulePoll();
  }

  /** Schedule the next poll with adaptive interval */
  private schedulePoll(): void {
    if (this.disposed) { return; }
    const interval = this.hasActiveSessions() ? 500 : 2000;
    this.pollTimer = setTimeout(() => {
      if (this.disposed) { return; }
      this.poll().then(() => {
        this.schedulePoll();
      }).catch((err) => {
        this.log.error('poll failed:', err);
        this.schedulePoll();
      });
    }, interval);
  }

  /** Check if any sessions are currently active (running or needs-input) */
  private hasActiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      const status = session.getStatus();
      if (status === 'running' || status === 'waiting') { return true; }
    }
    if (this.teamDiscovery.hasActiveAgents()) { return true; }
    if (this.workflowDiscovery.hasActiveRuns()) { return true; }
    return false;
  }

  stop(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.worktreeRefreshTimer) {
      clearTimeout(this.worktreeRefreshTimer);
      this.worktreeRefreshTimer = undefined;
    }
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.siblingManager.dispose();
    this.foreignManager.dispose();
    this.teamDiscovery.dispose();
    this.workflowDiscovery.dispose();
    this.processRegistry.dispose();
  }

  /** Re-enumerate worktrees of the local repo AND every foreign repo currently
   *  tracked. No-op for the local side when no repoRoot. Fires the change
   *  callback when either set changes so the panel re-renders the picker. */
  private async refreshDiscoveredWorktrees(): Promise<void> {
    let localChanged = false;
    if (this.localRepoRoot) {
      let next: WorktreeInfo[] = [];
      try {
        next = await discoverWorktrees(this.localRepoRoot);
      } catch (err) {
        this.log.warn('discoverWorktrees failed:', err);
        next = this.discoveredWorktrees;
      }
      if (worktreeSetChanged(this.discoveredWorktrees, next)) {
        this.discoveredWorktrees = next;
        localChanged = true;
      } else {
        this.discoveredWorktrees = next;
      }
    } else {
      this.discoveredWorktrees = [];
    }

    // Foreign side: re-enumerate worktrees for every distinct foreign repoRoot.
    // Reads only `.git/worktrees/*` dirents — same cost profile as the local
    // refresh, scaled by the number of distinct foreign repos.
    let foreignChanged = false;
    try {
      foreignChanged = await this.foreignManager.refreshWorktreesForKnownRepos();
    } catch (err) {
      this.log.warn('foreign worktree refresh failed:', err);
    }

    if (localChanged || foreignChanged) {
      this.onChangeCallback?.();
    }
  }

  private scheduleWorktreeRefresh(): void {
    if (this.disposed) { return; }
    this.worktreeRefreshTimer = setTimeout(() => {
      if (this.disposed) { return; }
      void this.refreshDiscoveredWorktrees().finally(() => this.scheduleWorktreeRefresh());
    }, SessionDiscovery.WORKTREE_REFRESH_MS);
  }

  /** Snapshot of the worktree enumeration. Includes the main checkout. */
  getDiscoveredWorktrees(): WorktreeInfo[] {
    return this.discoveredWorktrees;
  }

  /** Get snapshots of all sessions, sorted by priority */
  getSnapshots(): SessionSnapshot[] {
    const now = Date.now();
    const snapshots: SessionSnapshot[] = [];
    // Suppress sessions claimed by active (non-dismissed) teams
    const teamClaimed = this.teamDiscovery.getClaimedSessionIds(this.sessionMeta);
    for (const session of this.sessions.values()) {
      if (teamClaimed.has(session.getSessionId())) { continue; }
      const snapshot = session.getSnapshot();
      // Tag local sessions with the local worktree so cards render
      // consistently — the panel hides the pill when origin == local.
      snapshot.worktreeRoot = this.localCwd;
      snapshot.worktreeLabel = this.localWorktreeLabel;
      const meta = this.sessionMeta.get(snapshot.sessionId);

      snapshot.dismissed = meta?.dismissed ?? false;
      snapshot.title = meta?.title ?? null;

      // Cache live title fields into meta so they survive the 7-day archive
      // cutoff (lightweight scanner doesn't parse JSONL).
      if (meta && snapshot.aiTitle && snapshot.aiTitle !== meta.aiTitle) {
        meta.aiTitle = snapshot.aiTitle;
        this.metaDirty = true;
      }
      if (meta && snapshot.customTitle && snapshot.customTitle !== meta.customTitle) {
        meta.customTitle = snapshot.customTitle;
        this.metaDirty = true;
      }

      // Apply stale transition: done + acknowledged + 10s elapsed = stale
      // But guard against enqueued sessions (C3): a queued session is done+acknowledged
      // but should not go stale while waiting for dequeue.
      if (snapshot.status === 'done' && meta?.acknowledged) {
        const enqueuedAt = session.getEnqueuedAt();
        const recentlyEnqueued = enqueuedAt > 0 && (now - enqueuedAt < 120_000);
        if (!recentlyEnqueued) {
          const ackTime = meta.acknowledgedAt ?? 0;
          if (now - ackTime > 10_000) {
            snapshot.status = 'stale';
          }
        }
      }

      snapshots.push(snapshot);
    }

    // Merge sibling-worktree sessions into the same feed. Sibling sessions
    // already carry worktreeRoot/worktreeLabel; we don't write back title/aiTitle
    // to them because that lives in the sibling's own session-meta.json and isn't
    // ours to mutate. Dismissal is the exception: it's a local view-state overlay,
    // so we honour the local `dismissed` flag (set by dismissSession) without
    // touching the sibling's meta. The done→stale rollover uses lastActivity as the
    // time anchor (rather than acknowledgedAt) so the Worktrees pane decays
    // correctly without cross-workspace meta reads.
    for (const sib of this.siblingManager.getSnapshots()) {
      if (this.sessionMeta.get(sib.sessionId)?.dismissed) { sib.dismissed = true; }
      if (sib.status === 'done' && now - sib.lastActivity > 10_000) {
        sib.status = 'stale';
      }
      snapshots.push(sib);
    }

    // Two-zone ordering: Active zone then Completed zone.
    // Active (waiting, running) sorted by firstActivity (stable creation order).
    // Completed (done, stale) sorted by lastActivity (most recent completion first).
    const isActive = (s: SessionSnapshot) =>
      s.status === 'waiting' || s.status === 'running';

    const active = snapshots.filter(s => !s.dismissed && isActive(s));
    const completed = snapshots.filter(s => !s.dismissed && !isActive(s));
    const dismissed = snapshots.filter(s => s.dismissed);

    active.sort((a, b) => a.firstActivity - b.firstActivity);
    completed.sort((a, b) => b.lastActivity - a.lastActivity);
    dismissed.sort((a, b) => b.lastActivity - a.lastActivity);

    snapshots.length = 0;
    snapshots.push(...active, ...completed, ...dismissed);

    // Append extended archive entries (older than SCAN_AGE_GATE_MS) when range demands it
    if (this.archiveRangeMs >= SessionDiscovery.SCAN_AGE_GATE_MS && this.extendedArchive.size > 0) {
      const extendedDismissed: SessionSnapshot[] = [];
      for (const snap of this.extendedArchive.values()) {
        // Skip if already covered by a live session (shouldn't happen, but guard)
        if (this.sessions.has(snap.sessionId)) { continue; }
        extendedDismissed.push(snap);
      }
      extendedDismissed.sort((a, b) => b.lastActivity - a.lastActivity);
      snapshots.push(...extendedDismissed);
    }

    return snapshots;
  }

  /** Set the archive time range. When range exceeds the scan age gate,
   *  triggers a one-off lightweight scan of older JSONL files (stat + meta only). */
  async setArchiveRange(rangeMs: number): Promise<boolean> {
    // 0 = no limit (all). Convert to Infinity internally.
    const effective = rangeMs === 0 ? Infinity : rangeMs;
    this.log.info('[archive] setArchiveRange(%d) effective=%s loadedRange=%s', rangeMs, effective, this.extendedArchiveLoadedRange);
    this.archiveRangeMs = effective;
    if (effective < SessionDiscovery.SCAN_AGE_GATE_MS) {
      // Within the active scan gate — clear extended archive
      this.extendedArchive.clear();
      this.extendedArchiveLoadedRange = 0;
      return true;
    }
    // Only rescan if the requested range is wider than what we've already loaded
    if (effective <= this.extendedArchiveLoadedRange) { return false; }
    await this.scanExtendedArchive(effective);
    return true;
  }

  /** Lightweight scan of JSONL files older than SCAN_AGE_GATE_MS.
   *  Reads file stats, session-meta.json, and (one-time, when meta lacks them)
   *  streams the JSONL to extract `ai-title` / `custom-title` records so the
   *  archived card shows a real label instead of the hex session id. The result
   *  is persisted into session-meta.json so subsequent scans don't re-read. */
  private async scanExtendedArchive(rangeMs: number): Promise<void> {
    const wsDir = path.join(this.projectsDir, this.workspaceKey);
    const now = Date.now();
    let backfilled = 0;
    try {
      const files = await fs.promises.readdir(wsDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) { continue; }
        const sessionId = file.replace('.jsonl', '');
        // Skip sessions already in the active map
        if (this.sessions.has(sessionId)) { continue; }
        // Skip sessions already in extended archive
        if (this.extendedArchive.has(sessionId)) { continue; }

        const filePath = path.join(wsDir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          const age = now - stat.mtimeMs;
          // Only include files older than the active gate but within the requested range
          if (age <= SessionDiscovery.SCAN_AGE_GATE_MS) { continue; }
          if (rangeMs !== Infinity && age > rangeMs) { continue; }

          let meta = this.sessionMeta.get(sessionId);

          // Backfill cached title fields once per session. Files written before
          // this code shipped have no aiTitle/customTitle in meta, so we stream
          // the JSONL one time and cache the result.
          if (!meta || (meta.aiTitle === undefined && meta.customTitle === undefined)) {
            const titles = await this.extractTitlesFromJsonl(filePath);
            if (titles.aiTitle || titles.customTitle) {
              meta = this.getOrCreateMeta(sessionId);
              if (titles.aiTitle) { meta.aiTitle = titles.aiTitle; }
              if (titles.customTitle) { meta.customTitle = titles.customTitle; }
              this.metaDirty = true;
              backfilled++;
            } else if (meta) {
              // Record an empty marker so we don't re-scan this file every
              // time the archive range expands. Empty string distinguishes
              // "scanned, nothing found" from "never scanned" (undefined).
              meta.aiTitle = meta.aiTitle ?? '';
              meta.customTitle = meta.customTitle ?? '';
              this.metaDirty = true;
            } else {
              // No meta entry and no titles found — still mark scanned to
              // avoid re-reading on future range expansions.
              meta = this.getOrCreateMeta(sessionId);
              meta.aiTitle = '';
              meta.customTitle = '';
              this.metaDirty = true;
            }
          }

          const snapshot: SessionSnapshot = {
            sessionId,
            slug: sessionId.slice(0, 8),
            cwd: '',
            workspaceKey: this.workspaceKey,
            topic: '',
            status: 'stale',
            activity: '',
            subagents: [],
            lastActivity: stat.mtimeMs,
            firstActivity: stat.mtimeMs, // approximate
            dismissed: true, // old sessions are always shown as dismissed/archived
            contextTokens: 0,
            searchText: '',
            modelLabel: '',
            title: meta?.title ?? null,
            customTitle: meta?.customTitle ?? '',
            aiTitle: meta?.aiTitle ?? '',
            confidence: 'high', // terminal status
          };
          this.extendedArchive.set(sessionId, snapshot);
        } catch (err) {
          this.log.warn('[archive] Failed to stat %s: %s', file, err);
        }
      }
      this.extendedArchiveLoadedRange = rangeMs;
      if (this.metaDirty) { this.enqueueSave(); }
      this.log.info('[archive] Extended archive scan complete: %d entries for range %dms (scanned %d jsonl files, %d title backfills)', this.extendedArchive.size, rangeMs, files.filter(f => f.endsWith('.jsonl')).length, backfilled);
    } catch (err) {
      this.log.warn('[archive] Failed to read workspace directory %s: %s', wsDir, err);
    }
  }

  /** Stream a JSONL file looking for the latest `ai-title` and `custom-title`
   *  records. Used as a one-time backfill so archived cards can show a label
   *  instead of the hex session id. Returns empty strings if not found. */
  private async extractTitlesFromJsonl(filePath: string): Promise<{ aiTitle: string; customTitle: string }> {
    let aiTitle = '';
    let customTitle = '';
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        // Cheap substring pre-filter to avoid JSON.parse on every line.
        if (!line.includes('"type":"ai-title"') && !line.includes('"type":"custom-title"')) {
          continue;
        }
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle) {
            aiTitle = rec.aiTitle;
          } else if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle) {
            customTitle = rec.customTitle;
          }
        } catch { /* skip malformed line */ }
      }
    } catch (err) {
      this.log.warn('[archive] Failed to extract titles from %s: %s', filePath, err);
    }
    return { aiTitle, customTitle };
  }

  /** Resolved local repoRoot, or null when not in a git repo. Used by the
   *  panel to derive the repo basename for label-stripping. */
  getLocalRepoRoot(): string | null {
    return this.localRepoRoot;
  }

  /** Get the JSONL file path for a session — falls back to sibling worktrees
   *  so transcript view / editor focus works for cards from another worktree
   *  of the same repo. */
  getSessionFilePath(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.getFilePath()
      ?? this.siblingManager.getSessionFilePath(sessionId);
  }

  /** Check if a session is currently running. Sibling-worktree sessions are
   *  also considered, so click-to-focus skips metadata writes for live ones. */
  isSessionRunning(sessionId: string): boolean {
    const status = this.sessions.get(sessionId)?.getStatus();
    if (status === 'running' || status === 'waiting') { return true; }
    return this.siblingManager.isSessionRunning(sessionId);
  }

  /** Count sessions waiting on user input. Dismissed (archived) sessions are
   *  excluded — they don't render as live cards, so they must not bump the
   *  sidebar badge (mirrors the dismissed filter in the snapshot builder). */
  getWaitingCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (this.sessionMeta.get(session.getSessionId())?.dismissed) { continue; }
      if (session.getStatus() === 'waiting') { count++; }
    }
    return count;
  }

  /** Get foreign workspace summaries. Delegates to ForeignWorkspaceManager. */
  getForeignWorkspaces(): WorkspaceGroup[] {
    return this.foreignManager.getWorkspaces();
  }

  /** Foreign sessions in the `waiting` state — surfaced inline at top of the panel. */
  getForeignWaitingSnapshots(): SessionSnapshot[] {
    return this.foreignManager.getWaitingSnapshots();
  }

  /** Foreign sessions in the `running` state — surfaced as a compact strip below local cards. */
  getForeignRunningSnapshots(): SessionSnapshot[] {
    return this.foreignManager.getRunningSnapshots();
  }

  /** Resolve a CWD for a foreign workspace key (used when the panel passes back a workspaceKey). */
  getForeignWorkspaceCwd(workspaceKey: string): string | null {
    return this.foreignManager.getCwdForWorkspace(workspaceKey);
  }

  // ── Team API ──────────────────────────────────────────────────────

  /** Get team snapshots for the webview. */
  getTeamSnapshots(): TeamSnapshot[] {
    return this.teamDiscovery.getTeamSnapshots(this.sessionMeta);
  }

  /** Dismiss a team (archive). Stored in sessionMeta keyed as team:<teamId>. */
  dismissTeam(teamId: string): void {
    const metaKey = `team:${teamId}`;
    const meta = this.getOrCreateMeta(metaKey);
    meta.dismissed = true;
    this.metaDirty = true;
    this.enqueueSave();
  }

  /** Undismiss a team. */
  undismissTeam(teamId: string): void {
    const metaKey = `team:${teamId}`;
    const meta = this.getOrCreateMeta(metaKey);
    meta.dismissed = false;
    this.metaDirty = true;
    this.enqueueSave();
  }

  /** Get JSONL path for a team agent session (for transcript viewing). */
  getTeamSessionFilePath(sessionId: string): string | null {
    return this.teamDiscovery.getSessionFilePath(sessionId);
  }

  /** Resolve a team member's transcript JSONL by member name, for the detail
   *  panel reader. Handles both spawned-session and in-process members. */
  getTeamAgentFilePath(teamId: string, agentName: string): string | null {
    return this.teamDiscovery.getTeamAgentFilePath(teamId, agentName);
  }

  /** Whether a team agent session is currently running. */
  isTeamSessionRunning(sessionId: string): boolean {
    return this.teamDiscovery.isSessionRunning(sessionId);
  }

  /** Resolve a plain Task subagent's transcript JSONL for the detail panel
   *  reader. Subagents live at <sessionDir>/subagents/agent-<agentId>.jsonl,
   *  where sessionDir is the session's JSONL path with `.jsonl` stripped. */
  getSubagentFilePath(sessionId: string, agentId: string): string | null {
    if (!isValidSessionId(agentId)) { return null; }
    const jsonlPath = this.getSessionFilePath(sessionId);
    if (!jsonlPath) { return null; }
    const sessionDir = jsonlPath.replace(/\.jsonl$/, '');
    const file = path.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`);
    return fs.existsSync(file) ? file : null;
  }

  /** Dir-scan a session's on-disk subagent transcripts. The detail panel's
   *  subagents source prefers live-tracked subagents (they carry rich progress),
   *  but Agent-tool subagents that never relay `agent_progress` leave the tracker
   *  with a null agentId — yet their transcript + meta still land on disk. This
   *  recovers them: list `subagents/agent-*.jsonl` (the `workflows/` subdir is
   *  skipped — those agents belong to a workflow run, not this session), reading
   *  the sibling `agent-*.meta.json` for `agentType`/`description` labels. Sorted
   *  by mtime so spawn order is stable. */
  listSubagentFiles(sessionId: string): { agentId: string; agentType: string | null; description: string | null }[] {
    const jsonlPath = this.getSessionFilePath(sessionId);
    if (!jsonlPath) { return []; }
    const subagentsDir = path.join(jsonlPath.replace(/\.jsonl$/, ''), 'subagents');
    let files: string[];
    try {
      files = fs.readdirSync(subagentsDir);
    } catch {
      return [];
    }
    const out: { agentId: string; agentType: string | null; description: string | null; ts: number }[] = [];
    for (const f of files) {
      const match = f.match(/^agent-(.+)\.jsonl$/);
      if (!match) { continue; }
      const agentId = match[1];
      if (!isValidSessionId(agentId)) { continue; }
      let agentType: string | null = null;
      let description: string | null = null;
      try {
        const metaRaw = fs.readFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), 'utf8');
        const meta = JSON.parse(metaRaw) as { agentType?: unknown; description?: unknown };
        if (typeof meta.agentType === 'string') { agentType = meta.agentType; }
        if (typeof meta.description === 'string') { description = meta.description; }
      } catch {
        // No meta (or unreadable/malformed) — the row still resolves by agentId.
      }
      let ts = Number.MAX_SAFE_INTEGER;
      try {
        const stat = fs.statSync(path.join(subagentsDir, f));
        ts = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      } catch { /* keep default */ }
      out.push({ agentId, agentType, description, ts });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.map(({ agentId, agentType, description }) => ({ agentId, agentType, description }));
  }

  // ── Workflow API ──────────────────────────────────────────────────

  /** Get workflow-run snapshots for the webview. */
  getWorkflowSnapshots(): WorkflowSnapshot[] {
    return this.workflowDiscovery.getWorkflowSnapshots(this.sessionMeta);
  }

  /** Resolve a workflow agent's transcript JSONL (for the detail panel reader). */
  getWorkflowAgentFilePath(runId: string, agentId: string): string | null {
    return this.workflowDiscovery.getWorkflowAgentFilePath(runId, agentId);
  }

  /** Dismiss a workflow run (archive). Stored in sessionMeta as workflow:<runId>;
   *  getWorkflowSnapshots overlays this onto WorkflowSnapshot.dismissed. */
  dismissWorkflow(runId: string): void {
    const meta = this.getOrCreateMeta(`workflow:${runId}`);
    meta.dismissed = true;
    this.metaDirty = true;
    this.enqueueSave();
  }

  /** Undismiss a workflow run. */
  undismissWorkflow(runId: string): void {
    const meta = this.getOrCreateMeta(`workflow:${runId}`);
    meta.dismissed = false;
    this.metaDirty = true;
    this.enqueueSave();
  }

  // ── Process-liveness API ──────────────────────────────────────────
  // Backed by ~/.claude/sessions/<pid>.json + a kill(pid,0) probe. A hit is a
  // strong positive ("this session has a live process"); a miss is "unknown",
  // not proof of death (not every session class is guaranteed to register).

  /** All currently-live Claude processes. */
  getLiveProcesses(): LiveProcess[] {
    return this.processRegistry.getLiveProcesses();
  }

  /** True when a live process is backing this session id. */
  isSessionLive(sessionId: string): boolean {
    return this.processRegistry.isSessionLive(sessionId);
  }

  // ── Discovery and polling ─────────────────────────────────────────

  /** Discover JSONL files for the current workspace only */
  private async scan(): Promise<void> {
    const wsDir = path.join(this.projectsDir, this.workspaceKey);
    try {
      await fs.promises.access(wsDir);
    } catch {
      return;
    }

    await this.scanWorkspace(this.workspaceKey);
  }

  private async scanWorkspace(workspaceKey: string): Promise<void> {
    const workspacePath = path.join(this.projectsDir, workspaceKey);
    const now = Date.now();
    let olderCount = 0;

    try {
      const files = await fs.promises.readdir(workspacePath);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) { continue; }

        const sessionId = file.replace('.jsonl', '');
        const filePath = path.join(workspacePath, file);

        if (!this.sessions.has(sessionId)) {
          // Age gate [Phase 6]: skip files older than SCAN_AGE_GATE_MS to avoid
          // loading hundreds of dormant sessions on startup
          try {
            const stat = await fs.promises.stat(filePath);
            if (now - stat.mtimeMs > SessionDiscovery.SCAN_AGE_GATE_MS) {
              olderCount++;
              continue;
            }
          } catch { continue; }

          const manager = new SessionManager(sessionId, filePath, workspaceKey, {
            hookRouter: this.hookRouter,
            // Registry-backed liveness, bound to this session id. Tri-state:
            // null when the registry isn't in use OR the last scan was degraded
            // (so absence never reads as death from a missing registry or a
            // transient disk error), else whether a live process backs it.
            livenessProbe: () => (this.processRegistry.isActive() && this.processRegistry.isScanClean())
              ? this.processRegistry.isSessionLive(sessionId)
              : null,
          });
          this.sessions.set(sessionId, manager);
          // Ensure meta entry exists for newly discovered sessions
          this.getOrCreateMeta(sessionId);
          this.metaDirty = true;
          // Do initial read
          await manager.update();
        }
      }
      this.olderSessionCount = olderCount;
    } catch {
      // Skip unreadable directories
    }
  }

  /** Number of JSONL files in the local workspace older than the active
   *  scan window (SCAN_AGE_GATE_MS). Used by the panel to reveal the
   *  time-range bar when the active list is empty but older sessions exist. */
  getOlderSessionCount(): number {
    return this.olderSessionCount;
  }

  /** Maximum time (ms) a single poll cycle is allowed to run before aborting.
   *  Prevents hangs from stalled filesystem operations (e.g. network drives). */
  private static readonly POLL_TIMEOUT_MS = 30_000;

  /** Poll all sessions for updates, discover new files */
  private async poll(): Promise<void> {
    // Guard against overlapping polls (async poll could overlap if previous is slow)
    if (this.polling) { return; }
    this.polling = true;

    try {
      const pollStart = Date.now();

      // Wrap the entire poll body in a timeout to prevent indefinite hangs [A4]
      await Promise.race([
        this.pollInner(pollStart),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('poll timeout')), SessionDiscovery.POLL_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === 'poll timeout') {
        this.log.warn('poll cycle exceeded 30s timeout — skipping');
      } else {
        this.log.error('poll error:', err);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollInner(pollStart: number): Promise<void> {
    try {

      // Reload meta only if externally modified (prevents overwriting in-memory mutations) [H2]
      await this.reloadMetaIfChanged();

      // Check for new session files
      await this.scan();

      // Stat-based poll pruning [Phase 6]: dormant sessions (done/stale/idle) only
      // need a stat() check. Full update() (open+read+close = 3 syscalls) is reserved
      // for active sessions and dormant sessions whose file has changed.
      let changed = false;
      const allSessions = Array.from(this.sessions.values());

      // Partition: active sessions always get full update; dormant get stat check first
      const activeSessions: SessionManager[] = [];
      const dormantSessions: SessionManager[] = [];
      for (const session of allSessions) {
        const status = session.getStatus();
        if (status === 'running' || status === 'waiting') {
          activeSessions.push(session);
        } else {
          dormantSessions.push(session);
        }
      }

      // Stat-check dormant sessions in batches to find which ones need a full update
      const wokenSessions: SessionManager[] = [];
      for (let i = 0; i < dormantSessions.length; i += SessionDiscovery.UPDATE_BATCH_SIZE) {
        const batch = dormantSessions.slice(i, i + SessionDiscovery.UPDATE_BATCH_SIZE);
        const mtimeResults = await Promise.all(
          batch.map(async (session) => {
            try {
              const mtimeChanged = await session.checkMtime();
              return { session, mtimeChanged };
            } catch {
              return { session, mtimeChanged: false };
            }
          })
        );
        for (const { session, mtimeChanged } of mtimeResults) {
          if (mtimeChanged) { wokenSessions.push(session); }
        }
      }

      // Full update for active + woken sessions, in batches
      const sessionsToUpdate = [...activeSessions, ...wokenSessions];
      const updateResults: { session: SessionManager; hadNewData: boolean }[] = [];
      for (let i = 0; i < sessionsToUpdate.length; i += SessionDiscovery.UPDATE_BATCH_SIZE) {
        const batch = sessionsToUpdate.slice(i, i + SessionDiscovery.UPDATE_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (session) => {
            try {
              const hadNewData = await session.update();
              return { session, hadNewData };
            } catch (err) {
              this.log.error(`session ${session.getSessionId()} update failed:`, err);
              return { session, hadNewData: false };
            }
          })
        );
        updateResults.push(...batchResults);
      }

      for (const { session, hadNewData } of updateResults) {
        if (hadNewData) {
          changed = true;
        }
        // Demote sessions stuck on 'running' or 'waiting' with no new records.
        // Skip demotion if update() just processed records (avoids false demotion on replay) [M2]
        if (!hadNewData && session.demoteIfStale(30_000)) {
          changed = true;
        }
      }

      // Reconcile meta: clear acknowledged state for sessions that resumed [H2]
      for (const session of this.sessions.values()) {
        const status = session.getStatus();
        if (status === 'running') {
          const meta = this.sessionMeta.get(session.getSessionId());
          if (meta?.acknowledged) {
            meta.acknowledged = false;
            meta.acknowledgedAt = null;
            this.metaDirty = true;
            changed = true;
          }
        }
      }

      // Prune stale meta entries (no matching session, older than 30 days) [F12]
      // Snapshot keys before iterating to avoid delete-during-iteration [audit fix]
      const META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const now2 = Date.now();
      for (const [id, meta] of Array.from(this.sessionMeta)) {
        if (!this.sessions.has(id) && meta.firstSeen && (now2 - meta.firstSeen > META_TTL_MS)) {
          this.sessionMeta.delete(id);
          this.metaDirty = true;
        }
      }

      // Prune sessions whose files no longer exist
      for (const [id, session] of this.sessions) {
        try {
          await fs.promises.access(session.getFilePath());
        } catch {
          session.dispose();
          this.sessions.delete(id);
          // Also prune orphaned meta entry [M5]
          if (this.sessionMeta.has(id)) {
            this.sessionMeta.delete(id);
            this.metaDirty = true;
          }
          changed = true;
        }
      }

      // Flush any meta changes from scan (new sessions)
      await this.flushMeta();

      // Sibling worktrees of the local repo: scan periodically, poll every cycle.
      // Run before foreign manager so foreign can exclude any newly-discovered siblings.
      if (this.siblingManager.shouldRescan()) {
        if (await this.siblingManager.scan()) { changed = true; }
      }
      const siblingChanged = await this.siblingManager.poll();
      if (siblingChanged) { changed = true; }

      // Cross-workspace: scan periodically, poll active foreign sessions every cycle
      if (this.foreignManager.shouldRescan()) {
        await this.foreignManager.scan();
      }
      const foreignChanged = await this.foreignManager.poll();
      if (foreignChanged) { changed = true; }

      // Team discovery: scan periodically, poll team agents every cycle
      if (this.teamDiscovery.shouldRescan()) {
        await this.teamDiscovery.scan();
      }
      const teamChanged = await this.teamDiscovery.poll();
      if (teamChanged) { changed = true; }

      // Workflow discovery: scan periodically, poll for sidecar/live changes
      if (this.workflowDiscovery.shouldRescan()) {
        await this.workflowDiscovery.scan();
      }
      const workflowChanged = await this.workflowDiscovery.poll();
      if (workflowChanged) { changed = true; }

      // Process-liveness registry: refresh on a relaxed cadence. No consumer
      // gates a panel update on it yet, so it never sets `changed`.
      if (this.processRegistry.shouldRescan()) {
        await this.processRegistry.scan();
      }

      // Poll performance log [v0.4]
      const updatedCount = updateResults.filter(r => r.hadNewData).length;
      const totalCount = allSessions.length;
      this.log.trace(
        `poll: ${Date.now() - pollStart}ms, updated ${updatedCount}/${totalCount} sessions`
        + ` (${activeSessions.length} active, ${dormantSessions.length} dormant stat-checked, ${wokenSessions.length} woken)`
        + (this.foreignManager.getWorkspaces().length > 0 ? `, foreign active` : '')
      );

      if (changed && this.onChangeCallback) {
        this.onChangeCallback();
      }
    } catch (err) {
      this.log.error('pollInner error:', err);
    }
  }
}

/** Compare two worktree lists for set equality (order-insensitive, branch-aware). */
function worktreeSetChanged(a: WorktreeInfo[], b: WorktreeInfo[]): boolean {
  if (a.length !== b.length) { return true; }
  const key = (w: WorktreeInfo) => `${w.path}\0${w.branch ?? ''}`;
  const aKeys = new Set(a.map(key));
  for (const w of b) {
    if (!aKeys.has(key(w))) { return true; }
  }
  return false;
}
