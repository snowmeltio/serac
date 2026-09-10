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
import type { WriterAggregate } from './writerOwnership.js';
import { resolveRepoRoot } from './gitWorktreeUtil.js';
import type { SessionSnapshot } from './types.js';
import type { Logger } from './sessionDiscovery.js';
import { pollTrackedSessions, hasActiveTrackedSessions, trackJsonlSessions, jsonlSessionId, makeRescanGate, sumBytesRead, offerSessionToReplayCache } from './sessionPolling.js';
import { readSettings, ageGateMsFor } from './settings.js';
import { peekCwd } from './jsonlPeek.js';
import type { ReplayCacheStore } from './replayCache.js';

/** Cap on how many of the newest candidate JSONLs in an unclassified dir get
 *  a head-only cwd peek. Most dirs resolve on the newest file; a handful of
 *  fallbacks covers a newest file that predates the `cwd` field (compacted
 *  away, or an old transcript) without unbounded work on a busy workspace. */
const PEEK_CANDIDATES = 3;

/** Should sibling-worktree discovery run at all? The Worktrees pane is one
 *  consumer; squash mode is the other, and it renders those sessions as cards
 *  in the main list with the pane hidden. Gating discovery on the pane toggle
 *  alone would make squash-with-pane-off silently show nothing — a setting
 *  that appears to do nothing is worse than one that isn't there. */
