/**
 * PermissionTracker — owns timer scheduling for permission-wait detection.
 *
 * Behaviour:
 *   - Base delay PERMISSION_DELAY_MS=3s; SLOW_PERMISSION_DELAY_MS=15s for slow tools.
 *   - Doubled (max 6s/30s) if a tool result arrived within TOOL_RECENCY_MS=3s.
 *   - Exempt tools never trigger the timer.
 *   - `onWaitingFired` only fires if activeTools is non-empty at fire time;
 *     the host then applies any additional guards (e.g. status === 'running',
 *     subagent bubble policy).
 *
 * FALSE-POSITIVE NOTE: the `PermissionRequest` hook (ground truth, 25-29 ms)
 * IS wired in production (extension.ts hook ingress → hookEventRouter), so a
 * genuine prompt normally surfaces in well under a second and this TIMER is
 * the backstop for hook-silence modes (hooks disabled, foreign and sibling
 * sessions without ingress). A timer alone cannot tell a slow-EXECUTING tool
 * from one BLOCKED on a permission prompt (both look like "tool_use, then
 * silence"), so the slow delay stays generous (15s): a routine long Bash —
 * tests, builds, packaging — completes and clears before the timer flags it,
 * instead of flickering the card to "Waiting for permission" mid-run. Do NOT
 * drop it back to 6s; that reintroduces the slow-Bash flicker (decision
 * recorded 2026-06-10). See BACKLOG.md and project_permission_false_positives.
 *
 * Used in two scopes per session:
 *   1. Session-level — host reads session activeTools, sets "Waiting for permission".
 *   2. Per-subagent — host reads subagent.activeTools, sets waitingOnPermission,
 *      bubbles to parent only when allRunningSubagentsBlocked().
 *
 * The hook variant subscribes to Claude Code's `PermissionRequest` event and
 * pre-empts the timer when ingress is live (25-29 ms ground truth vs the
 * seconds-scale heuristic). Same interface; different fire source.
 */

import { getToolProfile } from '../toolProfiles.js';
import type { HookEventRouter } from '../hookEventRouter.js';

/** Base permission delay for normal (non-slow) tools. */
export const PERMISSION_DELAY_MS = 3_000;
/** Permission delay for slow tools (Bash, WebSearch, WebFetch, Skill, MCP).
 *  Generous on purpose — see the FALSE-POSITIVE NOTE in the module header: with
 *  no hook ground truth, this is long enough that a routine slow Bash (test /
 *  build / package run) finishes before the timer mistakes it for a prompt. */
export const SLOW_PERMISSION_DELAY_MS = 15_000;
/** Recency window: doubled delay only when tool_result arrived within this window. */
export const TOOL_RECENCY_MS = 3_000;

