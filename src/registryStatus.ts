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
  /** The same reading with the flag off too: what Claude Code says the
   *  process is doing, for inference's own backstops. Identity-checked like
   *  verdict(), so the first call for a process may be null while ps runs. */
  activity?(): RegistryStatusVerdict | null;
}

/** The slice of ProcessRegistry the feed reads. */
export interface StatusRegistry {
  isActive(): boolean;
  isScanClean(): boolean;
  getProcessesForSession(sessionId: string): LiveProcess[];
  /** Every live process from the latest scan (a new array per scan). */
  getLiveProcesses(): LiveProcess[];
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


export interface RegistryStatusFeed {
  verdictFor(sessionId: string): RegistryStatusVerdict | null;
  /** verdictFor without the flag gate. */
  activityFor(sessionId: string): RegistryStatusVerdict | null;
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
  /** pid:start → identity, for processes in the latest scan only. Absent =
   *  not asked yet; 'pending' = ps is running, and the entry gives no verdict
   *  until it answers (the next sync, at most a poll later). A process that
   *  drops out of a scan is forgotten, so a pid that dies and comes back
   *  (reused by another program, under a leftover file) is checked again. */
  const identity = new Map<string, 'ok' | 'bad' | 'pending'>();
  let scanSeen: LiveProcess[] | null = null;
  const keyOf = (p: LiveProcess) => `${p.pid}:${registryStartMs(p) ?? '?'}`;

  function pruneToLatestScan(): void {
    const live = registry.getLiveProcesses();
    if (live === scanSeen) { return; }
    scanSeen = live;
    const present = new Set(live.map(keyOf));
    for (const key of identity.keys()) {
      if (!present.has(key)) { identity.delete(key); }
    }
  }

  function trusted(p: LiveProcess): boolean {
    const key = keyOf(p);
    const known = identity.get(key);
    if (known === undefined) {
      identity.set(key, 'pending');
      verify(p).then(r => { identity.set(key, r); }, () => { identity.set(key, 'ok'); });
      return false;
    }
    return known === 'ok';
  }

  function verdictFor(sessionId: string): RegistryStatusVerdict | null {
    return enabled() ? activityFor(sessionId) : null;
  }

  function activityFor(sessionId: string): RegistryStatusVerdict | null {
    if (!registry.isActive()) { held.delete(sessionId); return null; }
    pruneToLatestScan();
    const clean = registry.isScanClean();
    const procs = registry.getProcessesForSession(sessionId).filter(trusted);
    if (clean && procs.length === 0) {
      // Nothing trusted: absent, or still being identity-checked. Either way
      // inference decides; a held verdict (from before a recheck) carries on.
      const last = held.get(sessionId);
      if (last && now() - last.at < REGISTRY_VERDICT_HOLD_MS && registry.getProcessesForSession(sessionId).length > 0) { return last.verdict; }
      held.delete(sessionId);
      return null;
    }
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
    activityFor,
    enabled,
    probeFor: (sessionId: string) => ({
      enabled,
      verdict: () => verdictFor(sessionId),
      activity: () => activityFor(sessionId),
    }),
  };
}
