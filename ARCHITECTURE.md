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

| File | Role |
|------|------|
| `extension.ts` | Entry point. Wires providers, registers commands, starts timers. |
| `sessionManager.ts` | Core state machine. Processes JSONL records, infers session status, manages idle/permission/stale timers. One instance per session. |
| `sessionDiscovery.ts` | Session lifecycle. Discovers JSONL files, manages metadata persistence (`session-meta.json`), sorts snapshots into two-zone order, handles dismiss/acknowledge. |
| `usageProvider.ts` | Usage tracking. OAuth API polling for quota percentages, JSONL parsing for per-session costs, disk caching. |
| `panelProvider.ts` | Webview provider. Generates full HTML/CSS inline, handles webview commands, updates panel badge. |
| `panel.js` | Webview frontend. Keyed DOM reconciler with FLIP animations, status debouncing, ghost filtering, card rendering. |
| `jsonlTailer.ts` | Byte-offset file reader. Tracks read position, buffers incomplete lines across reads. |
| `sessionRepair.ts` | JSONL metadata repair. Reads tail 64KB, appends `custom-title` record if no metadata exists. |
| `transcriptRenderer.ts` | JSONL to markdown converter. Renders user/assistant/system records with tool summaries. |
| `types.ts` | All TypeScript interfaces. SessionState, SessionSnapshot, UsageSnapshot, WebviewMessage, JsonlRecord. |
| `settings.ts` | Typed accessor and change subscriber for the `serac.*` configuration namespace. Single source of truth for defaults. |
| `workflowSidecar.ts` | Pure parser. `parseWorkflowSidecar()` turns a completed run's `wf_<runId>.json` sidecar into a `WorkflowSnapshot`. Never-throw, version-tolerant, in the style of `teamManifest.ts`. |
| `workflowScript.ts` | Static (never-eval) extractors. `extractWorkflowMeta()` pulls `name`/`description`/`phases` from a workflow script's `meta` literal; `extractAgentCalls()` pulls each `agent(prompt, {label, phase})` call's static prompt segments + opts, plus the prompt/label split into ordered `TemplateParts` (statics + interpolation exprs); `matchAgentCall()` correlates a running agent's record-0 prompt back to its call; `recoverInterpolatedLabel()` rebuilds an interpolated label (`audit:${d.key}`) into its real per-agent value (`audit:privacy`) by aligning the prompt template's statics against the expanded prompt. All via brace/string matching. Used for the live tier. |
| `workflowDiscovery.ts` | Two-tier workflow discovery, parallel to `teamDiscovery`. Scans each session dir for sidecars (Tier 1) and live run dirs (Tier 2), caches by mtime, prunes, applies the 7-day age gate and dismiss overlay. |
| `processRegistry.ts` | Reads Claude Code's live process registry (`~/.claude/sessions/<pid>.json`) and confirms each pid with `kill(pid, 0)`. The one source of *actual* process liveness in an otherwise disk-tailing monitor. Owned by `SessionDiscovery` (scanned on a relaxed cadence); exposes `getLiveProcesses()` / `isSessionLive()` / `isActive()`. Injected into each `SessionManager` as a tri-state `livenessProbe` that powers the permission-false-positive gate (a registry-confirmed-dead session can't be `waiting` — see Status inference §6). A hit is a strong positive, a miss is "unknown" (not every session class is guaranteed to register), and an inactive registry disables the gate. `isScanClean()` distinguishes a degraded scan (a non-ENOENT read error or unparseable content on a *present* file) from genuine absence, so a transient disk error on a live session's file degrades the probe to "unknown" rather than "dead" — only a clean scan's absence is trusted as death. |
| `detailPanel.ts` | Source-keyed editor-area webview host (`createWebviewPanel`, `ViewColumn.Beside`). One reused instance serves three drill-ins (workflow / team / subagents); builds a normalised `DetailModel` per source (with a cross-source view switcher for session-card sources) and resolves agent transcripts on demand via injected deps. Dedups re-pushes (`lastPushed` JSON compare). |
| `detailView.ts` | Detail-panel webview frontend. Two-pane navigator: left = collapsible groups → agents, right = transcript reader led by the agent's inception brief. Renders any `DetailModel` generically; redeclares its own view types (separate bundle). Clears its transcript cache when the drill-in identity (source + container) changes. |
| `detailViewScroll.ts` | Pure scroll-intent decision for the detail reader (agent change → top; at-bottom → live tail; scrolled up → preserve). Extracted because jsdom has no layout. |
| `teammateInbox.ts` | Serac's only write into `~/.claude/`: hardened append to a team member's inbox (realpath/lstat confinement, atomic `wx`+rename, `O_NOFOLLOW` + size-capped read, schema-strict kill-switch, NFKC + control/bidi rejection, per-inbox serialised queue, byte-accurate ring buffer). |
| `hookEventRouter.ts` | Fan-out + buffer-with-TTL for inbound Claude Code hook events; fed by `hookIngress/`, consumed by per-session tracker subscribers. |
| `hookIngress/` | Inbound hook transport: Unix-socket server + leader election (one listener across windows) + the forwarder handshake (`bin/serac-hook-forward.cjs`). |
| `trackers/` | Non-status enrichment slices (background shells, tool outcomes, permission timing, hook enrichment) — they never move `running`/`waiting`/`done`. |
| `teamDiscovery.ts` / `teamManifest.ts` | Agent Teams discovery (`~/.claude/teams/`), config parsing, workspace scoping, inbox target resolution. |
| `foreignWorkspaceManager.ts` / `siblingWorktreeManager.ts` / `worktreeRows.ts` | Out-of-window sections: foreign-workspace rows/strips and sibling-worktree cards. |
| `subagentTailerManager.ts` | Subagent transcript tailing + silent-subagent file scanning. |
| `validation.ts` | Webview→host message validation (the webview is untrusted). |
| `panelUtils.ts` / `footerSlots.ts` / `paths.ts` / `jsonlValidator.ts` / `gitWorktreeUtil.ts` / `claudeSettings.ts` / `toolProfiles.ts` / `workspaceOpener.ts` | Support modules: pure pill/format helpers, footer slot layout, path mapping, record validation, worktree enumeration, CC settings reads, the canonical tool-profile table, focus-safe workspace opening. |

