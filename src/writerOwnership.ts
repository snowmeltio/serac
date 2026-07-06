import { execFile } from 'child_process';
import type { LiveProcess } from './processRegistry.js';

const PS_TIMEOUT_MS = 2000;

/**
 * Tracks, for each currently-live registered Claude process
 * (`~/.claude/sessions/<pid>.json`), whether it is a child of THIS VS Code
 * window's own Extension Host process — i.e. whether this window itself
 * already owns the session, versus a different VS Code window/instance
 * driving it right now. Deliberately account-agnostic: two windows on the
 * very same Claude account are just as much a collision risk as two
 * different accounts, so nothing here looks at Claude account/profile
 * identity at all.
 *
 * `SessionManager.getSnapshot()` is synchronous and polled frequently, so the
 * `ps`-based resolution happens out-of-band in `refresh()` (called from the
 * same throttled poll loop as `ProcessRegistry`'s own rescans); `getInfo()` is
 * a plain synchronous read of the last-resolved value.
 */
interface CacheEntry {
  ownWindow: boolean;
  /** The LiveProcess's `startedAt` this verdict was resolved against — see
   *  refresh()'s re-resolve check below. */
  startedAt: number | null;
}

export class WriterOwnership {
  /** pid -> resolved verdict, tagged with the process's startedAt at
   *  resolution time. A bare pid key isn't enough on its own: if a process
   *  exits and the OS recycles its pid for an unrelated process before a scan
   *  ever observes the gap (ProcessRegistry's own docstring names this same
   *  caveat), a stale verdict for the old process would otherwise silently
   *  carry over to the new one. Tagging with startedAt and re-resolving on
   *  mismatch closes that gap without needing to detect the gap itself. */
  private cache = new Map<number, CacheEntry>();

  /** Serializes every cache-mutating call (refresh() from the poll loop, and
   *  resolveFor() from an on-demand isExternalWriterFresh() decision) against
   *  each other. Without this, two independent callers can genuinely run
   *  concurrently — refresh() used to have exactly one call site, gated by
   *  SessionDiscovery's own polling flag, but resolveFor() is invoked from an
   *  open/send decision at any time, with no such gate — and race on this
   *  shared Map: one call's prune step (built from ITS OWN liveProcesses
   *  snapshot) could delete an entry another call just resolved, moments
   *  before that other call reads it back. Chaining every call through one
   *  promise queue means at most one is ever mutating `cache` at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Resolve ownership for every currently-live pid not yet known (or whose
   *  cached verdict was resolved against a *different* startedAt — pid
   *  reuse), then drop entries for pids no longer live. Safe to call
   *  repeatedly — already resolved, still-current pids are skipped, so a
   *  steady-state refresh is a no-op. Serialized against every other
   *  cache-mutating call — see `queue`. */
  refresh(liveProcesses: readonly LiveProcess[]): Promise<void> {
    return this.enqueue(async () => {
      await this.resolveAll(liveProcesses.filter(p => this.needsResolution(p)));
      const livePids = new Set(liveProcesses.map(p => p.pid));
      for (const pid of this.cache.keys()) {
        if (!livePids.has(pid)) { this.cache.delete(pid); }
      }
    });
  }

  /** Resolve ownership for exactly these processes — no prune step. Used by
   *  an on-demand, latency-sensitive decision (isExternalWriterFresh) that
   *  must answer for one session's process(es) without paying to resolve (or
   *  risking pruning the cache entry of) every OTHER live process on the
   *  machine. Still serialized against refresh() via the shared queue. */
  resolveFor(processes: readonly LiveProcess[]): Promise<void> {
    return this.enqueue(async () => {
      await this.resolveAll(processes.filter(p => this.needsResolution(p)));
    });
  }

