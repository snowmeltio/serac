/**
 * Shared session scan/poll machinery for the cross-workspace managers
 * (ForeignWorkspaceManager, SiblingWorktreeManager). Both track a
 * `compositeId (workspaceKey/sessionId) → SessionManager` map fed by a
 * dir-walk and advanced by a dormant/active poll loop; before this module the
 * pipeline existed twice, line for line, and fixes were hand-copied between
 * the copies (the sweepBackgroundWork parity fix landed that way).
 *
 * Per-manager differences are injected: the visibility window (foreign is
 * registry-aware, sibling is a plain age gate) and manager construction
 * (sibling decorates with worktree origin). The loop is deliberately serial —
 * matching prior behaviour; teams/local batch at UPDATE_BATCH_SIZE for
 * FD-budget reasons but foreign/sibling populations are small. If batching is
 * ever needed it now has exactly one place to land.
 *
 * sessionDiscovery.pollInner and teamDiscovery.poll intentionally do NOT use
 * this: they carry extra logic (woken promotion, batched updates, shell sweep
 * ordering) that this shared loop does not model.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import { isHydratable, sameStamp, type ReplayCacheStore } from './replayCache.js';
import type { CachedSessionState, FileStamp } from './types.js';

/** The slice of SessionManager the poll loop touches — structural so tests
 *  can drive the loop without filesystem fixtures. The replay-cache-era
 *  additions (getFilePath/getReadStamp/exportCachedState/isHydrated) are
 *  exercised only via offerSessionToReplayCache() and the hydration branch of
 *  trackJsonlSessions() below — everything else in this module still only
 *  needs the original members. */
export interface PollableSession {
  getStatus(): string;
  getLastActivity(): Date;
  checkMtime(): Promise<boolean>;
  update(): Promise<boolean>;
  demoteIfStale(thresholdMs: number): boolean;
  sweepBackgroundWork(now: number): boolean;
  dispose(): void;
  getFilePath(): string;
  getReadStamp(): FileStamp & { caughtUp: boolean };
  exportCachedState(now?: number): CachedSessionState | null;
  isHydrated(): boolean;
}

/** Shared dormant-session replay-cache population, used by both
 *  SessionDiscovery's own local-scan dormant loop (pollInner, next to
 *  sweepBackgroundWork) and pollTrackedSessions' dormant branch below (via
 *  the optional `offer` parameter) — one eligibility/write decision rather
 *  than two hand-copied ones. Refuses when the session is itself hydrated
 *  (nothing new to capture — see SessionManager.isHydrated()) or
 *  exportCachedState() refuses (see its own eligibility doc), and skips the
 *  write when the cache already holds an identical {size, mtimeMs} stamp for
 *  this file (no benefit to re-writing the same bytes). The `serac.discovery.
 *  replayCache` kill switch is checked by the CALLER (SessionDiscovery,
 *  ForeignWorkspaceManager, SiblingWorktreeManager) before this is ever
 *  reached — this module deliberately never imports settings.ts (see
 *  replayCache.ts's own note on the vscode-mock blast radius that would
 *  otherwise hit every test file importing this one). */
export function offerSessionToReplayCache(
  session: PollableSession,
  now: number,
  replayCache: ReplayCacheStore,
): void {
  if (session.isHydrated()) { return; }
  const state = session.exportCachedState(now);
  if (!state) { return; }
  const stamp = session.getReadStamp();
  const filePath = session.getFilePath();
  const existing = replayCache.get(filePath);
  if (existing && sameStamp(existing, stamp)) { return; }
  replayCache.put(filePath, { size: stamp.size, mtimeMs: stamp.mtimeMs, cachedAt: now, state });
}

/** Visibility predicate: is the session still inside its window? Foreign
 *  binds this to the registry-aware withinWindow; sibling to a plain age gate. */
export type WithinWindow = (sessionId: string, lastActivityMs: number) => boolean;

/** running→done demotion threshold shared by the dormant/active poll loop. */
const DEMOTE_STALE_MS = 30_000;

/** Default every-Nth-cycle full-rescan cadence, uniform across managers. */
const RESCAN_INTERVAL = 10;

