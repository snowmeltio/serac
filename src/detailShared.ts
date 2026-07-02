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

/** One rendered transcript record (host-parsed JSONL → webview reader).
 *
 *  `content` is the v1 chat renderer's truncated, human-readable display
 *  string, populated exactly as before and consumed by both the chat
 *  webview and the markdown exporter. The fields below are additive
 *  (Phase 1 of the detail-pane v2 rework, DESIGN-DETAIL-PANE-V2.md): they
 *  carry the same record's data in untruncated, structured form for the
 *  future log view, and are optional so today's renderer keeps working
 *  untouched. */
export interface TranscriptEntry {
  timestamp: string;
  role: string;
  content: string;
  /** Event kind for the future log view's kind glyph/filter. Left unset for
   *  record shapes that don't map cleanly onto one of these (e.g. the
   *  `turn_duration` system marker); `content`/`role` still describe them. */
  kind?: 'text' | 'tool_use' | 'tool_result' | 'task' | 'result';
  /** Tool name for a `tool_use` (or `task`, i.e. Task/Agent) entry. NOT
   *  populated for `tool_result` entries: a lone JSONL record only carries
   *  `tool_use_id`, not the originating tool's name; recovering that needs
   *  cross-record correlation, which this per-record function doesn't do
   *  (see evidenceExtractor.ts's Bash pairing for that kind of matching). */
  toolName?: string;
  /** Tool_use input, JSON-stringified, untruncated (the future log view
   *  expands it in place). Capped at 64KB (65536 UTF-16 code units) per
   *  entry as a sanity bound against a pathological single input blob,
   *  not a byte-exact limit. When a record carries more than one tool_use
   *  block (rare, parallel tool calls), this reflects the first block only;
   *  `content` above still summarises all of them. */
  rawInput?: string;
  /** Tool_result content, untruncated (same 64KB sanity cap as rawInput,
   *  same first-block-only caveat for a record with more than one
   *  tool_result block). Unlike `content`'s collapsed single-line summary,
   *  this preserves original formatting/newlines for in-place expansion. */
  rawOutput?: string;
  /** True when the paired tool_result block carries `is_error: true`. */
  isError?: boolean;
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

/** One file touched by an Edit/Write/NotebookEdit tool call — the wire shape
 *  of evidenceExtractor.ts's FileTouch, posted alongside a transcript for
 *  Phase 3's Result strip (DESIGN-DETAIL-PANE-V2.md). Declared literally
 *  here rather than imported: evidenceExtractor.ts pulls in jsonlValidator.ts
 *  -> types.ts, whose SubagentInfo etc. carry extension-side lazy tracker
 *  imports (see TranscriptEntry's own doc comment on the same constraint,
 *  and types.ts's note on why DetailAgentStatus is declared literally too)
 *  that the webview bundle must never resolve. */
export interface FileTouch {
  path: string;
  kind: 'edit' | 'write' | 'notebook';
  approxAdded: number | null;
  approxRemoved: number | null;
}

/** One Bash invocation paired with its result — the wire shape of
 *  evidenceExtractor.ts's CommandRun. See FileTouch above for why this is a
 *  literal duplicate rather than an import. */
export interface CommandRun {
  command: string;
  exitOk: boolean | null;
}

/** Host-computed verification evidence for one agent's transcript — the wire
 *  shape of evidenceExtractor.ts's Evidence, posted by detailPanel.ts
 *  alongside `agentTranscript`/`agentTranscriptAppend` so the webview never
 *  re-derives it (or, worse, fabricates it) from `content` strings. See
 *  evidenceExtractor.ts for the full extraction rules and FileTouch above
 *  for why this is a literal duplicate rather than an import. */
export interface Evidence {
  filesTouched: FileTouch[];
  commandsRun: CommandRun[];
  testsRun: boolean;
  finalMessage: string | null;
}

/** One host-computed mismatch between an agent's prose and its own tool
 *  evidence — the wire shape of mismatch.ts's Mismatch. Declared literally
 *  here for the same webview-purity reason as Evidence above (mismatch.ts
 *  itself imports Evidence from evidenceExtractor.ts, which is fine there —
 *  mismatch.ts is host/test-only and never bundled into the webview). The
 *  webview renders `message` plus a fixed disclaimer suffix; it never
 *  computes a Mismatch itself. */
export interface Mismatch {
  kind: string;
  message: string;
}

/** One Edit tool call's file/old/new strings, parsed from a TranscriptEntry's
 *  JSON-stringified `rawInput` (see `entryFromRecord` in transcriptRenderer.ts).
 *  Shared by the webview (Phase 4, DESIGN-DETAIL-PANE-V2.md: gates the "Show
 *  file changes" button — an inert display decision, it never drives what
 *  actually opens) and nativeDocs.ts (the host's own authoritative re-parse
 *  before building the diff — the webview's parse is display-only, never
 *  trusted for the write). */
export interface EditInput {
  filePath: string;
  oldString: string;
  newString: string;
}

/** Null for anything that isn't a two-sided Edit: malformed JSON, a
 *  non-object shape, a missing/empty file_path, or a non-string
 *  old_string/new_string (including a Write/NotebookEdit input, which never
 *  carries both). */
export function parseEditInput(rawInput: string): EditInput | null {
  let parsed: unknown;
  try { parsed = JSON.parse(rawInput); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') { return null; }
  const obj = parsed as Record<string, unknown>;
  const filePath = obj.file_path;
  const oldString = obj.old_string;
  const newString = obj.new_string;
  if (typeof filePath !== 'string' || !filePath) { return null; }
  if (typeof oldString !== 'string' || typeof newString !== 'string') { return null; }
  return { filePath, oldString, newString };
}

/** Cache key for one agent's transcript, owner-prefixed so an in-flight
 *  response from a previous drill-in can never collide with the current
 *  container's keys (e.g. the same member name across two teams). THE single
 *  definition, imported by both sides — independent copies here once drifted
 *  toward a silent, permanent "Loading transcript" state. */
export function transcriptKey(source: string, containerId: string, groupKey: string, agentId: string): string {
  return source + ':' + containerId + '|' + groupKey + '|' + agentId;
}
