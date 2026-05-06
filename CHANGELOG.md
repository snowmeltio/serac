# Changelog

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
- **Other-workspaces flicker** — Workspaces (e.g. TSF OD) appeared and disappeared as the panel re-rendered, and active foreign agents (e.g. BHP) only surfaced briefly. Root cause was a race in `ForeignWorkspaceManager` between `scan()` populating `this.sessions` and `loadMeta()` populating `this.meta`: concurrent `getWorkspaces()` calls during await yields could observe sessions whose dismiss state was unloaded, intermittently filtering them out.
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
