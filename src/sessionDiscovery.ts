import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from './sessionManager.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { ForeignWorkspaceManager } from './foreignWorkspaceManager.js';
import type { SessionSnapshot, SessionMeta, SessionMetaFile, WorkspaceGroup } from './types.js';

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
  /** Concurrency limit for session updates (stays under macOS ulimit -n 256) */
  private static readonly UPDATE_BATCH_SIZE = 50;
  /** Age gate: skip JSONL files older than this during scan [Phase 6] */
  private static readonly SCAN_AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
  private readonly log: Logger;
  /** Manages cross-workspace session discovery and polling */
  private foreignManager: ForeignWorkspaceManager;
  /** Extended archive: lightweight snapshots for sessions older than SCAN_AGE_GATE_MS.
   *  Only populated when archiveRangeMs > SCAN_AGE_GATE_MS. Keyed by sessionId. */
  private extendedArchive: Map<string, SessionSnapshot> = new Map();
  /** Current archive range requested by the panel (ms). Infinity = all. */
  private archiveRangeMs = 86400000; // default 1d
  /** The range that extendedArchive was last populated for (avoids redundant rescans) */
  private extendedArchiveLoadedRange = 0;

  constructor(workspacePath: string, opts?: { projectsDir?: string; log?: Logger }) {
    this.projectsDir = opts?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
    this.workspaceKey = sanitiseWorkspaceKey(workspacePath);
    this.metaFilePath = path.join(this.projectsDir, this.workspaceKey, 'session-meta.json');
    this.log = opts?.log ?? nullLogger;
    this.foreignManager = new ForeignWorkspaceManager(this.projectsDir, this.workspaceKey, this.log);
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
    const tmpPath = `${this.metaFilePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
    await fs.promises.rename(tmpPath, this.metaFilePath);
    // Update mtime so reloadMetaIfChanged() won't re-read our own write [C1]
    try {
      const stat = await fs.promises.stat(this.metaFilePath);
      this.metaLastMtime = stat.mtimeMs;
    } catch { /* stat failed */ }
    this.metaDirty = false;
  }

  /** Flush pending meta changes if dirty */
  private async flushMeta(): Promise<void> {
    if (this.metaDirty) { await this.saveMeta(); }
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

    // Initial scan (local + foreign)
    await this.scan();
    await this.foreignManager.scan();

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
    return false;
  }

  stop(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.foreignManager.dispose();
  }

  /** Get snapshots of all sessions, sorted by priority */
  getSnapshots(): SessionSnapshot[] {
    const now = Date.now();
    const snapshots: SessionSnapshot[] = [];
    for (const session of this.sessions.values()) {
      const snapshot = session.getSnapshot();
      const meta = this.sessionMeta.get(snapshot.sessionId);

      snapshot.dismissed = meta?.dismissed ?? false;
      snapshot.title = meta?.title ?? null;

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
   *  Only reads file stats and session-meta.json — no JSONL parsing. */
  private async scanExtendedArchive(rangeMs: number): Promise<void> {
    const wsDir = path.join(this.projectsDir, this.workspaceKey);
    const now = Date.now();
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

          // Build lightweight snapshot from meta + stat
          const meta = this.sessionMeta.get(sessionId);
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
            customTitle: '',
            confidence: 'high', // terminal status
          };
          this.extendedArchive.set(sessionId, snapshot);
        } catch (err) {
          this.log.warn('[archive] Failed to stat %s: %s', file, err);
        }
      }
      this.extendedArchiveLoadedRange = rangeMs;
      this.log.info('[archive] Extended archive scan complete: %d entries for range %dms (scanned %d jsonl files)', this.extendedArchive.size, rangeMs, files.filter(f => f.endsWith('.jsonl')).length);
    } catch (err) {
      this.log.warn('[archive] Failed to read workspace directory %s: %s', wsDir, err);
    }
  }

  /** Get the JSONL file path for a session */
  getSessionFilePath(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.getFilePath();
  }

  /** Check if a session is currently running */
  isSessionRunning(sessionId: string): boolean {
    const status = this.sessions.get(sessionId)?.getStatus();
    return status === 'running' || status === 'waiting';
  }

  /** Count sessions waiting on user input */
  getWaitingCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.getStatus() === 'waiting') { count++; }
    }
    return count;
  }

  /** Get foreign workspace summaries. Delegates to ForeignWorkspaceManager. */
  getForeignWorkspaces(): WorkspaceGroup[] {
    return this.foreignManager.getWorkspaces();
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
            if (now - stat.mtimeMs > SessionDiscovery.SCAN_AGE_GATE_MS) { continue; }
          } catch { continue; }

          const manager = new SessionManager(sessionId, filePath, workspaceKey);
          this.sessions.set(sessionId, manager);
          // Ensure meta entry exists for newly discovered sessions
          this.getOrCreateMeta(sessionId);
          this.metaDirty = true;
          // Do initial read
          await manager.update();
        }
      }
    } catch {
      // Skip unreadable directories
    }
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

      // Cross-workspace: scan periodically, poll active foreign sessions every cycle
      if (this.foreignManager.shouldRescan()) {
        await this.foreignManager.scan();
      }
      const foreignChanged = await this.foreignManager.poll();
      if (foreignChanged) { changed = true; }

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
