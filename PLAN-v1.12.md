# v1.12 plan — agreed 2026-06-10 (Murray + Fable)

Source: multi-agent audit (7 lenses, adversarially verified, 38 confirmed findings) + 4 ideation lenses + value-prop review. Delete this file at release; residuals go to BACKLOG.md.

## Track A — Harden the uncommitted 2026-06-09 batch, then commit — DONE (30936d1)

- [x] ReDoS in `workflowScript.ts:matchStringField` — ambiguous `(?:\\.|(?!\1).)*` alternation, empirically exponential (10ms @ 28 backslashes, ×2 per +2). Replace with unambiguous pattern or bounded scan.
- [x] `serac.experimental.teammateMessaging` + `operatorName` → `"scope": "application"` (untrusted workspace can currently flip the gate / spoof operator name).
- [x] Scroll intent defeated: agent select lands at bottom (detailView.ts — cache-hit second render misclassifies as same-agent-at-bottom).
- [x] Stale transcript cache across container switch + no in-flight sequencing on the 2.5s live refresh (cache key lacks source/container; out-of-order responses can stick).
- [x] `isAgentChange` compares agentId only — same-named agents across teams skip scroll reset (key by group too).
- [x] Composer: Cmd+Enter bypasses in-flight guard; draft/pendingSendText survive agent switch (cross-teammate leak); plain Task subagents of a team lead get a dead composer (`teammate: true` blanket).
- [x] Inbox lows: U+061C (ALM) missing from UNSAFE_CHARS; `readExistingEntries` uncapped read; ring-buffer cap counts UTF-16 units not bytes.
- [x] Docs drift: hookEventRouter stale "stub" header; CLAUDE.md "panel.js vanilla JS" (actually src/panel.ts TS); BACKLOG transcript-timestamps contradiction; ARCHITECTURE settings-invariant claim vs serac.hooks.* direct reads; permission-exempt list missing TeamCreate/TeamDelete/NotebookEdit, slow list missing Monitor.
- [x] Stale memory: hook forwarder is WIRED (extension.ts startHookIngress + src/hookIngress/) — update project memory + BACKLOG hook item.
- [x] Full test suite green → commit batch.

## Track B — Status correctness — DONE (e2d2607)

- [x] Registry death-gate latch is in-memory only → inert after every reload (sessionManager.ts ~649). Persist seen-live or rework semantics.
- [x] `isActive()` goes false when the only registered process dies → gate structurally off in single-session case (sessionDiscovery.ts ~927).
- [x] Permission recency-doubling dead code: processUserRecord zeroes lastToolResultAt in the same call that sets it (sessionManager.ts ~877).
- [x] Subagent/sidechain records set parent `seenOutputInTurn` → kills 30s extended-thinking grace, premature done (sessionManager.ts ~1303).
- [x] Silent-subagent scan can claim a sibling's transcript — dedup ignores relay-known/completed agentIds (subagentTailerManager.ts ~181).
- [x] enqueue replay stamps wall-clock enqueuedAt, not record timestamp (sessionManager.ts ~1089).
- [x] PermissionRequest positive-path tests with the real captured payload (all-hook-events fixture, replayed end-to-end through router→tracker). **Decision change:** the 15s→6s drop is NOT taken — with hooks live a genuine prompt surfaces in ~25ms via the hook, so the timer only covers hook-silence modes; dropping it to 6s would reintroduce the slow-Bash flicker (a 10s build with no prompt → timer fires at 6s). 15s stays as the backstop by design. Fixture refresh for session_crons/background_tasks deferred to the loops-badge work (BACKLOG).

## Track C — Freshness parity — DONE (9e19730); closes the 2026-06-04 backlog item

- [x] Inject registry livenessProbe into foreign/sibling/team SessionManagers (currently primary-only).
- [x] Run `sweepBackgroundShells` for dormant sibling/foreign sessions.
- [x] Sibling-worktree waiting sessions must bump the needs-input badge.
- [x] Dismissed foreign sessions leak into waiting/running strips + badge (filter metaCache in get*Snapshots).
- [x] Adaptive fast-poll keyed to local+teams+workflows only — include active foreign/sibling.
- [ ] (opt, NOT taken this cycle) Foreign/sibling scan cadence active bypass + confidence-cap alignment — low value once the fast-poll fix landed; revisit on demand.

## Track D — Workflow viewer v2 — DONE (1fe2300); waiting-tint + fixture refresh deferred to BACKLOG

- [x] Never display a journal key: unmatched live agents → `Agent · <shortId>` + promptPreview fill.
- [x] Resolve identifier-bound prompts statically (canonical `pipeline(DIMS, d => agent(d.prompt))` pattern): extract `prompt:` templates from top-level const arrays, associate via pipeline/map extent; resolve fn-returned template for `agent(fn(x))`.
- [x] Live tokens/toolCalls from agent JSONLs (currently hardcoded 0).
- [x] recoverInterpolatedLabel first-occurrence anchor bug.
- [x] Failure roll-up in detail header + failed-first nav ordering.
- [ ] (deferred to BACKLOG) Waiting workflow agent tints the card detail chip — needs per-agent permission inference the live tier does not have; see BACKLOG residuals.
- [x] Team roster drill-in unreachable since v1.11 card folding — restore via detail chip with source 'team'.

## Features — DONE (this commit)

- [x] **Glance pack:** waiting-age on the Waiting pill; done-with-errors badge (is_error tool_results); git branch pill (JSONL `gitBranch`, read nowhere today); last_assistant_message as done-card preview (Stop hook already carries it).
- [x] **Model-tinted pills (Murray 2026-06-10):** tint the model pill per model — separate colour register from status colours, unique + consistent per model, hash-derived hue (stable across sessions/builds).

## Deferred to BACKLOG (not in this cycle)

Loops/wakeup badge (groundwork captured: /loop interval = CronCreate not ScheduleWakeup; Stop payload carries session_crons + background_tasks → also future shell-tracker hardening). Cost/quota pack (per-session spend, top burners). Plans/todos surfacing. Inbox read-side thread + pulse. MCP needs-auth chip. IDE lock attribution. Detail-panel UX batch (streaming dedup, tooltip roll-up, state persistence, relative-time tick, flex layout). Test-gap items not covered above (bg-shell completion replay e2e, truncation-sans-PreCompact, workspaceOpener tests, extension.ts wiring assertions).

## Batch 2 — agreed 2026-06-10 (Murray)

- [ ] Fresh all-hook-events fixture (CC ≥2.1.159; want Stop with background_tasks, ideally session_crons)
- [ ] Background-shell completion-replay e2e test
- [ ] Orphan/live signal on cards (terminal cards annotated ended/live; never downgrade active)
- [ ] Live-only mode for Other workspaces + age-gate presets (session-only/1d/7d/30d/forever)
- [ ] Detail-panel UX batch: streaming re-render dedup, chip tooltip roll-up, webview state persistence, relative-time slow tick, flex layout vs 130px offsets
- [ ] Smaller singles: MCP needs-auth chip, same-file collision badge, IDE lock window attribution, inbox read-side thread
