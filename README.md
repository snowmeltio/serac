# Serac

**Manage your Claude Code agents, workflows, and teams.**

Serac is a VS Code sidebar that turns your Claude Code sessions into colour-coded status cards, so across many windows you can see at a glance which agent needs you, which is done, and which is blocked, then drill into any of them. It also surfaces Opus 4.8 **Workflow** runs and **Agent Teams** as cards you can manage and explore.

In one sidebar, you get:

- **Visibility of all Claude Code activity in your workspace,** as colour-coded status cards with no setup.
- **The full shape of each run on its card:** dynamic workflows, agent teams, and subagents, nested underneath as they spawn.
- **Access to their histories,** with every session, workflow, and agent transcript readable as markdown, plus a time-filtered archive.
- **Insight into your worktrees and other open windows,** gathered into one cross-window list.
- **Session usage at a glance,** with rolling quota bars and a per-session context-window gauge.

## Requirements

- VS Code 1.94 or later
- The Claude Code VS Code extension (provides the `claude-vscode.editor.open` command)
- macOS. Other platforms run with reduced usage-credential support (Keychain on macOS, plaintext `~/.claude/.credentials.json` elsewhere, usage bars hidden if neither is present).

## Fragility

Serac reads Claude Code's **undocumented** internal formats: the JSONL session logs, the workflow and team sidecars under `~/.claude/`, and the OAuth usage endpoint. None are guaranteed by Anthropic. It validates defensively and degrades gracefully (unknown records are skipped, not crashed on), and has been stable through daily use since March 2026.

## Licence

[PolyForm Shield 1.0.0](LICENSE.md). Use it freely, including at work; the one restriction is don't sell it or use it to build a competing product. For anything beyond the licence, get in touch at [murray@snowmelt.io](mailto:murray@snowmelt.io).

Copyright 2026 Snowmelt Consulting Pty Ltd.
