# Serac — Architecture

## Data flow

```
JSONL files (~/.claude/projects/{workspaceKey}/)
    ↓ adaptive polling (500ms active, 2s idle)
JsonlTailer (byte-offset reads, per session)
    ↓ new records
SessionManager (state inference, timer management)
    ↓ snapshots
SessionDiscovery (lifecycle, metadata, sorting)
    ↓ sorted snapshots + usage
AgentPanelProvider (HTML/CSS generation)
    ↓ postMessage
panel.js (DOM reconciliation, FLIP animations)
```

Separately, UsageProvider polls the Anthropic OAuth API every 4-6 minutes and parses local JSONL for per-session costs.

## Source files

| File | Lines | Role |
|------|-------|------|
| `extension.ts` | 191 | Entry point. Wires providers, registers commands, starts timers. |
| `sessionManager.ts` | 772 | Core state machine. Processes JSONL records, infers session status, manages idle/permission/stale timers. One instance per session. |
| `sessionDiscovery.ts` | 330 | Session lifecycle. Discovers JSONL files, manages metadata persistence (`session-meta.json`), sorts snapshots into two-zone order, handles dismiss/acknowledge. |
| `usageProvider.ts` | 445 | Usage tracking. OAuth API polling for quota percentages, JSONL parsing for per-session costs, disk caching. |
| `panelProvider.ts` | 682 | Webview provider. Generates full HTML/CSS inline, handles webview commands, updates panel badge. |
| `panel.js` | 850 | Webview frontend. Keyed DOM reconciler with FLIP animations, status debouncing, ghost filtering, card rendering. |
| `jsonlTailer.ts` | 70 | Byte-offset file reader. Tracks read position, buffers incomplete lines across reads. |
| `sessionRepair.ts` | 84 | JSONL metadata repair. Reads tail 64KB, appends `custom-title` record if no metadata exists. |
| `transcriptRenderer.ts` | 206 | JSONL to markdown converter. Renders user/assistant/system records with tool summaries. |
| `types.ts` | 244 | All TypeScript interfaces. SessionState, SessionSnapshot, UsageSnapshot, WebviewMessage, JsonlRecord. |
| `settings.ts` | 130 | Typed accessor and change subscriber for the `serac.*` configuration namespace. Single source of truth for defaults. |

## Status inference

### States

| Status | Meaning | Visual |
|--------|---------|--------|
| `running` | Agent is actively processing | Blue border, spinner |
| `waiting` | Waiting for user (permission prompt or AskUserQuestion) | Orange border, pulsing pill |
| `done` | Turn complete, not yet acknowledged by user | Teal border |
| `stale` | Display-only: `done` + acknowledged + 10s elapsed | Grey border |
| `idle` | Display-only: queued (`enqueue`) but not yet dequeued | Grey border |

### Transitions

```
done ──→ running          (user record arrives, dequeue, or compact_boundary)
running ──→ waiting       (AskUserQuestion, permission timer 3s/6s, all subagents blocked)
running ──→ done          (idle timer 5s, all-subagents-done, hard ceiling 3min, or Stop hook)
waiting ──→ running       (sidechain tool_result unblocks subagents, user record)
waiting ──→ done          (waiting hard ceiling 10min)
any ──→ done              (queue-operation: enqueue, JSONL truncation)
done ──→ stale            (display-only: acknowledged + 10s elapsed)
```

Internal statuses are `running | waiting | done`. `stale` and `idle` are display-only labels applied in `SessionDiscovery.getSnapshots()` and `panel.ts`.

### Timer hierarchy

`turn_duration` system records were never observed in production JSONL and were removed as a state signal in v0.9. Status now derives from record cadence and tool-completion signals.

1. **Tool completion signals** — `tool_result` blocks remove tools from `activeTools`; the all-subagents-done shortcut marks orchestrator turns complete immediately.
2. **Permission timer** — heuristic for stuck permission prompts. Base delay **3s** for normal tools, **6s** for slow tools (Bash, WebSearch, WebFetch, Skill, MCP). Doubled (max **6s/12s**) if a tool result arrived within the last 3s, to absorb sequential auto-approved tools.
3. **Idle timer (5s)** — fires only if status is `running` AND output has been seen in this turn AND no blocking subagents are active.
4. **Extended thinking grace (30s)** — first 30s of a turn with no output yet uses PID-liveness check instead of demoting (covers slow first-token).
5. **Hard ceiling (3 min running, 10 min waiting)** — safety net; forces done regardless of state. Covers laptop sleep, quota hits, abandoned permission prompts.
6. **`Stop` hook (when present)** — accelerates `running → done` to the instant the turn ends, ahead of the 5s idle timer. Sets the `turnEndedByStop` guard so the turn's trailing assistant record (polled 0.5–2s later) cannot re-fire `running`; the guard is released by the next genuine new-turn reopener (user record, `dequeue`, or `compact_boundary`) or on `resetState`. Pure acceleration — `done` is still reached by the idle timer when no hook arrives, so hookless sessions are unchanged. See "Hook consumption".

