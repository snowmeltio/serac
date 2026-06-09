# Serac — Backlog

Candidate work, not yet scheduled.

## Orchestration views ("GUI for terminal-native features")

- **Loops (`/loop`).** No dedicated state file, but `ScheduleWakeup`/`CronCreate` records + the `loop` skill's records appear in the parent session transcript (Serac already tails these). Surface a "looping" badge + interval/next-fire on the session card. The natural next orchestration view after workflows.
- **Schedules / routines (`/schedule`).** No local disk state — remote/cloud-managed (`CronCreate`/`CronList`). Not file-tailable; needs a CLI/API integration, a different class from everything else Serac does. Separate spike.
- **Process-liveness applications.** The reader (`processRegistry.ts`) is shipped (reads `~/.claude/sessions/<pid>.json`, confirms each pid with `kill(pid, 0)`, exposed on `SessionDiscovery` as `getLiveProcesses()`/`isSessionLive()`). Two consumers now gate on it via `SessionManager.isConfirmedDeadByRegistry()` (conservative tri-state — dead only when seen-live-before-and-now-gone): the **permission false-positive gate** (`demoteIfStale` resolves a dead `running`/`waiting` session to `done`) and the **background-shell sweep** (clears outstanding shells on confirmed death). Remaining candidate consumers:
  - **Orphan/live signal on cards.** Mark terminal (done/stale) sessions with no live process as "ended/orphaned"; positively confirm live ones. Reuse existing status styling (no new chrome). Safe — only annotate already-terminal sessions; never downgrade an active one (a hit is a strong positive, a miss is "unknown", since not every session class is guaranteed to register).
  - **Live-only mode for "Other workspaces"** (see below).

## Teammate messaging — direct line to a team member (candidate)

**Idea (Murray, 2026-06-04):** an inline message composer at the **foot of a teammate's transcript** in the detail panel — type, send, and the member receives it directly (no orchestrator relay). Plus near-real-time refresh of the transcript so the reply shows up.

**Mechanism — verified empirically (2026-06-04, throwaway teams `serac-inbox-spike` / `serac-from-spike`; no code written):**
- In-process members **poll their inbox file** `~/.claude/teams/<team>/inboxes/<member>.json` and **consume external writes** — a plain filesystem append (no `SendMessage`) is picked up in **~5–6s** (n≥3). The write path is real, not just a mirror.
- The host **drains the file to `[]`** on its own poll. Worker inbox files are **created lazily** (absent until first delivery).
- The **`from` field is passed through verbatim — NOT validated against the roster.** Injecting `from:"operator"` / `"ghost-narwhal"` both delivered and were shown to the member as that sender; `from:""` renders as `UNKNOWN`. → **Use an honest sender label** (e.g. `operator` / a real name); no need to impersonate `team-lead`. Never send empty `from`.
- Delivery is **sequential — ~1 queued message per poll tick (~6s)**; a rapid multi-send drains slowly.
- Entry schema (v2.x): `{"from":"operator","text":"<msg>","timestamp":"<ISO>","color":"<c>","type":"message","read":false}`. Cross-ref `[[project_agent_teams_disk_state]]`.

**Identity story by member type (the crux):**
- **tmux members (team source):** clean — `containerId` (`at:<dir>`) gives the team, `agentId` is the member; inbox path fully recoverable. tmux delivery itself **not yet verified** (Medium: likely behaves like in-process).
- **in-process members (the VS Code default; render as the lead's *subagents*):** the webview `agentId` is a **subagent hash, not the member name** — the host must resolve hash→roster name (via `agent-*.meta.json` `agentType`↔roster, as `teamDiscovery.getTeamAgentFilePath` already does) before writing `inboxes/<member>.json`. Team name comes from `model.team`. **This is the target case** (the only one Serac's VS Code users have); the resolver is required. The clean tmux case is out of scope (no terminal panes).

