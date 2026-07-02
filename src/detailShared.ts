/**
 * Shared contract between the detail panel's two sides: the extension-side
 * model builders (detailPanel.ts) and the webview renderer (detailView.ts).
 * Pure types and tiny formatters with NO vscode imports — this module is
 * compiled into BOTH bundles, so it is registered in BOTH tsconfigs (root and
 * tsconfig.webview.json). types.ts re-exports the shapes so extension-side
 * code keeps importing from the central types module.
 */

/** Which kind of parent a detail-panel view is drilling into. */
export type DetailSource = 'workflow' | 'team' | 'subagents';

/** Status of one agent row. Mirrors types.ts DisplayStatus plus the
 *  workflow-only 'failed' — declared literally here so the webview bundle
 *  never pulls types.ts (whose lazy tracker imports are extension-side). */
export type DetailAgentStatus = 'running' | 'waiting' | 'done' | 'stale' | 'failed';

/** One selectable agent row in the detail navigator. */
export interface DetailAgentView {
  /** Resolution key within (source, containerId, groupKey) — used to locate the
   *  transcript JSONL. runId-agent for workflow, agent-hash for subagents,
   *  member name for team. */
  agentId: string;
  label: string;
  /** Cross-source: 'failed' occurs only for workflow agents. */
  status: DetailAgentStatus;
  tokens: number;
  toolCalls: number;
  durationMs: number | null;
  model: string;
  /** Optional enrichments (workflow carries these; team/subagents may omit). */
  phaseTitle?: string | null;
  /** Live signal for a running agent: what it's doing right now. Both come
   *  from the workflow live tier; rendered as a recessed tool line under the
   *  reader head and dropped once the agent completes. */
  lastToolName?: string | null;
  lastToolSummary?: string | null;
  attempt?: number;
  promptPreview?: string;
  resultPreview?: string | null;
  /** This agent is a teammate of an Agent Team (in-process members surface
   *  through the subagents source), not a plain Task subagent — render distinctly. */
  teammate?: boolean;
  /** Teammate can still receive inbox messages: its member name is in the
   *  CURRENT team config (members are removed on shutdown) and the lead process
   *  is not registry-confirmed dead. Gates the composer — an idle teammate is
   *  alive (listening on its inbox) even when its subagent status reads done. */
  alive?: boolean;
}

/** A left-pane group: a workflow phase, or a single flat group (team/subagents). */
export interface DetailGroupView {
  /** Group identity passed back on viewAgent (runId for workflow; '' when flat). */
  key: string;
  /** Section heading; null renders the agents as a flat list with no header. */
  title: string | null;
  agents: DetailAgentView[];
}

/** A selectable view in the detail header's view switcher. A session card's
 *  agents can come from more than one source — each workflow run it owns, plus
 *  its plain Task subagents — so the panel shows one view at a time and these
 *  chips switch between them. Present only when a session exposes >1 view.
 *  `id` is the runId for a workflow view, or the literal 'subagents' for the
 *  subagents view; `kind` tells the host which model-builder to run. */
export interface DetailViewChoice {
  id: string;
  kind: DetailSource;
  label: string;
  status: string;
  active: boolean;
  /** Agent roll-up for the chip tooltip (e.g. "12 agents · 9 done · 1 failed").
   *  Host-computed; display-only. */
  summary?: string;
}

/** Normalised detail-panel payload (host → webview). */
export interface DetailModel {
  source: DetailSource;
  /** sessionId (workflow/subagents) or teamId (team). */
  containerId: string;
  /** The invoking conversation to open from the panel header. */
  sessionId: string;
  title: string;
  metrics: string;
  groups: DetailGroupView[];
  /** View switcher (session-card sources, >1 view only); omitted otherwise. */
  views?: DetailViewChoice[];
  /** Set to the team name when this session is an Agent Team orchestrator — the
   *  webview then frames its subagents as teammates (heading + per-agent badge). */
  team?: string;
}

/** One rendered transcript record (host-parsed JSONL → webview reader). */
export interface TranscriptEntry {
  timestamp: string;
  role: string;
  content: string;
}

/** Derive a display label like "Opus 4.8" / "Sonnet 5" from a model id or
 *  bare alias. Handles the new (`claude-opus-4-8`) and legacy version-first
 *  (`claude-3-5-haiku-...`) id shapes, strips the context-window suffix
 *  (`[1m]`) and the trailing date stamp (`-20251001`), and degrades to the
 *  bare tier when no version is present. Lives here (not sessionManager) so
 *  the detail webview labels models identically to the sidebar pill. */
export function formatModelLabel(modelId: string): string {
  if (!modelId) return '';
  // Drop the context-window suffix ("[1m]") and the "claude-" prefix.
  const clean = modelId.replace(/\[[^\]]*\]/g, '').replace(/^claude-/, '');
  const segments = clean.split('-');

  // Tier: a known family by canonical name, else the first word-bearing segment.
  let tier: string;
  if (clean.includes('opus')) tier = 'Opus';
  else if (clean.includes('sonnet')) tier = 'Sonnet';
  else if (clean.includes('haiku')) tier = 'Haiku';
  else {
    const word = segments.find(p => /[a-z]/i.test(p));
    if (!word) return '';
    tier = word.charAt(0).toUpperCase() + word.slice(1);
  }

  // Version: numeric segments, excluding the 8-digit date stamp (YYYYMMDD).
  const version = segments
    .filter(p => /^\d+$/.test(p) && !/^\d{8}$/.test(p))
    .join('.');

  return version ? `${tier} ${version}` : tier;
}

export function fmtTokens(n: number): string {
  if (n >= 1000) { return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'; }
  return String(n);
}

export function fmtDuration(ms: number | null): string {
  if (!ms || ms <= 0) { return ''; }
  const secs = Math.round(ms / 1000);
  if (secs < 60) { return secs + 's'; }
  const m = Math.floor(secs / 60);
  const r = secs % 60;
  return r > 0 ? m + 'm ' + r + 's' : m + 'm';
}

/** Cache key for one agent's transcript, owner-prefixed so an in-flight
 *  response from a previous drill-in can never collide with the current
 *  container's keys (e.g. the same member name across two teams). THE single
 *  definition, imported by both sides — independent copies here once drifted
 *  toward a silent, permanent "Loading transcript" state. */
export function transcriptKey(source: string, containerId: string, groupKey: string, agentId: string): string {
  return source + ':' + containerId + '|' + groupKey + '|' + agentId;
}
