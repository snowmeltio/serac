# Dispatch

**Session monitor for Claude Code.**

Dispatch is a VS Code sidebar extension that shows all your Claude Code sessions as colour-coded status cards. Built for multi-session workflows where you need to know which agent needs attention, which is finished, and which is blocked.

## Panel layout

The sidebar is organised into vertical zones, top to bottom:

1. **Top bar** — status summary counts (running, waiting, done) with colour-coded dots. Refresh and new-chat buttons.
2. **Active session cards** — one card per running or waiting session. Colour-coded left border (blue = running, peach = waiting, teal = done). Each card shows session name, status pill, elapsed time, context usage bar, and subagent tree.
3. **Archive section** — dismissed sessions in a collapsible list with time-range filter (1d / 3d / 7d / 30d / all). Click to view transcript or restore.
4. **Usage quotas** — weekly session usage bar showing consumption against your plan limits (5-hour and 7-day windows). Sourced from the Anthropic OAuth API.
5. **Other workspaces** — collapsed summary of Claude Code sessions running in other VS Code windows, with running/waiting/done counts per workspace.

## Features

### Session tracking
- **Automatic discovery** — finds all Claude Code sessions in your workspace by scanning `~/.claude/projects/`. No configuration needed.
- **Status inference** — determines session state (running, waiting, done) from JSONL records using a state machine with idle timers, permission detection, and process liveness checks.
- **Status confidence** — sessions display at full, 75%, or 50% opacity depending on how recently data was received. Stale sessions show elapsed time instead of status labels.
- **Click to focus** — clicking a card opens that Claude Code session in the editor.
- **Session naming** — displays custom title, topic (from first user message), or folder name. Titles survive context compaction.

### Subagent tracking
- **Nested agent detection** — Agent and Task tool calls appear as child items under the parent session card.
- **Permission bubbling** — when a subagent is waiting for permission, it shows on the subagent row. The parent only transitions to "waiting" when all running subagents are blocked.
- **Blocking vs background** — distinguishes between subagents the parent is waiting for (blocking) and those running independently (`run_in_background: true`).
- **Enrichment** — completed subagents show duration, tool count, and a result preview (first 120 characters).
- **Compaction** — sessions with more than 5 subagents collapse to show only running/waiting agents, with an expand toggle.

### Usage tracking
- **OAuth API integration** — polls the Anthropic usage API for server-truth quota data (5-hour rolling window, 7-day rolling window).
- **Visual quota bars** — colour-coded progress bars with hot-zone warnings.
- **Per-session context** — each card shows a context usage bar (tokens consumed vs model context window).
- **Model-aware** — correctly sizes context bars for different models (1M for Opus/Sonnet, 200K for Haiku).
- **Ghost bars** — shows greyed-out quota bars when your usage window has expired, so you know the state without confusion.

### Transcript viewer
- Renders any session's full JSONL log as readable markdown.
- Opens in a VS Code editor tab for searching, copying, and reference.

### Cross-workspace monitoring
- **Foreign workspaces** — shows running/waiting/done counts for Claude Code sessions in other open VS Code windows.
- **Dismissable** — individual foreign workspaces can be dismissed if not relevant.
- **Stable naming** — workspace display names are cached to prevent flicker as sessions churn.

### Visual design
- **FLIP animations** — smooth 300ms card reordering when session states change.
- **Light and dark themes** — full CSS variants for both VS Code themes, using the Snowmelt colour palette.
- **Keyboard accessible** — focus-visible styles, keyboard activation on all interactive elements, WCAG AA contrast ratios.

## Requirements

