# State checker audit — 2026-04-29

Audit of Serac's state inference against current Claude Code (v2.1.121-era) JSONL output. Triggered by Murray's "feels off" intuition after time away from the project. Plan and execution covered toolProfiles, record-type dispatch, subagent detection, session repair, team manifests, and supporting types.

**Tally:** 26 items audited · **9 confirmed OK** · **7 fixed in this branch** · **5 documented but deferred** · **5 deliberately out of scope**.

Priorities — High items materially change what users see in the status pill or card title; Medium items affect edge cases; Low items are hygiene.

---

## Fixed in this branch

### F1 [sessionManager.ts:90-103] — Permission-timer doc drift (3-way mismatch)
**Status:** Drifted-and-broken → Fixed
**Priority:** High
**Evidence:** [ARCHITECTURE.md:60-69](ARCHITECTURE.md) said 20s/45s; [sessionManager.ts:23](src/sessionManager.ts#L23) transition table comment said 3s/8s; canonical constants are 3s/6s (max 6s/12s with recent-tool-result doubling). [CHANGELOG.md:33](CHANGELOG.md#L33) had a stale v0.2 entry claiming 7s → 20s/45s.
**Current:** Code uses 3s/6s. Both doc sources now match. Permission-exempt list updated to include Edit, Write, and the new tools.
**Blast radius:** This was the prime suspect for "feels off" — anyone calibrating intuition from the docs expected status changes 4-15× later than they actually happen.
**Fix:** [ARCHITECTURE.md](ARCHITECTURE.md), [sessionManager.ts:23](src/sessionManager.ts#L23), [CHANGELOG.md](CHANGELOG.md) updated.

### F2 [subagentTailerManager.ts:131-191] — Multi-subagent invisibility (dead dedup)
**Status:** Drifted-and-broken → Fixed
**Priority:** High
**Evidence:** `scanForFile` accepted an optional `allSubagents` arg for sibling-tailer dedup, but neither call site in `openTailer` passed it. The fallback used `[subagent]` (only self), so dedup was always a no-op. Combined with the loss of `progress` records (see F4), the silence-timer + filename scan became the sole detection path. Counted 0 progress records in 284 recent JSONLs over 7 days — confirming the path is now load-bearing.
**Current:** When 2+ subagents silence-fire in the same poll cycle, scanner sees N unmatched files and refuses to attach any (`unmatched.length === 1` guard). All silent subagents become invisible.
**Fix:** Added `getAllSubagents()` to `TailerContext`; `openTailer` now threads siblings into `scanForFile`; logic claims the oldest unmatched file by birthtime so FIFO timer firing pairs subagents to files in spawn order. New test in `subagentTailerManager.test.ts` covers the parallel case.

### F3 [toolProfiles.ts:38-59] — Missing tools tripped the permission timer
**Status:** Drifted-and-broken → Fixed
**Priority:** High
**Evidence:** Recent JSONLs show invocations of `CronCreate`, `Monitor`, `ScheduleWakeup`, `TaskOutput`, `TaskStop`, `SendMessage` that were absent from `TOOL_PROFILES`. The default profile (`exempt: false`) means each invocation started a 3s permission timer that fired before the tool returned.
**Current:** Sessions that orchestrate teammates or schedule wake-ups flickered through `waiting` for no reason.
**Fix:** Added 13 new entries: `TaskOutput`, `TaskStop`, `TeamCreate`, `TeamDelete`, `SendMessage` (exempt + orchestration); `NotebookEdit`, `EnterWorktree`, `ExitWorktree`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `PushNotification` (exempt); `Monitor` (slow). Pure-function tests cover each group.

### F4 [sessionManager.ts:483-489] — `ai-title` record never consumed
**Status:** Drifted-and-broken → Fixed
**Priority:** High
**Evidence:** 122 `ai-title` records in last 7 days carrying Claude Code's auto-generated session titles (e.g. `{"type":"ai-title","aiTitle":"Build Service Architecture spreadsheet for JMC Phase 2","sessionId":"..."}`). No code path read them. Cards stayed on the topic-from-first-user-message even when Claude Code had a better title ready.
**Current:** Sessions with no custom title and no panel-injected title were always falling back to topic / cwd / slug.
**Fix:** New `state.aiTitle` populated by record dispatch, surfaced on `SessionSnapshot.aiTitle`, and slotted into [panelUtils.ts:94](src/panelUtils.ts#L94) `getDisplayName` priority chain after `customTitle`/`title` and before `topic`. Preserved across compaction-truncation in `resetState`. Tests added in `sessionManager.transition.test.ts` and `panelUtils.test.ts`.

### F5 [sessionRepair.ts:29-32] — Repair clobbered Claude Code's auto title
**Status:** Drifted-and-broken → Fixed
**Priority:** Medium
**Evidence:** The metadata-presence check looked for `custom-title`, `last-prompt`, `summary` but not `ai-title`. So when Claude Code wrote `ai-title` and Serac later opened the session, repair appended its own `custom-title` derived from the first user message — overwriting the cleaner AI-generated title in the Claude extension's view.
**Fix:** Added both quoted forms of `ai-title` to the metadata-presence guard. Test added in `sessionRepair.test.ts`.

### F6 [sessionManager.ts:805-821] — `queue-operation: remove` undocumented
**Status:** Confirmed-OK (with comment) → Fixed
**Priority:** Low
**Evidence:** `remove` operation observed in real JSONLs (queued message removed without dispatch). Dispatcher fell through to `false` correctly, but no comment explained why or what it meant.
**Fix:** Added comment and test asserting `false` is the intended outcome.

### F7 [teamDiscovery.ts:31] — Dead `ORPHAN_CEILING_MS` constant
**Status:** Drifted-and-broken (cosmetic) → Fixed
**Priority:** Low
**Evidence:** Declared but zero call sites. Either a planned feature that never landed or a leftover from a refactor.
**Fix:** Removed.

---

## Confirmed OK (verified, no change needed)

### O1 [sessionManager.ts:1100-1107] — Model label extraction (J3)
**Evidence:** Sample of last 7 days shows `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. `formatModelLabel` matches via `includes()`, so all four resolve to `Opus`/`Sonnet`/`Haiku` correctly.

### O2 [jsonlValidator.ts:119-127] — Token usage extraction (J5)
**Evidence:** Real `usage` blocks include `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` as sub-totals of the existing `cache_creation_input_tokens` field. Adding the parent already counts the ephemeral sub-totals; no double-count or undercount.

### O3 [schemas/team-manifest-schema.json] — Cornice schema parity
**Evidence:** `diff` between Serac's vendored `schemas/team-manifest-schema.json` and the upstream copy at `cornice/schemas/team-manifest-schema.json` returns no differences. Cornice writer shipped in commit `94a1e28` and persisted-on-shutdown in `14df2a5`. No schema drift to chase.

### O4 [teamManifest.ts:174-273] — Agent Teams parser
**Evidence:** Parser matches the live config at `~/.claude/teams/serac-tmux-test/config.json`. Lead member's empty `tmuxPaneId` is handled correctly because lead is extracted before the in-process filter runs. Worker members carry real pane IDs (`%1`, `%2`).

### O5 [sessionManager.ts:651] — Subagent detection signal (S1)
**Evidence:** Real Task tool_use blocks confirmed as the only `Agent`/`Task` orchestration spawn point. `parentToolUseID` (uppercase `ID`) field-name confirmed in samples. No alternative spawn path exists.

### O6 [jsonlValidator.ts:64-66] — Meaningful record heuristic (R7/J4)
**Evidence:** Top-level grep for record types shows `user`/`assistant` are the dominant turn-bearing types. `thinking` appears only as nested content blocks, never as top-level — no top-level `thinking` records exist.

### O7 [sessionManager.ts:790-797] — System subtype handling (R3)
**Evidence:** Last 7 days: 66 `compact_boundary`, 7 `stop_hook_summary`, 4 `api_error`. Only `compact_boundary` needs state action. `api_error` could in theory be a "done" signal but the session usually continues — leaving as no-op is correct (would need a deliberate behaviour decision, not an audit fix).

### O8 [sessionManager.ts:494-614] — Subagent permission bubbling (S5)
**Evidence:** Existing `sessionManager.sidechain.test.ts` covers the "all blocked" rule. Logic at `sessionManager.ts:838-842` is unchanged and correct.

### O9 [sessionManager.ts:798-800] — `turn_duration` removed cleanly
**Evidence:** Code comment confirms `turn_duration` was removed in v0.9 after never being observed; the relevant ARCHITECTURE.md entry is now updated to match. `transcriptRenderer.ts` still handles it for display purposes only — no state coupling.

---

## Documented but deferred

### D1 [toolProfiles.ts:99] — Slow-MCP delay may be tight for large MCP calls
**Priority:** Medium
**Evidence:** 6s base delay + recency doubling = 12s max. Some Slack/Drive MCP calls (canvas writes, multi-attachment fetches) routinely run 15-30s. Edit/Write exemption from 2026-03-30 doesn't cover MCP.
**Why deferred:** Needs live observation to calibrate. Calibrating from raw latency without watching false-positive rate could over-relax.
**Recommendation:** If users report flicker on long MCP calls, bump `SLOW_PERMISSION_DELAY_MS` from 6_000 to 8_000-10_000.

### D2 [sessionManager.ts:790-797] — `api_error` system subtype not propagated
**Priority:** Low
**Evidence:** 4 `api_error` records in last 7 days. Currently ignored — session continues until idle/permission timer fires.
**Why deferred:** `api_error` doesn't necessarily mean the session is done; user might retry. Conservative no-op is defensible.
**Recommendation:** If users report sessions stuck running after API errors, surface `api_error` as a "needs attention" signal in the activity field rather than a status transition.

### D3 [sessionManager.ts:718-786] — Phase-1 `processProgressRecord` is dead code
**Priority:** Low
**Evidence:** 0 `progress` records in 284 JSONLs over 7 days. The Phase-1 progress-record path was the original subagent-detection mechanism; with progress gone, only Phase 2 (silence timer + filename scan) runs.
**Why deferred:** Removing it is a refactor, not an audit fix. The dead branch costs nothing to keep, and provides a re-entry point if Anthropic re-enables progress relay.
**Recommendation:** Schedule a cleanup PR in 1-2 months once Phase 2's resilience is validated in production.

### D4 [types.ts:302-310] — `JsonlRecordType` union not exhaustive
**Priority:** Low
**Evidence:** Real top-level types include `hook_non_blocking_error`, `hook_success`, `hook_blocking_error`, `file-history-snapshot`, `todo_reminder`, `deferred_tools_delta`, `queued_command`, `auto_mode`, `skill_listing`, `command_permissions`, `task_status`, `compact_file_reference`, `plan_file_reference`, `plan_mode`, `plan_mode_exit`, `edited_text_file`. None drive state, but the union doesn't list them.
**Why deferred:** They're already accepted via the `string & {}` escape hatch. Listing them is autocomplete-only and would need maintenance.
**Recommendation:** Add as needed when new behaviours surface.

### D5 [src/extension.ts] — Live status verification (Phase C)
**Priority:** Medium
**Evidence:** Plan called for opening Serac and watching the pill during real workloads (single Edit, multi-step Bash, Agent spawn, AskUserQuestion).
**Why deferred:** Requires VS Code session and human eyes. The fixes in F1-F7 should resolve "feels off" — verifying empirically is the natural next step.
**Recommendation:** After this branch lands, watch for a few days. If anything still feels off, the next likely suspects are D1 (slow-MCP) and the silence threshold (`SUBAGENT_SILENCE_MS = 8_000`).

---

## Out of scope (deliberately excluded)

- **Webview rendering** (panel.ts, panelProvider.ts, FLIP animations) — visual polish, not state inference.
- **Usage tracking** (usageProvider.ts, OAuth API) — separate subsystem; quota-related stalls would surface during D5 live verification.
- **JSONL tailer byte mechanics** (jsonlTailer.ts) — battle-tested; no record-type audit surfaced a tailer-level cause.
- **Foreign workspace handling** (foreignWorkspaceManager.ts) — aggregation layer over already-inferred state.
- **Transcript renderer** (transcriptRenderer.ts) — read-only view of completed JSONL.

---

## What this means for "feels off"

Three of the High-priority fixes directly change what users see:

1. **F1** corrects the mental model — anyone (including future-Murray) reading the docs now sees the actual 3s/6s timer values.
2. **F3** stops every `TaskOutput`/`SendMessage`/`ScheduleWakeup`/`Monitor`/`Cron*` call from briefly flashing the session through `waiting`.
3. **F2** restores subagent visibility for parallel-Task orchestrator sessions — these had been silently invisible whenever 2+ subagents silence-fired together.

**F4** and **F5** improve card titles. The other items are hygiene that keeps the audit trail honest.

The 5 deferred items (D1-D5) are noted but require either more live observation or scope expansion beyond the audit's brief.
