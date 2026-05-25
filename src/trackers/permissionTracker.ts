/**
 * PermissionTracker — owns timer scheduling for permission-wait detection.
 *
 * Spike extraction (entanglement test): does the permission timer's contract
 * close without leaking SessionManager internals?
 *
 * Behaviour preserved verbatim from sessionManager.ts (Path B audit §2):
 *   - Base delay PERMISSION_DELAY_MS=3s; SLOW_PERMISSION_DELAY_MS=6s for slow tools
 *   - Doubled (max 6s/12s) if a tool result arrived within TOOL_RECENCY_MS=3s
 *   - Exempt tools never trigger the timer
 *   - `onWaitingFired` only fires if activeTools is non-empty at fire time
 *     (host then applies any additional guards e.g. status === 'running')
 *
 * Used in two scopes per session:
 *   1. Session-level — host reads session activeTools, applies "Waiting for permission"
 *   2. Per-subagent — host reads subagent.activeTools, sets waitingOnPermission,
 *      bubbles to parent only when allRunningSubagentsBlocked()
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

export class TimerPermissionTracker implements PermissionTracker {
  private timerId: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly host: PermissionTrackerHost) {}

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
    const recentToolResult = lastResult > 0 && (Date.now() - lastResult < TOOL_RECENCY_MS);
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

/** Future seam: returns the hook variant when hooks are wired, timer-derived otherwise. */
export function makePermissionTracker(host: PermissionTrackerHost): PermissionTracker {
  return new TimerPermissionTracker(host);
}