### Out-of-order tool_use/tool_result

Claude Code's JSONL writer occasionally flushes a `tool_result` record before its
matching `tool_use` (file order reversed despite an earlier wall-clock timestamp on
the `tool_use`). Without compensation, the late `tool_use` adds an entry to
`activeTools` that nothing ever clears, and `demoteIfStale` falsely promotes the
session to `'waiting'` after 30 s of silence. `SessionManager.earlyToolResults`
tracks IDs whose `tool_result` arrived first, so the late `tool_use` can be skipped.

### Permission-exempt tools

These tools never trigger permission wait detection: `Agent`, `Task`, `TodoWrite`, `ToolSearch`, `Read`, `Glob`, `Grep`, `Edit`, `Write`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `PushNotification`, `TaskOutput`, `TaskStop`, `SendMessage`. See `toolProfiles.ts` for the canonical list.

### Subagent permission bubbling

Each subagent runs its own permission timer against `subagent.activeTools`. When it fires, the subagent is marked `waitingOnPermission`. The parent only transitions to `waiting` when **all** running subagents are blocked — a single-subagent block doesn't bubble if other subagents are still progressing.

Subagents are further classified for demotion:
- **Blocking subagent** — `parentToolUseId` is still in the parent's `activeTools` (parent waiting for the Task/Agent result). Suppresses parent demotion.
- **Background subagent** — parent has moved on (`parentToolUseId` no longer in `activeTools`). Does NOT suppress demotion; parent can demote to `done` while the background subagent finishes.

## Hook consumption