**Real-time refresh:** plumbing exists (`detailView.ts` re-renders on a tick; host pushes `agentTranscript`; members carry live `status`). Tighten cadence for the selected live member and **burst-poll (~1s for ~15s) after a send** to catch the ~5s-delayed reply, then back off; use the existing `SessionManager` tailer (incremental), not full JSONL re-reads. **Collision:** `detailView.ts` renders via `root.innerHTML = …` (full replace, *not* the sidebar's keyed reconciler) — frequent refresh wipes the textarea (value/focus/caret/IME) every tick. The composer **must live outside `#wf-root`** or be re-seeded each render. This is the #1 UI build risk and is caused directly by the refresh requirement.

**Risk register (handling user input + crossing read-only → write):**
- *Tier 1 — defines whether it's safe:*
  - **Read-only → write boundary.** First time Serac writes into `~/.claude/`; a bug can now corrupt agent state. Contain to `inboxes/<member>.json` only (never config/tasks/JSONL); reuse existing path-traversal validation; **gate behind an experimental setting, default-off** (cf. `serac.show.workflows`). Same settings group carries the **operator identity** used for `from` (e.g. `serac.experimental.teammateMessaging` + `serac.experimental.operatorName`, default `"operator"`, user-editable to their name).
  - **Second-writer race — inherent.** The owner drains on its ~5s poll; Serac's read-modify-write races it (resurrect/drop/partial-array). Atomic write (tmp+rename), re-read immediately before write, serialise Serac's own sends via a per-file queue. **Residual race unavoidable** — no sanctioned send API, file-write is the only lever; we can't hold the owner's lock.
  - **In-process identity resolution** (above) — a wrong hash→name writes the wrong/dead inbox.
- *Tier 2 — manageable engineering:*
  - **Schema fragility** (undocumented format): validate the existing file shape before writing; **refuse on surprise** rather than guess; behind the flag with a kill-switch.
  - **Composer/refresh isolation** (above).
  - **Refresh cost:** incremental tailing; stick-to-bottom unless the user scrolled up.
- *Tier 3 — accept + disclose:*
  - **Lead desync:** a direct message bypasses the lead's coordination and the lead has no record of it. Disclose in UI ("direct — bypasses the lead").
  - **No delivery receipt:** infer delivered from the file draining + a new turn appearing; show sent→delivered; warn if no drain within ~10s.
  - **Liveness staleness:** gate on `status==='running'` (already in the model).
  - **Webview XSS:** escape user input *and* member replies through the bespoke markdown renderer; validate inbound host messages.

**Decisions (all resolved 2026-06-04 — ready to plan):** (1) scope — **in-process members only.** tmux is out of scope: Serac runs in the VS Code extension with no terminal panes, so users never have tmux members. The hash→roster-name resolver is therefore **required**, not optional. (tmux would be a near-free follow-on via the clean roster identity if that ever changes, but it's not a goal.) (2) sender label — send as a **configurable operator identity** (experimental setting, default `"operator"`, user-editable to their name); no lead-impersonation. (3) **ship behind an experimental default-off flag — yes.**

## Background-shell signal ("DONE while a build is still running")

Origin: a card showed `DONE · 49s` while the chat had launched `./deploy.sh` with `run_in_background: true` and ended its turn on "Stand by." The status is correct — the *turn* ended (`Stop`/idle → `done`) — but a detached shell kept running, invisible to the JSONL until the agent retrieves it in a later turn.

**Shipped (spike, 2026-06-03).** Detection layer, proven end-to-end against the real `672181b9` records:
- `trackers/backgroundShellTracker.ts` — strictly **non-status** enrichment (same charter as `ToolOutcomeTracker`); never moves `running`/`waiting`/`done`. String-matches launch ("Command running in background with ID: `<id>`") and terminal retrieval (`<task_id>` + `<status>completed|failed|killed|…`) from main-thread `tool_result` text; `<status>running</status>` polls don't clear. 15-min hard ceiling pruned in `demoteIfStale`. Surfaced as `SessionSnapshot.backgroundShellCount`. 14 co-located tests; full suite green.

**UI surfacing — shipped 2026-06-03 (status policy: option A).** A quiet "⚙ N shell(s) running" badge rides the card meta row whenever `backgroundShellCount > 0`, tinted with the running accent (`--sm-blizzard-blue`, `.bg-shell-badge` in `panel.css`). **Non-status:** the card keeps its real status (a `done` card stays `done`), so the Stop/idle path is untouched — no `done→running→done` flicker. Rendered in `panel.ts:renderCardInner` after the model pill; `PanelSession.backgroundShellCount` carries it through. Ungated (no `serac.show.*` toggle): the count is only ever non-zero when detection fires, and the fail-safe if Claude Code's wording changes is to show nothing.

**Remaining (minor):**
- **Bug — badge not clearing. FIXED 2026-06-04.** See Shipped → "Background-shell badge clears on idle done cards".
- **Completion-replay test.** When a background shell finishes, CC re-invokes the model → the next assistant record flips the card back to `running` via the normal path and the tracker clears the count on the terminal retrieval. Covered by the tracker unit tests; not yet by an end-to-end integration replay.

## Detail panel UX

- **Don't auto-collapse the agent list when clicking through (Murray, 2026-06-04).** In the detail panel, selecting an agent currently collapses the agent list, so stepping through agents one-by-one means re-expanding each time. Keep the list expanded while navigating between agents — let the user click through without losing the list.
- **Collapsing the agent list should widen the transcript to full (Murray, 2026-06-04).** When the user *does* collapse the agent list, reclaim the freed space — expand the transcript view to fill the full panel width rather than leaving a gap.
- **Agent list should expand/compress smoothly (Murray, 2026-06-04).** Animate the collapse/expand transition rather than snapping — a smooth width/visibility transition as the list opens and closes (in concert with the transcript widening above).
- **Separately group workflows, subagents, and agent teams at the top of the view (Murray, 2026-06-04).** Rather than a single flat agent list, split the top of the detail view into distinct groups by source — workflows, subagents, and agent teams — so each kind is visually delineated rather than intermixed.

## Other workspaces

- **Freshness audit — are foreign workspaces and worktrees as up-to-date as the primary view? (Murray, 2026-06-04).** Verify that foreign-workspace and worktree cards reflect the *current* state, drawing on every signal the primary workspace already uses: hook-based status inference, in-flight workflows, active teams, background shells, and the process-liveness reader. Concern: these out-of-window sections may be inferred from staler/cheaper data (e.g. mtime + age gate only) and lag the live state. Confirm whether they're refreshed on the same cadence and through the same inference path, and close any gap so a foreign workspace/worktree shows the same currency as a local card.
- **Visibility window — partly shipped 2026-06-03 (option b).** The age gate is now **decoupled per section**: `serac.discovery.ageGateDays` (default 7, min 1) is the inherited base, and each of `foreignWorkspacesAgeGateDays` / `worktreesAgeGateDays` / `teamsAgeGateDays` / `workflowsAgeGateDays` (null = inherit) can override it. Resolve via `settings.ageGateDaysFor(section)`. Still candidate: (a) **presets** instead of a raw day count — session-only / 1d / 7d / 30d / forever; (c) a **"live only" mode** keyed off the process-liveness reader — show only workspaces with a live Claude process and ignore the time gate.

## Workflow viewer

- **Live-tier agent labels show raw template-literal source (Murray, 2026-06-09).** A running workflow's agent rows render `audit:${d.key}` verbatim — the un-interpolated `agent()` `label` template — repeated identically for every fan-out agent. Observed on session `8400f83c`, run `wf_2647e7a9-707` (`audit-claude-profile-system`): five agents, all labelled `audit:${d.key}`.

  **Cause (confirmed).** `workflowScript.ts:extractAgentCalls` pulls `opts.label` as a static string via `matchStringField`, so a backtick label `` `audit:${d.key}` `` is captured with its `${...}` intact (the script is never eval'd, by design). `workflowDiscovery.ts:buildLiveSnapshot` then assigns that one static string to every agent matched to the call site (~line 301). Two failures compound:
    1. **Un-interpolated** — the `${d.key}` is literal source, not a value.
    2. **Non-distinguishing** — all fan-out agents share one `agent()` call site, so the static label is identical across rows; even stripped of `${...}` they would collapse to `audit:`.
  The journal `key` fallback (`label = key`, ~line 294) is no better: it is a `v2:<sha256>` cache key, not a name. The `phase` (`'Audit'`) is a plain literal and resolves correctly — only the label is broken. Live-tier only; the completion sidecar carries real per-agent labels written by the runtime and is unaffected.

  **Fix options (ranked):**
    - **(Recommended) Recover the interpolated value from the prompt.** `matchAgentCall` already reads each agent's record-0 prompt; the real per-agent value sits between the call's static segments (the prompt contains e.g. `=== YOUR DIMENSION: privacy ===`). Align the template's static segments against the prompt to extract the interpolated slice and rebuild a true label (`audit:privacy`). Highest value, most work.
    - **(Cheap, correct) Detect `${` in the extracted label and discard it**, falling back to a phase-scoped ordinal (`Audit #1…#5`) or `<phase> · <short agentId>`. Honest and distinguishable; no interpolation recovery.
    - **(Minimum) Strip the `${...}` tail** so it reads `audit:` not `audit:${d.key}` — removes the raw source but leaves rows indistinguishable. Weakest.
  Whichever lands, gate the static label behind an interpolation check so a raw `${...}` never reaches the webview.

## Settings / configuration

- **Consolidate the settings into grouped sections (Murray, 2026-06-09).** The extension contributes **27 settings under a single `contributes.configuration` block titled "Serac"**, so the VS Code settings pane renders one long alphabetical list. VS Code auto-subgroups by the id's second segment, giving 11 ad-hoc clusters — several of them singletons (`animations`, `cleanup`, `refresh`, `foreignWorkspaces.maxHeightPx`) floating between the dense ones (`show.*` ×6, `discovery.*` ×5) — with no narrative order.

  **Fix.** Split the single `configuration` object into an **array of titled blocks** (VS Code renders each as its own section in the settings table of contents, sequenced by an `order` field). Proposed grouping:
    - **Display & sections** — `show.*` (the six visibility toggles), `animations.enabled`, `foreignWorkspaces.maxHeightPx`, `worktrees.maxHeightPx`/`autoCollapseAfterSeconds`/`consolidateTmp`.
    - **Discovery & freshness** — `discovery.*` (base age gate + four per-section overrides), `refresh.intervalSeconds`.
    - **Usage & quota** — `usage.*`.
    - **Session confidence** — `sessions.highConfidenceSeconds`/`mediumConfidenceSeconds`.
    - **Hooks** — `hooks.enabled`/`debug`.
    - **Behaviour** — `cleanup.confirmRequired`, `archive.defaultRange`/`maxDoneShown`.
  Keep the existing setting ids (no migration) — grouping is presentation-only via the manifest. Optionally rationalise stragglers later (fold the `worktrees.*`/`foreignWorkspaces.maxHeightPx` view knobs nearer the `show.*` toggles they relate to), but that renames ids and is not required for the consolidation.

## Hooks — wire the inbound forwarder (ground-truth events)

- **Wire `hookEventRouter` to a real inbound source (Murray, 2026-06-09).** `hookEventRouter.ts` + `HookPermissionTracker` are built but the router is a **stub — no production caller feeds it**, so `PermissionRequest` events never flow and the permission timer is the sole signal. Attach an inbound forwarder (Unix socket / HTTP via `bin/serac-hook-forward.cjs`) so the tracker gets ground truth (25-29 ms vs the 3-15 s heuristic). **Payoff:** the slow-tool permission delay (bumped 6s→15s as a stopgap, see Shipped) can drop back down once a genuine prompt fires the hook — and the same stream unlocks low-latency status/`Stop`/subagent signals generally. This is the **structural cure** for the "Waiting for permission" false positive; the 15s delay is the interim mitigation. Cross-ref `[[project_permission_false_positives]]`, HOOK-MONITORING.md.

---

## Shipped (was on this backlog)

- **Background-shell start anchored to the record timestamp (2026-06-04).** The shell's `startedAt` now comes from the launch record's own timestamp, not wall-clock-at-processing — so the 15-min ceiling reflects true launch age and survives a reload (a reload replays the JSONL; `Date.now()` had reset every past shell's age to ~now, giving an abandoned shell fresh grace on every restart). `sessionManager.ts`; 1 co-located test.
- **Permission "waiting" false-positive — slow-tool timer 6s→15s (2026-06-04).** A long Bash (test/build/package) ran past the 6s slow delay and flickered the card to "Waiting for permission" mid-run. Hooks (ground truth) aren't wired (`hookEventRouter` is a stub), so the timer is the sole signal and can't tell slow-executing from blocked; the generous 15s delay (→30s with recency doubling, the rapid-command-sequence case) lets routine slow tools finish before flagging. Mitigation, not a cure — real fix is wiring the `PermissionRequest` hook. `permissionTracker.ts`; see `project_permission_false_positives`.
- **Background-shell badge clears on idle done cards (fix a+b+c).** Closed the "⚙ N shell(s) running" badge that lingered indefinitely on an idle `done` card. New `SessionManager.sweepBackgroundShells(now)` (a) prunes shells past the 15-min hard ceiling and (c) clears all outstanding shells at once when the backing process is **confirmed dead via `processRegistry`** (conservative tri-state: only when previously seen live and now gone — first consumer to gate on the liveness reader). `pollInner` runs it over **dormant** sessions every poll, decoupled from mtime/new-data, and (b) sets `changed` when the count actually drops, so the cleared badge is pushed even though the status stays `done`. `sessionManager.ts` / `sessionDiscovery.ts`; 5 co-located tests.
- **Background-shell badge (option A).** A quiet running-tinted "⚙ N shell(s) running" badge on the card meta row when a `run_in_background` shell outlives the turn; non-status (card stays `done`). `panel.ts` / `panel.css` / `PanelSession.backgroundShellCount`.
- **Per-section discovery age gates (option b).** `serac.discovery.ageGateDays` is now an inherited base with four nullable per-section overrides (foreign workspaces / worktrees / teams / workflows), resolved through `settings.ageGateDaysFor(section)`.
- **Workflow viewer (v1).** Opus 4.8 Workflow runs render as session cards: sidecar-first phase tree (Tier 1) + reconstructed live tier (Tier 2, with record-0↔`agent()` phase correlation), drill-in detail panel, per-agent transcript navigation. `workflowDiscovery.ts` / `workflowSidecar.ts` / `workflowScript.ts` / `detailPanel.ts`.
- **Detail navigation panel (generic, source-keyed).** One `detailPanel.ts` component serves `workflow` / `team` / `subagents` drill-ins, including the **View subagents** pill on plain session cards and unified team+workflow agent click-through (in-process team members resolve to `<orchestrator>/subagents/agent-<id>.jsonl`).
- **Team workspace-scoping.** `teamDiscovery` filters to teams whose orchestrator workspace matches the panel's, so a team no longer shows in every window.
- **Continuous archive + reopen.** Dismissed sessions, teams, and workflows interleave by recency as compact archive rows; clicking reopens the invoking conversation (team → orchestrator; workflow → parent session). `TeamDelete` stays a rare, explicit action, never wired to the X.
- **Cornice deprecation.** Removed the legacy `version 1` sidecar parser and the vendored `schemas/team-manifest-schema.json`; only the native Agent Teams `config.json` (`version 0`) parser remains.
- **`serac.workflowInlineThreshold` — dropped (decision record).** No inline-vs-section split; cards render uniformly. The setting was never added to `package.json`/`settings.ts`, so this was a doc closure.
