# Serac — Backlog

Candidate work, not yet scheduled.

## Orchestration views ("GUI for terminal-native features")

- **Loops (`/loop`).** No dedicated state file, but `ScheduleWakeup`/`CronCreate` records + the `loop` skill's records appear in the parent session transcript (Serac already tails these). Surface a "looping" badge + interval/next-fire on the session card. The natural next orchestration view after workflows.
- **Schedules / routines (`/schedule`).** No local disk state — remote/cloud-managed (`CronCreate`/`CronList`). Not file-tailable; needs a CLI/API integration, a different class from everything else Serac does. Separate spike.
- **Process-liveness applications.** The reader (`processRegistry.ts`) is shipped (reads `~/.claude/sessions/<pid>.json`, confirms each pid with `kill(pid, 0)`, exposed on `SessionDiscovery` as `getLiveProcesses()`/`isSessionLive()`). No behaviour is gated on it yet. Candidate consumers:
  - **Orphan/live signal on cards.** Mark terminal (done/stale) sessions with no live process as "ended/orphaned"; positively confirm live ones. Reuse existing status styling (no new chrome). Safe — only annotate already-terminal sessions; never downgrade an active one (a hit is a strong positive, a miss is "unknown", since not every session class is guaranteed to register).
  - **Permission false-positive gate.** Suppress a false "Waiting for your response" when the backing process is dead (a dead process can't be blocked on a prompt). See `[[project_permission_false_positives]]`. Needs care re: registry completeness so a live-but-unregistered session isn't silently muted.
  - **Live-only mode for "Other workspaces"** (see below).

## Background-shell signal ("DONE while a build is still running")

Origin: a card showed `DONE · 49s` while the chat had launched `./deploy.sh` with `run_in_background: true` and ended its turn on "Stand by." The status is correct — the *turn* ended (`Stop`/idle → `done`) — but a detached shell kept running, invisible to the JSONL until the agent retrieves it in a later turn.

**Shipped (spike, 2026-06-03).** Detection layer, proven end-to-end against the real `672181b9` records:
- `trackers/backgroundShellTracker.ts` — strictly **non-status** enrichment (same charter as `ToolOutcomeTracker`); never moves `running`/`waiting`/`done`. String-matches launch ("Command running in background with ID: `<id>`") and terminal retrieval (`<task_id>` + `<status>completed|failed|killed|…`) from main-thread `tool_result` text; `<status>running</status>` polls don't clear. 15-min hard ceiling pruned in `demoteIfStale`. Surfaced as `SessionSnapshot.backgroundShellCount`. 14 co-located tests; full suite green.

**UI surfacing — shipped 2026-06-03 (status policy: option A).** A quiet "⚙ N shell(s) running" badge rides the card meta row whenever `backgroundShellCount > 0`, tinted with the running accent (`--sm-blizzard-blue`, `.bg-shell-badge` in `panel.css`). **Non-status:** the card keeps its real status (a `done` card stays `done`), so the Stop/idle path is untouched — no `done→running→done` flicker. Rendered in `panel.ts:renderCardInner` after the model pill; `PanelSession.backgroundShellCount` carries it through. Ungated (no `serac.show.*` toggle): the count is only ever non-zero when detection fires, and the fail-safe if Claude Code's wording changes is to show nothing.

**Remaining (minor):**
- **Completion-replay test.** When a background shell finishes, CC re-invokes the model → the next assistant record flips the card back to `running` via the normal path and the tracker clears the count on the terminal retrieval. Covered by the tracker unit tests; not yet by an end-to-end integration replay.

## Other workspaces

- **Visibility window — partly shipped 2026-06-03 (option b).** The age gate is now **decoupled per section**: `serac.discovery.ageGateDays` (default 7, min 1) is the inherited base, and each of `foreignWorkspacesAgeGateDays` / `worktreesAgeGateDays` / `teamsAgeGateDays` / `workflowsAgeGateDays` (null = inherit) can override it. Resolve via `settings.ageGateDaysFor(section)`. Still candidate: (a) **presets** instead of a raw day count — session-only / 1d / 7d / 30d / forever; (c) a **"live only" mode** keyed off the process-liveness reader — show only workspaces with a live Claude process and ignore the time gate.

---

## Shipped (was on this backlog)

- **Background-shell badge (option A).** A quiet running-tinted "⚙ N shell(s) running" badge on the card meta row when a `run_in_background` shell outlives the turn; non-status (card stays `done`). `panel.ts` / `panel.css` / `PanelSession.backgroundShellCount`.
- **Per-section discovery age gates (option b).** `serac.discovery.ageGateDays` is now an inherited base with four nullable per-section overrides (foreign workspaces / worktrees / teams / workflows), resolved through `settings.ageGateDaysFor(section)`.
- **Workflow viewer (v1).** Opus 4.8 Workflow runs render as session cards: sidecar-first phase tree (Tier 1) + reconstructed live tier (Tier 2, with record-0↔`agent()` phase correlation), drill-in detail panel, per-agent transcript navigation. `workflowDiscovery.ts` / `workflowSidecar.ts` / `workflowScript.ts` / `detailPanel.ts`.
- **Detail navigation panel (generic, source-keyed).** One `detailPanel.ts` component serves `workflow` / `team` / `subagents` drill-ins, including the **View subagents** pill on plain session cards and unified team+workflow agent click-through (in-process team members resolve to `<orchestrator>/subagents/agent-<id>.jsonl`).
- **Team workspace-scoping.** `teamDiscovery` filters to teams whose orchestrator workspace matches the panel's, so a team no longer shows in every window.
- **Continuous archive + reopen.** Dismissed sessions, teams, and workflows interleave by recency as compact archive rows; clicking reopens the invoking conversation (team → orchestrator; workflow → parent session). `TeamDelete` stays a rare, explicit action, never wired to the X.
- **Cornice deprecation.** Removed the legacy `version 1` sidecar parser and the vendored `schemas/team-manifest-schema.json`; only the native Agent Teams `config.json` (`version 0`) parser remains.
- **`serac.workflowInlineThreshold` — dropped (decision record).** No inline-vs-section split; cards render uniformly. The setting was never added to `package.json`/`settings.ts`, so this was a doc closure.
