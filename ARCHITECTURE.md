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

**Extension to webview:** Two message types:
- `update` — all session snapshots, usage data, needs-input count, and workspace path. A 200ms debounce guard prevents double-renders when onChange callbacks and the 5s timestamp refresh timer overlap.
- `focusSession` — sets `focusedSessionId` and re-renders with highlight. Used when a new chat is detected after the user clicks "+ New".

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