function siblingDiscoveryWanted(): boolean {
  const s = readSettings();
  return s.show.worktrees || s.worktrees.squash;
}



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
  /** Dormant-session replay cache (PR D), injected by SessionDiscovery via
   *  setReplayCache() — same shape as the liveness/writer-ownership probe
   *  factories above. */
  private replayCache?: ReplayCacheStore;
  /** Hydrated-vs-replayed counts from the most recent scan() — startup
   *  instrumentation only (the `[replay-cache]` summary line). Reset at the
   *  top of every scan(). */
  private replayCacheStats = { hydrated: 0, replayed: 0 };

  constructor(
    private readonly projectsDir: string,
    private readonly localWorkspaceKey: string,
    private readonly log: Logger,
  ) {}

  /** Per-session registry liveness probe factory, injected by SessionDiscovery
   *  (freshness parity: sibling cards get the same death gate as primary). */
  private probeFactory?: (sessionId: string) => () => boolean | null;
  /** Per-session writer-ownership probe factory, injected by SessionDiscovery —
   *  reports whether a *different* VS Code window is confirmed to be a
   *  session's live writer right now. Account-agnostic; see WriterOwnership. */
  private writerOwnershipProbeFactory?: (sessionId: string) => () => WriterAggregate;

  setLivenessProbeFactory(factory: (sessionId: string) => () => boolean | null): void {
    this.probeFactory = factory;
  }

  setWriterOwnershipProbeFactory(factory: (sessionId: string) => () => WriterAggregate): void {
    this.writerOwnershipProbeFactory = factory;
  }

  /** Wire in the dormant-session replay cache, injected by SessionDiscovery
   *  once (same pattern as setLivenessProbeFactory). scan()/poll() still
   *  re-check `serac.discovery.replayCache` on every call. */
  setReplayCache(store: ReplayCacheStore): void {
    this.replayCache = store;
  }

  /** Hydrated-vs-replayed counts from the most recent scan() call — read by
   *  SessionDiscovery right after the foreign-scan startup stage for the
   *  `[replay-cache]` summary line. */
  getReplayCacheStats(): { hydrated: number; replayed: number } {
    return { ...this.replayCacheStats };
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

  /** Workspace key of the worktree that owns `sessionId`, or null when this
   *  manager doesn't track it. Lets a dismiss write through to that worktree's
   *  own session-meta.json instead of stopping at this window. */
  ownerWorkspaceKeyFor(sessionId: string): string | null {
    const suffix = '/' + sessionId;
    for (const compositeId of this.sessions.keys()) {
      if (compositeId.endsWith(suffix)) {
        return compositeId.slice(0, compositeId.length - suffix.length);
      }
    }
    return null;
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
    if (!siblingDiscoveryWanted()) { return false; }
    const now = Date.now();
    const ageGate = ageGateMsFor('worktrees');
    this.replayCacheStats = { hydrated: 0, replayed: 0 };
    // Genuine no-op when the kill switch is off: replayCache/makeHydrated
    // simply aren't passed to trackJsonlSessions below, not passed-but-inert.
    const cache = readSettings().discovery.replayCache ? this.replayCache : undefined;
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
          const manager = new SessionManager(sessionId, filePath, dir, {
            livenessProbe: this.probeFactory?.(sessionId),
            writerOwnershipProbe: this.writerOwnershipProbeFactory?.(sessionId),
          });
          manager.setWorktreeOrigin(wtRoot, wtLabel);
          return manager;
        },
        warn: (compositeId, err) => this.log.warn(`Sibling session update failed (${compositeId}):`, err),
        replayCache: cache,
        livenessOf: cache ? (sessionId) => this.probeFactory?.(sessionId)?.() ?? null : undefined,
        makeHydrated: cache
          ? (sessionId, filePath, state, stamp) => {
            const manager = SessionManager.fromCache(sessionId, filePath, dir, {
              livenessProbe: this.probeFactory?.(sessionId),
              writerOwnershipProbe: this.writerOwnershipProbeFactory?.(sessionId),
            }, state, stamp);
            // Origin tagging must reach a hydrated manager exactly like an
            // ordinarily-constructed one (makeManager above) — otherwise a
            // hydrated sibling card would silently lose its worktree chip.
            manager.setWorktreeOrigin(wtRoot, wtLabel);
            return manager;
          }
          : undefined,
        onTracked: cache
          ? (hydrated) => {
            if (hydrated) { this.replayCacheStats.hydrated++; } else { this.replayCacheStats.replayed++; }
          }
          : undefined,
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
   *  recently-modified file(s) first because old files may pre-date the cwd
   *  field or have been compacted in ways that strip it — capped at the
   *  newest PEEK_CANDIDATES so a dir with no usable head never costs more
   *  than a handful of bounded reads. Head-only (jsonlPeek.ts) rather than a
   *  full SessionManager replay: this only needs one field, not a state
   *  machine run over the whole transcript. */
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
        // A zero-byte file is a just-created placeholder (Claude Code writes
        // the file before its first record) with nothing to peek. Excluding
        // it here, before the PEEK_CANDIDATES cap below, matters: several can
        // sit among a dir's newest files at once and would otherwise occupy
        // every slot for nothing.
        if (stat.size === 0) { continue; }
        candidates.push({ file, mtimeMs: stat.mtimeMs });
      } catch { /* skip */ }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { file } of candidates.slice(0, PEEK_CANDIDATES)) {
      const cwd = await peekCwd(path.join(wsPath, file));
      if (cwd) { return cwd; }
    }
    return null;
  }

  /** Poll active sibling sessions (shared loop in sessionPolling.ts). */
  async poll(): Promise<boolean> {
    if (this.inert) { return false; }
    if (!siblingDiscoveryWanted()) { return false; }
    let changed = false;
    const now = Date.now();
    const ageGate = ageGateMsFor('worktrees');

    const cache = readSettings().discovery.replayCache ? this.replayCache : undefined;
    if (await pollTrackedSessions(this.sessions, now,
      (_sessionId, lastActivityMs) => now - lastActivityMs <= ageGate,
      cache ? (session, pollNow) => offerSessionToReplayCache(session, pollNow, cache) : undefined)) {
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

  /** Startup-timing instrumentation: session/sibling-worktree counts and
   *  total bytes read across every tracked sibling session, for the
   *  `[startup]` log line. */
  getScanStats(): { sessions: number; siblings: number; bytes: number; hydrated: number } {
    return {
      sessions: this.sessions.size, siblings: this.siblingKeys.size, bytes: sumBytesRead(this.sessions.values()),
      hydrated: this.replayCacheStats.hydrated,
    };
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
