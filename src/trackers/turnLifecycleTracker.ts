/**
 * TurnLifecycleTracker — accelerates the `running → done` transition using the
 * `Stop` hook, which fires the instant the main agent finishes a turn.
 *
 * JSONL variant: a no-op. There is no JSONL "turn ended" record — `done` is
 * reached by SessionManager's idle timer (5s after the last record). So the
 * JSONL variant does nothing and `done` keeps coming from the idle path; the
 * hook merely gets there sooner when available.
 *
 * Hook variant: subscribes to `Stop`. On a genuine turn-end it calls
 * `host.onTurnEnded()`, which (at the SessionManager host edge) sets the
 * turn-close guard and marks the session done.
 *
 * Why the guard lives in the host, not here: `Stop` is NOT an order-free
 * accelerator. It fires `done`, but the turn's own trailing assistant record is
 * polled 0.5-2s later and would re-fire `running` via setRunning(). Suppressing
 * that requires coordinating setRunning + activeTools + the idle timer, which is
 * host state. This tracker only delivers the edge; the host enforces the rule.
 * See ARCHITECTURE.md "The `Stop` turn-close guard".
 *
 * `stop_hook_active: true` means a Stop *hook* forced a continuation — the turn
 * is still running, not ended — so those events are ignored here.
 */

import type { HookEventRouter } from '../hookEventRouter.js';

export interface TurnLifecycleTrackerHost {
  /** A genuine turn end was observed (Stop with stop_hook_active !== true).
   *  The host sets the turn-close guard and marks the session done. */
  onTurnEnded(): void;
}

export interface TurnLifecycleTracker {
  /** Stop the tracker. Idempotent. */
  dispose(): void;
}

/** JSONL variant: no-op. `done` is owned by SessionManager's idle timer. */
class JsonlDerivedTurnLifecycleTracker implements TurnLifecycleTracker {
  constructor(_host: TurnLifecycleTrackerHost) { /* no JSONL turn-end signal */ }
  dispose(): void { /* no resources */ }
}

/** Hook variant: fast-path `done` via the `Stop` hook. */
class HookTurnLifecycleTracker implements TurnLifecycleTracker {
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    host: TurnLifecycleTrackerHost,
    sessionId: string,
    router: HookEventRouter,
  ) {
    this.unsubscribe = router.register(sessionId, 'Stop', (event: unknown) => {
      if (this.disposed) { return; }
      if (typeof event !== 'object' || event === null) { return; }
      // A continuation-triggered Stop is not a turn end.
      if ((event as Record<string, unknown>).stop_hook_active === true) { return; }
      host.onTurnEnded();
    });
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.unsubscribe();
  }
}

export interface TurnLifecycleTrackerFactoryOptions {
  /** Hook router for the owning workspace. */
  hookRouter?: HookEventRouter;
  /** Session UUID. Required for hook subscription. */
  sessionId?: string;
}

/** Construct the variant appropriate for the current environment.
 *
 *  - hookRouter + sessionId → `HookTurnLifecycleTracker` (fast path)
 *  - otherwise → `JsonlDerivedTurnLifecycleTracker` (no-op; idle timer owns done) */
export function makeTurnLifecycleTracker(
  host: TurnLifecycleTrackerHost,
  opts: TurnLifecycleTrackerFactoryOptions = {},
): TurnLifecycleTracker {
  if (opts.hookRouter && opts.sessionId) {
    return new HookTurnLifecycleTracker(host, opts.sessionId, opts.hookRouter);
  }
  return new JsonlDerivedTurnLifecycleTracker(host);
}
