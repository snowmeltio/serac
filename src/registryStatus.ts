import type { LiveProcess } from './processRegistry.js';
import { deriveRegistryStatus, type RegistryVerdict } from './registryShadow.js';
import { verifyClaudeProcess, registryStartMs } from './processIdentity.js';

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

/** Is this registry entry's pid still the Claude process that wrote it?
 *  `kill(pid, 0)` alone can't tell: a `kill -9`'d session leaves its file
 *  behind, and a reused pid would then pin the card on that entry's last
 *  status forever, with inference vetoed. 'bad' drops the entry. */
export type VerifyProcess = (p: LiveProcess) => Promise<'ok' | 'bad'>;

const defaultVerify: VerifyProcess = async (p) => {
  const id = await verifyClaudeProcess(p.pid, registryStartMs(p));
  return id.kind === 'not-claude' || id.kind === 'start-mismatch' ? 'bad' : 'ok';
};

/** Identity results kept (pid+start → verdict); cleared wholesale past this. */
const IDENTITY_CACHE_MAX = 512;

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
  verify: VerifyProcess = defaultVerify,
): RegistryStatusFeed {
  const held = new Map<string, { verdict: RegistryStatusVerdict; at: number }>();
  /** pid:start → identity. Absent = not asked yet; 'pending' = trusted until
   *  ps answers (the next sync then sees the result). */
  const identity = new Map<string, 'ok' | 'bad' | 'pending'>();

  function trusted(p: LiveProcess): boolean {
    const key = `${p.pid}:${registryStartMs(p) ?? '?'}`;
    const known = identity.get(key);
    if (known === 'bad') { return false; }
    if (known === undefined) {
      if (identity.size >= IDENTITY_CACHE_MAX) { identity.clear(); }
      identity.set(key, 'pending');
      verify(p).then(r => { identity.set(key, r); }, () => { identity.set(key, 'ok'); });
    }
    return true;
  }

  function verdictFor(sessionId: string): RegistryStatusVerdict | null {
    if (!enabled() || !registry.isActive()) { held.delete(sessionId); return null; }
    const clean = registry.isScanClean();
    const procs = registry.getProcessesForSession(sessionId).filter(trusted);
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