- VS Code 1.94 or later
- Claude Code VS Code extension (provides the `claude-vscode.editor.open` command)
- macOS (see [Platform notes](#platform-notes))

## Installation

### From VSIX (local)

```bash
npm install
npm run build
npx vsce package
code --install-extension dispatch-claude-code-1.0.0.vsix
```

### From VS Code Marketplace

Not yet published. Coming soon as an unlisted extension under the `snowmelt` publisher.

## Configuration

Dispatch works with zero configuration. All settings are optional.

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `agentActivity.accountCutover` | string | `""` | ISO 8601 timestamp. Sessions before this date become transcript-only (useful after switching Claude accounts). |

## Commands

| Command | Title | Description |
|---------|-------|-------------|
| `agentActivity.refresh` | Refresh Agent Activity | Force-refresh the panel (also in toolbar) |
| `agentActivity.focusSession` | Focus Claude Code Session | Open a specific session in the editor |

## Platform notes

**Dispatch is built and tested on macOS.** It will run on other platforms, but with reduced functionality:

- **Credential extraction** — usage quota data is read from the macOS Keychain (`Claude Code-credentials`). On Linux/Windows, it falls back to `~/.claude/.credentials.json` (plaintext). If neither is available, usage bars are hidden.
- **File paths** — session discovery paths (`~/.claude/projects/`) are Unix-convention. Windows support has not been tested.

## Fragility profile

Dispatch reads Claude Code's internal data formats. None of these are documented or guaranteed by Anthropic:

| Dependency | What breaks if it changes |
|------------|--------------------------|
| **JSONL session logs** (`~/.claude/projects/<key>/*.jsonl`) | Session discovery, status inference, transcript rendering. This is the core data source. |
| **JSONL record format** (type, content, tool_use structure) | Status state machine, subagent detection, topic extraction. |
| **`session-meta.json`** | Dismissed/acknowledged state persistence. |
| **OAuth usage API** (`api.anthropic.com/api/oauth/usage`) | Usage quota bars. Undocumented endpoint; could change or be removed. |
| **Keychain entry** (`Claude Code-credentials`) | OAuth token retrieval on macOS. |
| **`claude-vscode.editor.open`** command | Click-to-focus. If the Claude Code extension changes this command ID, focusing breaks. |

**In practice:** Dispatch has been stable through 37 development sessions and daily use since March 2026. JSONL format changes are the highest-risk dependency; the extension validates records defensively and degrades gracefully (unknown records are skipped, not crashed on).

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical reference: data flow, status inference rules, timer hierarchy, usage model, and webview rendering protocol.

### Source files

| File | LOC | Role |
|------|-----|------|
| `extension.ts` | ~220 | VS Code entry, OutputChannel, command registration |
| `sessionManager.ts` | ~1,154 | Per-session state machine, record processing |
| `sessionDiscovery.ts` | ~679 | JSONL scanning, meta persistence, extended archive scanning |
| `foreignWorkspaceManager.ts` | 213 | Cross-workspace session discovery and polling |
| `panel.ts` | ~795 | Webview UI, DOM reconciler, error boundary |
| `panelProvider.ts` | 166 | WebviewViewProvider, CSP, HTML template |
| `panelUtils.ts` | ~205 | 16 pure functions for testability |
| `toolProfiles.ts` | 112 | Tool metadata map, `computeDemotion` pure function |
| `subagentTailerManager.ts` | 192 | Subagent JSONL tailer lifecycle and I/O polling |
| `jsonlTailer.ts` | 125 | Byte-offset JSONL tailing with truncation detection |
| `jsonlValidator.ts` | ~130 | Record validation, type predicates, content extraction |
| `usageProvider.ts` | 307 | OAuth token + Anthropic usage API polling |
| `transcriptRenderer.ts` | ~215 | Markdown transcript generation |
| `sessionRepair.ts` | 190 | Title extraction from first user message |
| `types.ts` | ~238 | All shared types and discriminated unions |
| `validation.ts` | 39 | Session ID + webview message validation |

445 tests across 18 test files.

## Development

```bash
npm install
npm run build        # esbuild dual-target (Node CJS + browser IIFE)
npm test             # vitest
npm run lint         # eslint
npm run smoke        # smoke test (build + basic checks)
```

## Licence

[PolyForm Shield 1.0.0](LICENSE.md)

Use it freely. Fork it, extend it, run it at work. The one restriction: don't sell it or use it to build a competing product.

Copyright 2026 Snowmelt Pty Ltd.
