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

## Style

- TypeScript strict mode
- Prefer pure functions; side effects at the edges
- No classes unless the VS Code API requires them (providers)
- Australian English in comments and user-facing strings
