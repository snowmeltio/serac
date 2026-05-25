/**
 * PermissionTracker — owns timer scheduling for permission-wait detection.
 *
 * Behaviour:
 *   - Base delay PERMISSION_DELAY_MS=3s; SLOW_PERMISSION_DELAY_MS=6s for slow tools.
 *   - Doubled (max 6s/12s) if a tool result arrived within TOOL_RECENCY_MS=3s.
 *   - Exempt tools never trigger the timer.
 *   - `onWaitingFired` only fires if activeTools is non-empty at fire time;
 *     the host then applies any additional guards (e.g. status === 'running',
 *     subagent bubble policy).
 *
 * Used in two scopes per session:
 *   1. Session-level — host reads session activeTools, sets "Waiting for permission".
 *   2. Per-subagent — host reads subagent.activeTools, sets waitingOnPermission,
 *      bubbles to parent only when allRunningSubagentsBlocked().
 *
 * The hook variant (Phase 4) will replace the timer with subscriptions to
 * Claude Code's `PermissionRequest` event (25-29 ms ground-truth latency vs
 * 3-6 s heuristic). Same interface; different fire source.
 */

import { getToolProfile } from '../toolProfiles.js';

/** Base permission delay for normal (non-slow) tools. */
export const PERMISSION_DELAY_MS = 3_000;
/** Permission delay for slow tools (Bash, WebSearch, WebFetch, Skill, MCP). */
export const SLOW_PERMISSION_DELAY_MS = 6_000;
/** Recency window: doubled delay only when tool_result arrived within this window. */
export const TOOL_RECENCY_MS = 3_000;

export interface PermissionTrackerHost {
  /** Live snapshot of activeTools — read fresh at every reschedule + at fire time. */
  getActiveTools(): Map<string, string>;
  /** Timestamp (ms) of the most recent tool_result. 0 if none in this turn.
   *  Used for recency-doubling — only doubles if `Date.now() - lastResult < TOOL_RECENCY_MS`. */
  getLastToolResultAt(): number;
  /** Timer fired AND activeTools is still non-empty. Host applies status side effects
   *  (e.g. set status='waiting', append activity, bubble to parent). */
  onWaitingFired(): void;
}

export interface PermissionTracker {
  /** Cancel any pending timer and schedule a fresh one based on current host state.
   *  No-op (cancels existing only) if there are no non-exempt active tools. */
  reschedule(): void;
  /** Cancel any pending timer without scheduling a new one. */
  cancel(): void;
  /** Stop and release. Idempotent. After dispose(), reschedule() is a no-op. */
  dispose(): void;
}

export interface TimerPermissionTrackerOptions {
  /** Override clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

class TimerPermissionTracker implements PermissionTracker {
  private timerId: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly now: () => number;

  constructor(
    private readonly host: PermissionTrackerHost,
    opts: TimerPermissionTrackerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  reschedule(): void {
    this.cancel();
    if (this.disposed) { return; }
    const tools = this.host.getActiveTools();
    if (tools.size === 0) { return; }
    const toolNames = [...tools.values()];
    const hasNonExempt = toolNames.some(name => !getToolProfile(name).exempt);
    if (!hasNonExempt) { return; }

    const hasSlow = toolNames.some(name => getToolProfile(name).slow);
    let delay = hasSlow ? SLOW_PERMISSION_DELAY_MS : PERMISSION_DELAY_MS;
    const lastResult = this.host.getLastToolResultAt();
    const recentToolResult = lastResult > 0 && (this.now() - lastResult < TOOL_RECENCY_MS);
    if (recentToolResult) { delay *= 2; }

    this.timerId = setTimeout(() => {
      if (this.disposed) { return; }
      if (this.host.getActiveTools().size === 0) { return; }
      this.host.onWaitingFired();
    }, delay);
  }

  cancel(): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

/** Construct the variant appropriate for the current environment.
 *
 *  Today: always returns `TimerPermissionTracker` — no other variant exists.
 *
 *  Why the factory exists *before* a second variant does: Phase 4 will
 *  introduce `HookPermissionTracker`, fed by Claude Code's `PermissionRequest`
 *  hook event (25-29 ms latency vs current 3-6 s heuristic — confirmed in
 *  spike capture 2026-05-12). When that lands, the factory's body grows a
 *  feature-flag branch; every call site at the SessionManager — session-level
 *  and per-subagent (currently two sites) — remains unchanged.
 *
 *  This is a deliberate one-line layer of indirection, not pretend
 *  abstraction. Removing it now would force a wider diff in Phase 4. */
export function makePermissionTracker(host: PermissionTrackerHost): PermissionTracker {
  return new TimerPermissionTracker(host);
}