/** Every-Nth-cycle rescan gate shared by the discovery managers. The optional
 *  isActive predicate passes the gate every cycle while live work is in
 *  flight, so teams/workflows pick up new artifacts quickly; managers whose
 *  rescan walks the entire projectsDir (foreign, sibling) deliberately omit
 *  it — the walk is too costly for the 500ms fast cadence. */
export function makeRescanGate(isActive?: () => boolean, interval: number = RESCAN_INTERVAL): () => boolean {
  let counter = 0;
  return () => {
    if (isActive?.()) { return true; }
    counter++;
    if (counter >= interval) {
      counter = 0;
      return true;
    }
    return false;
  };
}

/** Session id for a `.jsonl` dirent, or null for anything else. The
 *  filter-and-strip pair this replaces appeared at five call sites. */
export function jsonlSessionId(file: string): string | null {
  return file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : null;
}

/** Total bytes read across a set of sessions — the `[startup]` log lines'
 *  shared MB-counting step (local, sibling, foreign all sum the same way). */
export function sumBytesRead(sessions: Iterable<{ getBytesRead(): number }>): number {
  let total = 0;
  for (const session of sessions) { total += session.getBytesRead(); }
  return total;
}

/**
 * One poll pass over a composite-keyed session map.
 *
 * Active (running/waiting) sessions are updated and demoted if stale — never
 * window-evicted (the never-downgrade rule: demoteIfStale resolves a
 * genuinely dead one first, then the dormant branch evicts it on a later
 * cycle). Dormant sessions are evicted once outside the window, otherwise
 * cheaply mtime-checked and swept for stuck background-shell badges
 * (freshness parity with dormant local sessions).
 *
 * Returns true when anything changed (data, eviction, demotion, sweep).
 */
