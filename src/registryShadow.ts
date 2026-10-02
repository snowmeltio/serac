import * as fs from 'fs';
import type { LiveProcess, RegistryStatus } from './processRegistry.js';
import type { SessionStatus } from './types.js';

/**
 * Registry status in shadow mode. Claude Code 2.1.269+ writes its own turn
 * state (`status`, `waitingFor`, `statusUpdatedAt`) into every live process's
 * `~/.claude/sessions/<pid>.json`. This module derives the status the registry
 * implies for a session and compares it against the status Serac infers from
 * the JSONL, logging each disagreement as an episode to the `[status]` trace.
 * Nothing here feeds a card: it measures how far inference and the registry
 * diverge before the registry is allowed to drive status.
 * See spike/manifest-audit-2026-10-01/REPORT.md section 4 (lane B).
 */

/** What the registry implies for one session. */
export interface RegistryVerdict {
  status: SessionStatus;
  /** The registry state behind it: the most urgent live status, or `absent`
   *  when no live process backs the session. */
  raw: RegistryStatus | 'absent';
  waitingFor: string | null;
}

const URGENCY: Record<RegistryStatus, number> = { idle: 0, busy: 1, waiting: 2 };
const MAPPED: Record<RegistryStatus, SessionStatus> = { idle: 'done', busy: 'running', waiting: 'waiting' };

/** Map a session's live registry entries to a status: no live entry → done;
 *  otherwise the most urgent of waiting > busy > idle across its processes,
 *  as the Claude Code extension does. Null (no verdict) when the scan was
 *  degraded, or when every live entry lacks `status` (a pre-2.1.269 writer,
 *  or an entry in its first ~0.4 s). */
export function deriveRegistryStatus(procs: readonly LiveProcess[], scanClean: boolean): RegistryVerdict | null {
  if (procs.length === 0) {
    return scanClean ? { status: 'done', raw: 'absent', waitingFor: null } : null;
  }
  let worst: { status: RegistryStatus; waitingFor: string | null } | null = null;
  for (const p of procs) {
    if (!p.status) { continue; }
    if (!worst || URGENCY[p.status] > URGENCY[worst.status]) {
      worst = { status: p.status, waitingFor: p.waitingFor ?? null };
    }
  }
  if (!worst) { return null; }
  return {
    status: MAPPED[worst.status],
    raw: worst.status,
    waitingFor: worst.status === 'waiting' ? worst.waitingFor : null,
  };
}

/** A disagreement episode still open for one session. */
interface Episode {
  serac: SessionStatus;
  registry: RegistryVerdict;
  since: number;
  flagged: boolean;
}

interface ShadowEntry {
  /** Last non-null verdict, for registry-side transition lines. */
  verdict: RegistryVerdict | null;
  episode: Episode | null;
}

/** An open episode is reported once it outlasts this, so one that never
 *  closes (a stuck card, busy-after-turn-end during a workflow) still shows. */
export const SHADOW_LONG_EPISODE_MS = 10_000;

function label(v: RegistryVerdict): string {
  return v.waitingFor ? `${v.status}(${v.raw}: ${v.waitingFor})` : `${v.status}(${v.raw})`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Per-session comparison state. `observe()` takes Serac's current status for
 * every tracked session and a verdict lookup, and returns the lines to log
 * (all at info):
 * - `registry A→B` when the registry's mapped status changes (running↔done
 *   included; first sight of a session logs nothing).
 * - `shadow serac=X registry=Y for Ns` when a disagreement episode closes:
 *   the two agree again, either side moves to a different disagreement, or
 *   Serac stops tracking the session.
 * - `shadow ... open Ns` once, when an episode outlasts SHADOW_LONG_EPISODE_MS.
 * A null verdict (no evidence) leaves an open episode as it is.
 */
export function createRegistryShadow() {
  const entries = new Map<string, ShadowEntry>();

  function closeEpisode(id8: string, ep: Episode, now: number, why: string, out: string[]): void {
    out.push(`[status] ${id8} shadow serac=${ep.serac} registry=${label(ep.registry)} for ${seconds(now - ep.since)}${why}`);
  }

  function observe(
    serac: ReadonlyMap<string, SessionStatus>,
    verdictFor: (sessionId: string) => RegistryVerdict | null,
    now: number,
  ): string[] {
    const out: string[] = [];
    for (const [sessionId, status] of serac) {
      const id8 = sessionId.slice(0, 8);
      const verdict = verdictFor(sessionId);
      let entry = entries.get(sessionId);
      if (!entry) {
        entry = { verdict: null, episode: null };
        entries.set(sessionId, entry);
      }
      if (!verdict) { continue; }

      const prev = entry.verdict;
      if (prev && prev.status !== verdict.status) {
        out.push(`[status] ${id8} registry ${label(prev)}→${label(verdict)}`);
      }
      entry.verdict = verdict;

      const ep = entry.episode;
      if (verdict.status === status) {
        if (ep) {
          closeEpisode(id8, ep, now, '', out);
          entry.episode = null;
        }
        continue;
      }
      if (ep && ep.serac === status && ep.registry.status === verdict.status) {
        ep.registry = verdict;
        if (!ep.flagged && now - ep.since >= SHADOW_LONG_EPISODE_MS) {
          ep.flagged = true;
          out.push(`[status] ${id8} shadow serac=${ep.serac} registry=${label(verdict)} open ${seconds(now - ep.since)}`);
        }
        continue;
      }
      if (ep) { closeEpisode(id8, ep, now, ` (now serac=${status} registry=${verdict.status})`, out); }
      entry.episode = { serac: status, registry: verdict, since: now, flagged: false };
    }

    for (const [sessionId, entry] of entries) {
      if (serac.has(sessionId)) { continue; }
      if (entry.episode) { closeEpisode(sessionId.slice(0, 8), entry.episode, now, ' (untracked)', out); }
      entries.delete(sessionId);
    }
    return out;
  }

  return { observe };
}

export type RegistryShadow = ReturnType<typeof createRegistryShadow>;

/** Debounce for registry file events. A turn transition rewrites one file in
 *  place; a burst (several processes changing at once) collapses to a scan. */
export const REGISTRY_WATCH_DEBOUNCE_MS = 150;

/** Watch the registry directory and call `onChange` once per burst of file
 *  events. Returns a disposer, or null when the directory can't be watched
 *  (absent, or `fs.watch` unavailable); the caller retries later. `onError`
 *  fires if a live watcher dies, after which the caller should re-arm. */
export function watchRegistryDir(
  dir: string,
  onChange: () => void,
  onError: (err: unknown) => void,
  debounceMs = REGISTRY_WATCH_DEBOUNCE_MS,
): (() => void) | null {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && !String(filename).endsWith('.json')) { return; }
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(() => { timer = undefined; onChange(); }, debounceMs);
    });
  } catch {
    return null;
  }
  const dispose = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    watcher.close();
  };
  watcher.on('error', (err) => { dispose(); onError(err); });
  return dispose;
}
