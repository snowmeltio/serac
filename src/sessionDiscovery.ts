import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { SessionManager } from './sessionManager.js';
import { jsonlSessionId } from './sessionPolling.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { ForeignWorkspaceManager } from './foreignWorkspaceManager.js';
import { SiblingWorktreeManager } from './siblingWorktreeManager.js';
import { resolveRepoRoot, discoverWorktrees, worktreeSetChanged, type WorktreeInfo } from './gitWorktreeUtil.js';
import { TeamDiscovery } from './teamDiscovery.js';
import { WorkflowDiscovery } from './workflowDiscovery.js';
import { ProcessRegistry, type LiveProcess } from './processRegistry.js';
import { WriterOwnership, aggregateWriterOwnership } from './writerOwnership.js';
import { getSessionLastWriteMtime, isWithinActivityWindow, EXTERNAL_WRITER_QUIET_MS } from './writerActivity.js';
import { readSettings } from './settings.js';
import { claudeStateDir, sessionDirFromJsonl, subagentsDirFor, subagentJsonlPath } from './paths.js';
import { readDefaultModel } from './claudeSettings.js';
import { isValidSessionId } from './validation.js';
import { SYNTHETIC_MODEL_ID } from './jsonlValidator.js';
import { makeSessionMetaStore, type SessionMetaStore } from './sessionMetaStore.js';
import type { SessionSnapshot, WorkspaceGroup, TeamSnapshot, WorkflowSnapshot } from './types.js';
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
  /** session-meta.json lifecycle: load/reload/dirty/serialised saves.
   *  See sessionMetaStore.ts for the concurrency invariants ([C1], [H2]). */
  private readonly meta: SessionMetaStore;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private onChangeCallback: (() => void) | undefined;
  /** Prevents timer callbacks from running after dispose */
  private disposed = false;
  /** Guard against concurrent poll executions */
  private polling = false;
  /** Concurrency limit for session updates (stays under macOS ulimit -n 256) */
  private static readonly UPDATE_BATCH_SIZE = 50;
  /** Age gate: skip JSONL files older than this during scan [Phase 6].
   *  Deliberately fixed rather than settings-driven: the
   *  `serac.discovery.*AgeGateDays` settings scope themselves to foreign
   *  workspaces, worktrees, teams, and workflows — the local card list keeps
   *  a stable window so it doesn't grow or shrink with discovery tuning. */
  private static readonly SCAN_AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
  /** How long an age-gate classification is trusted before re-statting. */
  private static readonly KNOWN_OLD_TTL_MS = 30_000;
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
  /** Resolves whether a live registered process belongs to a *different* VS
   *  Code window than this one. Refreshed alongside processRegistry. */
  private writerOwnership: WriterOwnership;
  /** TTL cache for `isRecentlyActiveElsewhere()`'s per-session recency
   *  verdict, used ONLY by the cosmetic `resolveWriterOwnership()` path
   *  (never by `isExternalWriterFresh()`, which must stay fully fresh/
   *  uncached — see its docstring). `resolveWriterOwnership()` runs on every
   *  snapshot build on every refresh tick, and the recency check walks the
   *  subagents/ directory tree; without amortising it, a session already
   *  flagged as externalWriter would re-walk its own subagents tree on every
   *  single tick.
   *
   *  Deliberately set ABOVE `serac.refresh.intervalSeconds`'s default (5s,
   *  see `package.json`/`settings.ts`) — `extension.ts`'s panel refresh timer
   *  fires unconditionally on that cadence with no upper throttle, so a TTL
   *  shorter than (or equal to) it would be expired again by the time the
   *  very next guaranteed tick arrives, defeating the cache entirely on the
   *  default install (the bug this comment used to describe). 10s clears
   *  that default cadence with margin while staying far below the 10-minute
   *  quiet threshold it feeds into, so it never meaningfully delays the
   *  unlock. This is a static margin, not a dynamic read of the live
   *  setting — a user who sets `serac.refresh.intervalSeconds` above ~10s
   *  will see reduced amortisation, but `getSessionLastWriteMtime`'s own
   *  entry/time budget (see `writerActivity.ts`) now bounds the cost of an
   *  uncached call regardless, so a cache miss is no longer expensive. */
  /** Must exceed the default refresh interval (settings.refresh.intervalSeconds)
   *  or the cache expires before the next guaranteed tick and every poll pays
   *  full price — the v1.16.7 regression. The relationship is pinned by a test
   *  (sessionDiscovery.test.ts), which is why this is not `private`. */
  static readonly RECENCY_CACHE_TTL_MS = 10_000;
  private recencyCache = new Map<string, { active: boolean; expiresAt: number }>();
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
  /** Session ids classified outside the scan window, skipped per cycle so the
   *  local scan doesn't re-stat every age-gated JSONL twice a second (audit
   *  perf-io-3). Cleared every KNOWN_OLD_TTL_MS so a resumed old session
   *  (fresh mtime on an old file) is still picked up within that window. */
  private knownOldSessions = new Set<string>();
  private knownOldClearedAt = 0;
  /** Session ids present in the most recent workspace readdir; null while no
   *  trustworthy listing exists (transient readdir failure). Drives the prune
   *  pass with zero extra syscalls. */
  private lastScanSessionIds: Set<string> | null = null;

  /** Hook-event router for the local workspace's own sessions. Passed
   *  through to SessionManager construction at line ~670. Undefined when
   *  no router is provided (tests, foreign-only contexts). Foreign and
   *  sibling worktrees' SessionManagers do NOT receive this — those
   *  sessions are owned by their own VS Code window's leader. */
  private readonly hookRouter?: HookEventRouter;

  /** Configured default model (e.g. "sonnet"), used to seed a session's model
   *  pill before its first assistant record confirms the actual model. Read
   *  once at construction; injectable for tests so they aren't coupled to the
   *  real machine's settings.json. */
  private readonly defaultModelGuess: string;

  constructor(workspacePath: string, opts?: { projectsDir?: string; log?: Logger; hookRouter?: HookEventRouter; defaultModelGuess?: string }) {
    this.projectsDir = opts?.projectsDir ?? path.join(claudeStateDir(), 'projects');
    this.workspaceKey = sanitiseWorkspaceKey(workspacePath);
    this.metaFilePath = path.join(this.projectsDir, this.workspaceKey, 'session-meta.json');
    this.log = opts?.log ?? nullLogger;
    this.meta = makeSessionMetaStore(this.metaFilePath, this.log);
    this.localCwd = workspacePath;
    this.localWorktreeLabel = path.basename(workspacePath) || workspacePath;
    this.hookRouter = opts?.hookRouter;
    this.defaultModelGuess = opts?.defaultModelGuess ?? readDefaultModel();
    this.foreignManager = new ForeignWorkspaceManager(this.projectsDir, this.workspaceKey, this.log);
    this.siblingManager = new SiblingWorktreeManager(this.projectsDir, this.workspaceKey, this.log);
    this.foreignManager.setSiblingKeysProvider(() => this.siblingManager.getSiblingKeys());
    this.teamDiscovery = new TeamDiscovery(this.projectsDir, this.workspaceKey, this.log);
    // Sessions registry is a sibling of projects/ under the Claude state dir.
    // Constructed before WorkflowDiscovery so the workflow live tier can use it
    // as a liveness probe (abandoned-run → 'incomplete').
    this.processRegistry = new ProcessRegistry(path.join(path.dirname(this.projectsDir), 'sessions'), this.log);
    this.writerOwnership = new WriterOwnership();
    this.workflowDiscovery = new WorkflowDiscovery(this.projectsDir, this.workspaceKey, this.log, this.processRegistry);
    // Freshness parity: out-of-window sessions (foreign / sibling / team
    // orchestrators) get the same registry-backed death gate as primary cards.
    const probeFactory = (sessionId: string) => this.livenessProbeFor(sessionId);
    this.foreignManager.setLivenessProbeFactory(probeFactory);
    this.siblingManager.setLivenessProbeFactory(probeFactory);
    this.teamDiscovery.setLivenessProbeFactory(probeFactory);
    const writerOwnershipProbeFactory = (sessionId: string) => this.writerOwnershipProbeFor(sessionId);
    this.foreignManager.setWriterOwnershipProbeFactory(writerOwnershipProbeFactory);
    this.siblingManager.setWriterOwnershipProbeFactory(writerOwnershipProbeFactory);
    this.teamDiscovery.setWriterOwnershipProbeFactory(writerOwnershipProbeFactory);
  }

  // ── Probe factories ───────────────────────────────────────────────
  // ONE derivation of each probe, shared by primary SessionManagers and the
  // foreign/sibling/team factories above — the closures were re-written
  // inline at both sites and would have drifted apart silently.

  /** Registry-backed liveness, bound to a session id. Tri-state: null when
   *  the last scan was degraded (absence must never read as death off a
   *  transient disk error), else whether a live process backs the session.
   *  Deliberately NOT gated on isActive(): when the ONLY registered process
   *  dies the registry empties, and an isActive() gate would switch the probe
   *  off at the exact moment it matters. Safety against registry-less
   *  machines lives in the manager's seen-live latch — a session never
   *  observed live is never confirmed dead, so an old client degrades to the
   *  timer path. */
  private livenessProbeFor(sessionId: string): () => boolean | null {
    return () => this.processRegistry.isScanClean()
      ? this.processRegistry.isSessionLive(sessionId)
      : null;
  }

  /** Parallel probe: is a *different* VS Code window the confirmed live
   *  writer of this session right now? Account-agnostic by design — see
   *  WriterOwnership's header comment. */
  private writerOwnershipProbeFor(sessionId: string): () => boolean | undefined {
    return () => this.resolveWriterOwnership(sessionId);
  }

  // ── Public API (signatures unchanged where possible) ──────────────

  /** Dismiss a session */
  dismissSession(sessionId: string): void {
    // Archiving a done session implies the user has seen it, regardless of
    // whether it was the last-focused card.
    this.acknowledgeIfDone(sessionId);
    this.meta.getOrCreate(sessionId).dismissed = true;
    this.meta.markDirty();
    // Fire-and-forget save — UI is updated from in-memory state
    this.meta.enqueueSave();
  }

  /** Undismiss a session */
  undismissSession(sessionId: string): void {
    this.meta.getOrCreate(sessionId).dismissed = false;
    this.meta.markDirty();
    this.meta.enqueueSave();
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
    const meta = this.meta.getOrCreate(sessionId);
    if (meta.acknowledged) { return; }
    meta.acknowledged = true;
    meta.acknowledgedAt = Date.now();
    this.meta.markDirty();
    this.meta.enqueueSave();
  }

  /** Start watching for sessions. Calls onChange when state changes. */
  async start(onChange: () => void): Promise<void> {
    this.onChangeCallback = onChange;

    // Load session metadata (with legacy migration)
    await this.meta.load();

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
    await this.writerOwnership.refresh(this.processRegistry.getLiveProcesses());

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
    // Freshness parity: an active foreign/sibling card holds the fast cadence
    // too — previously they refreshed at the idle 2s while visibly running.
    if (this.foreignManager.hasActiveSessions()) { return true; }
    if (this.siblingManager.hasActiveSessions()) { return true; }
    return false;
  }

  stop(): void {
    this.disposed = true;
    // Best-effort persist of any dirty tail state (bounded by one poll cycle —
    // every cycle ends in a flush). Fire-and-forget: stop() is synchronous and
    // deactivation can't await; the store's queue serialises it safely.
    void this.meta.flush();
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
    this.writerOwnership.dispose();
    this.recencyCache.clear();
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
    const teamClaimed = this.teamDiscovery.getClaimedSessionIds(this.meta.asMap());
    for (const session of this.sessions.values()) {
      if (teamClaimed.has(session.getSessionId())) { continue; }
      const snapshot = session.getSnapshot();
      // Tag local sessions with the local worktree so cards render
      // consistently — the panel hides the pill when origin == local.
      snapshot.worktreeRoot = this.localCwd;
      snapshot.worktreeLabel = this.localWorktreeLabel;
      const meta = this.meta.get(snapshot.sessionId);

      snapshot.dismissed = meta?.dismissed ?? false;
      snapshot.title = meta?.title ?? null;

      // (Title write-back into meta lives in the poll cycle — see pollInner.
      // This read path must stay mutation-free.)

      // [L1/F-1] Display-layer derivation: a session whose TURN has ended
      // (status 'done') can still have a live run_in_background subagent
      // working — markSessionDone() deliberately leaves a live background
      // agent running (see its own comment at the call site: "A live
      // background agent outlives the turn by design"), and
      // hasBlockingSubagents() excludes it from blocking demotion for the
      // same reason. Left alone, the card reads "Done" for the whole gap
      // until the next <task-notification>/registry-death/dormant-sweep
      // backstop resolves it — a real, longstanding false-completion gap
      // (decided by Murray 2026-07-23). No new label or card chrome: the
      // card simply presents as 'running'. Must run BEFORE the stale
      // rollover below (so a delegating card is never rolled to stale) and
      // before the two-zone sort (so it sorts into the active zone).
      // Sibling snapshots are deliberately out of scope — this only reads
      // the primary session's own subagents.
      if (snapshot.status === 'done' && snapshot.subagents.some(s => s.running && s.background)) {
        snapshot.status = 'running';
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
      if (this.meta.get(sib.sessionId)?.dismissed) { sib.dismissed = true; }
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
        const sessionId = jsonlSessionId(file);
        if (!sessionId) { continue; }
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

          let meta = this.meta.get(sessionId);

          // Backfill cached title fields once per session. Files written before
          // this code shipped have no aiTitle/customTitle in meta, so we stream
          // the JSONL one time and cache the result.
          if (!meta || (meta.aiTitle === undefined && meta.customTitle === undefined)) {
            const titles = await this.extractTitlesFromJsonl(filePath);
            if (titles.aiTitle || titles.customTitle) {
              meta = this.meta.getOrCreate(sessionId);
              if (titles.aiTitle) { meta.aiTitle = titles.aiTitle; }
              if (titles.customTitle) { meta.customTitle = titles.customTitle; }
              this.meta.markDirty();
              backfilled++;
            } else if (meta) {
              // Record an empty marker so we don't re-scan this file every
              // time the archive range expands. Empty string distinguishes
              // "scanned, nothing found" from "never scanned" (undefined).
              meta.aiTitle = meta.aiTitle ?? '';
              meta.customTitle = meta.customTitle ?? '';
              this.meta.markDirty();
            } else {
              // No meta entry and no titles found — still mark scanned to
              // avoid re-reading on future range expansions.
              meta = this.meta.getOrCreate(sessionId);
              meta.aiTitle = '';
              meta.customTitle = '';
              this.meta.markDirty();
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
            // Tagging invariant: EVERY local snapshot producer stamps its
            // origin (worktreeRoot === workspacePath for local). This literal
            // shipped untagged for weeks — benign only because panel.ts's
            // untagged-means-local fallback happened to match; that exact
            // assumption killed new-chat auto-focus for two releases when a
            // foreign snapshot arrived untagged.
            worktreeRoot: this.localCwd,
            worktreeLabel: this.localWorktreeLabel,
          };
          this.extendedArchive.set(sessionId, snapshot);
        } catch (err) {
          this.log.warn('[archive] Failed to stat %s: %s', file, err);
        }
      }
      this.extendedArchiveLoadedRange = rangeMs;
      if (this.meta.isDirty()) { this.meta.enqueueSave(); }
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
      if (this.meta.get(session.getSessionId())?.dismissed) { continue; }
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
    return this.teamDiscovery.getTeamSnapshots(this.meta.asMap());
  }

  /** Dismiss a team (archive). Stored in sessionMeta keyed as team:<teamId>. */
  dismissTeam(teamId: string): void {
    const metaKey = `team:${teamId}`;
    this.meta.getOrCreate(metaKey).dismissed = true;
    this.meta.markDirty();
    this.meta.enqueueSave();
  }

  /** Undismiss a team. */
  undismissTeam(teamId: string): void {
    const metaKey = `team:${teamId}`;
    this.meta.getOrCreate(metaKey).dismissed = false;
    this.meta.markDirty();
    this.meta.enqueueSave();
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

  /** The `~/.claude/teams` root this discovery scans (for the inbox writer). */
  getTeamsDir(): string {
    return this.teamDiscovery.getTeamsDir();
  }

  /** Resolve the inbox write target for an in-process teammate (subagents
   *  source): map orchestrator session + subagent hash → { teamDir, member },
   *  roster-validated, or null to refuse. For teammate messaging only. */
  resolveInboxTarget(orchestratorSessionId: string, agentId: string): { teamDir: string; member: string } | null {
    return this.teamDiscovery.resolveInboxTarget(orchestratorSessionId, agentId);
  }

  /** Resolve a plain Task subagent's transcript JSONL for the detail panel
   *  reader. Subagents live at <sessionDir>/subagents/agent-<agentId>.jsonl,
   *  where sessionDir is the session's JSONL path with `.jsonl` stripped. */
  getSubagentFilePath(sessionId: string, agentId: string): string | null {
    if (!isValidSessionId(agentId)) { return null; }
    const jsonlPath = this.getSessionFilePath(sessionId);
    if (!jsonlPath) { return null; }
    const file = subagentJsonlPath(sessionDirFromJsonl(jsonlPath), agentId);
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
  listSubagentFiles(sessionId: string): { agentId: string; agentType: string | null; description: string | null; model: string | null }[] {
    const jsonlPath = this.getSessionFilePath(sessionId);
    if (!jsonlPath) { return []; }
    const subagentsDir = subagentsDirFor(sessionDirFromJsonl(jsonlPath));
    let files: string[];
    try {
      files = fs.readdirSync(subagentsDir);
    } catch {
      return [];
    }
    const out: { agentId: string; agentType: string | null; description: string | null; model: string | null; ts: number }[] = [];
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
      out.push({ agentId, agentType, description, model: this.readSubagentModel(path.join(subagentsDir, f)), ts });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.map(({ agentId, agentType, description, model }) => ({ agentId, agentType, description, model }));
  }

  /** Model ids already recovered from subagent transcripts, keyed by file path.
   *  A subagent's model never changes mid-run, so a hit is permanent — steady
   *  refresh ticks cost nothing after the first read. A miss (no assistant
   *  record yet) is NOT cached, so a just-spawned agent resolves on a later scan. */
  private readonly subagentModelCache = new Map<string, string>();

  /** Head-read a subagent transcript for its model (`message.model` on the
   *  first REAL assistant record — meta.json never carries it; the synthetic
   *  sentinel is skipped so an opening synthetic turn doesn't get cached as
   *  the agent's model). Bounded to a single 64 KB read; the first assistant
   *  record lands within the opening lines. */
  private readSubagentModel(filePath: string): string | null {
    const cached = this.subagentModelCache.get(filePath);
    if (cached) { return cached; }
    const MAX_BYTES = 64 * 1024;
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(MAX_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
      const chunk = buf.toString('utf8', 0, bytesRead);
      for (const line of chunk.split('\n')) {
        // Cheap pre-filter before JSON.parse — user/tool records rarely match.
        if (!line.includes('"model"')) { continue; }
        try {
          const rec = JSON.parse(line) as { message?: { model?: unknown } };
          const model = rec.message?.model;
          if (typeof model === 'string' && model && model !== SYNTHETIC_MODEL_ID) {
            this.subagentModelCache.set(filePath, model);
            return model;
          }
        } catch { /* malformed or window-truncated line — keep scanning */ }
      }
    } catch {
      // Unreadable transcript — the row simply shows no model.
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    }
    return null;
  }

  // ── Workflow API ──────────────────────────────────────────────────

  /** Get workflow-run snapshots for the webview. */
  getWorkflowSnapshots(): WorkflowSnapshot[] {
    return this.workflowDiscovery.getWorkflowSnapshots(this.meta.asMap());
  }

  /** Resolve a workflow agent's transcript JSONL (for the detail panel reader). */
  getWorkflowAgentFilePath(runId: string, agentId: string): string | null {
    return this.workflowDiscovery.getWorkflowAgentFilePath(runId, agentId);
  }

  /** Dismiss a workflow run (archive). Stored in sessionMeta as workflow:<runId>;
   *  getWorkflowSnapshots overlays this onto WorkflowSnapshot.dismissed. */
  dismissWorkflow(runId: string): void {
    this.meta.getOrCreate(`workflow:${runId}`).dismissed = true;
    this.meta.markDirty();
    this.meta.enqueueSave();
  }

  /** Undismiss a workflow run. */
  undismissWorkflow(runId: string): void {
    this.meta.getOrCreate(`workflow:${runId}`).dismissed = false;
    this.meta.markDirty();
    this.meta.enqueueSave();
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

  /** Cached writer-ownership verdict for a session id, aggregated across
   *  EVERY live process currently registered under it (usually one, but two
   *  can coexist — see ProcessRegistry.getProcessesForSession). Any one
   *  confirmed-external process is enough to flag the whole session (fail
   *  toward flagging, not away from it); every process must be
   *  confirmed-own-window to clear it; anything unresolved falls back to
   *  "don't flag", matching WriterOwnership.getInfo()'s own tri-state
   *  contract. This reads the last poll's cache — fine for a cosmetic
   *  render-time signal, too stale for an actual open/send decision (see
   *  isExternalWriterFresh()).
   *
   *  A confirmed-external verdict is additionally gated on recent activity
   *  (`isRecentlyActiveElsewhere()`, TTL-cached via `recencyCache` — see its
   *  field doc): a session sitting idle at a prompt in another window for
   *  the last `EXTERNAL_WRITER_QUIET_MS` clears back to not-flagged even
   *  though the owning process is still alive. The fs-touching recency check
   *  only ever runs once ownership itself has already resolved `true` — the
   *  own-window and unresolved cases below are unaffected and stay pure
   *  in-memory checks with zero fs cost, which matters because this function
   *  runs on every session snapshot build on every refresh tick. The recency
   *  check is scoped to only the CONFIRMED-EXTERNAL processes among `procs`
   *  (not every process registered under the id) — see
   *  `isRecentlyActiveElsewhere`'s docstring for why an own-window process's
   *  recency must never be allowed to stand in for the external writer's.
   *
   *  Gated on `serac.experimental.externalWriterBlock` (default OFF): when
   *  off, this returns `undefined` before touching the process registry or
   *  `writerOwnership` at all — the whole feature is a no-op, not just
   *  hidden in the UI, matching the "no filtering/blocking by default"
   *  requirement. Read fresh (not cached) each call, same as every other
   *  experimental-gate read in this codebase (see e.g. `getMessagingSettings`
   *  in extension.ts) — cheap, and this function already runs on every
   *  snapshot build. */
  private resolveWriterOwnership(sessionId: string): boolean | undefined {
    if (!readSettings().experimental.externalWriterBlock) { return undefined; }
    const procs = this.processRegistry.getProcessesForSession(sessionId);
    const ownership = aggregateWriterOwnership(procs.map(p => this.writerOwnership.getInfo(p.pid)));
    if (ownership !== true) { return ownership; }

    const now = Date.now();
    const cached = this.recencyCache.get(sessionId);
    if (cached && cached.expiresAt > now) {
      return cached.active;
    }
    const externalProcs = procs.filter(p => this.writerOwnership.getInfo(p.pid) === true);
    const active = this.isRecentlyActiveElsewhere(sessionId, externalProcs);
    this.recencyCache.set(sessionId, { active, expiresAt: now + SessionDiscovery.RECENCY_CACHE_TTL_MS });
    return active;
  }

  /** Authoritative, UNCACHED check for the exact moment of an actual
   *  open-editor or send-message decision — the poll loop only rescans the
   *  process registry every REGISTRY_SCAN_INTERVAL cycles (a few seconds),
   *  which is stale exactly during the highest-risk window (a session that
   *  just started elsewhere, or just finished). Forces a fresh registry scan,
   *  then resolves ownership for exactly this session's own process(es) via
   *  `writerOwnership.resolveFor()` — deliberately NOT the full-list
   *  `refresh()` the poll loop uses: resolving ownership means spawning a
   *  real `ps` subprocess per unresolved pid, and this runs on every ordinary
   *  session open, so scoping it to the session in question keeps that cost
   *  (and the tail risk of a slow/hung `ps`) from leaking onto a click that
   *  has nothing to do with any other live process. `resolveFor()` is
   *  serialized against every other cache-mutating call (see
   *  WriterOwnership's `queue`), so a concurrent poll-loop refresh() can't
   *  race this decision — that used to be possible when both went through
   *  plain, unserialized `refresh()` calls. Checked directly against the
   *  process registry rather than a merged snapshot list, so it answers
   *  correctly for any session id — including team orchestrators and
   *  workflow-owning sessions, which don't appear in getSnapshots().
   *  Account-agnostic: see WriterOwnership. Resolves false (never blocks)
   *  when there's no live process or ownership can't be determined.
   *
   *  Once ownership resolves confirmed-external, ALSO requires recent
   *  activity (`isRecentlyActiveElsewhere()`) before blocking — a session
   *  quiet for `EXTERNAL_WRITER_QUIET_MS` no longer blocks even though the
   *  external process is still alive. This recency check is always computed
   *  fresh here (no cache, unlike `resolveWriterOwnership()`'s
   *  `recencyCache`), consistent with this function's existing
   *  fresh-registry-scan-and-fresh-`resolveFor()` contract — an authoritative
   *  open/send decision must never trust a cached verdict. Scoped to only the
   *  CONFIRMED-EXTERNAL processes among `procs` — see
   *  `isRecentlyActiveElsewhere`'s docstring for why.
   *
   *  Gated on `serac.experimental.externalWriterBlock` (default OFF): when
   *  off, resolves `false` (never blocks) before even scanning the process
   *  registry — see `resolveWriterOwnership`'s docstring for the same gate. */
  async isExternalWriterFresh(sessionId: string): Promise<boolean> {
    if (!readSettings().experimental.externalWriterBlock) { return false; }
    await this.processRegistry.scan();
    const procs = this.processRegistry.getProcessesForSession(sessionId);
    if (procs.length === 0) { return false; }
    await this.writerOwnership.resolveFor(procs);
    const ownership = aggregateWriterOwnership(procs.map(p => this.writerOwnership.getInfo(p.pid))) === true;
    if (!ownership) { return false; }
    const externalProcs = procs.filter(p => this.writerOwnership.getInfo(p.pid) === true);
    return this.isRecentlyActiveElsewhere(sessionId, externalProcs);
  }

  /** Filesystem-touching recency check: is ANY of the given live processes
   *  registered under `sessionId` backed by activity within the quiet
   *  window? "Activity" includes the session's own top-level JSONL AND
   *  everything under its `subagents/` tree — Task-tool subagents and
   *  Workflow-run agents write their own separate per-agent JSONLs there
   *  (nested under `subagents/workflows/<runId>/` for Workflow runs), and the
   *  session's own top-level JSONL can sit completely quiet for the entire
   *  duration of a subagent/workflow run (see the comment near
   *  `hasLiveBackgroundAgents()` above documenting the same fact for the
   *  dormant-sweep wake path). A recency check that only looked at the main
   *  JSONL would misjudge an actively-orchestrating session as dormant.
   *
   *  Derives each process's session file/subagents paths the same way
   *  `SessionManager.backgroundAgentFileMtime()` derives its subagents dir
   *  from a filePath (`<sessionDir>/subagents`), rooted instead at THAT
   *  process's own `cwd` (via `sanitiseWorkspaceKey`) rather than
   *  `this.workspaceKey` — a confirmed-external process is, by definition,
   *  very likely NOT rooted at this window's own workspace.
   *
   *  CALLERS MUST pass only the CONFIRMED-EXTERNAL processes among the
   *  session's registered processes (i.e. those for which
   *  `writerOwnership.getInfo(pid) === true`), never the full unfiltered
   *  list. An own-window process can legitimately coexist under the same
   *  sessionId as a confirmed-external one (e.g. this window resuming a
   *  session another window already holds); that own-window process's
   *  `startedAt`/cwd carry no information about whether the EXTERNAL writer
   *  has gone quiet, and including it here would let a fresh own-window
   *  attach spuriously keep (or re-trigger) a lock that should have cleared
   *  — the "own window just legitimately opened this and its own fresh
   *  process immediately re-locks it" self-defeat case. Checks EVERY given
   *  (already-filtered) process — usually one, but two confirmed-external
   *  processes can coexist too (see `ProcessRegistry.getProcessesForSession`)
   *  — and returns true if ANY is within the window: same
   *  any-positive-signal-is-enough posture already used for ownership itself
   *  (see `resolveWriterOwnership`'s docstring), just scoped to the set that
   *  posture is actually meant to apply to.
   *
   *  CALLERS MUST ONLY invoke this once ownership has already resolved
   *  `true` (confirmed external) — this does real disk I/O (a stat per
   *  subagent-tree file, bounded — see `getSessionLastWriteMtime`'s own
   *  entry/time budget) and must never run on the own-window or unresolved
   *  hot-path cases. */
  private isRecentlyActiveElsewhere(sessionId: string, procs: readonly LiveProcess[]): boolean {
    const now = Date.now();
    return procs.some(proc => {
      const wsDir = path.join(this.projectsDir, sanitiseWorkspaceKey(proc.cwd));
      const filePath = path.join(wsDir, `${sessionId}.jsonl`);
      const subagentsDir = subagentsDirFor(path.join(wsDir, sessionId));
      const lastWrite = getSessionLastWriteMtime(filePath, subagentsDir, {
        recentEnoughMs: EXTERNAL_WRITER_QUIET_MS,
        nowMs: now,
      });
      return isWithinActivityWindow(lastWrite, proc.startedAt, now, EXTERNAL_WRITER_QUIET_MS);
    });
  }

  /** Sibling-worktree sessions waiting on input (badge parity with local). */
  getSiblingWaitingCount(): number {
    return this.siblingManager.getWaitingCount();
  }

  // ── Discovery and polling ─────────────────────────────────────────

  /** Discover JSONL files for the current workspace only */
  private async scan(): Promise<void> {
    const wsDir = path.join(this.projectsDir, this.workspaceKey);
    try {
      await fs.promises.access(wsDir);
    } catch (err) {
      // Dir confirmed absent: nothing in it exists, so the prune pass may
      // evict all tracked sessions. Any other failure (EACCES etc.) leaves
      // the listing untrusted — never mass-evict off a transient error.
      this.lastScanSessionIds = (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null;
      return;
    }

    await this.scanWorkspace(this.workspaceKey);
  }

  private async scanWorkspace(workspaceKey: string): Promise<void> {
    const workspacePath = path.join(this.projectsDir, workspaceKey);
    const now = Date.now();
    let olderCount = 0;

    // Forget age-gate classifications on a slow cadence so a resumed old
    // session is re-statted (and picked up) within the TTL.
    if (now - this.knownOldClearedAt > SessionDiscovery.KNOWN_OLD_TTL_MS) {
      this.knownOldSessions.clear();
      this.knownOldClearedAt = now;
    }

    try {
      const files = await fs.promises.readdir(workspacePath);
      const seen = new Set<string>();
      for (const file of files) {
        const sessionId = jsonlSessionId(file);
        if (!sessionId) { continue; }
        seen.add(sessionId);

        const filePath = path.join(workspacePath, file);

        if (!this.sessions.has(sessionId)) {
          // Already classified as outside the window — count it, skip the stat.
          if (this.knownOldSessions.has(sessionId)) {
            olderCount++;
            continue;
          }
          // Age gate [Phase 6]: skip files older than SCAN_AGE_GATE_MS to avoid
          // loading hundreds of dormant sessions on startup
          try {
            const stat = await fs.promises.stat(filePath);
            if (now - stat.mtimeMs > SessionDiscovery.SCAN_AGE_GATE_MS) {
              olderCount++;
              this.knownOldSessions.add(sessionId);
              continue;
            }
          } catch { continue; }

          const manager = new SessionManager(sessionId, filePath, workspaceKey, {
            hookRouter: this.hookRouter,
            defaultModelGuess: this.defaultModelGuess,
            // Status-transition trace. Permission-FP diagnostics: the waiting
            // lifecycle (and any stale-waiting reconciliation) surfaces at `info`
            // so it is visible without enabling trace; every other transition
            // logs at `trace`. Reason + activeTools count discriminate the path
            // (permission_fired / demote_waiting / subagent_permission_bubble /
            // needs_user_input / stale_waiting_reconciled). See
            // project_permission_false_positives.
            onTransition: (from, to, reason, activeToolCount) => {
              const msg = `[status] ${sessionId.slice(0, 8)} ${from}→${to} (${reason}) activeTools=${activeToolCount}`;
              if (to === 'waiting' || from === 'waiting' || reason === 'stale_waiting_reconciled') {
                this.log.info(msg);
              } else {
                this.log.trace(msg);
              }
            },
            // Shared probe derivations — see the Probe factories section.
            livenessProbe: this.livenessProbeFor(sessionId),
            writerOwnershipProbe: this.writerOwnershipProbeFor(sessionId),
            // The latch survives reloads via session-meta.json — without the
            // seed, every reload disarmed the death gate until re-observed.
            registrySeenLive: this.meta.get(sessionId)?.seenLive === true,
            onRegistrySeenLive: () => {
              const meta = this.meta.getOrCreate(sessionId);
              if (!meta.seenLive) {
                meta.seenLive = true;
                this.meta.markDirty();
              }
            },
          });
          this.sessions.set(sessionId, manager);
          // Ensure meta entry exists for newly discovered sessions
          this.meta.getOrCreate(sessionId);
          this.meta.markDirty();
          // Do initial read
          await manager.update();
        }
      }
      this.olderSessionCount = olderCount;
      this.lastScanSessionIds = seen;
    } catch (err) {
      // Dir gone → trust emptiness for pruning; transient failure → distrust
      // the listing and skip pruning this cycle (see scan()).
      this.lastScanSessionIds = (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null;
    }
  }

  /** Number of JSONL files in the local workspace older than the active
   *  scan window (SCAN_AGE_GATE_MS). Used by the panel to reveal the
   *  time-range bar when the active list is empty but older sessions exist. */
  getOlderSessionCount(): number {
    return this.olderSessionCount;
  }

  /** Maximum time (ms) a single poll cycle is allowed to run before aborting.
   *  Prevents hangs from stalled filesystem operations (e.g. network drives).
   *  Note this only stops `poll()` from *waiting* on a stalled `pollInner()` —
   *  `Promise.race` doesn't cancel the loser, so a stalled call keeps running
   *  in the background and a fresh `pollInner()` can start over it once
   *  `this.polling` resets, so `processRegistry.scan()`/`writerOwnership`
   *  calls from two overlapping cycles CAN run concurrently. `ProcessRegistry`
   *  itself doesn't need protecting from this (`scan()` ends in one atomic
   *  array assignment — concurrent scans just mean "whichever finishes last
   *  wins", never a torn read). `WriterOwnership` does: an earlier version of
   *  this class let `isExternalWriterFresh()`'s on-demand resolution and the
   *  poll loop's routine resolution both mutate its cache directly, and one
   *  call's prune step could delete an entry the other had just resolved
   *  moments before reading it back — a real, adversarially-confirmed bug,
   *  not a hypothetical one. `WriterOwnership` now serializes every
   *  cache-mutating call through one internal queue (see its own docstring),
   *  so this is closed at the source: it doesn't matter how many overlapping
   *  poll cycles or on-demand checks are in flight, at most one is ever
   *  mutating that cache, and each one's own read reflects only its own,
   *  fully-applied result. */
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
      await this.meta.reloadIfChanged();

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
      // A done card with live background agents still has work to observe: its
      // main JSONL is quiet (no mtime wake) but the agents' own JSONLs are
      // growing. Keep pumping update() so the subagent tailers feed the roster,
      // tool counts, and permission detection while the detached agents run.
      for (const session of dormantSessions) {
        if (session.hasLiveBackgroundAgents() && !wokenSessions.includes(session)) {
          wokenSessions.push(session);
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

      // Background-shell maintenance on dormant cards (done/stale/idle). The
      // demote loop above only prunes shells for active/woken sessions, so an
      // idle `done` card with an outstanding background shell would never prune
      // (ceiling never fires) nor clear on confirmed process death. Sweep them
      // here, decoupled from mtime/new-data; a count drop sets `changed` so the
      // cleared badge reaches the webview (demote can't — the status stays
      // `done`). Cheap: each call returns early unless the session has shells.
      const shellSweepNow = Date.now();
      for (const session of dormantSessions) {
        if (session.sweepBackgroundWork(shellSweepNow)) { changed = true; }
      }

      // Reconcile meta: clear acknowledged state for sessions that resumed [H2]
      for (const session of this.sessions.values()) {
        const status = session.getStatus();
        if (status === 'running') {
          const meta = this.meta.get(session.getSessionId());
          if (meta?.acknowledged) {
            meta.acknowledged = false;
            meta.acknowledgedAt = null;
            this.meta.markDirty();
            changed = true;
          }
        }
      }

      // Cache live title fields into meta so they survive the 7-day archive
      // cutoff (the lightweight archive scanner doesn't parse JSONL). Lives
      // here — not in getSnapshots — so the snapshot read path stays
      // mutation-free; flushed by the end-of-cycle flush below. Deliberately
      // covers ALL sessions including team-claimed ones (the old getSnapshots
      // site skipped those incidentally via the card-suppression `continue`;
      // caching their titles too is strictly better for the archive).
      for (const session of this.sessions.values()) {
        const meta = this.meta.get(session.getSessionId());
        if (!meta) { continue; }
        const { aiTitle, customTitle } = session.getTitles();
        if (aiTitle && aiTitle !== meta.aiTitle) {
          meta.aiTitle = aiTitle;
          this.meta.markDirty();
        }
        if (customTitle && customTitle !== meta.customTitle) {
          meta.customTitle = customTitle;
          this.meta.markDirty();
        }
      }

      // Prune stale meta entries (no matching session, older than 30 days) [F12]
      // Snapshot keys before iterating to avoid delete-during-iteration [audit fix]
      const META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const now2 = Date.now();
      for (const [id, meta] of this.meta.entries()) {
        if (!this.sessions.has(id) && meta.firstSeen && (now2 - meta.firstSeen > META_TTL_MS)) {
          this.meta.delete(id);
        }
      }

      // Prune sessions whose files no longer exist. Existence comes from the
      // readdir scan() just did this cycle — zero extra syscalls, and it
      // covers active sessions too (their update() path never stats for
      // deletion). A null listing means the last readdir wasn't trustworthy;
      // skip pruning rather than mass-evict off a transient error.
      if (this.lastScanSessionIds) {
        for (const [id, session] of this.sessions) {
          if (this.lastScanSessionIds.has(id)) { continue; }
          session.dispose();
          this.sessions.delete(id);
          // Also prune orphaned meta entry [M5]
          this.meta.delete(id);
          // And any stale recency verdict for this locally-scanned id. The
          // broader sweep below (near processRegistry.shouldRescan()) also
          // covers foreign/sibling/team-lead ids sharing this same cache;
          // this one just fires on the tighter local-scan cadence.
          this.recencyCache.delete(id);
          changed = true;
        }
      }

      // Flush any meta changes from scan (new sessions)
      await this.meta.flush();

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

      // Process-liveness registry: refresh on a relaxed cadence. This feeds
      // cosmetic, render-time signals only (card liveness dimming, the cached
      // externalWriter probe) — nothing here gates a panel update, so it
      // never sets `changed`. The one consumer where staleness would be a
      // real (not cosmetic) problem, isExternalWriterFresh(), deliberately
      // does NOT rely on this cadence — it forces its own scan + a scoped
      // WriterOwnership.resolveFor() at the point of decision instead. Don't
      // add an authoritative gate against this cached path without giving it
      // the same treatment.
      if (this.processRegistry.shouldRescan()) {
        await this.processRegistry.scan();
        // writerOwnership.refresh() and the recencyCache sweep below exist
        // purely in service of the externalWriter feature (ps subprocess
        // spawning + cache bookkeeping) — processRegistry.scan() itself must
        // always run regardless (it also feeds the unrelated permission-
        // false-positive liveness gate), so only these two are gated.
        if (readSettings().experimental.externalWriterBlock) {
          const liveProcesses = this.processRegistry.getLiveProcesses();
          await this.writerOwnership.refresh(liveProcesses);
          // Sweep recencyCache for ids no longer backed by any live process. The
          // per-session prune loop above only walks `this.sessions` (the local
          // workspace scan), but recencyCache is shared across local, foreign,
          // sibling-worktree, and team-lead sessions via the one
          // writerOwnershipProbeFactory closure (see its wiring above, near the
          // constructor) — a
          // confirmed-external entry only ever gets created while backed by a
          // live process, so "no longer live" is a safe, universal eviction
          // signal regardless of which category the id came from.
          const liveSessionIds = new Set(liveProcesses.map(p => p.sessionId));
          for (const id of this.recencyCache.keys()) {
            if (!liveSessionIds.has(id)) { this.recencyCache.delete(id); }
          }
        }
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

