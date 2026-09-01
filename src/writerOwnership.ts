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
  /** The claude process's parent pid at resolution time. When `ownWindow` is
   *  false this is (usually) the OWNING window's Extension Host pid — the
   *  address a cross-window handoff needs. It shares this entry with the
   *  verdict so the startedAt pid-reuse guard covers both. */
  ownerPid: number;
  /** The LiveProcess's `startedAt` this verdict was resolved against — see
   *  refresh()'s re-resolve check below. */
  startedAt: number | null;
  /** When this verdict was resolved (Date.now()) — see the non-own TTL in
   *  needsResolution(). */
  resolvedAt: number;
}

/** How long a NON-own verdict may stand before it is re-resolved. A verdict
 *  is a snapshot of the writer's parentage, and for an external process that
 *  parentage goes stale in one important way: the owning window dies while
 *  the writer survives, leaving `ownerPid` pointing at a dead Extension Host
 *  — exactly the address the cross-window handoff would target, so the click
 *  offers a switch to a window that no longer exists. Re-resolving refreshes
 *  the address (post-orphaning it is the new parent, launchd's pid 1, which
 *  fails isExtensionHostPid → not addressable → no unfulfillable offer).
 *
 *  Deliberately NOT a "clear the mark" mechanism: a surviving orphan still
 *  resolves not-this-window, so it stays 'external' — correct, it is not this
 *  window's writer, and mapping orphans to unowned was red-teamed and dropped
 *  (2026-08-26: it would clear the open gate for a still-running writer).
 *  Own-window verdicts never expire: this window's pid cannot stop being the
 *  parent while both live, and if THIS window dies the cache dies with it.
 *  External verdicts are rare (RC-hosted sdk-cli writers never enter the
 *  cache since v1.22.2), so the recurring `ps` cost is one call per external
 *  writer per minute. */