> Status: **implemented 2026-06-01** — `TurnLifecycleTracker`,
> `ToolOutcomeTracker`, `SessionLifecycleTracker`; `HOOK_EVENTS` gained
> `SessionEnd`/`PreCompact` and lost `SubagentStart`. Panel rendering of the
> enrichment fields (`lastTool`, `permissionMode`, `endReason`) is the remaining
> follow-up: the data is on the snapshot but not yet drawn on the card.
>
> Red-teamed twice. Draft 1's authority/coverage model was rejected (see
> **Rejected: the authority model**). Draft 2's "acceleration is order-free via
> idempotency" claim was found **false for `Stop`** — see **The `Stop` turn-close
> guard**. `Notification`→`waiting` and `SubagentStart` consumption were
> investigated and dropped (AskUserQuestion is already covered by
> `PermissionRequest`; `SubagentStart` can't bridge to `parentToolUseId` at spawn).

### Principle: two roles

Hooks serve two roles. The split removes most cross-source arbitration — but not
all of it, which Draft 2 got wrong.

1. **Accelerators for status.** A hook fires a status transition JSONL would
   reach anyway, only earlier.
   - **Same-transition accelerators are order-free.** `setStatus` no-ops on
     same-status, so a hook and JSONL firing the *same* transition is idempotent
     regardless of order. The permission→`waiting` path is like this:
     `PermissionRequest` and the JSONL tool path both fire `waiting`.
   - **`Stop`→`done` is the exception — NOT same-transition, NOT order-free.**
     `Stop` fires `done`; the turn's trailing JSONL assistant record fires
     `running` via `setRunning()` ([sessionManager.ts:763](src/sessionManager.ts#L763)).
     Different transitions ⇒ not idempotent ⇒ a per-turn `done→running→done`
     flicker unless guarded. See the next subsection.
2. **Enrichment via dedicated snapshot fields.** `PostToolUse` (tool duration +
   outcome), `PreToolUse` (permission mode), and `SessionEnd` (end reason) carry
   data JSONL lacks. They write **dedicated snapshot fields** (`lastTool`,
   `permissionMode`, `endReason`) — **not** the shared `activity` line and
   **never** status. This is deliberate: the hook fires ahead of the JSONL poll,
   so writing `activity` would be clobbered by a *stale* later-arriving JSONL
   `tool_use` (arrival-order, not event-order — the exact race Draft 2
   over-claimed immunity to). A dedicated field sidesteps it entirely.
   - **Exception — `PreCompact` is a status-stabiliser, not enrichment.** It
     opens the compacting grace window (below): holds `running`/high-confidence
     and suppresses demotion. It is the one lifecycle event that touches status.

This is **observe-only.** Serac's forwarder always exits `0` and never returns a
blocking, deny, or context-injection decision. Consuming more events never gives
Serac a vote in what the agent does — only a clearer view of what it did. The
exit-0 guarantee in `bin/serac-hook-forward.cjs` is the guardrail; it must not
change.

### The `Stop` turn-close guard

`Stop` must **not** bypass the idle path by calling `markSessionDone()` directly.
The turn's trailing assistant record is polled 0.5–2s later, hits the text-only
branch of `processAssistantRecord` → `setRunning()`, flipping `done→running`;
the 5s idle timer then re-demotes — a per-turn flicker that is *worse* than
today's single clean `running→done`.

The fix uses the reopener taxonomy. `done→running` has exactly four sources
([sessionManager.ts:15-20](src/sessionManager.ts#L15)): user record, `dequeue`,
trailing assistant record, and `compact_boundary`. A *legitimate* new turn always
begins with one of the first, second, or fourth — so a bare assistant record
after `Stop` is, by construction, trailing data of the turn that just ended.

- `Stop` sets a `turnEndedByStop` flag and marks done.
- While the flag is set, `processAssistantRecord`'s `setRunning()` is
  **suppressed** (trailing records cannot reopen), as is `activeTools`
  repopulation from a trailing `tool_use`.
- A `user` / `dequeue` / `compact_boundary` record **clears** the flag and
  proceeds normally — a real new turn.

State-based, ~10 lines, no timestamp/clock dependency. The flag lives at the
**SessionManager host edge**, not inside a tracker slice, because it coordinates
`setRunning`, `activeTools`, and the idle timer.

### JSONL stays the status backstop — at full strength

Because hooks only *accelerate* status, the existing JSONL heuristics are **not
demoted** when hooks are present:

- The **idle timer**, **extended-thinking grace**, and especially the
  **PID-liveness check** keep running at full cadence. This is deliberate: when
  Claude Code *crashes* mid-turn, no `Stop` fires — and the hook channel is dead
  exactly when you need it. PID-liveness is the only thing that catches a dead
  process fast, so it must never be gated behind "hooks are live."
- A session that emits no hooks at all (started before hooks were installed, or
  running in a non-leader VS Code window) behaves **exactly as it does today**.
  No per-session capability flag is required; absence of acceleration is just the
  current path.

### Signal map

| Hook event | Registered today | Plan | Role |
|---|---|---|---|
| `Stop` | ✅ | **consume (new)** | accelerate `done` — with the turn-close guard |
| `PostToolUse` | ✅ | **consume (new)** | enrichment: `duration_ms`, outcome, response preview |
| `PreToolUse` | ✅ | **consume (new)** | enrichment: intent, `permission_mode`, deny-by-rule |
| `PermissionRequest` | ✅ | already consumed (tweak) | ground-truth `waiting` for permission **and** AskUserQuestion; needs a `tool_name`-keyed activity label |
| `SessionStart` / `UserPromptSubmit` / `SubagentStop` | ✅ | already consumed | cwd, compact boundary, subagent lifecycle |
| `SubagentStart` | ✅ | **drop / de-register** | payload has `agent_id` but no `tool_use_id`; can't bridge to the `parentToolUseId`-keyed subagent model at spawn → double-counts |
| `Notification` | ❌ | **do not add** | `permission_prompt` is redundant with `PermissionRequest` (verified: AskUserQuestion fires both); only unique variant `idle_prompt` is a nudge about an already-waiting session and is ignored |
| `SessionEnd` | ❌ | **add (initial)** | enrichment: end reason (clear/logout/prompt_input_exit/other) |
| `PreCompact` | ❌ | **add (initial)** | **status-stabiliser**: opens a compacting grace window (holds `running`/high-confidence, suppresses idle-demotion + survives truncation) until `compact_boundary` or timeout; carries `trigger` (manual/auto) |

Steps 1–2 register **nothing new** — `Stop`/`PreToolUse`/`PostToolUse` are already
in `HOOK_EVENTS`. Only the later enrichment phase adds `SessionEnd`/`PreCompact`.
`SubagentStart` should be **removed** from `HOOK_EVENTS` to stop paying a forwarder
spawn per subagent for an event nothing consumes.

### Caveats (resolved / settled)

- **`stop_hook_active`.** `Stop`/`SubagentStop` payloads carry this flag (`false`
  in every capture). A `Stop` with `stop_hook_active: true` is a
  continuation-triggered stop, not a turn end — the `Stop` consumer must ignore
  those or it will close a turn that is still running.
- **`notification_type` (informational, since `Notification` is dropped).** The
  payload discriminates `permission_prompt` from `idle_prompt`. We verified
  `permission_prompt` is redundant with `PermissionRequest` (AskUserQuestion
  fires *both*), so `Notification` is not consumed at all. Kept here only so a
  future reader doesn't re-derive it.

### Cost (benchmarked 2026-06-01)

- **Steps 1–2 add ≈ zero forwarder cost.** `Stop`/`PreToolUse`/`PostToolUse` are
  already registered and already spawn `serac-hook-forward.cjs` on every tool
  call — today they're just dropped at the router. Consuming them adds only a
  synchronous router dispatch + a field write.
- **`SessionEnd`/`PreCompact` add negligible cost** — they fire once per session
  end / compaction, not per tool call.
- **The forwarder is over its own spec, independently of this work.**
  `scripts/bench-forwarder.cjs`: min 38ms / p50 40ms / p95 71ms / max 603ms
  against a `<30ms` cold-spawn target — node cold-start per event. This is a
  pre-existing per-tool latency tax on *all* hooked tool calls; worth a separate
  cleanup (persistent helper or compiled forwarder), not a blocker for consuming.

### Where it lives

New consumers follow the existing tracker convention (`src/trackers/README.md`):
one slice of state, a host interface for callbacks, a factory hiding the source.

- **`TurnLifecycleTracker`** — consumes `Stop` to accelerate `done`. The
  turn-close guard (`turnEndedByStop` flag + suppression of trailing
  `setRunning`/`activeTools`) lives at the **SessionManager host edge**, not in
  the tracker slice, because it coordinates `setRunning`, `activeTools`, and the
  idle timer. The existing `seenOutputInTurn` / idle / PID-liveness logic stays
  as the JSONL backstop and keeps running.
- **`ToolOutcomeTracker`** — consumes `PostToolUse` (→ `lastTool`) and
  `PreToolUse` (→ `permissionMode`). Non-authoritative; writes dedicated snapshot
  fields, never status and never the `activity` line.
- **`SessionLifecycleTracker`** — consumes `SessionEnd` (enrichment: end reason,
  no status effect) and `PreCompact` (status-stabiliser). `PreCompact` opens a
  **compacting grace window** at the SessionManager host edge: while open, the
  session holds `running` at high confidence, the idle timer does not demote, and
  `resetState` (triggered by compaction's JSONL truncation) must **preserve** the
  window so the card doesn't flip to `done` mid-compaction. The window closes on
  the existing `compact_boundary` signal (handled by `CompactBoundaryTracker`) or
  a timeout. This fixes the observed mid-compaction `running`→`done` flip and
  confidence decay. `SessionEnd` itself never moves status (enrichment-only
  unless an `ended` display state is added later — see Status inference).

(`NotificationTracker` from the prior draft is dropped — see signal map.)

### Implementation order (single initial build)

`SessionEnd` and `PreCompact` are in the initial build, not deferred.

1. **`Stop` → accelerate `done`** (`TurnLifecycleTracker` + host-edge turn-close
   guard). Build the guard first — it *is* the feature. Already registered.
2. **`PostToolUse`/`PreToolUse` enrichment** (`ToolOutcomeTracker`) → dedicated
   `lastTool`/`permissionMode` snapshot fields. Already registered; marginal cost ≈ 0.
3. **`SessionEnd`/`PreCompact` enrichment** (`SessionLifecycleTracker`). Add both
   to `HOOK_EVENTS`, remove `SubagentStart`, re-patch settings, then consume.

Independent follow-ups (not blockers):
- Accelerate the AskUserQuestion `waiting` via the already-wired
  `PermissionRequest`, fixing the hardcoded `'Waiting for permission'` activity
  ([sessionManager.ts:205](src/sessionManager.ts#L205)) to key off `tool_name`
  (AskUserQuestion → "Waiting for your response").
- Forwarder perf cleanup (see Cost).

Each step degrades cleanly to today's behaviour when no hook arrives.

### Rejected: the authority model

The first draft made hooks *authoritative* for status, with:
- a per-session coverage state machine (`unknown`/`live`/`degraded`), and
- a "causal-recency-wins" rule letting the latest-processed record from either
  source override the other, and
- demotion of JSONL heuristics (including PID-liveness) under `live` coverage.

Rejected because:
- **Causal-recency was wrong across async channels.** Hooks arrive on a push
  socket; JSONL is polled 500ms–2s later. A `Stop` is almost always *processed*
  before its own turn's trailing JSONL is read off disk, so "latest processed
  wins" would let stale JSONL reopen a hook-closed turn — flicker on every turn,
  not a corner case.
- **The machinery was unjustified.** It existed only to arbitrate two sources
  both claiming a *status*. The two-roles split removes that need entirely:
  acceleration is idempotent, enrichment has no rival source.
- **Demoting PID-liveness was a crash-detection regression** — see "JSONL stays
  the status backstop" above.

Reintroduce an authority model only if a concrete case appears where JSONL infers
a **durably wrong** terminal status (not merely a *late* one) that a hook must
override — or where `Stop`/`Notification` prove unreliable enough that JSONL must
*cross-check* rather than *backstop* them.

## Usage model

### OAuth API (primary)

- Endpoint: `GET https://api.anthropic.com/api/oauth/usage`
- Auth: Bearer token from macOS Keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json`
- Response: `five_hour.utilization`, `seven_day.utilization`, per-model weekly quotas, extra usage info
- Polling: 4-6 minute randomised interval with 10-15 minute cooldown between API calls
- Cache: `~/.claude/usage-cache.json` with 15-minute TTL
- Fallback: reuse last successful response on transient failures (429, network errors)

## Webview rendering

### Message protocol

**Extension to webview:** Three message types:
- `update` — all session snapshots, usage data, needs-input count, and workspace path. A 200ms debounce guard prevents double-renders when onChange callbacks and the refresh timer overlap.
- `focusSession` — sets `focusedSessionId` and re-renders with highlight. Used when a new chat is detected after the user clicks "+ New".
- `settings` — the current `serac.*` configuration snapshot. Posted once on `resolveWebviewView` (before the first `update` so the very first render sees the right visibility / heights) and again whenever `onDidChangeConfiguration` fires. Held separate from `update` because settings change rarely and updates are noisy.

**Webview to extension:** Command messages (focusSession, dismissSession, undismissSession, viewTranscript, newChat, cleanup, copyToClipboard, requestUpdate).

### New chat detection

When the user clicks "+ New", the extension snapshots known session IDs and opens a new Claude Code editor panel. The JSONL file only appears when the user sends their first message, so a fixed polling timer would expire before detection. Instead, a `pendingNewChatKnownIds` set persists across poll cycles. On each `sendUpdate()`, if the set is active, any session not in it is treated as the new chat — focused in the panel and the set is cleared.

### DOM reconciliation

The webview uses a keyed reconciler (not innerHTML replacement). Cards are matched by session ID; new cards fade in, removed cards fade out, reordered cards animate via FLIP (First, Last, Invert, Play) with 300ms CSS transitions.

### Status debouncing

A 2-second debounce prevents flicker during rapid `needs-input → running → needs-input` cycles that occur when sequential tool permissions are approved.

### Ghost filtering

Sessions with no topic and no activity in idle/stale status are silently filtered from the display.

### Card name display priority

`customTitle` > `title` (from session-meta.json) > `topic` (first user message) > folder name > slug > session ID.

### Foreign workspace worktree picker

When `groupForeignWorkspaces` aggregates 2+ foreign workspaces sharing a `repoRoot`, the synthetic row becomes click-to-expand (chevron, no `data-cwd`). Expanding inlines one child row per worktree of the repo (read from `<repoRoot>/.git/worktrees/*` by `ForeignWorkspaceManager`, refreshed on the same 60s cadence as the local `discoveredWorktrees`). Per-worktree counts come from the pre-aggregation `members` preserved on the synthetic row. Inactive worktrees (no Claude Code activity within `serac.discovery.ageGateDays`) still appear, marked with a quiet "no activity" tag. Picking a worktree posts `openWorkspace` and auto-collapses the parent; an idle expand collapses after `serac.worktrees.autoCollapseAfterSeconds`.

#### `/private/tmp` pseudo-repository

Scratch sessions under the temp root aren't git repos, so each would otherwise show as its own flat "Other workspaces" row. When `serac.worktrees.consolidateTmp` is on, `ForeignWorkspaceManager.getWorkspaces` overlays a synthetic `repoRoot` of `PSEUDO_TMP_REPO_ROOT` (`/private/tmp`) onto any workspace whose cwd is under `/private/tmp` or `/tmp` (`isTmpScratchPath`) **and** has no real git `repoRoot`. The overlay is applied at read time, not baked into `repoRootCache`, so toggling the setting takes effect on the next poll without a cache flush. `groupForeignWorkspaces` then folds these into one `tmp` row flagged `pseudoRepo: true`. Because a pseudo root has no `.git`, there are no enumerated worktrees: the row withholds `cwd` (no canonical checkout to open), its chip reuses the `Nwt` suffix marked with a `*` (e.g. `2wt*`, explained in the chip tooltip — they aren't real git worktrees, and `Nd` was avoided since `d` reads as the Done count or "days"), and the inline picker is driven by `members` (one child per scratch dir, no main/detached/no-activity hints) rather than `worktrees`. Real git-repo aggregation is unaffected.

## Configuration

The extension exposes a `serac.*` namespace via `package.json#contributes.configuration`. Reads go through a single typed accessor in `src/settings.ts` — never `vscode.workspace.getConfiguration` directly elsewhere.

- **Reading:** `readSettings(): SeracSettings` returns a complete snapshot, falling back to `DEFAULT_SETTINGS` for any unset key. Defaults match the historical hardcoded constants so an upgrade with no `serac.*` keys behaves identically.
- **Reactivity:** `onSettingsChanged(cb)` wraps `vscode.workspace.onDidChangeConfiguration` and fires the callback with a fresh snapshot whenever any `serac.*` key changes. `extension.ts` posts a new `settings` message to the webview and (when `serac.refresh.intervalSeconds` changed) rebuilds the refresh timer.
- **Webview side:** `panel.ts` caches the last received `SettingsMessage` in `currentSettings`. Render functions consult it directly for visibility gates (`show.foreignWorkspaces`, `show.worktrees`, `show.usage`, `show.subagents`, `show.teams`), thresholds (`usage.warnAtPercent`, `usage.criticalAtPercent`), and limits (`archive.maxDoneShown`, `worktrees.autoCollapseAfterSeconds`).
- **Discovery managers** (`foreignWorkspaceManager`, `siblingWorktreeManager`, `teamDiscovery`) call `readSettings()` at the top of `scan()` / `poll()` to:
  - Short-circuit when the corresponding `show.*` setting is false (no background work for hidden sections).
  - Read the consolidated `discovery.ageGateDays` (single source of truth — replaces three previously identical 7-day constants).
- **CSS reactivity:** Heights and animation timings are CSS custom properties on `:root` (`--serac-foreign-max-height`, `--serac-worktrees-max-height`, `--serac-transition-ms`, `--serac-foreign-slide-ms`), set by `applySettings()` in the webview. A `maxHeightPx` of `0` maps to `none` (no cap). `.card-archive-scroll` has a fixed `min-height: 200px` so cards can never be collapsed by the workspace/worktree panes; `#root` uses `overflow-y: auto` so the whole panel scrolls when the combined content exceeds the viewport.
- **Per-workspace overrides:** All settings inherit VS Code's standard layering — user settings → workspace settings (`.vscode/settings.json`). Free, no additional plumbing.

## Session metadata

Consolidated in `session-meta.json` per workspace:

```json
{
  "sessions": {
    "<sessionId>": {
      "title": null,
      "dismissed": false,
      "acknowledged": false,
      "acknowledgedAt": null,
      "firstSeen": 1741500000000
    }
  }
}
```

Reloaded every poll cycle (500ms active, 2s idle), enabling external processes to update metadata. Legacy migration from `dismissed-sessions` and `acknowledged-sessions` text files happens on first load.

## Session repair

`sessionRepair.ts` ensures JSONL files have metadata for Claude extension discovery. If no user text is found (e.g. session is too new), repair is skipped — no fallback title is written. The display layer (`getDisplayName` in panel.js) also treats `Session [hex]{8}` titles as placeholders and falls through to topic/slug/cwd.

1. Read last 64KB of JSONL file
2. Check for existing `custom-title`, `last-prompt`, or `summary` records
3. If none found, scan full file for first user message text
4. Append a `custom-title` JSONL record with extracted title (max 200 chars)
5. Failures are silently suppressed (non-critical path)

Called on session focus and undismiss operations.
