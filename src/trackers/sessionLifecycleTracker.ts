/**
 * SessionLifecycleTracker — consumes `SessionEnd` and `PreCompact`.
 *
 * Two distinct roles:
 *   - `SessionEnd` → **enrichment**: records the end reason
 *     (clear/logout/prompt_input_exit/other). Never moves status.
 *   - `PreCompact` → **status-stabiliser**: opens a "compacting grace window".
 *     Compaction rewrites the JSONL (truncation → resetState → done) and is a
 *     silence gap (idle timer → done, confidence decays). PreCompact fires
 *     *before* that, so the host can hold `running`/high-confidence and suppress
 *     demotion until the `compact_boundary` (handled by CompactBoundaryTracker)
 *     or a safety timeout. This fixes the observed mid-compaction running→done
 *     flip. See ARCHITECTURE.md.
 *
 * Hook-only. There is no JSONL pre-compaction signal (the JSONL
 * `compact_boundary` arrives *after* the fact and is already handled elsewhere),
 * and no JSONL end-reason record, so the JSONL variant is a no-op.
 */

import type { HookEventRouter } from '../hookEventRouter.js';

export interface SessionLifecycleTrackerHost {
  /** SessionEnd observed — `reason` is the raw payload reason string. */
  onSessionEnd(reason: string): void;
  /** PreCompact observed — open the compacting grace window. `trigger` is
   *  "manual" | "auto" (or "" if absent). */
  onPreCompact(trigger: string): void;
}

export interface SessionLifecycleTracker {
  dispose(): void;
}

class JsonlDerivedSessionLifecycleTracker implements SessionLifecycleTracker {
  constructor(_host: SessionLifecycleTrackerHost) { /* no JSONL source */ }
  dispose(): void { /* no resources */ }
}

class HookSessionLifecycleTracker implements SessionLifecycleTracker {
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(
    host: SessionLifecycleTrackerHost,
    sessionId: string,
    router: HookEventRouter,
  ) {
    this.unsubscribers.push(router.register(sessionId, 'SessionEnd', (event: unknown) => {
      if (this.disposed) { return; }
      const e = asRecord(event);
      const reason = e && typeof e.reason === 'string' ? e.reason : 'other';
      host.onSessionEnd(reason);
    }));

    this.unsubscribers.push(router.register(sessionId, 'PreCompact', (event: unknown) => {
      if (this.disposed) { return; }
      const e = asRecord(event);
      const trigger = e && typeof e.trigger === 'string' ? e.trigger : '';
      host.onPreCompact(trigger);
    }));
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const u of this.unsubscribers) { u(); }
  }
}

function asRecord(event: unknown): Record<string, unknown> | null {
  if (typeof event !== 'object' || event === null) { return null; }
  return event as Record<string, unknown>;
}

export interface SessionLifecycleTrackerFactoryOptions {
  hookRouter?: HookEventRouter;
  sessionId?: string;
}

export function makeSessionLifecycleTracker(
  host: SessionLifecycleTrackerHost,
  opts: SessionLifecycleTrackerFactoryOptions = {},
): SessionLifecycleTracker {
  if (opts.hookRouter && opts.sessionId) {
    return new HookSessionLifecycleTracker(host, opts.sessionId, opts.hookRouter);
  }
  return new JsonlDerivedSessionLifecycleTracker(host);
}
