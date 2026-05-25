/**
 * CompactBoundaryTracker — owns "compaction is happening" signals for a session.
 *
 * JSONL variant fires on `system.subtype === 'compact_boundary'` records.
 * The hook variant (Phase 4) will fire on `SessionStart(source: "compact")`
 * events — confirmed in spike capture 2026-05-12 that `/compact` keeps
 * session_id and transcript_path stable and emits exactly this event.
 *
 * Effect on the host:
 *   - If status is not 'running', set it to running.
 *   - Append "Compacting context" to the activity line.
 *
 * State: `lastCompactAt` (ms) — populated for future use (panel display,
 * debouncing repeated compact events, hook/JSONL reconciliation). Current
 * production code does not consume it.
 */

import type { HookEventRouter } from '../hookEventRouter.js';

export interface CompactBoundaryTrackerHost {
  /** Compact boundary detected — host applies its side effects (status,
   *  activity line). Called once per onCompactBoundary() call. */
  onCompactDetected(): void;
}

export interface CompactBoundaryTracker {
  /** A compact boundary has been observed at `timestampMs`. */
  onCompactBoundary(timestampMs: number): void;
  /** Timestamp (ms) of the most recent compact boundary. 0 if never. */
  getLastCompactAt(): number;
  /** Stop the tracker. Idempotent. */
  dispose(): void;
}

export class JsonlDerivedCompactBoundaryTracker implements CompactBoundaryTracker {
  private lastCompactAt = 0;

  constructor(private readonly host: CompactBoundaryTrackerHost) {}

  onCompactBoundary(timestampMs: number): void {
    this.lastCompactAt = timestampMs;
    this.host.onCompactDetected();
  }

  getLastCompactAt(): number { return this.lastCompactAt; }

  dispose(): void { /* no resources */ }
}

/**
 * Hook-overlay variant. Composes a `JsonlDerivedCompactBoundaryTracker`
 * as the authoritative fallback and adds a `SessionStart(source: "compact")`
 * subscription as a fast path.
 *
 * Why compose: `/compact` reliably emits `SessionStart(source: "compact")`
 * (confirmed 2026-05-12 spike), but the JSONL `system.subtype === 'compact_boundary'`
 * record arrives via the existing onCompactBoundary call site in
 * SessionManager. Keeping both feeds the same fallback so lastCompactAt is
 * single-sourced and the host's onCompactDetected fires once per real
 * boundary regardless of which signal arrived first.
 *
 * Host idempotency: `onCompactDetected` already no-ops when status is
 * already 'running' (it only sets it on demand). Double-fire is harmless.
 */
class HookCompactBoundaryTracker implements CompactBoundaryTracker {
  private readonly fallback: JsonlDerivedCompactBoundaryTracker;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    host: CompactBoundaryTrackerHost,
    sessionId: string,
    router: HookEventRouter,
    now: () => number = Date.now,
  ) {
    this.fallback = new JsonlDerivedCompactBoundaryTracker(host);
    this.unsubscribe = router.register(sessionId, 'SessionStart', (event: unknown) => {
      if (this.disposed) { return; }
      if (typeof event !== 'object' || event === null) { return; }
      const source = (event as Record<string, unknown>).source;
      if (source !== 'compact') { return; }
      this.fallback.onCompactBoundary(now());
    });
  }

  onCompactBoundary(timestampMs: number): void { this.fallback.onCompactBoundary(timestampMs); }
  getLastCompactAt(): number { return this.fallback.getLastCompactAt(); }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.unsubscribe();
    this.fallback.dispose();
  }
}

export interface CompactBoundaryTrackerFactoryOptions {
  /** Hook router for the owning workspace. */
  hookRouter?: HookEventRouter;
  /** Session UUID. Required for hook subscription. */
  sessionId?: string;
}

/** Construct the variant appropriate for the current environment.
 *
 *  - hookRouter + sessionId → `HookCompactBoundaryTracker` (overlay)
 *  - otherwise → `JsonlDerivedCompactBoundaryTracker` */
export function makeCompactBoundaryTracker(
  host: CompactBoundaryTrackerHost,
  opts: CompactBoundaryTrackerFactoryOptions = {},
): CompactBoundaryTracker {
  if (opts.hookRouter && opts.sessionId) {
    return new HookCompactBoundaryTracker(host, opts.sessionId, opts.hookRouter);
  }
  return new JsonlDerivedCompactBoundaryTracker(host);
}