The table is curated, not exhaustive — see `src/` for the full list.

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
running ──→ waiting       (AskUserQuestion, permission timer 3s/15s, all subagents blocked)
running ──→ done          (idle timer 5s, all-subagents-done, hard ceiling 3min, or Stop hook)
waiting ──→ running       (sidechain tool_result unblocks subagents, user record)
waiting ──→ done          (waiting hard ceiling 10min, or registry-confirmed process death)
running ──→ done          (registry-confirmed process death)
any ──→ done              (queue-operation: enqueue, JSONL truncation)
done ──→ stale            (display-only: acknowledged + 10s elapsed)
```

Internal statuses are `running | waiting | done`. `stale` and `idle` are display-only labels applied in `SessionDiscovery.getSnapshots()` and `panel.ts`.

### Timer hierarchy

`turn_duration` system records were never observed in production JSONL and were removed as a state signal in v0.9. Status now derives from record cadence and tool-completion signals.

1. **Tool completion signals** — `tool_result` blocks remove tools from `activeTools`; the all-subagents-done shortcut marks orchestrator turns complete immediately.
2. **Permission timer** — heuristic for stuck permission prompts. Base delay **3s** for normal tools, **15s** for slow tools (Bash, WebSearch, WebFetch, Skill, Monitor, MCP). Doubled (max **6s/30s**) if a tool result arrived within the last 3s, to absorb sequential auto-approved tools. The slow delay is deliberately generous: the `PermissionRequest` hook ingress is wired (socket server + leader election + forwarder), but until its positive path is validated against real captured payloads the timer remains the load-bearing signal, and a timer alone cannot distinguish a slow-*executing* tool from one *blocked* on a prompt — a long Bash (test/build/package) must be given time to finish before it is mistaken for a wait. See `permissionTracker.ts` FALSE-POSITIVE NOTE.
3. **Idle timer (5s)** — fires only if status is `running` AND output has been seen in this turn AND no blocking subagents are active.
4. **Extended thinking grace (30s)** — first 30s of a turn with no output yet uses PID-liveness check instead of demoting (covers slow first-token).
5. **Hard ceiling (3 min running, 10 min waiting)** — safety net; forces done regardless of state. Covers laptop sleep, quota hits, abandoned permission prompts.
6. **Registry-confirmed death (permission-FP gate)** — `demoteIfStale` resolves a `running`/`waiting` session to `done` at once (ahead of the hard ceiling) when the process-liveness registry (`processRegistry.ts`) confirms the backing process has exited; the same check suppresses the permission timer firing a false `waiting`. A dead process can't be blocked on a prompt, so this kills the stale "Waiting for your response". Conservative by design: it fires only when the session was *seen live in the registry before* and is now gone (`isConfirmedDeadByRegistry()` latches `everSeenLiveInRegistry`), so a session class the registry never tracks is never wrongly silenced, and an absent/empty registry is a no-op.
7. **`Stop` hook (when present)** — accelerates `running → done` to the instant the turn ends, ahead of the 5s idle timer. Sets the `turnEndedByStop` guard so the turn's trailing assistant record (polled 0.5–2s later) cannot re-fire `running`; the guard is released by the next genuine new-turn reopener (user record, `dequeue`, or `compact_boundary`) or on `resetState`. Pure acceleration — `done` is still reached by the idle timer when no hook arrives, so hookless sessions are unchanged. See "Hook consumption".

### Out-of-order tool_use/tool_result

Claude Code's JSONL writer occasionally flushes a `tool_result` record before its
matching `tool_use` (file order reversed despite an earlier wall-clock timestamp on
the `tool_use`). Without compensation, the late `tool_use` adds an entry to
`activeTools` that nothing ever clears, and `demoteIfStale` falsely promotes the
session to `'waiting'` after 30 s of silence. `SessionManager.earlyToolResults`
tracks IDs whose `tool_result` arrived first, so the late `tool_use` can be skipped.

### Permission-exempt tools

These tools never trigger permission wait detection: `Agent`, `Task`, `TodoWrite`, `ToolSearch`, `Read`, `Glob`, `Grep`, `Edit`, `Write`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `PushNotification`, `TaskOutput`, `TaskStop`, `SendMessage`, `TeamCreate`, `TeamDelete`, `NotebookEdit`. See `toolProfiles.ts` for the canonical list.

### Subagent permission bubbling

Each subagent runs its own permission timer against `subagent.activeTools`. When it fires, the subagent is marked `waitingOnPermission`. The parent only transitions to `waiting` when **all** running subagents are blocked — a single-subagent block doesn't bubble if other subagents are still progressing.

Subagents are further classified for demotion:
- **Blocking subagent** — `parentToolUseId` is still in the parent's `activeTools` (parent waiting for the Task/Agent result). Suppresses parent demotion.
- **Background subagent** — parent has moved on (`parentToolUseId` no longer in `activeTools`). Does NOT suppress demotion; parent can demote to `done` while the background subagent finishes.

### Background-shell signal (SPIKE — non-status enrichment)

A `Bash` launched with `run_in_background: true` returns its `tool_result`
immediately ("Command running in background with ID: `<id>`"), so the turn ends
and the idle/`Stop` path correctly marks the session `done` — while a detached
build/deploy keeps running, invisible to the JSONL until the agent retrieves it
in a later turn. `BackgroundShellTracker` (`trackers/backgroundShellTracker.ts`)
tracks those outstanding shells purely for display: it is **strictly
non-status** (same charter as `ToolOutcomeTracker`) and never moves
`running`/`waiting`/`done` — `done` still means the turn ended, which is true.

- **Source:** main-thread `tool_result` text only (string-matched, hence
  brittle — these are Claude Code surface strings, not an API). Launch banner
  adds a shell; a terminal retrieval (`<task_id>` + `<status>completed|failed|
  killed|…</status>`) clears it. A `<status>running</status>` poll does not.
- **Clearing (three paths):** (1) a terminal retrieval clears its shell on the
  normal update path; (2) a shell never observed completing is pruned after
  `BACKGROUND_SHELL_CEILING_MS` (15 min), mirroring the status ceilings so the
  signal can't stick forever; (3) confirmed process death clears all outstanding
  shells at once. Paths 2–3 run in `SessionManager.sweepBackgroundShells(now)`,
  which the poll loop calls over **dormant** (done/stale/idle) sessions every
  cycle — decoupled from mtime/new-data, because an idle `done` card never
  re-enters `demoteIfStale` and would otherwise never prune or clear. The sweep
  returns true when the count actually drops so `pollInner` sets `changed` and
  pushes the cleared badge (a `done` card's status never changes, so the demote
  path alone would never trigger a push). The death clear reuses the conservative
  registry tri-state (`isConfirmedDeadByRegistry()`, same as the permission-FP
  gate above).
- **Surface:** `SessionSnapshot.backgroundShellCount` (undefined when none),
  carried through to the webview on `PanelSession`.
- **Display:** rendered as a quiet `.bg-shell-badge` ("⚙ N shell(s) running",
  running-accent tint) in the card meta row by `panel.ts:renderCardInner`,
  whenever the count is `> 0` — on any status, including `done`. The badge is
  additive and never changes the card's status class, so the flicker-prone
  status path stays untouched. Ungated: the count is only non-zero when
  detection fires, and the fail-safe on a wording change is to show nothing.

### Orphan/live annotation (processLive)

`SessionSnapshot.processLive` is the registry tri-state surfaced for display:
`true` = the CC process is registered live right now (a `done` card is
resumable in its terminal), `false` = seen live before and now absent
(confirmed ended), `undefined` = can't say (no probe, degraded scan, or never
seen live). Computed by `SessionManager.registryLiveness()`, the same helper
(and the same persisted seen-live latch) behind `isConfirmedDeadByRegistry()`
— so a snapshot render latches evidence the death-gate later relies on.
Rendered only on terminal cards as a quiet `live`/`ended` qualifier inside the
status pill (`panelUtils.ts:getStatusLabel`); active cards are never
annotated, and the unknown state shows nothing rather than guessing.

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
| `PermissionRequest` | ✅ | consumed + `tool_name`-keyed label (done) | ground-truth `waiting` for permission **and** AskUserQuestion; label keys off the tool's `userInput` profile, and `userInput` tools bypass the active-tool gate to accelerate ahead of JSONL |
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

Independent follow-ups (both done 2026-06-01):
- **AskUserQuestion acceleration + `tool_name`-keyed label** (done). The
  `PermissionRequest` subscriber now threads the event's `tool_name` to
  `onWaitingFired(toolName?)`, which keys the activity label off the tool's
  `userInput` profile (AskUserQuestion → "Waiting for your response", else
  "Waiting for permission"). The timer variant passes no `toolName` and the host
  falls back to scanning `activeTools`. **Gate nuance:** the `activeTools`-non-empty
  gate is bypassed *only* for `userInput` tools, so AskUserQuestion accelerates
  to `waiting` ahead of its JSONL `tool_use` record (activeTools still empty),
  while non-input tools keep the gate — otherwise the trailing JSONL `setRunning`
  would flip them `waiting → running`. Safe because the JSONL path *re-affirms*
  `waiting` for `userInput` tools rather than running them.
- **Forwarder perf cleanup** (done) — see Cost. Lazy-`require('node:net')` on the
  no-socket fast path, `SOCKET_TIMEOUT_MS` 1000 → 250 to cap tail latency, and an
  honest bench that reports overhead above the ~30 ms Node-boot floor (≈5 ms) rather
  than an unachievable sub-30 ms absolute.

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

When `groupForeignWorkspaces` aggregates 2+ foreign workspaces sharing a `repoRoot`, the synthetic row becomes click-to-expand (chevron, no `data-cwd`). Expanding inlines one child row per worktree of the repo (read from `<repoRoot>/.git/worktrees/*` by `ForeignWorkspaceManager`, refreshed on the same 60s cadence as the local `discoveredWorktrees`). Per-worktree counts come from the pre-aggregation `members` preserved on the synthetic row. Inactive worktrees (no Claude Code activity within the foreign-workspace age gate, `ageGateDaysFor('foreignWorkspaces')`) still appear, marked with a quiet "no activity" tag. Picking a worktree posts `openWorkspace` and auto-collapses the parent; an idle expand collapses after `serac.worktrees.autoCollapseAfterSeconds`.

#### `/private/tmp` pseudo-repository

Scratch sessions under the temp root aren't git repos, so each would otherwise show as its own flat "Other workspaces" row. When `serac.worktrees.consolidateTmp` is on, `ForeignWorkspaceManager.getWorkspaces` overlays a synthetic `repoRoot` of `PSEUDO_TMP_REPO_ROOT` (`/private/tmp`) onto any workspace whose cwd is under `/private/tmp` or `/tmp` (`isTmpScratchPath`) **and** has no real git `repoRoot`. The overlay is applied at read time, not baked into `repoRootCache`, so toggling the setting takes effect on the next poll without a cache flush. `groupForeignWorkspaces` then folds these into one `tmp` row flagged `pseudoRepo: true`. Because a pseudo root has no `.git`, there are no enumerated worktrees: the row withholds `cwd` (no canonical checkout to open), its chip reuses the `Nwt` suffix marked with a `*` (e.g. `2wt*`, explained in the chip tooltip — they aren't real git worktrees, and `Nd` was avoided since `d` reads as the Done count or "days"), and the inline picker is driven by `members` (one child per scratch dir, no main/detached/no-activity hints) rather than `worktrees`. Real git-repo aggregation is unaffected.

## Configuration

The extension exposes a `serac.*` namespace via `package.json#contributes.configuration`. Reads go through a single typed accessor in `src/settings.ts` — with one deliberate exception: `serac.hooks.*` is read directly in `extension.ts` (and written via `hookSettings/patcher.ts`), because hook enable/debug gates run before the settings snapshot exists.

- **Reading:** `readSettings(): SeracSettings` returns a complete snapshot, falling back to `DEFAULT_SETTINGS` for any unset key. Defaults match the historical hardcoded constants so an upgrade with no `serac.*` keys behaves identically.
- **Reactivity:** `onSettingsChanged(cb)` wraps `vscode.workspace.onDidChangeConfiguration` and fires the callback with a fresh snapshot whenever any `serac.*` key changes. `extension.ts` posts a new `settings` message to the webview and (when `serac.refresh.intervalSeconds` changed) rebuilds the refresh timer.
- **Webview side:** `panel.ts` caches the last received `SettingsMessage` in `currentSettings`. Render functions consult it directly for visibility gates (`show.foreignWorkspaces`, `show.worktrees`, `show.usage`, `show.subagents`, `show.teams`), thresholds (`usage.warnAtPercent`, `usage.criticalAtPercent`), and limits (`archive.maxDoneShown`, `worktrees.autoCollapseAfterSeconds`).
- **Discovery managers** (`foreignWorkspaceManager`, `siblingWorktreeManager`, `teamDiscovery`, `workflowDiscovery`) call `readSettings()` at the top of `scan()` / `poll()` to:
  - Short-circuit when the corresponding `show.*` setting is false (no background work for hidden sections).
  - Resolve their section's age gate via `ageGateDaysFor(section)`. `discovery.ageGateDays` is the inherited base; each section (`foreignWorkspaces`, `worktrees`, `teams`, `workflows`) may override it with `discovery.<section>AgeGateDays` (null = inherit). The resolver is the only supported read path, so the inherit-when-unset rule lives in one place; a non-positive or absent override falls back to the base rather than disabling the gate.
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

## Workflow discovery (Opus 4.8)

Serac surfaces Opus 4.8 **Workflow** runs (the built-in fan-out orchestration tool) as ordinary session cards. The pipeline mirrors the Agent Teams path: `WorkflowDiscovery` → `WorkflowSnapshot` → `panelProvider` → `panel.js`, owned by `SessionDiscovery` alongside `teamDiscovery`.

### On-disk model

Per parent session at `~/.claude/projects/<workspaceKey>/<sessionId>/`:

- `workflows/wf_<runId>.json` — the **completion-only** sidecar (written once, at the end of the run). Render-ready: top-level roll-ups plus a `workflowProgress[]` array interleaving `workflow_phase` and `workflow_agent` entries (`phaseIndex` is 1-based). Embeds the full script and result blobs, so it is 48–85 KB+ — read lazily and cache by mtime.
- `workflows/scripts/<name>-<runId>.js` — the script. Begins with `export const meta = { name, description, phases }`. **Never eval'd** — `workflowScript.ts` extracts the meta statically.
- `subagents/workflows/<runId>/agent-<agentId>.jsonl` — per-agent transcripts in the same `isSidechain` format the renderer already handles; `journal.jsonl` records `started`/`result` pairs.

### Two tiers

- **Tier 1 — completed (sidecar present), the common case.** `parseWorkflowSidecar()` reproduces the `/workflows` phase-grouped tree exactly: phase grouping, per-agent tokens/tools/duration/state, roll-up metrics, and `log()` narrator lines all read directly. Zero correlation, no heuristics.
- **Tier 2 — live (run dir exists, no sidecar yet).** Phase scaffold from the script's `meta.phases`; agents listed from the journal. Each running agent is correlated back to its phase by `extractAgentCalls()` (the static `agent(prompt, {label, phase})` call sites, never eval'd) matched against the agent's record-0 prompt: the longest distinctive *static* segment of a call's prompt that appears verbatim in the expanded prompt wins (interpolated `${...}` parts differ per agent, so we key off the static text around them). An agent whose prompt is a bare expression (e.g. `agent(c.prompt)` in a loop) has no static segment to match, so it falls back to a flat, ungrouped entry labelled by its journal key. Low-stakes either way: completion immediately materialises the perfect sidecar. Stale live runs that never produce a sidecar (killed/abandoned) are filtered by the 7-day age gate and marked `incomplete`.
  - **Agent labels.** A plain literal `label` is used as-is. An *interpolated* label (`` `audit:${d.key}` ``, shared by all fan-out agents of one call site) is resolved per-agent by `recoverInterpolatedLabel()`: it aligns the prompt template's static segments against this agent's expanded prompt to read the runtime value of each `${…}` (the label and prompt share the same scope, so an expr like `d.key` appearing in both is recoverable), giving distinct rows (`audit:privacy`, `audit:security`, …). When recovery fails it falls back to a phase-scoped, agent-distinct label (`Audit · <shortId>`). A raw `${…}` is **never** surfaced to the webview. (The completion sidecar carries real per-agent labels from the runtime and bypasses all of this.)

### Status mapping

The sidecar's per-agent `state` maps to `DisplayStatus`; run `status` maps to `WorkflowRunStatus` (`completed` / `running` / `failed` / `incomplete`). Sidecar roll-up numbers are preferred over recomputation (retries are surfaced via `attempt`).

### Rendering

A session that owns run(s) renders as a normal card with: a clickable detail chip in the meta row (labelled `workflow`/`workflows`, or `agents` when the session also has plain subagents) that opens the detail panel **and** focuses the conversation; a **glance-only** roll-up (progress bar + a single count, e.g. `2/4 agents` / `✓ 4 agents` / `run failed`). The per-phase pills, token/tool/duration metrics, and per-agent rows are **not** on the card — they live in the detail panel. Likewise the subagent section on a session card is just the summary line (`3 subagents: 1 waiting, 2 running`); the per-agent rows + result previews are panel-only. The chip is tinted by the **agents' own** aggregate state (`wf-chip-*`: running/waiting/failed/done), dimmed when the parent card is seen/stale. Card-body click opens the **invoking conversation**; the chip opens the **detail panel** (`detailPanel.ts`) beside it. All gated behind `serac.show.workflows`.

Compatibility/safety: malformed agent entries are skipped (the rest still parses); `getWorkflowAgentFilePath` validates `runId`/`agentId` against path traversal and existence-checks before returning.

## Detail panel (source-keyed agent navigator)

One reused editor-area webview (`detailPanel.ts` host + `detailView.ts` frontend, `ViewColumn.Beside`) serves three drill-ins that share a parent → children shape. The card/header chip posts `openDetail { source, containerId, sessionId }` and also focuses the invoking conversation (the panel docks beside it); the host builds a normalised `DetailModel` (header chips + metrics, left-pane groups → agents) and the frontend renders it generically. The reader resolves the selected agent's transcript on demand (`viewAgent` → injected `resolveAgentFile` → `parseTranscript()`), leads with the agent's **inception brief** (its first prompt turn, pulled out and pinned in a collapsible block at the top), and the header's "↗ open conversation" jumps back to the invoking session. The left nav collapses to a rail to free reader width.

**View switcher (session-card sources).** A session's agents can come from more than one source — each workflow run it owns, plus its plain Task subagents — so the card shows a **single** chip (specifically labelled when one source exists, neutral `agents` when both) and the panel header carries a **view switcher** (`buildViewChoices`, generalising the old run switcher) across every workflow run + a `Subagents` entry. Selecting a chip posts `selectDetailView { id, kind }`; the host flips `source` (and `selectedRunId` for a workflow view) and re-renders. `views` is omitted when only one view exists. The `team` source is a separate surface (team-group header) and has no view switcher. **The switcher chips are grouped by source** (`detailView.ts:renderSwitcher` — Workflows / Subagents / Agent team) with sub-labels when more than one kind is present, flat otherwise.

**Left-nav collapse.** The agent list collapses to a thin rail to hand width to the reader. Collapse is **manual** (the `‹`/`☰` toggle) — selecting an agent never auto-collapses, so you can click through the roster. State lives as a `nav-collapsed` class on the persistent `#wf-root`; the toggle handler flips the class **without re-rendering**, so the existing `.wf-nav` width animates (and the `flex:1` reader widens in lockstep) instead of being destroyed and rebuilt. The full roster is always in the DOM (CSS clips/fades it when collapsed); `prefers-reduced-motion` disables the transition.

| Source | Chip / entry point | Left-pane grouping | Transcript resolver |
|--------|--------------------|--------------------|---------------------|
| `workflow` | session-card chip (`workflow`/`workflows`, or `agents` when subagents also present) | phases → agents (`runId` is the group key) | `getWorkflowAgentFilePath(runId, agentId)` |
| `subagents` | session-card chip (`subagents`, or folded into `agents`; gated on `serac.show.subagents`) | flat list of the session's Task subagents | `getSubagentFilePath(sessionId, agentId)` → `<sessionDir>/subagents/agent-<agentId>.jsonl` |
| `team` | `view agent team →` on the team-group header | flat roster, keyed by member name | `getTeamAgentFilePath(teamId, memberName)` |

`getTeamAgentFilePath` resolves a member with its own `sessionId` directly; for a null-sessionId member it scans the lead session's `subagents/agent-*.meta.json` for `agentType === memberName` (matched only against roster names so it can't collide with a plain Task subagent), returning the sibling `agent-<hash>.jsonl` (newest by mtime when re-runs leave duplicates). All resolvers validate ids against path traversal and existence-check before returning; an unresolved agent yields a graceful "Transcript not available yet." note.

### Transcript timestamps

Each turn carries a quiet relative-then-absolute time label (`detailView.ts:formatRelativeTime`/`renderTime`): `just now` → `Nm ago` → `Nh ago`, crossing over to an absolute date (`6 Jun`, with the year when not current) once ≥ ~24 h old. The full local date-time is always on hover (`title`). The host already populates `TranscriptEntry.timestamp` from the JSONL; the webview is a browser context, so `Date` is unrestricted here. The inception-brief head is stamped too; a record with no parseable timestamp renders no label.

### Live transcript streaming + intuitive scroll

A running agent's transcript streams: one persistent `setInterval` (`startRefreshLoop`, paused while `document.hidden`) re-requests `viewAgent` for the selected agent **only while its status is `running`**, at a steady ~2.5 s cadence. The cache is not touched on a refresh tick, so the current turns stay visible until the refreshed ones swap in (no loading flash). The host re-reads + re-posts on each `viewAgent` (incremental tailing is a deferred optimisation).

Scroll is intent-aware (`detailViewScroll.ts`, a pure helper so it's unit-testable without a layout engine): on **agent change** the reader starts at the **top** (read the brief); on the **same agent while already at the bottom** it sticks to the **bottom** (live tail); on the **same agent while scrolled up** it preserves the prior offset (appended turns stay below the fold, nothing jumps). "At the bottom" is `isNearBottom` within `STICK_THRESHOLD_PX` (40 px).

### Teammate messaging (experimental — the only write into `~/.claude/`)

Behind `serac.experimental.teammateMessaging` (default off), an inline composer at the foot of a **running in-process teammate's** transcript writes a message directly into that member's inbox (`~/.claude/teams/<team>/inboxes/<member>.json`) — Serac's sole write into `~/.claude/`. Direct delivery bypasses the team lead and has **no delivery guarantee** (the member drains its inbox on its own ~5-6 s poll; a send in that drain window can be lost — the UI discloses this and says to resend if unconfirmed). The sender label (`from`) is `serac.experimental.operatorName`, synthesized **server-side** (never accepted from the webview, so no lead/member impersonation).

Flow: the composer (a persistent sibling **outside `#wf-root`** so `render()`'s `innerHTML` swap never wipes a draft) posts `sendTeammateMessage { source, containerId, agentId, text }`. The host handler (`detailPanel.ts:handleSendTeammateMessage`) fails closed at every step, **in this order**: (1) re-check the flag server-side (a webview-cached flag is never trusted); (2) `validation.ts:parseTeammateMessageCommand` — pins `source === 'subagents'`, path-safe + 64-char-capped ids, bounded text, and never reads a webview `from`; (3) synthesize + validate `operatorName`; (4) `teamDiscovery.resolveInboxTarget` maps the orchestrator session + subagent hash → `{ teamDir, member }` by **roster** (reads the one `agent-<hash>.meta.json`, size-capped, accepts `agentType` only if it's a current roster name); (5) `teammateInbox.ts:appendInboxMessage` writes. Errors surface **in-webview only** (a toast would steal focus); the OutputChannel logs **metadata only** (never the message text — it could carry a pasted secret).

`teammateInbox.ts` is the hardened write boundary (pure `fs`, unit-tested): realpath/lstat **confinement** under `<teamsDir>/<team>/inboxes/` (a symlinked team dir, inboxes dir, or target file is refused); a **schema-strict kill-switch** read (non-array / unparseable / forbidden-key shape → refuse rather than overwrite, foreign entries preserved verbatim) opened with **`O_NOFOLLOW`** so a symlink swapped into the target after the confinement check is refused (`ELOOP`), not read through; an **atomic** write (crypto-random temp + exclusive `wx` create at `0o600` + rename — and `rename` *replaces* a symlink at the destination rather than following it, so the write side is symlink-safe too); a **per-inbox serialised queue** (depth-capped, so a burst can't grow unbounded; an `EEXIST` from a second writer racing the `inboxes/` creation is absorbed and re-validated, not surfaced raw); a **ring-buffer** size cap; and **NFKC normalisation with rejection of control/bidi characters** (which render invisibly but still reach the receiving LLM, so they could hide injected instructions). The team-discovery read path that feeds it is size-capped to match (1 MB per `config.json`, 64 KB per `agent-*.meta.json`). After a send, the webview bursts the refresh loop to ~1 s for ~15 s to catch the reply. The composer is gated client-side too (display-only flag + running-teammate check), but the host re-check is the authority. Residual, disclosed risks: the drain-window race, prompt-injection of the receiving agent (receiver-side framing belongs in `serac-snowmelt-companion`), and a fully-compromised `~/.claude` (already game-over).
