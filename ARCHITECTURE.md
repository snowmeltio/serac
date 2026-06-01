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
running ──→ done          (idle timer 5s, all-subagents-done, or hard ceiling 3min)
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