  private needsResolution(p: LiveProcess): boolean {
    const entry = this.cache.get(p.pid);
    if (!entry) { return true; }
    // A null startedAt (older client, or a degraded/malformed entry) proves
    // nothing about process identity across scans — `null !== null` would
    // otherwise read as "same process, cache hit" even across a genuine pid
    // recycle. Treat a null startedAt as "can't prove continuity" and always
    // re-resolve rather than trust the cache.
    if (p.startedAt === null) { return true; }
    return entry.startedAt !== p.startedAt;
  }

  private async resolveAll(pending: readonly LiveProcess[]): Promise<void> {
    await Promise.all(pending.map(async p => {
      const ownWindow = await isOwnWindowWriter(p.pid);
      if (ownWindow !== null) {
        this.cache.set(p.pid, { ownWindow, startedAt: p.startedAt });
        return;
      }
      // null = unknown (ps failed/timed out). If this pid had no prior entry,
      // leaving it unresolved (retry next call) is correct and harmless. But
      // if it HAD an entry that we just decided needed re-resolving (a
      // startedAt mismatch — pid reuse), that old entry belongs to a
      // DIFFERENT process and is now known-wrong, not just unconfirmed —
      // leaving it in place would silently hand out the previous process's
      // verdict as if it were current. Drop it so getInfo() reports
      // "unresolved" instead of a confident, wrong answer.
      const stale = this.cache.get(p.pid);
      if (stale && stale.startedAt !== p.startedAt) { this.cache.delete(p.pid); }
    }));
  }

  /** True when `pid` is confirmed to belong to a *different* VS Code window;
   *  undefined when unknown (not yet resolved, or ps couldn't determine it) —
   *  a consumer must treat undefined the same as "don't flag". */
  getInfo(pid: number): boolean | undefined {
    const entry = this.cache.get(pid);
    return entry === undefined ? undefined : !entry.ownWindow;
  }

  dispose(): void {
    this.cache.clear();
    this.queue = Promise.resolve();
  }
}

/** Aggregates per-process ownership verdicts (WriterOwnership.getInfo, one
 *  per live process registered under a session id — usually one, but two can
 *  coexist) into a single verdict for that session. Any one confirmed
 *  (`true`) is enough to flag the whole session — fail toward flagging, not
 *  away from it, when more than one live process shares a session id. Every
 *  process must be confirmed own-window (`false`) to clear it. Anything else
 *  (a mix including `undefined`, or an empty list) falls back to "don't
 *  flag", matching getInfo()'s own tri-state contract. */
export function aggregateWriterOwnership(verdicts: readonly (boolean | undefined)[]): boolean | undefined {
  if (verdicts.length === 0) { return undefined; }
  if (verdicts.some(v => v === true)) { return true; }
  if (verdicts.every(v => v === false)) { return false; }
  return undefined;
}

/**
 * Is `pid` a direct child of this window's own Extension Host process (i.e.
 * of `process.pid`)? Every VS Code window runs its extensions in one shared
 * Extension Host OS process, and a `claude` process opened via the
 * claude-vscode editor integration is spawned as a direct child of that same
 * process — so comparing parent pids distinguishes "this window already owns
 * this session" from "a different VS Code window/instance is driving it",
 * without inspecting Claude account/profile identity at all.
 *
 * Returns `true` (same window), `false` (confirmed a different window's
 * process), or `null` (ps failed/timed out/unparseable — unknown, treated
 * conservatively as "don't flag").
 *
 * Known limitation: a session started via a plain terminal command within
 * this same window is a child of a shell process, not the Extension Host
 * directly, so it would be misclassified as `false` here. Accepted gap —
 * see the plan this shipped under.
 */
export function isOwnWindowWriter(pid: number): Promise<boolean | null> {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => {
        if (err || !stdout) { resolve(null); return; }
        const ppid = parseInt(stdout.trim(), 10);
        if (isNaN(ppid) || ppid <= 0) { resolve(null); return; }
        resolve(ppid === process.pid);
      });
  });
}
