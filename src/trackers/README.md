# Trackers

Single-slice-of-state observers for SessionManager. Each tracker owns one
slice (cwd, permission-wait, subagent lifecycle, compact boundaries), exposes
a minimal interface for the SessionManager to read or notify against, and
hides its data source behind a factory function.

## Convention

For every tracker:

1. **One slice of state per tracker.** `CwdTracker` owns `{cwd, initialCwd}`.
   `PermissionTracker` owns timer state. If you find yourself sharing state
   between two trackers, that's a signal one of them is wrong.
2. **A host interface for callbacks only.** Trackers don't read from the
   `SessionManager` directly; they receive a `Host` shape at construction.
   `CwdTracker` needs zero host methods. `PermissionTracker` needs three.
3. **A factory function returns the interface, not the class.** All
   construction goes through `make<X>Tracker(host)`. Concrete classes are
   not exported. This is the seam where Phase 4 swaps in hook variants.
4. **`dispose()` is idempotent and required.** Even if the current variant
   has no resources, the interface declares it so hook variants can
   tear down subscriptions cleanly.
5. **Behaviour-only tests; no implementation-detail asserts.** Tests use
   `vi.useFakeTimers()` for time and an injected `now()` clock where the
   tracker needs to compare timestamps.

## Source variants

Today, all four trackers ship a JSONL/timer-derived variant only:

| Tracker | Today's source | Phase 4 source |
|---|---|---|
| `CwdTracker` | `cwd` field from JSONL records | `SessionStart` / `UserPromptSubmit` hook events |
| `PermissionTracker` | `setTimeout` against tool activity | `PermissionRequest` hook events |
| `SubagentLifecycleTracker` | wraps `SubagentTailerManager` | `SubagentStop` events |
| `CompactBoundaryTracker` | `system.subtype === 'compact_boundary'` | `SessionStart(source: "compact")` |
| `TurnLifecycleTracker` | no-op (idle timer owns `done`) | `Stop` → accelerate `done` (host-edge turn-close guard) |
| `ToolOutcomeTracker` | no-op (no JSONL source) | `PostToolUse`/`PreToolUse` → `lastTool`/`permissionMode` (enrichment) |
| `SessionLifecycleTracker` | no-op (no JSONL source) | `SessionEnd` (enrichment) / `PreCompact` (compacting grace window) |
| `GlanceTracker` | user/assistant/file-history JSONL records | n/a — display-only enrichment (topic, branch, tracked files, error count, last reply) |

The Phase 4 swap is a one-line change inside each factory body; no
SessionManager call site changes.

Beyond swapping these four, the **Hook consumption** design (`ARCHITECTURE.md`)
adds three new trackers: `TurnLifecycleTracker` (`Stop` → accelerate `done`),
`ToolOutcomeTracker` (`PreToolUse`/`PostToolUse` enrichment), and
`SessionLifecycleTracker` (`SessionEnd`/`PreCompact` enrichment). Hooks play two
roles there — they *accelerate* status transitions (JSONL stays the source of
truth, PID-liveness stays full-strength) and are the *sole source* for enrichment
(durations, outcomes, deny-by-rule, end reason). They are not authoritative for
status. One nuance: `Stop`→`done` is **not** order-free (it races trailing JSONL
that fires `running`), so its turn-close guard lives at the SessionManager host
edge, not in the tracker slice. New trackers follow the same convention below.

## Partial-order contract (PermissionTracker)

The persona-panel review (Elena Voss, event-ordering lens) flagged that the
PermissionTracker's invariants were implicit. They are:

- `reschedule_t` cancels any pending fire scheduled at an earlier
  `reschedule_t'`; only the most recent reschedule's timer can fire.
- The fire predicate is checked at three points: schedule (cheapest), timer
  fire (re-check `activeTools.size`), and host callback (re-check session
  status). All three must hold for `onWaitingFired()` to take effect. **The
  schedule-time check is an early-out; fire-time and host-callback are the
  authoritative gates.**
- `getLastToolResultAt()` is read **once at schedule time**. The doubled-delay
  decision is baked in; later tool results within the recency window do not
  retroactively extend an already-scheduled timer.
- Bubble policy: a subagent's `onWaitingFired()` evaluates
  `allRunningSubagentsBlocked()` against the live subagent set at fire time.
  A subagent that spawns after the fire decision will NOT re-bubble until
  its own timer fires.
- Hook variant: push events from `PermissionRequest` collapse the
  schedule → fire interval to ~0 ms. Subscribers must still apply the
  host-callback gate (session status, subagent running) because the parent
  state may have moved between the hook firing and the subscriber receiving.
- `onWaitingFired(source, toolName?)`: `source` is `'hook'` for a
  `PermissionRequest` event (ground truth — Claude Code confirms a prompt is
  genuinely on screen) or `'timer'` for the heuristic delay (cannot distinguish
  slow-executing from truly blocked). A host that skips a permission-typed wait
  in an auto-accept permission mode (see `isAutoAcceptMode()` in
  `sessionManager.ts`) MUST gate that skip on `source === 'timer'` only — a
  `'hook'` fire must never be suppressed, mode or no mode. `toolName` is the
  event's `tool_name` for the hook variant; the timer variant omits it (no
  single triggering tool). The host keys the activity label off the tool's
  `userInput` profile. The active-tool gate (`activeTools` non-empty) is
  bypassed **only** for `userInput` tools (AskUserQuestion), so they accelerate
  to `waiting` ahead of their JSONL `tool_use` record. Non-input tools keep the
  gate: their JSONL path runs `setRunning()`, which would otherwise flip an
  accelerated `waiting → running`.
- Same `source === 'timer'`-only rule applies to the session-level
  `hasBlockingSubagents()` guard (added 2026-07-11): a parallel `Agent`/`Task`
  call still unresolved in the same turn explains a sibling tool's silence
  (batched multi-tool-turn submission / execution-slot queueing, not
  permission), so the timer no-ops while one is blocking — but a `'hook'` fire
  is never suppressed by it, same as the mode gate above. See ARCHITECTURE.md
  status-inference item 10.

## Adding a new tracker

1. Create `src/trackers/<name>Tracker.ts`. Export an interface `<Name>Tracker`,
   a `<Name>TrackerHost` interface for callbacks, and a `make<Name>Tracker(host)`
   factory. Don't export the concrete class.
2. Add a colocated `<name>Tracker.test.ts` with behaviour-only tests.
3. Wire it into `SessionManager` at the constructor, alongside the existing
   trackers. If the tracker needs lifecycle handling, route through a private
   helper (see `createSubagent()` for the pattern).
4. If the tracker depends on per-record data (`record.cwd`, `record.subtype`),
   plumb it through the appropriate `process<Type>Record` method.

If the new tracker needs to read state owned by another tracker, surface
that need at the host interface — don't reach across trackers directly.
