import type { LiveProcess } from './processRegistry.js';
import { deriveRegistryStatus, type RegistryVerdict } from './registryShadow.js';

/**
 * Registry status as the source of truth (serac.experimental.registryStatus).
 * Claude Code 2.1.269+ writes its own turn state into each live process's
 * `~/.claude/sessions/<pid>.json`; the shadow log (registryShadow.ts) showed it
 * right in every disagreement with inference that was checked against the
 * JSONL. This feed turns it into a per-session verdict a SessionManager obeys.
 *
 * A verdict is never "absent → done": with no live entry the feed returns
 * null and inference (with the registry death gate) keeps the session. Null
 * also covers a pre-2.1.269 writer, and the flag being off.
 */

/** A verdict with the moment the registry last changed that status. */
export interface RegistryStatusVerdict extends RegistryVerdict {
  /** Max `statusUpdatedAt` across the entries carrying the winning status;
   *  null when the writer doesn't stamp it. */
  since: number | null;
}

/** What a SessionManager asks of the feed. */
export interface RegistryStatusProbe {
  /** The flag is on (inference hands over whenever a verdict exists). */
  enabled(): boolean;
  /** The registry's verdict for this session now, or null to let inference
   *  decide. */
  verdict(): RegistryStatusVerdict | null;
}

/** The slice of ProcessRegistry the feed reads. */
export interface StatusRegistry {
  isActive(): boolean;
  isScanClean(): boolean;
  getProcessesForSession(sessionId: string): LiveProcess[];
}

/** How long a session keeps its last verdict through a gap: an unclean scan
 *  (a torn read mid-write) or an entry with no `status` yet (born ~0.4 s
 *  before its first status write). Longer than either, shorter than any real
 *  turn the card should follow. */
export const REGISTRY_VERDICT_HOLD_MS = 3_000;

export interface RegistryStatusFeed {
  verdictFor(sessionId: string): RegistryStatusVerdict | null;
  enabled(): boolean;
  /** A probe bound to one session, for SessionManagerOptions. */
  probeFor(sessionId: string): RegistryStatusProbe;
}

export function createRegistryStatusFeed(
  registry: StatusRegistry,
  enabled: () => boolean,
  now: () => number = Date.now,
): RegistryStatusFeed {
  const held = new Map<string, { verdict: RegistryStatusVerdict; at: number }>();

  function verdictFor(sessionId: string): RegistryStatusVerdict | null {
    if (!enabled() || !registry.isActive()) { held.delete(sessionId); return null; }
    const clean = registry.isScanClean();
    const procs = registry.getProcessesForSession(sessionId);
    if (clean && procs.length === 0) { held.delete(sessionId); return null; }
    const fresh = clean ? deriveRegistryStatus(procs, true) : null;
    if (fresh) {
      let since: number | null = null;
      for (const p of procs) {
        if (p.status === fresh.raw && typeof p.statusUpdatedAt === 'number') {
          since = since === null ? p.statusUpdatedAt : Math.max(since, p.statusUpdatedAt);
        }
      }
      const verdict: RegistryStatusVerdict = { ...fresh, since };
      held.set(sessionId, { verdict, at: now() });
      return verdict;
    }
    const last = held.get(sessionId);
    if (last && now() - last.at < REGISTRY_VERDICT_HOLD_MS) { return last.verdict; }
    held.delete(sessionId);
    return null;
  }

  return {
    verdictFor,
    enabled,
    probeFor: (sessionId: string) => ({ enabled, verdict: () => verdictFor(sessionId) }),
  };
}
