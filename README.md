# Serac

**Session monitor for Claude Code.**

Serac is a VS Code sidebar extension that shows all your Claude Code sessions as colour-coded status cards. Built for multi-session workflows where you need to know which agent needs attention, which is finished, and which is blocked.

![Active sessions](https://raw.githubusercontent.com/snowmeltio/serac/main/media/screenshot-active.png) ![Archive and cross-workspace](https://raw.githubusercontent.com/snowmeltio/serac/main/media/screenshot-archive.png)

## Panel layout

The sidebar is organised into vertical zones, top to bottom:

1. **View title bar** — `+ New`, `Cleanup`, and `Refresh` icons live alongside the panel title. Cleanup uses an arm/confirm two-click pattern (the icon swaps to a warning glyph; auto-disarms after 3s).
2. **Status counts** — running / waiting / done totals with colour-coded dots. Hidden when there's nothing to show.
3. **Active session cards** — one card per local running or waiting session. Colour-coded left border (blue = running, peach = waiting). Each card shows session name, status pill, session id, model, elapsed time, context usage bar, and subagent tree. Sessions running in a sibling worktree of the current repo flow into this list with a small worktree pill alongside the session id and model.
4. **Done session cards** — completed local sessions (teal border) sit below the active cards until dismissed.
5. **Archive section** — `Dismissed` header, then archived sessions in a compact list with time-range filter (1d / 3d / 7d / 30d / all). When the active list is empty but older JSONL files exist beyond the scan window, a banner reveals the time-range bar so you can widen the view in one click.
6. **Other workspaces** — Claude Code sessions running in other VS Code windows. Each row shows the workspace name and a chip cluster: **W**aiting (peach), **R**unning (blue), **D**one (teal), **S**een/stale (grey). Sibling worktrees of an unrelated repo collapse under a single `repo/` header. The pane caps at ~8 rows and scrolls internally with a bottom-fade cue. **Click any row to jump directly into that window** (focuses an existing window if open, otherwise opens a new one).
7. **Usage quotas** — current session and weekly usage bars showing consumption against your plan limits. Sourced from the Anthropic OAuth API. The footer row hosts companion-registered status slots inline with "Updated X ago".

## How to use

### Cross-window navigation
- **Click an "Other workspaces" row** to focus or open that VS Code window. The W/R/D/S chips on each row tell you what's happening there at a glance — a waiting (W) chip means a session in that window is blocked on you.
- **Sibling worktrees of the local repo** appear as full cards in the main list (with a worktree pill); click as you would any local card.

Existing windows are reused where possible; otherwise a new window opens for the target workspace.

### Starting a new session
Click the **`+`** icon in the view title bar. This opens a fresh Claude Code editor panel. The session card appears in Serac when you send your first message.

### Focusing a session
Click any active session card to open that Claude Code session in the editor. The card highlights briefly to confirm focus.

### Dismissing and archiving
Hover over a session card to reveal action buttons on the right. Click the **×** button to dismiss the session. Dismissed sessions move to the archive section below. Dismissed sessions can be filtered by age using the time-range pills (1d, 3d, 7d, 30d, all).

### Restoring an archived session
Click any row in the archive section to restore it to the active list and open it in the editor.

### Viewing a transcript
Hover over a session card or archive row to reveal the transcript button (scroll icon). Click it to render the full session log as readable markdown in a new editor tab.

### Cleanup
Click the **trash** icon in the view title bar; it swaps to a warning glyph for 3 seconds. Click again to confirm. This closes all Claude Code editor tabs except the one you're currently viewing.

### Refresh
Click the refresh icon in the view title bar to force an immediate rescan. Serac also polls automatically (500ms when sessions are active, 2s when idle).

## Features

### Session tracking
- **Automatic discovery** — finds all Claude Code sessions in your workspace by scanning `~/.claude/projects/`. No configuration needed.
- **Status inference** — determines session state (running, waiting, done) from JSONL records using a state machine with idle timers, permission detection, and process liveness checks.
- **Status confidence** — sessions display at full, 75%, or 50% opacity depending on how recently data was received. Stale sessions show elapsed time instead of status labels.
- **Session naming** — displays custom title, topic (from first user message), or folder name. Titles survive context compaction.
- **Session repair** — automatically extracts titles from JSONL logs for sessions that Claude Code hasn't named yet, so every session has a readable label.

### Subagent tracking
- **Nested agent detection** — Agent and Task tool calls appear as child items under the parent session card.
- **Permission bubbling** — when a subagent is waiting for permission, it shows on the subagent row. The parent only transitions to "waiting" when all running subagents are blocked.
- **Blocking vs background** — distinguishes between subagents the parent is waiting for (blocking) and those running independently (`run_in_background: true`).
- **Enrichment** — completed subagents show duration, tool count, and a result preview (first 120 characters).
- **Compaction** — sessions with more than 5 subagents collapse to show only running/waiting agents, with an expand toggle.

### Usage tracking
- **OAuth API integration** — polls the Anthropic usage API for server-truth quota data (5-hour rolling window, 7-day rolling window).
- **Visual quota bars** — colour-coded progress bars with hot-zone warnings at 60% capacity.
- **Per-session context** — each card shows a context usage bar (tokens consumed vs model context window).
- **Model-aware** — correctly sizes context bars for different models (1M for Opus/Sonnet, 200K for Haiku).
- **Ghost bars** — shows greyed-out quota bars when your usage window has expired, so you know the state without confusion.

### Transcript viewer
- Renders any session's full JSONL log as readable markdown with user/assistant/tool sections.
- Opens in a VS Code editor tab for searching, copying, and reference.
- Accessible from both active cards and archived sessions.

### Cross-workspace monitoring
- **Single consolidated pane** — all sessions running in other VS Code windows appear in one "Other workspaces" list, with W/R/D/S chips per workspace. No separate foreign-waiting cards or running strips clutter the main view.
- **Sibling worktree consolidation** — sessions in any worktree of the *current* repo flow into the main card list with a worktree pill, so you don't have to context-switch to track them.
- **Repo grouping** — when 2+ workspaces share a repo root (e.g. main checkout + linked worktrees of an unrelated repo), they collapse under a single `repo/` header.
- **Done → Seen transitions** — once you've focused a completed session in its own window, its workspace's `D` chip moves to `S` (seen/stale) so the live `D` count stays meaningful.
- **Dismissed sessions excluded** — dismissed sessions in other workspaces drop out of the chip counts.
- **Capped + scrollable** — the pane shows ~8 rows then scrolls internally, with a bottom-fade cue that appears only when content overflows.

### Visual design
- **FLIP animations** — smooth 300ms card reordering when session states change.
- **Light and dark themes** — full CSS variants for both VS Code themes.
- **Keyboard accessible** — focus-visible styles, keyboard activation on all interactive elements, WCAG AA contrast ratios.

## Requirements

- VS Code 1.94 or later
- Claude Code VS Code extension (provides the `claude-vscode.editor.open` command)
- macOS (see [Platform notes](#platform-notes))

## Commands

| Command | Title | Description |
|---------|-------|-------------|
| `agentActivity.refresh` | Refresh Agent Activity | Force-refresh the panel (also in toolbar) |
| `agentActivity.focusSession` | Focus Claude Code Session | Open a specific session in the editor |

## Platform notes

**Serac is built and tested on macOS.** It will run on other platforms, but with reduced functionality:

- **Credential extraction** — usage quota data is read from the macOS Keychain (`Claude Code-credentials`). On Linux/Windows, it falls back to `~/.claude/.credentials.json` (plaintext). If neither is available, usage bars are hidden.
- **File paths** — session discovery paths (`~/.claude/projects/`) are Unix-convention. Windows support has not been tested.

## Fragility profile

Serac reads Claude Code's internal data formats. None of these are documented or guaranteed by Anthropic:

| Dependency | What breaks if it changes |
|------------|--------------------------|
| **JSONL session logs** (`~/.claude/projects/<key>/*.jsonl`) | Session discovery, status inference, transcript rendering. This is the core data source. |
| **JSONL record format** (type, content, tool_use structure) | Status state machine, subagent detection, topic extraction. |
| **Serac session metadata** (`session-meta.json` in `~/.claude/projects/<key>/`) | Dismissed/acknowledged state persistence. |
| **OAuth usage API** (`api.anthropic.com/api/oauth/usage`) | Usage quota bars. Undocumented endpoint; could change or be removed. |
| **Keychain entry** (`Claude Code-credentials`) | OAuth token retrieval on macOS. |
| **`claude-vscode.editor.open`** command | Click-to-focus. If the Claude Code extension changes this command ID, focusing breaks. |

These dependencies have been stable through daily use since March 2026. The extension validates records defensively and degrades gracefully (unknown records are skipped, not crashed on).

## Licence

[PolyForm Shield 1.0.0](LICENSE.md)

Use it freely. Fork it, extend it, run it at work. The one restriction: don't sell it or use it to build a competing product.

If you'd like to use Serac beyond the scope of the licence, get in touch at [murray@snowmelt.io](mailto:murray@snowmelt.io).

Copyright 2026 Snowmelt Consulting Pty Ltd.
