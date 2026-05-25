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
| `SubagentLifecycleTracker` | wraps `SubagentTailerManager` | `SubagentStart` / `SubagentStop` events |
| `CompactBoundaryTracker` | `system.subtype === 'compact_boundary'` | `SessionStart(source: "compact")` |

The Phase 4 swap is a one-line change inside each factory body; no
SessionManager call site changes.

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
- Hook variant (Phase 4): push events from `PermissionRequest` collapse the
  schedule → fire interval to ~0 ms. Subscribers must still apply the
  host-callback gate (session status, subagent running) because the parent
  state may have moved between the hook firing and the subscriber receiving.

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
