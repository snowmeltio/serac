# Workflow sidecar fixtures

Real, **non-confidential** Claude Code Workflow on-disk artifacts, used by the
workflow-viewer parser/discovery tests.

| Fixture | Provenance | Exercises |
|---------|-----------|-----------|
| `wf_889eb23a-c48.json` | Serac's own `serac-plan-consistency-audit` run | completed, 4 agents, 2 phases (Audit, Synthesise) |
| `wf_synthetic-edge.json` | Hand-authored | `failed` status, a zero-agent phase, `attempt > 1`, mixed `done`/`failed` states, `logs[]`, a null `resultPreview` |
| `scripts/*.js` | Script for the real run | `extractWorkflowMeta` / `extractAgentCalls` (static parse, never eval) |

## Do NOT add confidential runs

Serac ships as a packaged `.vsix` from a **public** repository, so anything
committed here is effectively published. Only Serac's own runs or
sanitised/synthetic data are allowed. Runs that name an individual, embed
internal People & Development material, or sit under a client engagement path
must never be used as fixtures — even indirectly: a run that merely *references*
such paths in its prompts or results is just as exposed (this is exactly how an
"assessment" run leaked once). When in doubt, author a synthetic fixture.
