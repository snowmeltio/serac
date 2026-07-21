# Changelog

## v1.16.21 (2026-07-21) — Background-shell badge reads "N 🐚"

### Changed
- **The background-shell badge now reads "N 🐚" instead of "N shell(s) running".** Reclaims horizontal space in the card's meta row; hovering still shows the full explanation via tooltip.

## v1.16.20 (2026-07-19) — Failed-run chip reads correctly in light mode

### Fixed
- **A failed workflow's agents chip no longer goes flat grey in light mode.** A light-theme override for the base chip style unintentionally outranked the failed-state colour on CSS specificity, so failed runs lost their red tint on light themes even though dark mode showed it correctly. Added the missing override.
- **A session's agents chip no longer stays red forever after a failed workflow run is superseded by a successful retry.** The chip's failed/incomplete tint now reflects only the most recent run, not any run in the session's history — an orchestrator that retried and fixed a failure now reads as done, not failed.

## v1.16.19 (2026-07-17) — Permission-mode pill updates immediately

### Fixed
- **The permission-mode pill (Auto/Plan/etc.) no longer lags behind a mode switch.** It previously only updated via the PreToolUse hook, which requires the model to have already invoked a tool — so switching modes and sending a message left the pill showing the old mode until the model responded. It now primes from the JSONL record the instant the message is sent.

## v1.16.18 (2026-07-17) — Status pill height matches card title

### Fixed
- **The status pill in a card's top-right corner no longer overhangs the card title.** Tightened its padding, line-height, and corner radius so its height matches the title's first line.

## v1.16.17 (2026-07-17) — Copy session ID via the model pill

### Changed
- **Session cards no longer show a separate session-ID chip.** Click the model pill (e.g. "Sonnet 5") instead — it copies the session ID to the clipboard and flashes "ID copied!" for a second before reverting to the model name.

## v1.16.16 (2026-07-16) — Companion footer slots render cross-platform

### Fixed
- **Companion-registered footer rows (e.g. the Snowmelt account-switcher) now appear on every platform.** The usage panel's footer used to compute those slots only after the live-usage happy path, so a Windows/Linux session (unsupported platform) or a disconnected API state never got past the earlier return and the slot silently vanished. Footer slots are independent of live-usage availability and now render in every usage state — ghost, platform-unsupported, disconnected, and live.

## v1.16.15 (2026-07-16) — Done-but-unseen stays visible until seen

### Changed
- **A never-acknowledged done session now keeps its teal wash and done count until it is actually seen.** The 24-hour decay introduced in v1.16.14 is removed: the signal exists to surface finished work that needs attention, so it no longer expires on a timer. Acknowledging the session in its own window still rolls it over to "seen" 10 seconds later, and the discovery window / age gate (default 7 days, configurable via `serac.discovery.foreignWorkspacesWindow`) remains the eventual ceiling for workspaces that are never opened.

## v1.16.14 (2026-07-16) — Teal wash on done-but-unseen workspace rows

### Added
- **Other-workspace and worktree rows now wash teal when an agent there has finished but hasn't been seen.** Matches the existing peach wash for waiting-on-permission rows, using the established done hue. Waiting outranks done when a workspace has both. Applies to Other workspaces rows, Worktrees-pane rows, and the expanded worktree picker's child rows; the wash clears once the session is acknowledged in its own window.

### Fixed
- **A finished, unattended session's done count no longer rolls over to "seen" 10 seconds after the turn ends.** The foreign done→stale rollover applied the same 10s delay to never-acknowledged sessions as to acknowledged ones, so the done signal (and the new teal wash) vanished before anyone could have looked. Never-acknowledged sessions now hold done for 24 hours; acknowledging one still rolls it over 10s later, and a late acknowledgement can no longer briefly revive an already-faded done.

## v1.16.13 (2026-07-16) — Permission-mode badge on session cards

### Added
- **A session's card now names its permission mode.** A glyph + word badge (Manual ✋, Edit automatically `</>`, Plan 📋, Auto ⚡, Bypass permissions 🔀) sits in the meta row next to the model pill, sourced from the permission-mode tracking Serac already carried internally but never surfaced. Colours are kept distinct from the left-edge status palette so the two never read as the same signal.

## v1.16.12 (2026-07-15) — Model pill no longer shows Claude Code's synthetic sentinel

### Fixed
- **A session's model pill no longer shows the literal `<synthetic>` sentinel.** Claude Code writes that value on its own locally-generated assistant turns (e.g. a "No response requested." placeholder) that never called a real model. When one of those landed as a session's most recent model-bearing record, the model tracking picked it up verbatim and rendered it in place of the real model. The sentinel is now excluded everywhere a model id is read, including the subagent model recovery (which could otherwise permanently cache a synthetic opening record).

### Changed
- **The workflow/team header's model roll-up now names a model on a mixed-model run instead of going blank.** When agents in one run used genuinely different real models, it previously omitted the model field entirely. It now shows the most recently spawned agent's model with a "+N" count (e.g. `Fable 5 +2`), with the full set in the tooltip.

## v1.16.11 (2026-07-12) — Stop false "Waiting for permission" from parallel subagent fan-out

### Fixed
- **A session no longer flashes "Waiting for permission" when a turn fans out parallel `Agent`/`Task` subagent calls alongside another tool.** A sibling tool's own result can land well after the subagent it happened to be batched with resolves — batched multi-tool-turn submission and/or execution-slot queueing, unrelated to permission. The 15s/30s heuristic timer previously read that gap as a stuck prompt; it now defers to the same "blocking subagent" signal the poll-path status check already trusted, and gives a sibling tool a fresh check once the subagent clears instead of leaving it stuck past the hard ceiling.

## v1.16.10 (2026-07-10) — Workflow bar above the agent strip; new agent detail bar

### Changed
- **The header strip (the workflow/team/subagent summary line) now renders above the agent strip, not below it.** Zone order in the default log view returns to "what am I in, then its summary, then pick an agent."
- **Per-pill model tags are gone from the agent strip.** A same-model workflow run no longer repeats "Sonnet 5" on every pill (v1.16.6 added the visible tag; it's still carried in each pill's tooltip). A new agent detail bar sits directly under the agent strip instead, showing the selected agent's model, tokens, runtime, and tool-call count, scoped to whichever pill is active.

## v1.16.9 (2026-07-07) — Stop false "Waiting for permission" in Auto mode

### Fixed
- **A session running in Claude Code's Auto (bypass-permissions) mode no longer flashes "Waiting for permission" on a slow tool call.** No permission prompt can ever appear in that mode, but the existing timer/poll-based wait detection couldn't tell a slow-*executing* tool (e.g. a Google Workspace API call) from one truly *blocked* — so anything slower than the 15s heuristic mislabelled the card. Serac now reads the session's reported permission mode (from the JSONL transcript, or hook enrichment when available) and skips the ambiguous timer-based wait when no prompt is structurally possible. A genuine, hook-confirmed permission prompt — Claude Code's own ground truth that a prompt is on screen — is never suppressed by this, regardless of mode, and neither is a real interactive question (AskUserQuestion).

## v1.16.8 (2026-07-07) — externalWriter is now opt-in (experimental)

### Changed
- **The "session open in another window" block is now off by default, behind `serac.experimental.externalWriterBlock`.** The feature (v1.16.5, refined in v1.16.7) is still being tuned and has been reported as temperamental in daily use. With the setting off (the default), Serac never checks process ownership or subagent activity for this at all — no dimming, no badge, no blocking. Turn it on to restore the full behaviour.

## v1.16.7 (2026-07-07) — externalWriter unlocks after 10 minutes of quiet

### Fixed
- **A session blocked as "open in another window" now unlocks after 10 minutes of quiet, not just when the owning process exits.** v1.16.5's block flagged any confirmed-external live process indefinitely — a session idle at a prompt in another window stayed flagged for as long as that window stayed open, even with nothing happening. The recency check now also counts subagent and Workflow-run activity (their own separate per-agent JSONLs, not just the session's own top-level file, so an actively-orchestrating session is never mistaken for dormant), with a grace period for a process that's just resumed an old, otherwise-quiet session.
- **The blocked-card dim now names itself.** An "Active elsewhere" badge joins the existing dim and tooltip, instead of relying on a hover-only tooltip to explain why a card looks greyed out.

## v1.16.6 (2026-07-06) — Subagent model shown in the log-view agent pills

### Fixed
- **Subagent model is shown again in the default (log) view.** The v1.16.0 detail-panel rework carried the per-agent model label into the classic nav rows and the reader header, but the new default agent-pill strip never picked it up — only the retired classic view showed it, and the aggregate header line only appears when every agent shares one model. Each agent pill now shows its formatted model (e.g. "Sonnet 5"), in both the visible label and the hover tooltip.

## v1.16.5 (2026-07-06) — Block a session another VS Code window owns

### Added
- **A session actively being driven by another VS Code window is now flagged and blocked, not just visible.** Serac already shows every session across a shared `~/.claude` scaffold (multiple Claude Code accounts or profiles on one machine symlink `projects/`/`sessions/` back to one place), but a card looked fully interactive even while a different VS Code window's process was live and appending to that exact session's JSONL. Serac now confirms, per live session, whether its registered process is a child of this window's own extension host or a different one, by comparing process ancestry rather than account identity, so it catches cross-account, same-account-different-profile, and even same-profile-two-windows cases with one mechanism. A flagged card dims, its cursor becomes `not-allowed`, and a tooltip explains why. Clicking it, whether from the card, the detail panel, the command palette, or the teammate composer, is refused before it can open the shared live editor, preventing two processes writing the same file at once.

