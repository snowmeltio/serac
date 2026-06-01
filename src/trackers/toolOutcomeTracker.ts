/**
 * ToolOutcomeTracker — enrichment from the `PostToolUse` / `PreToolUse` hooks.
 *
 * Strictly **non-status**: it never moves `running`/`waiting`/`done`. It exposes
 * data JSONL lacks (clean per-tool duration, success/failure) or sees late
 * (permission mode), via dedicated snapshot fields — NOT the shared `activity`
 * line. The activity line is written by the JSONL tool path, and the hook fires
 * ahead of the JSONL poll, so writing `activity` here would be clobbered by a
 * *stale* later-arriving JSONL `tool_use` (arrival-order, not event-order). A
 * dedicated field sidesteps that race entirely. See ARCHITECTURE.md.
 *
 * JSONL variant: no-op. JSONL has no clean per-tool duration, and Serac chooses
 * not to derive a fuzzy one — enrichment is hook-only and simply absent without
 * hooks.
 */

import type { HookEventRouter } from '../hookEventRouter.js';
import type { ToolOutcome } from '../types.js';

export interface ToolOutcomeTrackerHost {
  /** A tool completed (PostToolUse). Host stores it for display. */
  onToolOutcome(outcome: ToolOutcome): void;
  /** The session's permission mode was observed (PreToolUse). */
  onPermissionMode(mode: string): void;
}

export interface ToolOutcomeTracker {
  dispose(): void;
}

class JsonlDerivedToolOutcomeTracker implements ToolOutcomeTracker {
  constructor(_host: ToolOutcomeTrackerHost) { /* no JSONL enrichment source */ }
  dispose(): void { /* no resources */ }
}

class HookToolOutcomeTracker implements ToolOutcomeTracker {
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(
    host: ToolOutcomeTrackerHost,
    sessionId: string,
    router: HookEventRouter,
  ) {
    this.unsubscribers.push(router.register(sessionId, 'PostToolUse', (event: unknown) => {
      if (this.disposed) { return; }
      const e = asRecord(event);
      if (!e) { return; }
      const name = typeof e.tool_name === 'string' ? e.tool_name : '';
      if (!name) { return; }
      const durationMs = typeof e.duration_ms === 'number' ? e.duration_ms : 0;
      host.onToolOutcome({ name, durationMs, isError: isErrorResponse(e.tool_response) });
    }));

    this.unsubscribers.push(router.register(sessionId, 'PreToolUse', (event: unknown) => {
      if (this.disposed) { return; }
      const e = asRecord(event);
      if (!e) { return; }
      if (typeof e.permission_mode === 'string' && e.permission_mode) {
        host.onPermissionMode(e.permission_mode);
      }
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

/** A tool_response signals failure when it's flagged as an error or interrupted.
 *  Shapes vary across tools; this stays defensive and treats unknown as success. */
function isErrorResponse(resp: unknown): boolean {
  if (typeof resp !== 'object' || resp === null) { return false; }
  const r = resp as Record<string, unknown>;
  return r.is_error === true || r.interrupted === true;
}

export interface ToolOutcomeTrackerFactoryOptions {
  hookRouter?: HookEventRouter;
  sessionId?: string;
}

export function makeToolOutcomeTracker(
  host: ToolOutcomeTrackerHost,
  opts: ToolOutcomeTrackerFactoryOptions = {},
): ToolOutcomeTracker {
  if (opts.hookRouter && opts.sessionId) {
    return new HookToolOutcomeTracker(host, opts.sessionId, opts.hookRouter);
  }
  return new JsonlDerivedToolOutcomeTracker(host);
}
