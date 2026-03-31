# Serac — Claude Code Workspace

## What this is

Serac is a VS Code extension that monitors Claude Code sessions. Sidebar panel showing status cards, subagent tracking, usage quotas, and transcript viewer.

- **Publisher:** snowmeltio
- **Licence:** PolyForm Shield 1.0.0
- **Stack:** TypeScript, VS Code Extension API, esbuild, vitest

## Architecture

See `ARCHITECTURE.md` for the full data flow, source file map, status inference state machine, and rendering model.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Development build (esbuild) |
| `npm run watch` | Watch mode |
| `npm run package` | Production build |
| `npm run test` | Run all tests (vitest) |
| `npm run test:watch` | Watch mode tests |
| `npm run lint` | ESLint |
| `npm run smoke` | Smoke test (requires built extension) |
| `npm run vsce:package` | Package .vsix for distribution |

## Conventions

- **Tests:** Every module has a co-located `.test.ts`. Integration tests use jsdom. Run tests before committing.
- **No console.log in production code.** Use VS Code's `OutputChannel` for debug logging.
- **State machine changes** require updating both the code and `ARCHITECTURE.md` status inference section.
- **panel.js** is the webview frontend (vanilla JS, no framework). It uses a keyed DOM reconciler with FLIP animations.
- **Types** are centralised in `types.ts`.

## Cornice integration (team manifests)

Serac reads team manifests written by Cornice (`snowmeltio/cornice`) from `~/.claude/teams/<orchestrator-session-id>.json`.

- **Schema source of truth:** `snowmeltio/cornice/schemas/team-manifest-schema.json`
- **Vendored copy:** `schemas/team-manifest-schema.json` (documentation only, not a runtime dependency)
- **Parser:** `teamManifest.ts:parseTeamManifest()`

### Status mapping

| Cornice `AgentStatus` | Manifest `exitStatus` | Serac display |
|----------------------|----------------------|---------------|
| `completed`          | `success`            | done          |
| `failed`             | `failed`             | done          |
| `stopped`            | `cancelled`          | done          |
| `running`/`spawning` | `null`               | running       |

### Compatibility rules

- Serac silently rejects manifests with `version > MAX_SUPPORTED_VERSION` (currently 1)
- Manifests older than 7 days are ignored (filtered in `teamDiscovery.ts`)
- Malformed agent entries are skipped with a warning; the rest of the manifest is still parsed

## Style

- TypeScript strict mode
- Prefer pure functions; side effects at the edges
- No classes unless the VS Code API requires them (providers)
- Australian English in comments and user-facing strings