## v1.16.4 (2026-07-05) — Agents chip stays visible with inline rows off

### Fixed
- **The agents chip no longer disappears with `serac.show.subagents` off.** Turning off inline subagent rows (the v1.16.3 default) was also hiding the 🤖 chip itself on cards with plain Task subagents and no workflow — the only click-through to the detail panel's subagent view. The setting now gates the inline rows only; the chip stays keyed on presence, same as it already worked for workflow runs.

## v1.16.3 (2026-07-03) — Model pill colour reflects API cost; subagent rows off by default

### Changed
- **Model pill colour now reflects relative API cost, not family identity.** The small model badge on session cards (e.g. "Opus 4.8", "Sonnet 5") used a random per-family hash colour before; it now uses a fixed hue on a blue (cheap) → orange (expensive) scale — Haiku, Sonnet, Opus, then Fable/Mythos — based on normal per-token pricing. A model family not yet classified into a cost tier still gets a stable, distinct colour via the old hash fallback rather than defaulting into one bucket.
- **Subagent rows on session cards are now off by default.** The detail panel's subagent view (v1.16.0) is robust enough that the inline card rows were redundant noise for most users. Toggle `serac.show.subagents` back on to restore them.

### Fixed
- **Workflow agent rows now respect `serac.show.subagents`.** The setting previously only gated Task-tool subagent rows — inline rows for still-working workflow-run agents ignored it entirely and kept showing on cards even with the setting off.
- **Workflow phase grouping no longer silently drops out when a run's script lands under the wrong workspace key.** The detail panel has always grouped a workflow's agent roster by phase, but a live run's script sidecar can be written under a different `cwd` than its parent session (e.g. a scratchpad dir) — when that happened, phase correlation failed to find the script and quietly fell back to one flat, unphased agent list. Serac now also scans by run ID across every project dir when the script isn't where the session expects it.

## v1.16.2 (2026-07-02) — Weekly Fable usage quota