export interface PermissionTrackerHost {
  /** Live snapshot of activeTools — read fresh at every reschedule + at fire time. */
  getActiveTools(): Map<string, string>;
  /** Timestamp (ms) of the most recent tool_result. 0 if none in this turn.
   *  Used for recency-doubling — only doubles if `Date.now() - lastResult < TOOL_RECENCY_MS`. */
  getLastToolResultAt(): number;
  /** Timer fired AND activeTools is still non-empty, OR a `PermissionRequest`
   *  hook arrived. Host applies status side effects (e.g. set status='waiting',
   *  append activity, bubble to parent).
   *  @param toolName  The tool the request is for, when known from a hook event.
   *    Lets the host key the label (AskUserQuestion → "Waiting for your response"
   *    vs "Waiting for permission") and accelerate direct-input tools ahead of
   *    the JSONL tool_use record. Absent for the timer variant, which has no
   *    single triggering tool — the host then reads activeTools. */
  onWaitingFired(toolName?: string): void;
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

/**
 * Hook-overlay variant. Composes a `TimerPermissionTracker` as the
 * authoritative fallback and adds a `PermissionRequest` subscription
 * for low-latency wake-up.
 *
 * Routing model (confirmed 2026-05-25 subagent spike):
 *   All hook events for a session tree fire under the parent's session_id;
 *   subagent events carry an additional `agent_id` field. This tracker
 *   subscribes by parent session_id and filters by agent_id presence:
 *     - Parent tracker (no agentId passed): fires only when `agent_id` is
 *       absent on the payload. Otherwise a subagent's permission request
 *       would prematurely flip the parent to `waiting` without going
 *       through the bubble policy.
 *     - Subagent tracker (agentId passed): fires only when payload's
 *       `agent_id === agentId`. Per-subagent acceleration that flows
 *       through the existing bubble-policy code at the host.
 *
 * Why compose (not replace): Claude Code's hook stream has known
 * silence modes — `permissions.deny` rule auto-rejects emit `PreToolUse`
 * but no `PermissionRequest` (confirmed 2026-05-25 spike). The timer
 * fallback catches every wait the hook misses. When hooks fire on time,
 * the timer's `onWaitingFired` callback either becomes a no-op (host
 * already in `waiting` state) or fires the same legitimate transition
 * after the hook — same intent, idempotent at the host's edge.
 *
 * Latency win when hooks fire: 25-29 ms ground truth vs 3-6 s heuristic.
 */
class HookPermissionTracker implements PermissionTracker {
  private readonly timer: TimerPermissionTracker;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    host: PermissionTrackerHost,
    sessionId: string,
    router: HookEventRouter,
    /** When set, this tracker is for a specific subagent — fire only on
     *  events whose payload `agent_id` matches. When unset, this is the
     *  parent's tracker — fire only on events with no `agent_id`. */
    agentId?: string,
  ) {
    this.timer = new TimerPermissionTracker(host);
    this.unsubscribe = router.register(sessionId, 'PermissionRequest', (event: unknown) => {
      if (this.disposed) { return; }
      const eventAgentId = (typeof event === 'object' && event !== null)
        ? (event as Record<string, unknown>).agent_id
        : undefined;
      if (agentId) {
        if (eventAgentId !== agentId) { return; }
      } else {
        if (typeof eventAgentId === 'string' && eventAgentId.length > 0) { return; }
      }
      const rawToolName = (typeof event === 'object' && event !== null)
        ? (event as Record<string, unknown>).tool_name
        : undefined;
      const toolName = typeof rawToolName === 'string' ? rawToolName : undefined;
      // Direct-input tools (AskUserQuestion) accelerate ahead of the JSONL
      // tool_use record, when activeTools is still empty — safe because the
      // host's JSONL path re-affirms `waiting` for them rather than flipping to
      // `running`. Every other tool keeps the active-tool gate so a stray
      // request can't move a running session to waiting.
      const userInput = toolName ? getToolProfile(toolName).userInput : false;
      if (!userInput && host.getActiveTools().size === 0) { return; }
      host.onWaitingFired(toolName);
    });
  }

  reschedule(): void { this.timer.reschedule(); }
  cancel(): void { this.timer.cancel(); }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.unsubscribe();
    this.timer.dispose();
  }
}

export interface PermissionTrackerFactoryOptions {
  /** Hook router for the owning workspace. When provided alongside
   *  `sessionId`, the factory returns the hook-overlay variant. Otherwise
   *  it returns the pure-timer variant. */
  hookRouter?: HookEventRouter;
  /** Session UUID. Required for hook subscription. For subagent
   *  trackers, this is the *parent's* session_id (all subagent hook
   *  events fire under the parent's session_id; see HOOK-MONITORING.md
   *  2026-05-25 subagent spike). */
  sessionId?: string;
  /** Subagent agent_id. When set, the hook variant filters events to
   *  match this subagent only. When unset, the hook variant filters to
   *  parent-only events (agent_id absent). */
  agentId?: string;
}

/** Construct the variant appropriate for the current environment.
 *
 *  - hookRouter + sessionId → `HookPermissionTracker` (overlay)
 *  - otherwise → `TimerPermissionTracker` (timer-only)
 *
 *  The `agentId` opt selects parent vs subagent filter mode for the
 *  hook variant — see `HookPermissionTracker` docs. */
export function makePermissionTracker(
  host: PermissionTrackerHost,
  opts: PermissionTrackerFactoryOptions = {},
): PermissionTracker {
  if (opts.hookRouter && opts.sessionId) {
    return new HookPermissionTracker(host, opts.sessionId, opts.hookRouter, opts.agentId);
  }
  return new TimerPermissionTracker(host);
}