export async function pollTrackedSessions(
  sessions: Map<string, PollableSession>,
  now: number,
  withinWindow: WithinWindow,
  /** Replay-cache population hook (PR D), fired for every dormant session
   *  each cycle — mirrors the call site next to sweepBackgroundWork in
   *  SessionDiscovery.pollInner. Both cross-workspace managers pass
   *  `(session, pollNow) => offerSessionToReplayCache(session, pollNow, store)`
   *  when the cache is enabled and wired in; omitted entirely (not just a
   *  no-op closure) when the kill switch is off, so there is nothing to call. */
  offer?: (session: PollableSession, now: number) => void,
): Promise<boolean> {
  let changed = false;
  for (const [compositeId, session] of sessions) {
    const status = session.getStatus();
    if (status !== 'running' && status !== 'waiting') {
      const sessionId = compositeId.slice(compositeId.indexOf('/') + 1);
      if (!withinWindow(sessionId, session.getLastActivity().getTime())) {
        session.dispose();
        sessions.delete(compositeId);
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
      if (session.sweepBackgroundWork(now)) { changed = true; }
      offer?.(session, now);
      continue;
    }
    try {
      const hadData = await session.update();
      if (hadData) { changed = true; }
      if (!hadData && session.demoteIfStale(DEMOTE_STALE_MS)) {
        changed = true;
      }
    } catch { /* skip */ }
  }
  return changed;
}

/** Any tracked session currently running/waiting — feeds the adaptive
 *  fast-poll so an active card refreshes at the 500ms cadence. */
export function hasActiveTrackedSessions(sessions: Map<string, PollableSession>): boolean {
  for (const session of sessions.values()) {
    const status = session.getStatus();
    if (status === 'running' || status === 'waiting') { return true; }
  }
  return false;
}

export interface TrackJsonlOptions {
  /** Absolute path of the workspace directory being scanned. */
  wsPath: string;
  /** Sanitised workspace key (compositeId prefix). */
  workspaceKey: string;
  /** Dirents of wsPath (caller already has them from its own readdir). */
  files: string[];
  sessions: Map<string, SessionManager>;
  now: number;
  withinWindow: WithinWindow;
  /** Construct (and decorate — liveness probe, worktree origin) a manager for
   *  a candidate session. Called before the initial update(). */
  makeManager: (sessionId: string, filePath: string) => SessionManager;
  /** Initial-update failure sink (manager is kept; update retries next poll). */
  warn: (compositeId: string, err: unknown) => void;
  /** Replay-cache wiring (PR D). All three of `replayCache`/`makeHydrated`
   *  travel together — a caller omits them entirely (rather than passing a
   *  disabled store) when `serac.discovery.replayCache` is off, so hydration
   *  is a genuine no-op, not a runtime branch that happens to do nothing.
   *  `livenessOf` is optional even when the other two are set: a manager with
   *  no registry probe wired (e.g. a context that never calls
   *  setLivenessProbeFactory) just passes `undefined` liveness to
   *  isHydratable(), which treats "unknown" as eligible — the same tri-state
   *  contract SessionManager's own livenessProbe uses everywhere else. */
  replayCache?: ReplayCacheStore;
  /** Registry liveness for a candidate session id — must answer the same
   *  question SessionManager's own livenessProbe does (true = confirmed
   *  live, false = confirmed not, null/undefined = unknown), since
   *  isHydratable() refuses only on a confirmed `true`. */
  livenessOf?: (sessionId: string) => boolean | null;
  /** Construct an already-hydrated manager (SessionManager.fromCache() plus
   *  whatever decoration makeManager would otherwise apply — worktree
   *  origin, probes) from a cache entry already confirmed isHydratable()
   *  against the stat this function already took. */
  makeHydrated?: (sessionId: string, filePath: string, state: CachedSessionState, stamp: FileStamp) => SessionManager;
  /** Startup instrumentation only (the `[replay-cache]` summary line): fired
   *  once per newly tracked session, hydrated or not. */
  onTracked?: (hydrated: boolean) => void;
}

/**
 * Pick up untracked JSONL sessions in one workspace directory: stat, age-gate
 * on file mtime, construct, initial update, then re-gate on real activity.
 * The re-gate matters: Claude Code backfills `ai-title` records to old
 * sessions, bumping mtime without real activity — without it, scan() keeps
 * re-adding what poll() evicts and the workspace flickers.
 *
 * Returns true when any session was added.
 */
export async function trackJsonlSessions(opts: TrackJsonlOptions): Promise<boolean> {
  let changed = false;
  for (const file of opts.files) {
    const sessionId = jsonlSessionId(file);
    if (!sessionId) { continue; }
    const compositeId = `${opts.workspaceKey}/${sessionId}`;
    if (opts.sessions.has(compositeId)) { continue; }

    const filePath = path.join(opts.wsPath, file);
    let fstat: fs.Stats;
    try {
      fstat = await fs.promises.stat(filePath);
      if (!opts.withinWindow(sessionId, fstat.mtimeMs)) { continue; }
      // An empty JSONL has no session in it yet. SessionManager's initial
      // state is `done` with lastActivity = now, so tracking one manufactures
      // a permanent done-but-unseen count that no acknowledgement can clear.
      // Skip it; the next scan picks it up once Claude Code writes a record.
      // (Only foreign/sibling discovery comes through here — the local scan
      // has its own loop — so the one-scan delay costs nothing visible.)
      if (fstat.size === 0) { continue; }
    } catch { continue; }

    // Replay-cache hydration: reuse the stat just taken above rather than
    // re-statting. Only attempted when the caller wired both replayCache AND
    // makeHydrated — see TrackJsonlOptions' doc comment.
    let manager: SessionManager | undefined;
    let hydrated = false;
    if (opts.replayCache && opts.makeHydrated) {
      const entry = opts.replayCache.get(filePath);
      if (entry && isHydratable(entry, fstat, opts.livenessOf?.(sessionId))) {
        manager = opts.makeHydrated(sessionId, filePath, entry.state, entry);
        hydrated = true;
      }
    }
    if (!manager) {
      manager = opts.makeManager(sessionId, filePath);
      try {
        await manager.update();
      } catch (err) {
        opts.warn(compositeId, err);
      }
    }
    // The re-gate below matters just as much for a hydrated manager as a
    // freshly-replayed one: hydrate() restores the cached lastActivity onto
    // the manager, so this reads the SAME (restored) timestamp a full replay
    // would have produced — a hydrated session that has actually aged out of
    // the window since it was cached is still evicted here.
    if (!opts.withinWindow(sessionId, manager.getLastActivity().getTime())) {
      manager.dispose();
      continue;
    }
    opts.sessions.set(compositeId, manager);
    changed = true;
    opts.onTracked?.(hydrated);
  }
  return changed;
}