### Added
- **Weekly Fable usage bar.** Surfaces the new model-scoped weekly quota the Anthropic usage API now reports (a `weekly` entry in the API's generic `limits[]` array, scoped to the Fable model) alongside the existing session and weekly bars. Only appears for accounts with this quota tier.

## v1.16.1 (2026-07-02) — Fix: detail pane holds together at narrow widths

### Fixed
- **Zone rows no longer crumple in a narrow pane.** The header strip and display bar were no-wrap flex rows with shrinkable items, so at ~600px the title broke mid-word across three lines, the counts stacked into a skinny column, and a filter toggle's ☑ split from its label. Both now use the label-cell + wrapping-body pattern: whole units flow onto continuation lines that indent to the shared rail, and the title truncates with the full name on hover. The Result summary, permission row, and phase titles got the same atomic/ellipsis sweep.

### Changed
- **Header counts drop zero segments at every width** — a finished run reads "6 done", not "0 running · 0 waiting · 6 done" — and a non-zero failed count now surfaces (it was counted but never displayed).
- **Narrow register (≤720px).** The label/timestamp rail slims to 56px, "↗ session" goes icon-only, the search input relaxes, and the views row + agents strip default to their collapsed "+N" forms. Explicit expand/collapse choices — including ones persisted by v1.16.0 — win at every width.

## v1.16.0 (2026-07-02) — Detail pane v2: the forensic log view

A first-principles redesign of the drill-in detail panel, built from a judge-panel design workflow and five rounds of live-usage iteration. The old reader remains available behind a "classic view" toggle for one release.

### Added
- **Log view is the new default.** One row per transcript entry on a shared 64px rail: wall-clock timestamps (click any timestamp — or the `◷ absolute`/`◷ session` chip in the display bar — to switch the column to session-relative offsets), kind glyphs (💬 ⚙ ✗ ✔ ▶), and kind filters with live counts. Prose renders as flowing UI-font blocks at a reading measure (clamped at ~28 lines with "show all"); tool and error rows are dense one-liners, hidden by default (Text/Error/Result on), greyed in every state — tool chatter a step fainter than errors — so the agent's reasoning reads as the primary layer. A search box filters rows with match highlighting.
- **Result strip.** A host-computed verification anchor for the selected agent: inception brief, final message, files-touched chips (with approx +/− line deltas), and commands-run chips with exit marks. A **claims-vs-evidence mismatch flag** calls out "says tests passed but no test command ran" and "claims success but the last command failed" — computed from tool calls, never from the agent's prose, with benign non-zero exits (grep no-match, diff differ) exempted. Collapsed to one line by default; a mismatch stays visible inline.
- **Session-scoped view row.** Every view the session owns (workflow runs, subagent sets, team roster) as one chip row above the header — status dot, agent count, collapsible to a single line that keeps the active view plus anything running or waiting behind a "+N" chip. The pane stays a deep dive within one session; no cross-session navigation.
- **Unified zone chrome.** Every zone leads with a right-aligned rail label (views / agents / workflow / result / display) in the same gutter column as the timestamps, and views, agents, and Result share one bordered collapse control. The agent strip folds phased workflows to a single active+running line.
- **Pinned permission row.** Whenever any agent in the session is waiting on permission, a filter-immune row names the agent and the tool it is waiting on.
- **Native escape hatches.** From any expanded row: view the raw JSONL record in a virtual document, open the full transcript snapshot in an editor tab (for side-by-side agents), and open an Edit's before/after in the native diff viewer. Token-addressed URIs — no file paths cross the webview boundary.
- **Subagent model display.** Nav rows and the reader meta show each subagent's model ("Sonnet 5", "Opus 4.8"), recovered from the first assistant record's `message.model` via bounded 64KB head-reads, memoised.

### Fixed
- **Reading measure and light theme (pre-existing).** Transcript prose no longer stretches the full editor width (`clamp(60ch, 92%, 130ch)`); the nav rail clamps instead of consuming 20% of a wide panel; light-theme accent text lifted to WCAG AA (all computed ratios ≥ 4.5:1); focus outlines gained `--vscode-focusBorder` fallbacks.

## v1.15.6 (2026-07-01) — Self-heal stale "Waiting for permission" cards + model-guess pill

*(Backfilled: released without a changelog entry.)*

### Fixed
- **Stale-'waiting' reconciliation.** The one reachable stale path (a background subagent bubbles the parent to 'waiting', then the dormant sweep force-completes it without reopening the parent) is now reconciled: `demoteIfStale` asserts a permission-typed 'waiting' has a live backing (a non-exempt active tool or a running waiting subagent) and reopens to 'running' otherwise, preserving turn state so the next poll settles it. `needs_user_input` (AskUserQuestion) is exempt. A `[status]` from→to trace with active-tool counts now logs the waiting lifecycle.

### Added
- **Default-model-guess pill.** A session's model pill seeds from the configured default before the first assistant record confirms it; a trailing `*` marks the guess, and the family hue ignores the marker so "Opus\*" and "Opus 4.8" share one colour.

## v1.15.5 (2026-07-01) — Model pills show the version, not just the family

### Changed
- **Model pills now read "Opus 4.8", "Sonnet 4", "Fable 5"** — not the bare family name. `formatModelLabel` derives the version from the model id across every shape Claude Code emits: the current `claude-opus-4-8` form, the `[1m]` context-window suffix, the trailing date stamp (`claude-haiku-4-5-20251001` → "Haiku 4.5"), and the legacy version-first ids (`claude-3-5-haiku-...` → "Haiku 3.5"). The pill colour still keys on the family word, so every version of a family shares one hue and the colour keeps reading as "this is an Opus session".

## v1.15.4 (2026-06-29) — Fix: new-chat auto-focus actually fires (local/sibling gate)

### Fixed
- **The new-chat card highlight now works in practice.** v1.15.3 fixed the `enqueue`→`dequeue` focus race, but auto-focus still never fired for local sessions: the candidate filter excluded any session carrying a `worktreeRoot`, and `sessionDiscovery` tags *every local* snapshot with `worktreeRoot === the workspace path` (so the panel can tell local cards from sibling-worktree cards). The gate now mirrors the panel's local/sibling split — a session is excluded only when its `worktreeRoot` points at a *different* workspace — so a newly started local chat takes the highlight and scrolls into view as intended. The auto-focus tests now carry the same `worktreeRoot` tagging production emits (verified: they fail against the old gate), so the gap can't regress unseen.

## v1.15.3 (2026-06-29) — Fix: new-chat cards now grab focus and scroll into view

### Fixed
- **A newly created chat reliably takes the card highlight.** A new session's first JSONL record is `queue-operation: enqueue` (status `done`); only the following `dequeue`/user record flips it to `running`. The auto-focus diff absorbed every session id into its "known" set on every tick, so a new card observed during that brief `done` flicker was disqualified before its first turn and the highlight stayed on the previously focused card. A session is now absorbed only once seen live, so its `done`→`running` promotion is still focused; a `firstActivity` recency window (30s) keeps an old session re-discovered from outside the scan window (a resume) from re-firing focus, and a multi-session burst still picks no winner.

### Changed
- **An auto-focused card scrolls into view.** `scrollIntoView({block:'nearest'})` reveals a newly arrived card that would otherwise sit below the fold — a no-op when it is already visible (so it never yanks the viewport), and smooth only when animations are enabled and the OS is not requesting reduced motion. Only the extension's auto-focus triggers it; a manual card click does not.

## v1.15.2 (2026-06-18) — Fixes: workflow card classifier, thinking-turn liveness, card layout, tool-result reader lines

### Fixed
- **Workflow card classifier.** Four display/correlation fixes for a session running a background `Workflow`: a live-workflow parent no longer reads "Running · quiet" (the stall qualifier is suppressed while the card owns a running run, since the fan-out churns under a separate pipeline that never advances the lead's `lastActivity`); the card preview takes the first coherent prose line instead of a blind 200-char tail that straddled a trailing heading and read as running-and-done at once; the live header sums per-agent tokens/tools into run-level totals (was hardcoded 0/0); and live-tier phase correlation now resolves the dominant indirect-prompt shapes (`synthPrompt('P1')`, `ev('src', …)` over `SOURCES.map`, bare `gapsPrompt`) with a matched-length tiebreak so sibling fan-out calls get distinct labels.
- **No-output extended-thinking turns defer to liveness, not the 3-minute ceiling.** A turn that is still thinking with no emitted output no longer gets force-aged to quiet by the stall ceiling; liveness gates it instead.
- **Branch pill on its own line.** The git branch — the widest, most variable item in the card meta row — is lifted onto its own `.card-branch` row beneath the meta, so the action buttons stop wrapping up beside the status pill. Rendered only when the session has a branch, and the pill now truncates to the full card width rather than capping at 110px.
- **Tool result renders as a single reader line, not a box-in-a-box.** Internal whitespace is collapsed before truncating, so a multi-line result (e.g. WebSearch's `…query…\n\nLinks: […]`) stays one `> ` line instead of splitting across a recessed tool box and a separate prose block. The inner `.wf-tool` box chrome is stripped inside a tool turn's bubble (which already is the box), giving a single container.

## v1.15.1 (2026-06-15) — Fix: live workflow agents grouped under their phases for shared-preamble scripts

### Fixed
- **Live workflow agents no longer all fall into the "other" bucket while a run is in progress.** The live tier groups each running agent under its phase by matching the agent's first-message prompt back to an `agent()` call site. The matcher only lifted matchable text when the prompt argument began with a quote, so the dominant multi-agent shape — `agent(COMMON + \`…\`, …)`, where every call prepends a shared preamble const — produced no static segments and every agent rendered ungrouped for the whole live run (it self-corrected only once the completion sidecar materialised). The extractor now harvests segments from the embedded literals of a concatenated prompt, and the same scan skips over each literal so a comma or `${…}` brace inside a template can no longer truncate the prompt argument or misplace the opts object (which had also corrupted `label`/`phase` extraction for these calls). Bare `c.prompt` / `fn(args)` indirect shapes are unchanged. Verified against a real 21-agent run: all agents now group correctly live, matching the completed sidecar.

## v1.15.0 (2026-06-12) — The audit release: background agents survive turn-end, faster panels, hardened state inference

Thirty-one commits from a full-codebase audit (quick wins, security, performance, refactor, UI consistency, subagent UX) plus the deferred state-machine review.

### Added
- **Background agents survive turn-end.** Background-task banners are detected, task-notification completion is tracked, and the robot chip counts live background agents — a card no longer goes quiet while its background work runs on.
- **Running workflow agents show a live signal** — elapsed time and the tool currently executing, read from the journal tail.
- **Arrow-key roster navigation.** The detail-panel roster is keyboard-navigable, and focus survives re-renders.
- **Aggregate status dot on the collapsed nav rail** — collapsed Serac still tells you when something needs attention.
- **A newly started session auto-focuses its card.**

### Fixed
- **A blocked subagent now unblocks via the agent_progress relay.** The relay copy of tool-block handling rescheduled the permission timer on tool_result instead of cancelling it, and skipped the parent waiting→running recovery — a bubbled "Subagent waiting for permission" stuck until the next main-thread record. All three delivery channels now share one pair of helpers.
- **`Workflow` joined the slow-tool profile** (15s permission backstop). It was missing from TOOL_PROFILES entirely, so every workflow launch raced a 3s timer (observed launch latency up to 2.3s, and the tool raises a real permission prompt — so it stays timer-eligible rather than exempt).
- **Context bar fixed for Fable/Mythos sessions** — the 1M-token capacity entry was missing, so the fill bar read 5× too full on what is now the dominant model.
- **Security hardening:** `openWorkspace` confined to discovered workspace paths; hook-router buffers bounded; the `.serac` runtime dir is created owner-only.
- **Workflow read caps, script-parse memoisation, and expansion bounds** keep a pathological run directory from stalling the panel.
- **Detail panel polish** — roster accessibility, failed agents rolled into the header, zero counts only shown when honest.
- CSS consistency pass, including restoring live CSS an earlier cleanup had swallowed.

### Performance
- **The workflow live tier no longer re-reads the world** — journal tailing, a correlation cache, and scoped rescans (full-directory rescans only when something actually changed).
- **The detail panel streams transcript increments** instead of re-sending the whole transcript every poll.
- **Age-gated JSONLs are pruned via the scan readdir** instead of being re-statted every cycle, and TeamDiscovery tails only this workspace's teams.
- Detail model build collects session data in one pass.

### Internal
- Subagent tool-block handling deduplicated behind shared helpers; tracker dispose symmetry (no leaked hook-router subscriptions).
- Pure sidebar renderers extracted to `panelRender.ts` behind an explicit `RenderContext`; shared `detailShared.ts` panel contract; hook-ingress wiring extracted to `hookWiring.ts`; discovery polling shared via `sessionPolling.ts`; dead Cornice-era wire shape deleted.
- State-machine review (Phase 3) closed out the April audit deferrals; the new `mode` JSONL record type is documented.
- Suite 1282 → 1428 tests; full typecheck remains a test gate.

## v1.14.0 (2026-06-11) — Chat-style composer, honest card moves, failed agents surfaced

### Changed
- **Composer sends on Enter.** Enter sends, Shift+Enter inserts a newline; Cmd/Ctrl+Enter still sends for muscle memory. Enter mid-IME-composition never sends — there it confirms the composed text, not the message.
- **Card activity snippet clamps at 3 lines** (was 4) — the card is a glance layer, not a reading surface.
- **Other-workspaces rows pinned tight.** Row pitch was geometrically uniform but read uneven: badge-bearing rows fill the line box while bare lowercase names (rime, ws) leave it airy. An explicit 13px line-height plus slimmer padding keeps every row tight and deterministic.
- **Failed workflow agents keep their own status.** The sidecar's `failed` state no longer flattens to `done` — the detail panel sorts failed agents first, rolls them up in the header, and tints their dots (`WorkflowAgentStatus` = `DisplayStatus` + `failed`).

### Fixed
- **A card changing sections moves instead of teleporting.** The FLIP "First" snapshot is now taken once per render across both the active and done sections, so a status flip (running → done) slides the card to its new home rather than fading it out in one place and in at another — exactly one element per session, ever. Snapshots capture painted (mid-animation) positions, so a render landing mid-move continues from where the card visually is.
- **Card exits recede.** Removed cards fade at half duration, slightly scaled down and stacked beneath the in-flow cards sliding into the freed space; moves use standard-decelerate easing. Animation state commits via batched forced reflows, not rAF pairs, so transitions play deterministically under render bursts.

### Internal
- **Full typecheck is now a test gate.** `npm run test` runs `tsc --noEmit` over both the extension config (now ESNext/Bundler with DOM libs — matching how esbuild and the jsdom tests actually consume the files) and `tsconfig.webview.json` before vitest. The webview's hand-mirrored host types had drifted (four stale shapes, including the removed `show.teams` and undeclared `home`/`platformSupported` fields); all are fixed and now gated.
- Suite at 1282 tests, including cross-section move coverage and composer keymap tests.

## v1.13.0 (2026-06-10) — Teammate messaging actually works, workflow-live cards, transcript truth

Driven by a live aviary test team (three idle birds built to receive messages) that exposed the teammate-messaging feature as dead on arrival for its only real audience, plus a BHP overnight workflow run that exposed the done-card lie.

### Fixed
- **Teammate messaging works for in-process teams (was unreachable).** The Agent Teams parser dropped in-process member names entirely, so an all-in-process team had an empty roster: the composer never appeared, and the server-side inbox resolution refused every send. Names now survive in `TeamManifest.inProcessMembers` and all roster matching (teammate badge, inbox resolution, transcript lookup) unions them with tmux members.
- **The composer gates on liveness, not subagent status.** An idle teammate reads `done` to Task tracking while alive and listening on its inbox. The gate is now `teammate && alive` (member still in the team config — members are removed on shutdown — and the lead process not registry-confirmed dead), so idle teammates are messageable; departed ones are not.
- **Idle teammates' transcripts stream in real time.** The reader's refresh loop only polled `running` agents, so an idle bird's thread froze until reselected. It now also streams alive teammates — they can wake on an inbox message at any moment.
- **A done card with a live background workflow now reads running.** The Workflow tool runs in the background, so the lead's turn ends (idle timer → done) while its agents are mid-sweep. A `done`/`stale` session owning a running, non-dismissed run is upgraded to `running` (high confidence) at the host merge point; the override evaporates on completion.
- **Tool results are no longer labelled "prompt".** A user-role JSONL record carrying only `tool_result` blocks is plumbing riding back to the assistant; it now gets its own `tool` role, a recessed "tool result" turn, and can never be pinned as the inception brief.

### Changed
- **Teammates view deduped.** One row per current member (re-spawn rounds leave stale duplicates; the inbox keys by name), labelled by member name, roster-ordered; a running row beats a newer finished one. Non-roster leftovers split into an "Other subagents" group. Switcher roll-ups use the same deduped rows.
- **Roster view earns its keep or disappears.** It now renders in-process members (status borrowed from live tracking) and shows each member's queued-inbox tail — but the roster chip is suppressed for all-in-process teams, where the Teammates view is the same list *with* the composer.
- **Team accent is violet, selection is neutral.** Team badges no longer borrow teal (= done); the new `--sm-team-violet` sits outside the status palette. The reader's selected-row highlight uses the theme's list-selection colour instead of blue (= running).
- **Reader widens to the full pane when the nav rail is collapsed** (the 80ch reading measure lifts — collapsing is an explicit ask for width).
- **`serac.show.teams` removed.** Team discovery always runs; teams surface on the orchestrator's card, so a dedicated toggle gated nothing meaningful. (`serac.discovery.teamsAgeGateDays` is unchanged.) Anyone who had it set to `false` will see team affordances again on upgrade.
- **Workflow labelling de-Opus'd** — Workflows are generally available across models; settings/docs no longer name Opus 4.8.

## v1.12.1 (2026-06-10) — Active teams visible again, loops badge, stall surfacing

### Fixed
- **Active teams were invisible (v1.11 regression).** The v1.11 fold renders a team on its orchestrator's normal session card, but the pre-fold suppression of that card (`getClaimedSessionIds`) was never lifted — an active team's lead had no card anywhere, in its own workspace's window. The orchestrator is no longer claimed; member-session claims remain.
- **Branch pill suppressed in non-git workspaces.** Claude Code stamps the literal `gitBranch:"HEAD"` outside git repos (and in detached HEAD) — everything is in HEAD by definition, so the pill differentiated nothing.
- **Truncation reset covers the glance fields.** A JSONL truncation without a compaction signal now clears branch/tool-error/preview/tracked-file enrichment, which rebuilds from the replayed content (stale values could previously survive into the new timeline).
- **Tool-error badge removed from cards.** Non-actionable and badly correlated with real trouble (benign failed greps/probes inflate the count); the underlying count stays in the snapshot for a future actionable surface.

### Added
- **Loops badge.** A pending `ScheduleWakeup` renders a quiet `sleeping · Xm` chip (the card is sleeping, not finished); session crons (`CronCreate`/`CronDelete`, `/loop` interval mode) render a `loop` chip. Stop-hook `session_crons` applied as ground truth when hooks are live; registry-confirmed death clears all.
- **Stall surfacing.** A running card silent past 5 minutes reads `Running · quiet 12m` — neither healthy-running nor waiting; a hung tool or silent build you want to know about either way.
- **Shared-files chip is now opt-in** (`serac.show.fileCollisions`, default off) — rarely fires when parallelising via worktrees.

### Internal
- Test gaps closed: truncation-sans-PreCompact replay, `workspaceOpener.ts` co-located tests, extension activation wiring assertions. Suite at 1250 tests.

## v1.12.0 (2026-06-10) — Workflow viewer v2, status correctness, glance pack

A two-batch cycle driven by a 7-lens adversarial audit (38 confirmed findings) plus a product-ideation pass. Workflow drill-ins now render real labels for live runs, status inference closes its registry gaps, cards carry more glanceable signal, and the detail panel gets a quality-of-life batch.

### Workflow viewer v2
- **Live runs resolve identifier-bound prompts statically** — the canonical `pipeline(DIMS, d => agent(d.prompt))` pattern now matches agents to phases by extracting prompt templates from top-level const arrays and function bodies (never eval). On the run that exposed the bug: 0/58 agents matched before, 82/82 after.
- **Journal keys are never shown** — an unmatched live agent renders as `Agent · <shortId>` with its prompt preview filled in.
- **Live tokens/tool-call counts** from agent JSONLs (size-capped, cached) instead of hardcoded zeros; failure roll-up in the header and failed-first nav ordering.
- **Team roster drill-in restored** (unreachable since the v1.11 card folding) via a `Roster · <team>` switcher chip.

### Status correctness
- **Registry death-gate survives reloads** — the per-session seen-live latch persists in session-meta.json, and the probe no longer collapses when the registry empties (the single-session structural hole).
- **Orphan/live signal on terminal cards** — Done/Seen pills gain a quiet `live` (process still attached, resumable) or `ended` (registry-confirmed gone) qualifier; unknown shows nothing; active cards are never annotated.
- **Permission recency-doubling resurrected** (was dead code — the same call zeroed its own input) and **extended-thinking grace no longer killed by subagent records** (premature `done` on thinking sessions).
- **Hook ingress validated end-to-end** — positive-path PermissionRequest tests replay the real captured payloads through router → tracker; a fresh CC 2.1.159 fixture pins the extended Stop payload (`background_tasks`, `session_crons`, `last_assistant_message`). The 15s slow-tool timer stays by design: with hooks live a real prompt surfaces in ~25ms, so the timer only covers hook-silence modes.
- **Background-shell lifecycle proven end-to-end** — launch → badge on done card → completion re-invocation → retrieval clears → cold replay never resurrects.

### Freshness parity
- Foreign, sibling-worktree, and team sessions get the same registry probe, background-shell sweep, and adaptive fast-poll as local cards; sibling waiting sessions bump the needs-input badge; dismissed foreign sessions no longer leak into strips or the badge.

### Glance pack (cards)
- **Waiting-age on the pill** (`Waiting · 20m` — which blocked card has waited longest).
- **Model-tinted pills** — hash-derived hue per model (stable across sessions/builds), a separate colour register from status.
- **Git branch pill**, **tool-error badge** (`N tool errors` — done-but-look-closer), and the **last assistant reply as the done-card preview** (what it finished with, not the last tool name).
- **Same-file collision badge** — two ACTIVE sessions editing the same file get a quiet `N shared files` chip (paths in the tooltip).
- **MCP needs-auth footer chip** (servers awaiting `/mcp` re-auth, 24h freshness) and an **IDE tag** on Other-workspace rows open in a live VS Code window (pid-verified locks; the lock's authToken is never read).

### Other workspaces
- **Visibility presets** — `serac.discovery.foreignWorkspacesWindow`: `inherit` / `live-only` / `1d` / `7d` / `30d` / `forever`. Live-only keys off the process registry (live shows regardless of age, confirmed-absent hides regardless of youth) and falls back to the time window on degraded scans.

### Detail panel
- **Text selection survives the live refresh** — an unchanged transcript skips the re-render.
- **Selection, nav collapse, and brief collapse persist** across webview rebuilds (`vscode.setState`); switcher chips carry agent roll-up tooltips (failed-first); relative timestamps refresh in place on a 60s tick; a column flex chain replaces the hardcoded viewport offsets (the composer now shrinks the panes automatically).
- **Teammate inbox read-side** — pending (undrained) messages appear as "Queued for delivery" turns in the teammate's transcript, gated on the same server-side settings as the composer; the read path reuses the write path's confinement, size caps, and schema kill-switch, strictly read-only.

### Hardening
- ReDoS fix in the workflow script parser (exponential backtracking on backslash runs); `teammateMessaging`/`operatorName` settings moved to application scope (workspace configs can no longer flip the gate); composer in-flight/draft isolation across teammate switches; inbox: U+061C rejected, byte-accurate ring cap, 4 MiB read cap; transcript cache keys owner-prefixed against cross-container bleed.

## v1.11.1 (2026-06-10) — Usage cache correctness on credential change

### Fixed
- **Usage panel no longer shows stale quota data after the active config's credentials change.** The usage disk cache now records which account it was fetched for and is ignored on mismatch (including caches written by older builds); when the config file's recorded account identity changes, the cached OAuth token, last API response, and API-call cooldown are invalidated and fresh data is fetched on the next poll. Previously the panel could show out-of-date figures for up to ~25 minutes.
- **Usage refreshes when the window regains focus** — cheap no-op when nothing changed (the cooldown short-circuits), immediate correction when credentials changed while the window was in the background.

## v1.11.0 (2026-06-09) — Calmer cards, one agent interface, status false-positive fixes

A UX pass that collapses the per-kind agent affordances into one consistent interface, folds teams into their orchestrator card, and renders agent transcripts markdown-friendly — plus two status false-positive fixes (the lingering background-shell badge and the slow-tool "Waiting for permission" flicker).

### Changed — cards
- **One name for everything: "agents".** A card now shows a single `agents →` chip whether its children are workflow agents, plain subagents, or teammates (the drill-in's source still routes correctly). Replaces the old per-kind `workflow`/`workflows`/`subagents`/`team` chip labels.
- **Inline rows show only the still-working agents.** A card lists its running/awaiting agents inline (capped, then scrolls); click a row to drill straight to that agent. When all are done there's no list and no count — the chip is the click-through.
- **Removed the workflow progress bar and the "✓ N agents" roll-up tick.** A finished run is just the chip; a running run is its live inline rows. The card stays calm for cross-window glance.
- **Teams fold into the orchestrator card — no separate "Agent teams" section.** You always go through the lead, and its in-process teammates already surface as that session's subagents, so the team rides on the orchestrator's normal card.

### Changed — detail panel
- **Source-grouped switcher promoted to the top of the pane**, always shown, under a heading; the selected chip is tinted to its status colour (done/running/waiting/failed).
- **Light markdown rendering of agent text** — headings, lists, tables, bold/italic/inline code, links; framing pseudo-tags (e.g. `<teammate-message>`) are recessed rather than shown raw. Reclaimed vertical space on prompts and tightened list spacing to match the archive rows.
- **Teammates are visually distinct from subagents** (teal badge); the nav auto-collapses to a tinted rail on agent click; the header carries a heading + an "open parent session" jump and no longer repeats the parent id.
- **Inline card rows deep-link into the panel** — clicking an inline agent opens the drill-in already focused on that agent.

### Fixed
- **Background-shell badge no longer sticks on idle `done` cards.** A new dormant-session sweep prunes shells past the 15-min ceiling and clears them at once on registry-confirmed process death, pushing the cleared count even though the status stays `done` (the demote path never did). The badge previously could linger indefinitely.
- **Background-shell age survives a reload.** A shell's start time is anchored to its launch record's timestamp, not wall-clock-at-processing, so the ceiling reflects true age instead of resetting every restart.
- **"Waiting for permission" false positive on slow tools.** The slow-tool permission timer moved 6s→15s: routine long Bash (tests, builds, packaging) finishes before the timer mistakes it for a prompt. With no `PermissionRequest` hook wired, the timer is the sole signal and can't tell slow-executing from blocked — this is a mitigation; the cure is wiring the hook.
- **Killed / in-flight workflow sidecars parse correctly.** Live-tier agent states (`progress`/`start`/`queued`/`completed`) map to the right display status, and a `killed` run resolves to `incomplete` rather than masquerading as a completed run with running agents.

## v1.10.1 (2026-06-03) — Detail-panel fixes, accessibility, robustness audit

Follow-up to v1.10.0: six reported detail-panel/UX issues fixed, plus a 22-finding adversarial audit across the codebase (key collisions, dropped state, races/leaks, accessibility, parser hardening). 23 new regression tests.

### Fixed — reported issues
- **Detail panel reuses the existing editor pane** instead of spawning a new one. Revealing an already-open panel now targets its current column rather than `ViewColumn.Beside` (which recomputed relative to the active editor).
- **Workflow agents in later phases are selectable again.** The webview matched only the first group with a given key, but a run's phase groups all share the runId key, so agents after phase 1 were unselectable (reader stuck on "Select an agent"). It now searches every matching group.
- **Subagents drill-in is no longer empty.** Agent-tool subagents that never relayed `agent_progress` left the tracker with no agentId; the panel now unions live-tracked subagents with an on-disk dir-scan so every subagent shows.
- **Multiple workflow runs per session** are now a header **run switcher** (most-recent default, same-name runs disambiguated by recency), one run at a time, instead of every run's phases concatenated.
- **Chips shortened** (the "view " prefix dropped) and the **⚙ icon removed** from the background-shell badge.

### Fixed — audit findings
- **Detail panel:** reader/nav scroll position is preserved across live re-renders (no more snap-to-top while reading a running run); transcript sends are dropped if the panel is disposed mid-parse; failed/incomplete runs get a distinct status dot.
- **Accessibility:** native card buttons (transcript/dismiss/team-dismiss) keep their own Enter/Space activation; subagent and team expand toggles and companion footer slots are keyboard-operable; card `aria-label` is no longer HTML-escaped (screen readers no longer read literal entities).
- **Discovery/lifecycle:** completed subagents keep their agentId (rich result preview/tool count survive in the drill-in); `markSessionDone` releases subagent tailers + silence timers (no leaked tailer count); the waiting badge excludes dismissed sessions; per-write unique tmp path for meta saves; an abandoned live workflow run (parent process confirmed dead) is marked `incomplete` rather than pinned to `running`.
- **Tailing:** a known agentId is never re-pointed at another subagent's file when its own is briefly absent; the tailer cap is re-checked after I/O so concurrent opens can't exceed it.
- **Parser hardening:** `phases: [` and `agent(` written inside a workflow script's string literals no longer register as real call sites.
- **Misc:** `~`-abbreviation of paths now works in the webview (home dir is plumbed from the host); team-agent subagent dot strips wrap instead of overflowing; the usage bar no longer flashes red on trivial usage right after a quota reset; `archiveRange` rejects `NaN`/`Infinity`.

## v1.10.0 (2026-06-03) — Workflow viewer, detail panel, process liveness

Serac becomes a viewer for Claude Code's terminal-native orchestration: Opus 4.8 **Workflow** runs and **Agent Teams** now render as ordinary session cards with a drill-in navigator, and a new process-liveness reader closes a class of stuck-status false positives.

### Added
- **Workflow viewer.** Opus 4.8 Workflow runs surface as session cards: a sidecar-first phase tree for completed runs (Tier 1) and a reconstructed live tier for in-progress runs (Tier 2), correlating each running agent to its phase from the static `agent()` call sites (never eval'd). Gated behind `serac.show.workflows`.
- **Detail navigation panel.** One source-keyed panel serves `workflow` / `team` / `subagents` drill-ins — a phase/roster/agent list on the left, the selected agent's transcript rendered in the reader on the right. Plain session cards gain a **View subagents** pill; in-process team members resolve to their orchestrator's subagent transcripts.
- **Process-liveness reader.** Reads `~/.claude/sessions/<pid>.json` and confirms each pid with `kill(pid, 0)`. Used to resolve a registry-confirmed-dead session out of a stuck "Waiting for your response" without ever muting a live prompt (`everSeenLive` latch + degraded-scan guard).
- **Background-shell badge.** When a `run_in_background` shell outlives the agent's turn, a quiet running-tinted "⚙ N shell(s) running" badge appears on the card. Non-status — the card keeps its real status, so the Stop/idle path is untouched.
- **Per-section discovery age gates.** `serac.discovery.ageGateDays` is now an inherited base; each of `discovery.foreignWorkspacesAgeGateDays` / `worktreesAgeGateDays` / `teamsAgeGateDays` / `workflowsAgeGateDays` (empty = inherit) can override it.

### Changed
- **Team workspace-scoping.** Agent Teams are filtered to the workspace whose orchestrator they belong to, so a team no longer shows in every window.
- **Continuous archive.** Dismissed sessions, teams, and workflows interleave by recency as compact archive rows; clicking reopens the invoking conversation.

### Removed
- **Cornice deprecation.** Removed the legacy `version 1` sidecar parser and the vendored team-manifest schema; only the native Agent Teams `config.json` parser remains.

## v1.9.1 (2026-06-03) — Title-bar declutter + tunable confidence decay

### Changed
- **Title-bar trimmed to bin · cog · plus.** The manual refresh and hook-mode toggle were dropped from the view title bar — refresh is redundant with the auto-refresh timer, and hook mode is set-once-per-workspace via settings. Both remain available from the command palette. The cleanup, settings, and new-chat actions are reordered for a calmer toolbar.

### Added
- **Confidence-decay thresholds are now settings** — `serac.sessions.highConfidenceSeconds` (default 5) and `serac.sessions.mediumConfidenceSeconds` (default 30) control how quickly a quiet running/waiting session dims from high to medium to low confidence. Previously hardcoded. Defaults are unchanged, so existing behaviour is identical until you tune them.

## v1.9.0 (2026-06-02) — Hook consumption + scratch-session consolidation

The hook overlay added in v1.7.0 stopped being plumbing and started doing work. When hook mode is on, Serac now consumes the full event stream for faster, richer status, while JSONL polling stays the source of truth and the backstop whenever hooks are absent.

### Added
- **Hook consumption overlay** (hook mode only) — three new event consumers layered over JSONL:
  - **`Stop` accelerates turn-end.** A session drops to "done" the instant the turn closes rather than waiting out the 5s idle timer. A turn-close guard suppresses the turn's own trailing assistant record so it can't briefly re-open the session to "running" (the done→running→done flicker the red team caught).
  - **`PreToolUse` / `PostToolUse` enrichment** — cards now carry the live permission mode and the last tool's outcome (name, duration, error/interrupted), sourced only from hooks so arrival order never clobbers the activity line.
  - **`SessionEnd` / `PreCompact`** — end reason is recorded, and a compacting grace window holds a session at "running" + high confidence right through context compaction (previously it could flicker to low-confidence or "done" mid-compaction).
- **AskUserQuestion waiting is accelerated via the `PermissionRequest` hook**, ~25ms instead of the 3-6s timer, and labelled correctly. The label keys off the tool: AskUserQuestion reads "Waiting for your response", everything else "Waiting for permission".
- **`/private/tmp` scratch sessions consolidate** into a single pseudo-repo row instead of scattering one row per throwaway directory.

### Fixed
- **Stale "Waiting for your response" subtitle now clears** once the question is answered. The card kept the waiting subtitle through the following thinking phase; it now resets to "Processing".
- **Sibling-worktree sessions are pruned** when their worktree is removed, so a deleted worktree no longer leaves ghost cards in the aggregated counts.

### Performance
- **Hook forwarder cleanup** — lazy `require('node:net')` on the no-socket fast path and a tighter 250ms socket timeout to cap how long a stalled server can block Claude's tool loop. The "<30ms" target was retired as unachievable (it sits below Node's ~30ms cold-start floor for a spawn-per-event hook); the bench now reports overhead above that floor, which is ≈5ms.

## v1.8.0 (2026-06-01) — Configurable `serac.*` settings + worktree aggregation

### Added
- **User-configurable `serac.*` settings namespace** — panel section visibility, archive ranges, refresh interval, discovery age gate, pane height caps, usage thresholds, animations, and cleanup-confirmation behaviour are all now settings rather than constants.
- **Worktree picker** — clicking a foreign-workspace row expands it inline to pick a specific worktree, with per-worktree W/R/D/S counts. Auto-collapses on pick and after 20s idle.

### Changed
- **Foreign-workspace and worktree aggregation** now show inline counts, so a collapsed multi-worktree row tells you what's happening inside it without expanding.

## v1.7.0 (2026-05-25) — Opt-in hook mode + tracker refactor

Foundation release for hook-based monitoring. Status inference was refactored into composable trackers, and an opt-in hook ingress was added so events can drive status with far lower latency than the timer heuristics, while JSONL polling remains the default and the fallback.

### Added
- **Hook mode (opt-in, per-workspace)** — a header-bar button toggles it. When enabled, Serac installs project-scoped Claude Code hooks that forward events over a per-workspace Unix socket, collapsing permission-wait detection from the 3-6s timer heuristic to near-instant. A leader election ensures only one VS Code window per workspace owns the socket. With hook mode off, behaviour is identical to v1.6.2.

### Changed
- **Status inference refactored into single-slice trackers** (cwd, permission-wait, subagent lifecycle, compact boundaries) behind factory seams, with a `HookEventRouter` fan-out primitive and a replay harness. This is the seam the hook overlay plugs into; JSONL-derived behaviour is unchanged.
- Trimmed `.vscodeignore` so the packaged `.vsix` no longer carries internal dev artefacts.

### Fixed
- **Double-click throttling** on the cleanup arm→confirm flow and the hook-mode toggle, so an accidental double-click no longer skips the confirmation step or flip-flops the mode.

## v1.6.2 (2026-05-25) — Archive titles + repo aggregation back + smoother dismiss

### Fixed
- **Archived sessions past the 7-day window now show real labels** instead of falling back to the hex session id. The lightweight archive scanner never parsed JSONL, so `aiTitle`/`customTitle` were lost on the way to `getDisplayName()`. Both fields are now persisted into `session-meta.json` (forward-filled from active sessions, one-time stream-read backfill for already-archived ones), then read back in the lightweight snapshot. First time you expand the archive range after upgrading, expect a one-off scan of old JSONLs; after that the meta cache makes it free.

### Changed
- **"Other workspaces" repo aggregation re-enabled** — 2+ workspaces sharing a `repoRoot` collapse to a single synthetic row with summed counts and a `Nwt` chip (e.g. all `serac-spike-*` worktrees fold into one `serac` row when viewed from elsewhere). The parent-directory grouping that shipped alongside it in v1.6.0 stays permanently removed: nesting unrelated repos that just happened to share a parent dir was more confusing than helpful. v1.6.1 disabled both; this release brings back only the half that was actually useful.
- **Card dismiss animation now slides left** instead of fading downward, with a FLIP-style reflow so siblings move up immediately and the leaving card animates over the gap rather than after it.

## v1.6.1 (2026-05-11) — Disable foreign-workspace grouping

### Changed
- **"Other workspaces" now renders every workspace as a flat, alphabetically sorted row.** The repo-aggregation chip (`serac  4wt`) and the parent-directory nesting (e.g. `~/repos/snowmeltio/` → cornice/firn) are both off — they made the list inconsistent in practice (one repo's worktrees collapse, an adjacent repo's siblings expand). The `groupForeignWorkspaces` utility and its tests stay in place; this is a call-site bypass, not a removal.

## v1.6.0 (2026-05-09) — Worktrees pane + same-repo aggregation

A focused release on the multi-worktree workflow. The new Worktrees pane maps every worktree of the current repo with live W/R/D/S chips, and "Other workspaces" rows for unrelated repos with multiple worktrees collapse to a single synthetic row instead of an indented list.

### Added
- **Worktrees pane** — a new section above "Other workspaces" lists every worktree of the current repo (including the main checkout), with live W/R/D/S chip counts sourced from local + sibling sessions. The current worktree is pinned at the top; clicking any other row opens VS Code at that worktree. Worktrees with no Claude Code history still appear, so the pane is a faithful map of `git worktree list` rather than a list of "places I've chatted." Hidden when the repo has only one worktree.
- **Inline sibling-session click-through** — clicking a sibling-worktree card no longer spawns a new VS Code window. It falls through to the same focusSession / view-transcript path used by local cards, so transcript view works for sessions that live in another worktree of the same repo.
- **`initialCwd` field** on session snapshots — captures the first JSONL `cwd` that round-trips to the workspace key. Stable across mid-session `cd`s, so foreign-workspace display names and click-through anchor to the workspace dir rather than a transient subfolder.

### Changed
- **"Other workspaces" rows for a repo with multiple worktrees** collapse to a single synthetic row (e.g. "serac  3wt") with summed counts and a tooltip listing the member paths. Previously each worktree got its own indented row under a `serac/` header, which became noisy beyond two worktrees.

### Fixed
- **Sibling-worktree rows previously stuck on a `D` chip indefinitely** once a session finished. The done → stale transition is now driven by `lastActivity` for sibling sessions (no cross-workspace meta read needed), so chips fade to `S` 10 seconds after the session ends — matching the local row's behaviour.
- **"Other workspaces" chips for unattended workspaces** (closed VS Code, headless agents) similarly stuck on `D` because the source workspace never wrote an `acknowledgedAt`. The acknowledgement-driven rollover stays primary; a `lastActivity` fallback now catches sessions that nobody ever opens.

## v1.5.2 (2026-05-07) — Status pill casing + light-mode chip contrast

### Fixed
- **Elapsed-time letters in status pills** stay lowercase (e.g. "DONE · 3h" rather than "DONE · 3H"). The pill's `text-transform: uppercase` was capitalising unit letters, making them inconsistent with the rest of the UI and visually conflating with the deliberate W/R/D/S status letters used in the "Other workspaces" chips.
- **Light-mode "Done" chip** in the "Other workspaces" view now renders white text on teal, matching the running chip's white-on-blue treatment.

## v1.5.1 (2026-05-06) — Other workspaces polish

Minor UI tidy-up on the v1.5.0 cross-workspace pane.

### Changed
- **"No sessions" → "No active sessions"** in the top-bar empty state, since the archive list below it is also "sessions".
- **W/R/D/S chips on "Other workspaces" rows** are now flex-laid-out with auto width and tighter padding. Rows without chips no longer reserve space for an absent four-chip cluster, and present chips no longer hog enough horizontal real-estate to truncate workspace names.
- **Chip vertical footprint** is reduced (line-height 1.2, no vertical padding) so chip-bearing rows match the height of chip-less rows.

### Removed
- **"Dismissed" header** above the archive list. The visual separation from the time-range bar is enough; the label was redundant.

## v1.5.0 (2026-05-06) — Cross-workspace consolidation

A focused simplification of how Serac surfaces sessions running outside the current VS Code window. The two cross-workspace sections added in v1.3-v1.4 (foreign-waiting cards and foreign-running strip) are gone; their job now belongs to richer "Other workspaces" rows. Sibling worktrees of the local repo graduate into the main card list with a worktree pill.

### Added
- **Sibling-worktree consolidation** — sessions running in any worktree of the local repo no longer appear as a separate "foreign" workspace. They flow into the main card list with a small worktree pill alongside the existing session-id and model pills, and clicking the card opens VS Code at that worktree's CWD. Repo detection is fs-only (`.git`/`commondir`); no `git` CLI shellout. New `gitWorktreeUtil.resolveRepoRoot` and `siblingWorktreeManager`.
- **Repo-grouping in "Other workspaces"** — when 2+ unrelated other-repo workspaces share a `repoRoot`, they collapse under a single `repo/` header (full path on hover). Parent-directory grouping is preserved as the fallback for non-git directories.
- **W/R/D/S chip cluster** on every "Other workspaces" row — Waiting (peach), Running (blue), Done (teal), Seen/stale (grey). Replaces the previous tiny right-aligned counts.
- **Foreign done → stale promotion** — once a completed foreign session has been acknowledged in its own window and 10s has elapsed, its `D` chip moves to `S`, mirroring the local stale logic. Keeps the live `D` count meaningful.
- **`Dismissed` header** above the archive list, so it reads as a deliberate section rather than an unlabelled tail.

### Changed
- **"Other workspaces" pane is capped** at ~8 rows tall and scrolls internally. A bottom-fade gradient appears only while content overflows, so the cue never lies about scrollability. The slide-open animation respects the cap so adding workspaces no longer flashes to natural height before clipping.
- **Foreign-running rows** picked up a subtle blizzard-blue background tint (matching the section's blue accent) — they were nearly invisible against the panel background before, and the hover treatment didn't carry enough weight on its own. Light theme variant included.
- **Foreign workspace counts now respect dismissal** — dismissed sessions in other workspaces drop out of the chip counts entirely. Workspaces with all-dismissed sessions still render with empty chip clusters so the workspace itself stays discoverable.

### Removed
- **"Waiting in other workspaces" full-card section** at the top of the panel — the W chip on the workspace row now carries this signal. The full-card promotion was too attention-grabbing for sessions you can't action without first switching windows anyway.
- **"Running in other workspaces" compact strip** between local active and local done cards — duplicated the R chip on the workspace row. Same rationale.

### Internal
- New `panelUtils.ts` (`groupForeignWorkspaces`, `isFromOtherWorktree`) — pure functions extracted so the grouping logic is unit-testable in isolation.
- `WorkspaceGroup` gains `repoRoot`; `SessionSnapshot` gains `worktreeRoot`/`worktreeLabel`.
- `ForeignWorkspaceManager` accepts a sibling-keys provider and excludes those keys from its scan, so sibling worktrees stop appearing twice.
- 23 new tests across `gitWorktreeUtil`, `panelUtils`, `foreignWorkspaceManager`, and `sessionDiscovery.foreign`.

## v1.4.0 (2026-05-06) — Foreign-running strip + waiting card hierarchy

### Added
- **Running in other workspaces** — new compact strip between local active and local done cards, listing foreign sessions currently running. Single-line rows (task name + workspace) so the strip stays small at narrow panel widths. Click a row to switch to that VS Code window. Section only renders when there's something to show.

### Changed
- **Waiting card hierarchy reworked** — section header reads *Waiting in other workspaces* (matches the new running strip below). Cards are now two clean lines: title + Waiting pill, then workspace + age. The reason line and the explicit `↗` switch-window glyph were dropped — clickability is implicit, consistent with every other card.
- **Card section split** — local cards now render as two sections (active and done) so the foreign-running strip can sit between them. Sequence is now: foreign-waiting → local active (running/waiting/stale) → foreign-running → local done → archive.
- **Focused card border-left no longer shifts colour** — focus is conveyed by background tint alone. Previously focused cards lightened the border (e.g. blizzard-blue → snow-blue) which read as a second status indicator competing with the underlying status colour.



### Fixed
- **Usage reset-time spacing** — `formatResetTime` rendered hours/minutes as `4h15m` but days/hours as `6d 15h`. Aligned the hours/minutes case to match: now `4h 15m`.

## v1.3.6 (2026-05-05) — Other-workspaces alignment + ship the v1.3.4 flicker fix

### Fixed
- **`transcript-viewer` flicker, for real this time** — The v1.3.4 source fix never made it to a built artefact: `dist/extension.js` and `serac-claude-code-1.3.5.vsix` were both produced from a pre-fix tree. Rebuilt the bundle so the `getLastActivity()` gate in `ForeignWorkspaceManager.scan()` actually runs.

### Changed
- **Other-workspaces row indent** — Dropped the leading 6px status dot. For done/idle workspaces the dot was barely visible (30% opacity grey) but still cost 12px of layout, pushing names off the panel's 12px gutter shared with the time-range bar and usage section. Waiting state still gets the left border + frozen-peach background; running/done state is conveyed by the right-anchored W/R/D counts. Names now align with "Showing archived" and the usage labels.

## v1.3.5 (2026-05-04) — Foreign-waiting visual polish

### Changed
- Foreign-waiting section now sits under a thin separator border with extra padding under the cards, so the cross-window queue is visually distinct from local cards.
- Foreign-waiting cards get a subtle frozen-peach tinted background and a frozen-peach card name, matching the existing section-header colour cue.

## v1.3.4 (2026-05-04) — Other-workspaces flicker, round 2

### Fixed
- **Workspace flicker from `ai-title` backfill** — `transcript-viewer` (and any workspace whose sessions have user/assistant turns past the 7d gate but a recent file mtime) flickered in/out at the foreign-scan cadence. Cause: `scan()` admitted sessions on file mtime, but `poll()` evicted them on `lastActivity`. Claude Code retroactively appends `ai-title` records (no timestamp) to old sessions, bumping mtime without indicating real activity, so the two checks disagreed and one cycle's add was the next cycle's evict. `scan()` now also drops sessions whose `getLastActivity()` is past the gate after the first `update()`, unifying the criterion with `poll()`.

## v1.3.3 (2026-05-04) — Other-workspaces pane bugfix

### Fixed
- **Other-workspaces flicker** — Workspaces appeared and disappeared as the panel re-rendered, and active foreign agents only surfaced briefly. Root cause was a race in `ForeignWorkspaceManager` between `scan()` populating `this.sessions` and `loadMeta()` populating `this.meta`: concurrent `getWorkspaces()` calls during await yields could observe sessions whose dismiss state was unloaded, intermittently filtering them out.
- **Right-anchored W/R/D counts** — In the other-workspaces row, the `xxW yyR zzD` triplet is now laid out on a fixed 3-column grid with tabular numerals so columns align across rows regardless of digit width.

### Changed
- **Foreign workspace tracking simplified** — A workspace now appears in the panel iff it has at least one tracked JSONL within the age gate. Removed the dismiss filter, status filter, and team-claim exclusion (none were earning their complexity, and the dismiss/team paths were the source of the flicker race).
- **Foreign age gate reduced** — 14d → 7d to match the local session age gate.
- **Diagnostic logging stripped** — Removed `[foreign][diag]` log lines that were only useful while diagnosing the flicker.

## v1.2.0 (2026-04-29) — Anthropic-changes audit

### Fixed
- **Multi-subagent invisibility** — `subagentTailerManager.scanForFile` was dead-code for parallel subagents: `openTailer` never passed sibling state, so the dedup logic always ran with a 1-subagent siblings list. With the recent disappearance of `progress` records (0 of 284 recent JSONLs), the silence-timer fallback became the sole subagent-detection path. When 2+ subagents silence-fired in the same poll cycle the scanner saw N unmatched files and refused to attach any of them. `TailerContext` now exposes `getAllSubagents()` and `scanForFile` claims the oldest unmatched file by birthtime — combined with FIFO timer firing this gives a stable spawn-order pairing.
- **Stale permission-timer documentation** — `ARCHITECTURE.md` and the in-file transition table at `sessionManager.ts:23` claimed 20s/45s and 3s/8s respectively; actual constants are 3s/6s (max 6s/12s with recent-tool-result doubling). Reconciled both to match the canonical `toolProfiles.ts` values. `turn_duration` was removed as a state signal in v0.9 but the docs still listed it as authoritative — corrected.

### Added
- **`ai-title` record handling** — Claude Code's auto-generated title records (`{"type":"ai-title","aiTitle":"..."}`) are now parsed into `SessionState.aiTitle`, surfaced on `SessionSnapshot`, and slotted into the display-name priority chain after `customTitle` and `title` but before `topic`.
- **`ai-title` recognised by session repair** — `ensureSessionMetadata` now checks for existing `ai-title` records when deciding whether to write a fallback `custom-title`, preventing repair from clobbering Claude Code's own auto-generated title.
- **Tool profile entries** — added missing tools observed in recent JSONLs and the broader Claude Code surface: `TaskOutput`, `TaskStop`, `TeamCreate`, `TeamDelete`, `SendMessage` (orchestration); `NotebookEdit`, `EnterWorktree`, `ExitWorktree`, `ScheduleWakeup`, `CronCreate/Delete/List`, `RemoteTrigger`, `PushNotification` (exempt); `Monitor` (slow). Without these, every invocation was tripping the 3-second permission timer and flickering sessions through `waiting`.

### Removed
- **Dead `ORPHAN_CEILING_MS` constant** in `teamDiscovery.ts` — declared but never referenced.

### Changed
- `JsonlRecordType` union expanded to include `progress`, `system`, `queue-operation`, `ai-title`, and `agent-name` for editor autocomplete.
- `processQueueOperation` now documents the `remove` operation explicitly (no-op: queued message removed without dispatch).

## v0.1.0 (2026-03-06) — Initial release

- Session discovery via JSONL file polling (1s interval)
- 5-state status model: running, needs-input, done, stale, idle
- Colour-coded status cards with left border tinting
- Subagent tracking via Agent/Task tool_use detection and sidechain processing
- Permission wait detection (20s/45s timeout on non-exempt tools)
- Two-zone ordering (Active then Completed) with FLIP animated transitions
- Dismiss/archive with collapsible section and time-range filter
- Click-to-focus (opens Claude Code editor tab)
- Transcript viewer (JSONL to markdown)
- Usage tracking via JSONL parsing (24h/7d rolling windows, per-model rate cards)
- Usage quota bars (5h/7d) and daily bar chart
- CSV export (session rows, totals, quota percentages)
- USD to AUD conversion (1.57x) in cost display
- `accountCutover` setting for account switching (transcript-only mode)
- Light and dark theme support

## v0.2.0-dev (unreleased)

### Added
- **OAuth usage API** — server-truth quota data from `api.anthropic.com/api/oauth/usage`, 4-6 minute polling, 15-minute disk cache at `~/.claude/usage-cache.json`
- **Session repair** (`sessionRepair.ts`) — pre-flight JSONL metadata repair; reads last 64KB, appends `custom-title` record if missing
- **Stale session hard ceiling** — 3-minute timeout forces done regardless of active tools/subagents (covers laptop sleep, quota hits)
- **All-subagents-done shortcut** — if every subagent complete and only Agent/Task tools remain, mark done immediately
- **Clickable session UUID** — click to copy to clipboard
- **Anchored archive time-range bar** — fixed position instead of floating

### Changed
- Usage data source switched from JSONL-only estimation to OAuth API + JSONL hybrid
- Permission delay increased from 7s to 20s (45s for slow tools: Bash, WebSearch, WebFetch, Skill, MCP)
- `demoteIfStaleRunning` renamed to `demoteIfStale` (now covers needs-input sessions too)
- Session metadata consolidated into `session-meta.json` (migrates from legacy text files)
- Cost display stripped from UI (data still parsed but not rendered)

### Removed
- Search/filter UI handlers (HTML/CSS remains but JavaScript removed)
- Token bucket simulation (replaced by OAuth API)
- Per-session cost pills in webview
- CSV export functionality
- USD to AUD conversion

## v0.3.0-dev (unreleased)

### Security (Phase 1)
- **Shell injection fix** — credential extraction switched from `execSync` with string interpolation to `execFileSync` with array args
- **XSS hardening** — `escapeHtml()` now escapes single quotes (`&#39;`); all session IDs in data attributes now escaped
- **Plaintext credential warning** — logs console warning when falling back to `~/.claude/.credentials.json`
- **Path traversal guard** — session IDs from webview messages validated (rejects `/`, `\`, `..`, null bytes)
- **Cross-platform credential extraction** — macOS Keychain gated behind `process.platform === 'darwin'`; graceful fallback on other platforms

### Stability (Phase 2)
- **Buffer-based JSONL tailer** — lineBuffer changed from string to Buffer; handles UTF-8 multibyte chars split across read boundaries
- **Line buffer cap** — 1MB maximum; discarded if exceeded (prevents unbounded growth from malformed files)
- **Truncation detection** — offset + lineBuffer reset if file shrinks (handles log rotation / truncation)
- **Subagent cap** — maximum 50 tracked subagents per session (safety net for pathological cases)
- **Timer race guard** — `disposed` flag prevents poll callbacks from running after `stop()` in SessionDiscovery and UsageProvider
- **Bounded session repair** — `extractFirstUserText` reads first 256KB only instead of entire file
- **Test suite** — Vitest added with 26 tests (escapeHtml, isValidSessionId, JsonlTailer)

### Type Safety + Structure (Phase 3)
- **Discriminated union** — `JsonlRecordType` union type for JSONL record `type` field
- **Webview message validation** — `parseWebviewCommand()` validates all webview→extension messages at the boundary; 19 tests
- **CSS extraction** — ~470 lines of inline CSS moved to `media/panel.css`; CSP tightened from `'unsafe-inline'` to `${webview.cspSource}`
- **Test suite expanded** — 35 tests total (escapeHtml 8, validation 19, JsonlTailer 8)

### UI Polish (Phase 4)
- **Event delegation** — single click handler on root element replaces per-element `_hasClickHandler` wiring; eliminates listener leak on re-render
- **Accessibility** — `role="list"/"listitem"`, `tabindex="0"` on cards, `aria-live="polite"` on status summary, `aria-label` on action buttons, keyboard Enter/Space support
- **Atomic meta writes** — `session-meta.json` now written via tmp file + rename (prevents corruption on crash)

### Features + Packaging (Phase 5)
- **OAuth three-state indicator** — coloured dot (teal=connected, peach=cached, red=disconnected) next to usage footer
- **Locale auto-detection** — transcript timestamps use `vscode.env.language` instead of hardcoded `en-AU`
- **Package.json metadata** — keywords, icon field, pre-release packaging script
- **CSP fix** — re-added `'unsafe-inline'` to `style-src` for dynamic inline style attributes (usage bars, ticks)

### Test Coverage (Phase 6)
- **State machine tests** — 24 tests for SessionManager: lifecycle transitions, topic extraction, tool_use/turn_duration handling, permission timer (20s normal, 45s slow/MCP), idle timer, subagent tracking + cap, all-subagents-done shortcut, demoteIfStale hard ceiling, model label extraction, custom-title records, dispose cleanup
- **Test suite total** — 67 tests across 5 files (escapeHtml 8, validation 19, JsonlTailer 8, SessionManager 28, SessionDiscovery 4)

### Fixed
- **New chat detection + focus** — "+ New" button now detects the new session when its JSONL file appears (on first message, not on panel open) and auto-focuses the card. Previously the new session didn't appear promptly and wasn't highlighted. Uses a pending-ID-set checked on each poll cycle rather than a fixed timer, so it works regardless of how long the user takes to send their first message.
- **Stale "Waiting for permission" on done sessions** — `markSessionDone()` now clears the `activity` field when it contains status-indicator text ("Waiting for permission"). Genuine activity text (tool names, responses) is preserved for context on done/stale cards.
- **Hard ceiling incorrectly demoting needs-input sessions** — 3-minute hard ceiling now skips `needs-input` sessions. Previously, sessions genuinely waiting for user permission were marked done after 3 minutes, losing the "Waiting for permission" indicator.
- **Session repair writing "Session XXX" fallback titles** — Two-layer fix: (1) `ensureSessionMetadata` no longer writes a fallback title when no user text is found. (2) `getDisplayName` in panel.js treats titles matching `Session [hex]{8}` as placeholders and falls through to topic/slug/cwd. Previously, if repair ran before user records existed, it wrote "Session 3600bebf" as the custom-title, which stuck permanently.

### Added
- **`focusSession` webview message** — extension can now programmatically focus a session card via `panelProvider.focusSession(id)`, setting `focusedSessionId` and re-rendering with the highlight
- **`forceScan()` on SessionDiscovery** — public method to trigger an immediate JSONL file scan and return newly discovered session IDs
- **Adaptive polling** — 500ms when sessions active, 2s when idle (setTimeout chains replace fixed setInterval)
- **sendUpdate debounce** — 200ms guard prevents double-renders from onChange + timer overlap
- **effectiveLastActivity** — staleness check considers running subagent activity, not just parent session

### Changed
- Timestamp refresh timer increased from 1s to 5s (only needed for relative time labels)
- Vestigial search bar CSS removed from both themes

### Removed
- `accountCutover` setting and foreign-session cutover logic (sessions portable across accounts)
- `agentActivity.planTier` setting (superseded by OAuth API)
- `agentActivity.extraUsageEnabled` setting (read from API response, not config)
- Settings change listener in extension.ts (no settings remain)
- **JSONL cost parsing** — `RATE_CARDS`, `parseLocalJsonl()`, `SessionUsage`/`ModelUsage` types, `costEquiv7d`, `getSessionCost()`, `formatCostCard()`, `USD_TO_AUD` all removed
- **Activity log** — 50-entry per-session activity history accumulation removed (vestige of removed search feature)
- **Card name fade transition** — opacity animation on display name change removed (names no longer change dynamically)
- **Inline title editing** — attempted and reverted (conflicts with card click + innerHTML rebuild cycle)

### TypeScript Migration (v0.3 Phase 2)
- **panel.js → panel.ts** — webview script migrated to TypeScript; bundled via esbuild IIFE to `media/panel.js`
- **panelUtils.ts** — 18 pure functions extracted from panel.js into testable module (escapeHtml, stripMarkdown, getDisplayName, formatAge, quotaClass, etc.)
- **Dual build** — esbuild.config.mjs now builds both extension (Node/CJS) and webview (browser/IIFE) in parallel
- **tsconfig.webview.json** — separate TypeScript config with DOM lib for webview code
- **67 panelUtils tests** — comprehensive test coverage for all extracted pure functions
- **Test total** — 229 tests across 10 files

### Accessibility + UX (v0.3 Phase 4)
- **`:focus-visible` styles** — keyboard focus ring on cards, buttons, archive rows, and time pills using `var(--vscode-focusBorder)`
- **Action buttons on focus** — dismiss/transcript buttons now visible via `:focus-within`, not just `:hover`
- **WCAG AA contrast** — raised low-contrast colours: status counts, subagent text (#777→#999), subagent summary (#555→#888), subagent status (#555→#888), compact transcript (#555→#888)
- **Archive row accessibility** — `role="listitem"`, `tabindex="0"`, keyboard Enter/Space activation, `role="list"` on archive container
- **Cleanup button** — replaced hover-to-arm (inaccessible) with click-to-confirm dialog (3s timeout to reset)
- **Subagent list compaction** — sessions with >5 subagents collapse to running/waiting only; toggle expands/collapses full list; expanded state persisted via `vscode.setState()`