export const NON_OWN_VERDICT_TTL_MS = 60_000;

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
    if (entry.startedAt !== p.startedAt) { return true; }
    // Same process, but a non-own verdict ages: its ownerPid may now name a
    // dead window (see NON_OWN_VERDICT_TTL_MS). Re-resolve past the TTL.
    return !entry.ownWindow && Date.now() - entry.resolvedAt > NON_OWN_VERDICT_TTL_MS;
  }

  private async resolveAll(pending: readonly LiveProcess[]): Promise<void> {
    await Promise.all(pending.map(async p => {
      const ppid = await resolveParentPid(p.pid);
      if (ppid !== null) {
        this.cache.set(p.pid, { ownWindow: ppid === process.pid, ownerPid: ppid, startedAt: p.startedAt, resolvedAt: Date.now() });
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

  /** The parent pid recorded when `pid`'s ownership was resolved — for a
   *  confirmed-external process, the owning window's Extension Host pid.
   *  undefined when unresolved, same tri-state discipline as getInfo(). */
  getOwnerPid(pid: number): number | undefined {
    return this.cache.get(pid)?.ownerPid;
  }

  dispose(): void {
    this.cache.clear();
    this.queue = Promise.resolve();
  }
}

/** Session-level ownership verdict, aggregated across every live process
 *  registered under one session id. `'own'` — this window holds the only
 *  confirmed process(es); `'external'` — another window does; `'dual'` — BOTH
 *  at once: two live interactive processes appending the same JSONL, the
 *  exact hazard the externalWriterBlock feature exists to flag; `undefined`
 *  — nothing confirmed either way (treat as "don't flag"). */
export type WriterAggregate = 'own' | 'external' | 'dual' | undefined;

/** Aggregates per-process ownership verdicts (WriterOwnership.getInfo, one
 *  per live process registered under a session id — usually one, but two can
 *  coexist) into a single verdict for that session.
 *
 *  A confirmed own-window process alongside a confirmed-external one is
 *  `'dual'` — the two-windows-one-JSONL hazard, surfaced in BOTH windows so
 *  either can resolve it. When no external process coexists, a confirmed
 *  own-window process clears the session to `'own'`: a session only THIS
 *  window is running is never "elsewhere". (`'dual'` deliberately does NOT
 *  fall back to `'external'` anywhere downstream — v1.18.2's ping-pong bug
 *  class, where both windows offer a handoff to each other and a consumed
 *  focus hint bounces indefinitely, only existed because dual used to
 *  classify as external.) With no own-window process, any one
 *  confirmed-external flags `'external'`; a mix of only `undefined`s, or an
 *  empty list, falls back to `undefined`, matching getInfo()'s own tri-state
 *  contract. */
export function aggregateWriterOwnership(verdicts: readonly (boolean | undefined)[]): WriterAggregate {
  const own = verdicts.some(v => v === false);
  const external = verdicts.some(v => v === true);
  if (own && external) { return 'dual'; }
  if (own) { return 'own'; }
  if (external) { return 'external'; }
  return undefined;
}

/**
 * Resolve `pid`'s parent pid via `ps`. Every VS Code window runs its
 * extensions in one shared Extension Host OS process, and a `claude` process
 * opened via the claude-vscode editor integration is spawned as a direct
 * child of that same process — so the parent pid distinguishes "this window
 * already owns this session" (ppid === process.pid) from "a different VS Code
 * window/instance is driving it", without inspecting Claude account/profile
 * identity at all. For a confirmed-external process the ppid is the owning
 * window's Extension Host pid — the address a cross-window handoff targets.
 *
 * Returns the parent pid, or `null` (ps failed/timed out/unparseable —
 * unknown, treated conservatively as "don't flag").
 *
 * Known limitation: a session started via a plain terminal command within
 * this same window is a child of a shell process, not the Extension Host
 * directly, so it reads as external here. Accepted gap — the shell parent
 * fails isExtensionHostPid(), so it is never treated as an addressable
 * window either.
 */
export function resolveParentPid(pid: number): Promise<number | null> {
  return execPs('ppid=', pid).then(stdout => {
    if (stdout === null) { return null; }
    const ppid = parseInt(stdout.trim(), 10);
    return isNaN(ppid) || ppid <= 0 ? null : ppid;
  });
}

/** One ps field for one pid — the single home of the invocation contract
 *  (timeout, encoding, error/empty-to-null mapping) shared by both public
 *  probes above/below. */
function execPs(field: string, pid: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile('ps', ['-o', field, '-p', String(pid)], { timeout: PS_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => {
        resolve(err || !stdout || !stdout.trim() ? null : stdout);
      });
  });
}

/** Does this `ps -o args=` line look like an editor Extension Host process?
 *  The Extension Host is an Electron utility process of sub-type
 *  node.mojom.NodeService — on macOS it also carries the "Code Helper
 *  (Plugin)" helper-bundle name. A shell (`-zsh`, `/bin/bash`) or any other
 *  ancestor matches neither. Deliberately permissive across VS Code, Cursor,
 *  and Windsurf: every Electron editor uses the same utility-process argv
 *  shape. A false positive here is benign — an addressed focus hint written
 *  to a non-Serac pid is simply never consumed and gets swept. */
export function classifyProcessArgs(argsLine: string): 'extension-host' | 'other' {
  if (argsLine.includes('utility-sub-type=node.mojom.NodeService')) { return 'extension-host'; }
  if (argsLine.includes('Code Helper (Plugin)')) { return 'extension-host'; }
  return 'other';
}

/** Is `pid` plausibly a VS Code Extension Host process? Guards the swap path:
 *  an addressed focus hint is only written for an owner pid that looks like a
 *  window's Extension Host, never for a shell (the terminal-started
 *  false-positive case). Returns `null` when it cannot be determined (ps
 *  failed, or a platform without ps) — callers treat null as not
 *  addressable. */
export function isExtensionHostPid(pid: number): Promise<boolean | null> {
  if (process.platform === 'win32') { return Promise.resolve(null); }
  return execPs('args=', pid).then(stdout =>
    stdout === null ? null : classifyProcessArgs(stdout) === 'extension-host');
}
