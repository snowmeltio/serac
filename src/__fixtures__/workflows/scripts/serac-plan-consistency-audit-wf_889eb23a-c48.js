export const meta = {
  name: 'serac-plan-consistency-audit',
  description: 'Audit plan + mockup + backlog for internal contradictions and drift against the final agreed Serac workflow-viewer design',
  phases: [
    { title: 'Audit', detail: 'parallel: plan contradictions, mockup validity+fidelity, backlog+cross-artifact consistency' },
    { title: 'Synthesise', detail: 'dedupe + prioritise a single fix list' },
  ],
}

const SPEC = `FINAL AGREED DESIGN (ground truth — flag anything in the artifacts that contradicts THIS):
1. Workflows and Agent Teams are NOT separate sidebar sections. Each is an ordinary SESSION CARD in the one normal card list (a workflow/team IS its parent session).
2. The WF/team tag sits on the card's SECOND metadata line (id · model · TAG), NOT on the title. It appears only when the session has agents beneath it. Reuse the .worktree-count-chip quiet outlined look.
3. The roll-up (progress bar + phase/member counts + token/tool metrics) and a NEUTRAL "View workflow"/"View agent team"/"View subagents" pill appear only when the session has agents. The bar is the primary "has agents" signal.
4. NEUTRAL styling for the View pills and the detail-panel header chips — NO per-type colour (no teal-for-workflow / blue-for-team). Text carries the distinction. Only functional status colours (running/done dot+bar) remain.
5. Card body click -> open the parent/invoking conversation via existing claude-vscode.editor.open session-open (team: orchestrator leadSessionId; workflow: parent session owning workflows/wf_<runId>.json).
6. The View pill -> a DETAIL NAVIGATION PANEL: two-pane (left = phase/roster/flat navigator depending on source; right = the selected agent's transcript rendered INLINE and scrollable). ONE component keyed by source: 'workflow' | 'team' | 'subagents'. Reuses transcriptRenderer parsing fed into the webview (NOT writing a .md and opening an editor tab for the drill-in).
7. The panel opens as an editor tab via ViewColumn.Beside, REUSING the existing right-hand editor group; it does NOT spawn a new pane, and the parent conversation is the user's already-open left editor.
8. Agent list (nav) scrolls independently. OPEN/DEFERRED question: reader horizontal space (~320px side column wraps long responses) — fallback is a full-width viewer in the bottom panel; not decided.
9. Archive uses the NORMAL session archive path: archived workflow/team show as today's COMPACT archive rows with only the WF/team tag trailing the label. No "archived" chip, no special section, no full dimmed-card treatment.
10. serac.workflowInlineThreshold and the inline-vs-top-level-section split are DROPPED.
11. Detail data: completed workflows from the sidecar workflows/wf_<runId>.json (Tier 1); running workflows reconstructed (Tier 2, flat fallback); teams from config.json + transcripts; subagents from <session>/subagents/agent-<id>.jsonl.
12. Backlog items: Cornice deprecation (firm), loops, schedules (spike), process-liveness, team workspace-scoping, unified click-through, View-subagents generalisation.

FILES:
- Plan: /Users/murraystubbs/.claude/plans/radiant-enchanting-clover.md
- Mockup: /Users/murraystubbs/repos/snowmeltio/serac/mockups/workflow-team-views.html
- Backlog: /Users/murraystubbs/repos/snowmeltio/serac/BACKLOG.md
- Serac real CSS (for fidelity): /Users/murraystubbs/repos/snowmeltio/serac/media/panel.css`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        where: { type: 'string', description: 'file + section/line/quote' },
        problem: { type: 'string', description: 'the contradiction, stale decision, or error' },
        fix: { type: 'string', description: 'concrete correction' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      }, required: ['where', 'problem', 'fix', 'severity'],
    }},
    summary: { type: 'string' },
  }, required: ['findings', 'summary'],
}

phase('Audit')
const [plan, mockup, backlog] = await parallel([
  () => agent(`Audit the PLAN file ONLY for internal contradictions and decisions that are now STALE vs the final agreed design. Read it fully and check every section against the spec. Pay special attention to leftover language from superseded decisions (e.g. "top-level section", "inline threshold", per-type pill colours, "open a .md transcript", "new pane", title-tag). \n\n${SPEC}`,
    { phase: 'Audit', label: 'audit:plan', agentType: 'Explore', schema: FINDINGS_SCHEMA }),
  () => agent(`Audit the MOCKUP HTML for (a) HTML/CSS validity (unclosed tags, broken rules), (b) fidelity to Serac's REAL palette/classes in media/panel.css, and (c) whether it correctly reflects EVERY point of the final agreed design (tag on meta line not title; neutral pills; archive as compact rows with trailing tag; two-pane navigation panel; ViewColumn.Beside framing). Read both the mockup and media/panel.css.\n\n${SPEC}`,
    { phase: 'Audit', label: 'audit:mockup', agentType: 'Explore', schema: FINDINGS_SCHEMA }),
  () => agent(`Audit the BACKLOG file for correctness, AND check CROSS-ARTIFACT consistency: do the plan, mockup, and backlog agree on the final card model, archive treatment, pill neutrality, panel behaviour, and the dropped threshold? Read all three files. Flag any place where two artifacts disagree.\n\n${SPEC}`,
    { phase: 'Audit', label: 'audit:backlog+xref', agentType: 'Explore', schema: FINDINGS_SCHEMA }),
])

phase('Synthesise')
const synthesis = await agent(`Consolidate these three audit reports into ONE deduped, severity-ordered fix list for the maintainer. Drop duplicates, merge overlapping items, and separate "must fix (contradicts the agreed design)" from "nice-to-have". Be concrete about file + location + the exact edit.\n\n[PLAN AUDIT]\n${JSON.stringify(plan, null, 2)}\n\n[MOCKUP AUDIT]\n${JSON.stringify(mockup, null, 2)}\n\n[BACKLOG+XREF AUDIT]\n${JSON.stringify(backlog, null, 2)}`,
  { phase: 'Synthesise', label: 'synthesis', schema: {
    type: 'object', additionalProperties: false,
    properties: {
      mustFix: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { artifact: {type:'string'}, where: {type:'string'}, problem: {type:'string'}, fix: {type:'string'} }, required: ['artifact','where','problem','fix'] } },
      niceToHave: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { artifact: {type:'string'}, where: {type:'string'}, fix: {type:'string'} }, required: ['artifact','where','fix'] } },
      overallConsistent: { type: 'boolean' },
      verdict: { type: 'string' },
    }, required: ['mustFix', 'niceToHave', 'overallConsistent', 'verdict'],
  }})

return { plan, mockup, backlog, synthesis }
