/**
 * Pure HTML renderers for the sidebar webview.
 *
 * Extracted from the panel.ts IIFE (audit refactor-panel-4) so the builders
 * are unit-testable without jsdom: every function here is a string-in,
 * string-out renderer with NO DOM access, no vscode API, and no module-level
 * mutable state. Ambient state the builders need (settings, paths, derived
 * maps) arrives via an explicit RenderContext built once per render pass;
 * per-section data is passed as ordinary arguments.
 *
 * panel.ts keeps the reconciler (FLIP), event wiring, message handling, and
 * all mutable state. Webview-safe: bundled into media/panel.js by esbuild and
 * registered in tsconfig.webview.json (dual-registration rule).
 */

import {
  basename,
  countsChipsHtml,
  normPath,
  pickerChildRow,
  escapeHtml,
  stripMarkdown,
  getDisplayName,
  formatAge,
  formatAgeCoarse,
  getStatusLabel,
  getElapsedPct,
  quotaClass,
  formatResetTime,
  getModelCapacity,
  getCompactThreshold,
  formatTokenCount,
  groupForeignWorkspaces,
  PanelSession,
  UsageData,
} from './panelUtils.js';
import type { DetailSource } from './detailShared.js';

// ===== VIEW TYPES (mirrors of host shapes; the webview bundle cannot =====
// ===== import extension-side modules, so they are redeclared here)   =====

export interface WorkspaceGroup {
  workspaceKey: string;
  displayName: string;
  cwd?: string | null;
  counts: Record<string, number>;
  confidence?: string;
  repoRoot?: string | null;
  /** Set on synthetic rows (groupForeignWorkspaces collapses repos with 2+
   *  worktrees into one row). Drives the worktree-count chip and gates the
   *  inline picker. */
  worktreeCount?: number;
  worktreeMembersLabel?: string;
  /** Every worktree of the repo (incl. main). Drives the inline picker. */
  worktrees?: Array<{ path: string; branch: string | null; isMain: boolean }>;
  /** Pre-aggregation per-worktree workspaces, kept so the picker can show
   *  per-worktree counts. Inactive worktrees have no matching member. */
  members?: WorkspaceGroup[];
  /** Set on synthetic rows consolidating non-git scratch dirs (under
   *  /private/tmp). The picker is driven by `members` and the chip relabelled. */
  pseudoRepo?: boolean;
  /** True when a live VS Code window has this workspace open (quiet IDE tag).
   *  Not synthesised onto aggregated rows. */
  ideOpen?: boolean;
}

/** Compact settings shape (mirrors CompactSettings from claudeSettings.ts). */
export interface PanelCompactSettings { autoCompactWindow: number; autoCompactPct: number }

/** Team agent snapshot (mirrors TeamAgentSnapshot from types.ts) */
export interface PanelTeamAgent {
  sessionId: string | null;
  name: string;
  cwd: string;
  parentSessionId: string;
  depth: number;
  spawnedAt: number;
  status: string;
  activity: string;
  confidence: string;
  subagents: PanelSession['subagents'];
  contextTokens: number;
}

/** Team snapshot (mirrors TeamSnapshot from types.ts) */
export interface PanelTeam {
  teamId: string;
  name: string;
  orchestrator: {
    sessionId: string;
    status: string;
    activity: string;
    confidence: string;
    contextTokens: number;
    modelLabel: string;
  };
  agents: PanelTeamAgent[];
  counts: Record<string, number>;
  updatedAt: number;
  dismissed: boolean;
}

/** Workflow agent (subset of WorkflowAgentSnapshot the card needs). agentId and
 *  label are present at runtime (host sends the full snapshot) — they drive the
 *  inline not-done rows and their deep-link into the detail panel. */
export interface PanelWorkflowAgent {
  phaseIndex: number | null;
  status: string;
  agentId?: string;
  label?: string;
}

/** Workflow run snapshot (mirrors WorkflowSnapshot from types.ts; the card
 *  uses a subset). One session may own several runs. */
export interface PanelWorkflow {
  runId: string;
  sessionId: string;
  name: string;
  status: string;        // completed | running | failed | incomplete
  source: string;        // sidecar | live
  phases: { index: number; title: string }[];
  agents: PanelWorkflowAgent[];
  counts: Record<string, number>;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs: number | null;
  startTime: number;     // epoch ms; with durationMs gives the archive recency ts
  dismissed: boolean;
}

export interface PanelFooterSlot {
  slotId: string;
  label: string;
  icon?: string;
  status?: 'ok' | 'warn' | 'critical';
  hasCommand: boolean;
  tooltip?: string;
}

export interface PanelWorktreeRow {
  path: string;
  branch: string | null;
  displayName: string;
  counts: Record<string, number>;
  confidence: string;
  isCurrent: boolean;
  isMain: boolean;
}

/** Mirrors SeracSettings from settings.ts. Webview bundle can't import
 *  extension-side modules (different bundling target), so the shape is
 *  redeclared here. Keep field names in sync. */
export interface PanelSettings {
  show: {
    foreignWorkspaces: boolean;
    worktrees: boolean;
    usage: boolean;
    subagents: boolean;
    workflows: boolean;
    fileCollisions: boolean;
  };
  archive: { defaultRange: string; maxDoneShown: number };
  refresh: { intervalSeconds: number };
  discovery: { ageGateDays: number };
  foreignWorkspaces: { maxHeightPx: number };
  worktrees: { maxHeightPx: number; autoCollapseAfterSeconds: number };
  usage: { showWeekly: boolean; warnAtPercent: number; criticalAtPercent: number };
  animations: { enabled: boolean };
  cleanup: { confirmRequired: boolean };
}

/** Defaults that mirror DEFAULT_SETTINGS in settings.ts. Used as the
 *  initial value before the first SettingsMessage arrives — kept in sync
 *  with the package.json `default` declarations. */
export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  show: { foreignWorkspaces: true, worktrees: true, usage: true, subagents: false, workflows: true, fileCollisions: false },
  archive: { defaultRange: '1d', maxDoneShown: 20 },
  refresh: { intervalSeconds: 5 },
  discovery: { ageGateDays: 7 },
  foreignWorkspaces: { maxHeightPx: 280 },
  worktrees: { maxHeightPx: 280, autoCollapseAfterSeconds: 20 },
  usage: { showWeekly: true, warnAtPercent: 85, criticalAtPercent: 100 },
  animations: { enabled: true },
  cleanup: { confirmRequired: true },
};

// Range values in ms. 'all' uses 0 as sentinel (means no limit).
export const RANGE_MS: Record<string, number> = {
  '1d': 86400000,
  '3d': 259200000,
  '7d': 604800000,
  '30d': 2592000000,
  'all': 0,
};

/** Ambient state the renderers read, built once per render pass by panel.ts.
 *  Everything here is read-only from the renderers' point of view — they
 *  never mutate it and never cause re-renders. */
export interface RenderContext {
  settings: PanelSettings;
  /** Current workspace root (host-injected; '' until the first update). */
  workspacePath: string;
  /** Host home dir for ~-abbreviation — the webview has no process.env. */
  homeDir: string;
  /** sessionId → shared-file list (computeFileCollisions output). */
  fileCollisions: ReadonlyMap<string, string[]>;
  /** sessionId → that session's workflow runs (show.workflows pre-gated). */
  workflowsBySession: ReadonlyMap<string, PanelWorkflow[]>;
  /** Compact threshold settings from the host, when known. */
  compactSettings: PanelCompactSettings | null;
  /** Foreign-workspace picker rows currently expanded. */
  expandedWorkspaces: ReadonlySet<string>;
}

// ===== TOP BAR / EMPTY STATE / TIME-RANGE =====

/** Status-count summary chips for the top bar. */
export function statusSummaryHtml(counts: Record<string, number>): string {
  let summaryHtml = '';
  if (counts['waiting'] > 0) summaryHtml += '<span class="status-count waiting-count">' + counts['waiting'] + ' waiting</span>';
  if (counts.running > 0) summaryHtml += '<span class="status-count running-count">' + counts.running + ' running</span>';
  if (counts.done > 0) summaryHtml += '<span class="status-count done-count">' + counts.done + ' done</span>';
  if (counts.stale > 0) summaryHtml += '<span class="status-count stale-count">' + counts.stale + ' seen</span>';
  if (!summaryHtml) summaryHtml = '<span class="status-count">No active sessions</span>';
  return summaryHtml;
}

/** Empty card-section placeholder; mentions older sessions when the 7-day
 *  window is the only thing hiding them. */
export function emptyStateHtml(olderSessionCount: number): string {
  const hasOlder = olderSessionCount > 0;
  const headline = hasOlder
    ? olderSessionCount + ' older session' + (olderSessionCount === 1 ? '' : 's') + ' beyond the 7-day window.'
    : 'No Claude Code sessions detected.';
  const hint = hasOlder
    ? 'Widen the range below to load them.'
    : 'Sessions appear when you start Claude Code.';
  return '<div class="empty-state"><div class="icon">⊘</div><div>'
    + escapeHtml(headline) + '</div><div class="hint">' + escapeHtml(hint) + '</div></div>';
}

/** Inner content of the archive time-range bar. */
export function timeRangePillsHtml(activeRange: string): string {
  const ranges = ['1d', '3d', '7d', '30d', 'all'];
  let html = 'Showing archived from last ';
  for (const r of ranges) {
    const active = r === activeRange;
    html += '<span class="time-pill' + (active ? ' active' : '') + '" data-range="' + r + '">' + r + '</span>';
  }
  return html;
}

// ===== CARD INNER HTML =====

/** A clickable meta-row chip that opens the source-keyed detail panel.
 *  `source` selects the drill-in (workflow | team | subagents); `containerId`
 *  is the sessionId (workflow/subagents) or teamId (team); `sessionId` is the
 *  invoking conversation the panel header jumps back to. Styling reuses the
 *  status-tinted `.wf-view-chip` recipe; `.detail-chip` is the click hook.
 *  `state` (running | waiting | failed | done) tints the chip to reflect the
 *  agents' OWN aggregate state, not the parent card's turn state — a stale
 *  (seen) parent dims it via CSS. */
export function renderDetailChip(label: string, source: DetailSource, containerId: string, sessionId: string, state: string, visibleHtml?: string): string {
  return '<span class="wf-tag wf-view-chip detail-chip wf-chip-' + escapeHtml(state) + '"'
    + ' data-detail-source="' + escapeHtml(source) + '"'
    + ' data-detail-container="' + escapeHtml(containerId) + '"'
    + ' data-detail-session="' + escapeHtml(sessionId) + '"'
    + ' role="button" tabindex="0" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label)
    + '">' + (visibleHtml ?? escapeHtml(label)) + '<span class="wf-arrow">→</span></span>';
}

/** Visible content of the agents chip: robot glyph + live-agent count.
 *  The glyph replaces the word "agents" (meta-row space); the count is how
 *  many agents are working RIGHT NOW — workflow agents plus subagents,
 *  detached background agents included, so a `done` card with live robots
 *  still reads as active down here. Zero live → glyph only; the chip's
 *  wf-chip-* tint (count + arrow inherit it) says how the crew is going. */
export function agentsChipHtml(liveCount: number): string {
  return '\u{1F916}' + (liveCount > 0 ? ' <span class="agent-live-count">' + liveCount + '</span>' : '');
}

/** Live (running or awaiting permission) agents beneath a card. */
export function countLiveAgents(wfs: PanelWorkflow[] | undefined, subs: PanelSession['subagents'] | undefined): number {
  const wfLive = (wfs ?? []).reduce((n, w) =>
    n + w.agents.filter(a => a.status === 'running' || a.status === 'waiting').length, 0);
  const subLive = (subs ?? []).filter(a => a.running || a.waitingOnPermission).length;
  return wfLive + subLive;
}

/** Aggregate state for a session card's detail chip — reflects what the chip
 *  opens (its workflow run(s) and/or plain Task subagents), so a live workflow
 *  under an idle session still reads as running. Precedence: a permission wait
 *  outranks running, which outranks a failed/incomplete run, else done. */
export function detailChipState(wfs: PanelWorkflow[] | undefined, subs: PanelSession['subagents'] | undefined): string {
  if ((subs ?? []).some(a => a.waitingOnPermission)) { return 'waiting'; }
  if ((wfs ?? []).some(w => w.status === 'running') || (subs ?? []).some(a => a.running)) { return 'running'; }
  if ((wfs ?? []).some(w => w.status === 'failed')) { return 'failed'; }
  // Killed/abandoned runs are "didn't finish", not "errored" — warning
  // orange on both surfaces (the detail panel already renders it so).
  if ((wfs ?? []).some(w => w.status === 'incomplete')) { return 'incomplete'; }
  return 'done';
}

/** Inline rows for the still-working agents under a card — the at-a-glance
 *  "who's active" list (one name for all kinds: agents). Capped to ~6 rows by
 *  CSS max-height + scroll. Each row deep-links the detail panel to that agent
 *  (groupKey + agentId). Empty list → nothing rendered. */
export function renderInlineAgents(
  agents: { agentId?: string | null; label: string; status: string }[],
  source: DetailSource,
  containerId: string,
  sessionId: string,
  groupKey: string,
): string {
  if (agents.length === 0) { return ''; }
  let html = '<div class="card-agent-list" role="list">';
  for (const a of agents) {
    const dot = a.status === 'waiting' ? 'waiting' : a.status === 'failed' ? 'failed' : 'running';
    html += '<div class="card-agent-row" role="listitem button" tabindex="0"'
      + ' data-detail-source="' + escapeHtml(source) + '"'
      + ' data-detail-container="' + escapeHtml(containerId) + '"'
      + ' data-detail-session="' + escapeHtml(sessionId) + '"'
      + ' data-group="' + escapeHtml(groupKey) + '"'
      + ' data-agent="' + escapeHtml(a.agentId ?? '') + '"'
      + ' title="' + escapeHtml(a.label) + '">'
      + '<span class="card-agent-dot ' + dot + '"></span>'
      + '<span class="card-agent-name">' + escapeHtml(a.label) + '</span>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

/** A session's current workflow run contributes only its still-working agents
 *  as inline rows — no progress bar, no "✓ N agents" tick (decided by Murray:
 *  a finished run needs neither; the "agents →" chip carries the click-through).
 *  A terminal run (completed / failed / killed→incomplete) renders nothing. */
export function renderWorkflowBlock(wfs: PanelWorkflow[]): string {
  const run = wfs[0];
  if (run.status !== 'running') { return ''; }
  const active = run.agents.filter(a => a.status === 'running' || a.status === 'waiting');
  return renderInlineAgents(
    active.map(a => ({ agentId: a.agentId, label: a.label || (a.agentId ? a.agentId.slice(0, 8) : 'agent'), status: a.status })),
    'workflow', run.sessionId, run.sessionId, run.runId);
}

/** Fixed hue per model family, ordered cheapest → priciest on a blue → orange
 *  scale so the model pill reads as relative API cost, not family identity.
 *  Based on normal (non-introductory) per-token pricing, where same-family
 *  versions currently share a rate (Opus 4.6/4.7/4.8 are all $5/$25; Sonnet
 *  4.6 and 5 are both $3/$15 before Sonnet 5's temporary intro discount).
 *  Fable and Mythos share a hue — same price, same tier. */
const MODEL_COST_HUE: Record<string, number> = {
  'Haiku': 208,
  'Sonnet': 232,
  'Opus': 38,
  'Fable': 18,
  'Mythos': 18,
};

/** Hue for a model pill: the fixed cost-tier hue above for a known family, or
 *  a djb2-hash fallback (spread by the golden angle) for anything not yet
 *  classified, so a new model family still gets a stable, distinct colour
 *  instead of silently defaulting into one bucket. Same input → same hue,
 *  every build. */
export function modelHue(label: string): number {
  const tier = MODEL_COST_HUE[label];
  if (tier !== undefined) { return tier; }
  let h = 5381;
  for (let i = 0; i < label.length; i++) { h = ((h << 5) + h + label.charCodeAt(i)) >>> 0; }
  return Math.round((h * 137.508) % 360);
}

export function renderCardInner(ctx: RenderContext, s: PanelSession, now: number, isFocused: boolean): string {
  const wfs = ctx.workflowsBySession.get(s.sessionId);
  // A card owning a live workflow run is pinned `running` by applyWorkflowLiveStatus
  // even while its own JSONL is idle between fan-out waves; suppress the "quiet"
  // qualifier so the pill doesn't contradict that upgrade. Same `status === 'running'`
  // test the host upgrade uses (dismissed runs are already filtered out of this map).
  const liveWorkflow = (wfs ?? []).some(w => w.status === 'running');
  const statusLabel = getStatusLabel(s, now, { liveWorkflow });
  const displayName = stripMarkdown(getDisplayName(s));

  let subagentHtml = '';
  const hasSubagents = s.subagents && s.subagents.length > 0;
  const showSubagents = hasSubagents
    && ctx.settings.show.subagents
    // Live agents always earn their roster rows — a `done` card can still
    // have detached background agents working under it.
    && (s.status === 'running' || s.status === 'waiting' || isFocused
      || s.subagents!.some(a => a.running || a.waitingOnPermission));
  if (showSubagents && s.subagents) {
    // Only the still-working agents are listed inline (running / awaiting
    // permission); click one to drill straight to it. When all are done there's
    // no list and no count tick — the "agents →" chip is the click-through.
    const active = s.subagents.filter(a => a.running || a.waitingOnPermission);
    subagentHtml = renderInlineAgents(
      active.map(a => ({ agentId: a.agentId, label: a.description, status: a.waitingOnPermission ? 'waiting' : 'running' })),
      'subagents', s.sessionId, s.sessionId, '');
  }

  const isLive = s.status === 'running' || s.status === 'waiting';
  const dismissTitle = isLive
    ? 'Archive (use if status is stuck or hook hasn’t fired)'
    : 'Dismiss';
  let actionsHtml = '<div class="card-actions">';
  actionsHtml += '<button class="action-btn transcript-btn" data-transcript-id="' + escapeHtml(s.sessionId) + '" title="View transcript" aria-label="View transcript">&#x1f4dc;</button>';
  actionsHtml += '<button class="action-btn dismiss-btn' + (isLive ? ' dismiss-btn-force' : '') + '" data-dismiss-id="' + escapeHtml(s.sessionId) + '" title="' + escapeHtml(dismissTitle) + '" aria-label="Archive session">&times;</button>';
  actionsHtml += '</div>';

  let metaHtml = '<div class="card-meta">';
  metaHtml += '<span class="session-id-pill clickable" data-copy-id="' + escapeHtml(s.sessionId) + '" title="Copy session ID">' + escapeHtml(s.sessionId.slice(0, 8)) + '</span>';
  if (s.modelLabel) {
    // Cost-tier hue: blue = cheap, orange = expensive (see MODEL_COST_HUE).
    // A separate colour register from status colours — hue varies, sat/light
    // are fixed per theme in CSS, so the pills read as cost, not as status.
    // Hue keys on the family word ("Opus"), not the full "Opus 4.8", so every
    // version of a family shares one colour — same-family versions currently
    // share a price too (see MODEL_COST_HUE for the one time-boxed exception).
    // Strip a trailing "*" (unconfirmed-guess marker) first — "Opus*" (no
    // version yet) must hash to the same family as "Opus" / "Opus 4.8*".
    const family = s.modelLabel.replace(/\*$/, '').split(' ')[0];
    metaHtml += '<span class="model-pill" style="--model-hue:' + modelHue(family) + '">' + escapeHtml(s.modelLabel) + '</span>';
  }
  // Another VS Code window is confirmed to be this session's live writer right
  // now (see .card.external-writer in panel.css) — the dimmed card alone reads
  // as unexplained greying, so name the state explicitly.
  if (s.externalWriter) {
    metaHtml += '<span class="external-writer-badge" title="Open in another VS Code window right now — not opening here to avoid a conflict">Active elsewhere</span>';
  }
  // Background-shell badge — a detached `run_in_background` shell is still
  // going after the turn ended. Non-status (the card keeps its real status);
  // a quiet running-tinted chip so a `done` card still flags the live build.
  const bgShells = s.backgroundShellCount ?? 0;
  if (bgShells > 0) {
    const bgLabel = bgShells + ' shell' + (bgShells === 1 ? '' : 's') + ' running';
    metaHtml += '<span class="bg-shell-badge" title="Background shells launched with run_in_background still running">' + bgLabel + '</span>';
  }
  // Loops badge — the card is sleeping (ScheduleWakeup pending) or looping
  // (session crons live). Same quiet running-tinted chip as the shell badge:
  // a "done" card that will re-invoke itself is not finished, just idle.
  if (s.pendingWakeupAt && s.pendingWakeupAt > now) {
    const wakeTitle = 'Wakes at ' + new Date(s.pendingWakeupAt).toLocaleTimeString()
      + (s.pendingWakeupReason ? ' — ' + s.pendingWakeupReason : '');
    metaHtml += '<span class="bg-shell-badge" title="' + escapeHtml(wakeTitle) + '">'
      + '\u{1F4A4} ' + formatAge(s.pendingWakeupAt - now) + '</span>';
  }
  const cronN = s.sessionCronCount ?? 0;
  if (cronN > 0) {
    const cronTitle = 'Session cron' + (cronN === 1 ? '' : 's') + ' — re-invokes on schedule'
      + (s.sessionCronLabel ? ': ' + s.sessionCronLabel : '');
    metaHtml += '<span class="bg-shell-badge" title="' + escapeHtml(cronTitle) + '">'
      + 'loop' + (cronN > 1 ? ' · ' + cronN : '') + '</span>';
  }
  // A session's agents can come from workflow run(s) and/or plain Task
  // subagents. Both open the same detail panel (keyed to this session), which
  // surfaces a view switcher across them, so collapse to ONE chip rather than
  // two: workflow-specific label when only workflows, "subagents" when only
  // those, and a neutral "agents" when both — the switcher carries the rest.
  // Initial source is the workflow when present (richer), else subagents.
  // (Tool-error badge removed 2026-06-10 — Murray: non-actionable and badly
  // correlated with real trouble (benign failed greps/probes inflate it).
  // toolErrorCount stays in the snapshot for a future actionable surface.)
  // Same-file collision — another ACTIVE session is editing the same
  // file(s); a merge conflict in the making. Same quiet-chip pattern as
  // the tool-error badge; lists the shared paths in the tooltip.
  const collisions = ctx.settings.show.fileCollisions ? ctx.fileCollisions.get(s.sessionId) : undefined;
  if (collisions && collisions.length > 0) {
    const shown = collisions.slice(0, 6).map(f => f.split('/').pop() || f);
    const extra = collisions.length > 6 ? ' (+' + (collisions.length - 6) + ' more)' : '';
    metaHtml += '<span class="tool-error-badge" title="'
      + escapeHtml('Files also being edited by another active session:\n' + shown.join('\n') + extra)
      + '">' + collisions.length + ' shared file' + (collisions.length === 1 ? '' : 's') + '</span>';
  }
  const hasWf = !!wfs && wfs.length > 0;
  // The chip is the click-through to the detail panel, not the inline noise —
  // show.subagents only controls the inline rows (subagentHtml / renderWorkflowBlock
  // above). It stays keyed on presence alone, same as the workflow chip always was,
  // so the robot button still opens the panel with show.subagents off.
  const chipState = detailChipState(wfs, s.subagents);
  // One chip for everything beneath a card — agents (be they workflow agents,
  // subagents, or teammates), rendered as 🤖 + live count + arrow. The source
  // still routes the drill-in: prefer the workflow view when a run is present
  // (richer), else the subagents view.
  if (hasWf || hasSubagents) {
    const live = countLiveAgents(wfs, s.subagents);
    const label = live > 0 ? 'agents — ' + live + ' running' : 'agents';
    metaHtml += renderDetailChip(label, hasWf ? 'workflow' : 'subagents',
      s.sessionId, s.sessionId, chipState, agentsChipHtml(live));
  }
  metaHtml += actionsHtml;
  metaHtml += '</div>';

  // Context window fill bar — tracks effective compact threshold, tooltip shows both
  let contextBarHtml = '';
  if (s.contextTokens && s.contextTokens > 0) {
    const cw = ctx.compactSettings?.autoCompactWindow ?? 200_000;
    const cp = ctx.compactSettings?.autoCompactPct ?? 95;
    const threshold = getCompactThreshold(cw, cp);
    const capacity = getModelCapacity(s.modelLabel);
    const pct = Math.min(100, Math.round((s.contextTokens / threshold) * 100));
    const tokenLabel = formatTokenCount(s.contextTokens);
    const thresholdLabel = formatTokenCount(threshold);
    const capacityLabel = formatTokenCount(capacity);
    const fillClass = 'context-fill' + (pct >= 60 ? ' hot' : '');
    const tooltip = 'Context: ' + tokenLabel + ' / ' + thresholdLabel + ' compact (' + pct + '%) — ' + capacityLabel + ' model';
    contextBarHtml = '<div class="context-bar" title="' + escapeHtml(tooltip) + '">'
      + '<div class="' + fillClass + '" style="width:' + pct + '%"></div>'
      + '</div>';
  }

  // A finished card's most useful line is WHAT it finished with — prefer the
  // last assistant reply over the final tool-name activity on done/stale.
  const isTerminal = s.status === 'done' || s.status === 'stale';
  const activityText = stripMarkdown(
    (isTerminal && s.lastAssistantText ? s.lastAssistantText : s.activity) || 'No recent activity');
  const detailHtml = '<div class="card-detail">' + escapeHtml(activityText) + '</div>';

  // Branch / worktree line — its own row beneath the meta, rendered ONLY when
  // the session has a git branch (no branch ⇒ no line, no wasted height). The
  // branch is the widest, most variable item in the meta row; lifting it out
  // keeps that row short enough that the action buttons stop wrapping up beside
  // the status pill, and the branch gets the full card width to itself.
  const branchHtml = s.gitBranch
    ? '<div class="card-branch"><span class="branch-pill" title="Git branch: ' + escapeHtml(s.gitBranch) + '">' + escapeHtml('⎇ ' + s.gitBranch) + '</span></div>'
    : '';

  return '<div class="card-top">'
    + '<span class="card-name">' + escapeHtml(displayName) + '</span>'
    + '<span class="status-pill">' + statusLabel + '</span>'
    + '</div>'
    + metaHtml
    + branchHtml
    + detailHtml
    + (wfs && wfs.length > 0 && ctx.settings.show.subagents ? renderWorkflowBlock(wfs) : '')
    + subagentHtml
    + contextBarHtml;
}

// ===== FOREIGN WORKSPACE / WORKTREE ROWS =====

/** Abbreviate a path by replacing $HOME with ~. */
export function tildeAbbrev(ctx: RenderContext, p: string): string {
  // homeDir is injected by the host 'update' message — the webview runs in the
  // browser and has no process.env, so reading process.env.HOME never worked.
  if (ctx.homeDir && p.startsWith(ctx.homeDir)) { return '~' + p.slice(ctx.homeDir.length); }
  return p;
}

/** Render a single foreign workspace row.
 *  When the row aggregates 2+ worktrees, becomes a click-to-expand picker
 *  parent (chevron, no data-cwd) followed by an inline child list of every
 *  worktree of the repo. Otherwise behaves as a direct-open row. */
export function renderWsRow(ctx: RenderContext, ws: WorkspaceGroup): string {
  const running = ws.counts['running'] || 0;
  const waiting = ws.counts['waiting'] || 0;
  const wtCount = ws.worktreeCount ?? 0;
  const wtMembers = ws.worktreeMembersLabel ?? '';
  const isAggregated = wtCount > 1;
  // Pseudo rows (consolidated /private/tmp scratch dirs) have no git
  // worktrees — their picker is driven by `members` (one child per dir).
  const isPseudo = ws.pseudoRepo === true;
  // Expandable picker when we have per-worktree paths (foreign manager
  // populated `worktrees`) or, for pseudo rows, per-dir members. Otherwise
  // fall back to the legacy direct-open aggregated row.
  const pickerEligible = isAggregated && (
    (Array.isArray(ws.worktrees) && ws.worktrees.length > 0)
    || (isPseudo && Array.isArray(ws.members) && ws.members.length > 0)
  );
  const isExpanded = pickerEligible && ctx.expandedWorkspaces.has(ws.workspaceKey);
  const rowClass = 'ws-row'
    + (isAggregated ? ' ws-row-aggregated' : '')
    + (pickerEligible ? ' ws-row-expandable' : '')
    + (waiting > 0 ? ' ws-row-waiting' : '')
    + ((pickerEligible || ws.cwd) ? ' ws-row-clickable' : '');
  const countsHtml = countsChipsHtml(ws.counts);
  const hasLiveSessions = running > 0 || waiting > 0;
  const chevron = pickerEligible
    ? '<span class="ws-chevron' + (isExpanded ? ' expanded' : '') + '">&#x25B8;</span>'
    : '';
  // Pseudo (tmp) rows borrow the familiar `Nwt` suffix but mark it with a `*`
  // — these aren't real git worktrees, just consolidated scratch dirs. The
  // `*` is explained in the chip tooltip. (Avoided `Nd`: the `d` reads as the
  // Done count or "days".)
  const wtChip = isAggregated
    ? '<span class="worktree-count-chip" title="' + escapeHtml(isPseudo ? '* not git worktrees — consolidated scratch dirs under /tmp\n' + wtMembers : wtMembers) + '">' + wtCount + 'wt' + (isPseudo ? '*' : '') + '</span>'
    : '';
  // Picker parent rows don't open on click — they expand — so they don't
  // carry data-cwd. Plain aggregated rows (no per-worktree data) still
  // open the canonical checkout directly.
  const pickerNoun = isPseudo ? 'directories' : 'worktrees';
  const titleText = pickerEligible
    ? (isExpanded ? 'Collapse ' + pickerNoun : 'Show ' + wtCount + ' ' + pickerNoun)
    : (ws.cwd ? tildeAbbrev(ctx, ws.cwd) : '');
  let rowAttrs: string;
  if (pickerEligible) {
    rowAttrs = ' data-workspace-key="' + escapeHtml(ws.workspaceKey)
      + '" tabindex="0" role="button" aria-expanded="' + (isExpanded ? 'true' : 'false') + '"'
      + ' title="' + escapeHtml(titleText) + '"';
  } else if (ws.cwd) {
    rowAttrs = ' data-cwd="' + escapeHtml(ws.cwd) + '" tabindex="0" role="button" title="' + escapeHtml(titleText) + '"';
  } else {
    rowAttrs = '';
  }
  let html = '<div class="' + rowClass + '"'
    + (hasLiveSessions ? ' data-confidence="' + escapeHtml(ws.confidence || 'medium') + '"' : '')
    + rowAttrs + '>'
    + chevron
    + '<span class="ws-name">' + escapeHtml(ws.displayName) + '</span>'
    + (ws.ideOpen ? '<span class="ws-picker-quiet" title="Open in a VS Code window now">IDE</span>' : '')
    + wtChip
    + '<div class="ws-counts">' + countsHtml + '</div>'
    + '</div>';
  if (isExpanded) {
    html += renderWorktreePickerChildren(ctx, ws);
  }
  return html;
}

/** Render the inline picker children for an expanded aggregated row.
 *  Lists every worktree of the repo (incl. main). Skips the current
 *  workspace path so we never offer a no-op target. Per-worktree counts
 *  come from `ws.members[i].counts` matched on path. */
export function renderWorktreePickerChildren(ctx: RenderContext, ws: WorkspaceGroup): string {
  // Pseudo rows (consolidated scratch dirs) have no git worktrees — list the
  // member dirs directly, each opening its own cwd.
  if (ws.pseudoRepo === true) { return renderScratchPickerChildren(ctx, ws); }
  const worktrees = ws.worktrees ?? [];
  if (worktrees.length === 0) { return ''; }
  const wsRootNorm = normPath(ctx.workspacePath);
  const memberByCwd = new Map<string, WorkspaceGroup>();
  for (const m of (ws.members ?? [])) {
    if (m.cwd) { memberByCwd.set(normPath(m.cwd), m); }
  }
  // Sort: main first, then by branch/path
  const sorted = [...worktrees].sort((a, b) => {
    if (a.isMain !== b.isMain) { return a.isMain ? -1 : 1; }
    const aLabel = a.branch ?? a.path;
    const bLabel = b.branch ?? b.path;
    return aLabel.localeCompare(bLabel);
  });
  let html = '<div class="ws-picker-children" role="group" aria-label="Worktrees">';
  for (const wt of sorted) {
    const pathNorm = normPath(wt.path);
    // Skip the worktree the user is already in — clicking it is a no-op.
    if (pathNorm === wsRootNorm) { continue; }
    const member = memberByCwd.get(pathNorm);
    const mainChip = wt.isMain
      ? '<span class="ws-main-chip" title="Main checkout">main</span>'
      : '';
    const detachedHint = wt.branch ? '' : ' (detached)';
    const noActivityHint = !member && !wt.isMain
      ? '<span class="ws-picker-quiet" title="No Claude Code activity in 7d">no activity</span>'
      : '';
    html += pickerChildRow({
      cwd: wt.path,
      parentKey: ws.workspaceKey,
      label: wt.branch || basename(wt.path),
      title: tildeAbbrev(ctx, wt.path) + detachedHint,
      counts: member?.counts ?? {},
      confidence: member?.confidence,
      extraChipsHtml: mainChip + noActivityHint,
    });
  }
  html += '</div>';
  return html;
}

/** Render the inline picker children for an expanded pseudo (scratch) row.
 *  One child per member dir, each opening its own cwd. Skips the current
 *  workspace path so we never offer a no-op target. Unlike the worktree
 *  picker there are no main/detached/no-activity hints — every member is a
 *  live scratch dir with sessions. */
export function renderScratchPickerChildren(ctx: RenderContext, ws: WorkspaceGroup): string {
  const members = ws.members ?? [];
  if (members.length === 0) { return ''; }
  const wsRootNorm = normPath(ctx.workspacePath);
  const sorted = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName));
  let html = '<div class="ws-picker-children" role="group" aria-label="Directories">';
  for (const m of sorted) {
    if (!m.cwd) { continue; }
    if (normPath(m.cwd) === wsRootNorm) { continue; }
    html += pickerChildRow({
      cwd: m.cwd,
      parentKey: ws.workspaceKey,
      label: basename(m.cwd),
      title: tildeAbbrev(ctx, m.cwd),
      counts: m.counts ?? {},
      confidence: m.confidence,
    });
  }
  html += '</div>';
  return html;
}

/** Render one row of the Worktrees pane. Reuses .ws-row classes for visual
 *  consistency with foreign rows. The current worktree gets data-current so
 *  CSS can mark it; clicking any non-current row sends openWorkspace. */
export function renderWorktreeRow(ctx: RenderContext, wt: PanelWorktreeRow): string {
  const running = wt.counts['running'] || 0;
  const waiting = wt.counts['waiting'] || 0;
  const hasLive = running > 0 || waiting > 0;
  const countsHtml = countsChipsHtml(wt.counts);

  const cls = 'ws-row ws-row-worktree'
    + (waiting > 0 ? ' ws-row-waiting' : '')
    + (wt.isCurrent ? ' ws-row-current' : ' ws-row-clickable');
  // Tooltip is the full worktree path (with $HOME tilde-abbreviated). Keeps
  // it on one line; "Switch to" / "Current worktree" prefixes were redundant
  // when the path itself is shown.
  const branchHint = wt.branch ? '' : ' (detached)';
  const titleText = tildeAbbrev(ctx, wt.path) + branchHint
    + (wt.isCurrent ? ' (current)' : '');
  const cwdAttr = wt.isCurrent
    ? ''
    : ' data-cwd="' + escapeHtml(wt.path) + '" tabindex="0" role="button"';
  // Pin sits AFTER the name (before the optional `main` chip), so non-current
  // rows don't need a placeholder column on the left. Inline SVG keeps the
  // icon themable via currentColor and avoids a webfont fetch under our
  // restrictive CSP.
  const pinSlot = wt.isCurrent
    ? '<span class="ws-current-pin" title="You are here" aria-label="You are here">'
      + '<svg viewBox="0 0 24 24" width="9" height="11" fill="currentColor" aria-hidden="true">'
      + '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/>'
      + '</svg></span>'
    : '';
  const mainChip = wt.isMain
    ? '<span class="ws-main-chip" title="Main checkout">main</span>'
    : '';
  return '<div class="' + cls + '"'
    + (hasLive ? ' data-confidence="' + escapeHtml(wt.confidence) + '"' : '')
    + cwdAttr
    + ' title="' + escapeHtml(titleText) + '">'
    + '<span class="ws-name">' + escapeHtml(wt.displayName) + '</span>'
    + pinSlot
    + mainChip
    + '<div class="ws-counts">' + countsHtml + '</div>'
    + '</div>';
}

export function renderWorktreesPane(ctx: RenderContext, rows: PanelWorktreeRow[]): string {
  let html = '<div class="ws-section-header">Worktrees</div>';
  for (const wt of rows) { html += renderWorktreeRow(ctx, wt); }
  return html;
}

/** Collapse multi-worktree repos into a single row (e.g. when viewed from
 *  outside serac, all `serac-spike-*` worktrees fold into one `serac` row
 *  with a `Nwt` chip); render everything else flat. */
export function renderForeignWorkspaceRows(ctx: RenderContext, workspaces: WorkspaceGroup[]): string {
  let html = '<div class="ws-section-header">Other workspaces</div>';
  const rows = groupForeignWorkspaces(workspaces, p => tildeAbbrev(ctx, p));
  for (const ws of rows) {
    html += renderWsRow(ctx, ws);
  }
  return html;
}

// ===== ARCHIVE ROWS =====

export function renderCompactRow(s: PanelSession, now: number): string {
  const age = formatAge(now - s.lastActivity);
  const displayName = getDisplayName(s);
  return '<div class="compact-row" role="listitem" tabindex="0" data-session-id="' + escapeHtml(s.sessionId) + '">'
    + '<span class="compact-name">' + escapeHtml(displayName) + '</span>'
    + '<span class="compact-transcript" data-transcript-id="' + escapeHtml(s.sessionId) + '" role="button" tabindex="0" title="View transcript" aria-label="View transcript">&#x1f4dc;</span>'
    + '<span class="compact-age">' + age + '</span>'
    + '</div>';
}

export function renderTeamCompactRow(team: PanelTeam): string {
  const agentCount = team.agents.length;
  const countLabel = agentCount + ' agent' + (agentCount !== 1 ? 's' : '');
  return '<div class="team-compact-row" role="listitem" tabindex="0" data-team-id="' + escapeHtml(team.teamId) + '">'
    + '<span class="team-badge">team</span>'
    + '<span class="compact-name">' + escapeHtml(team.name) + '</span>'
    + '<span class="compact-transcript" data-detail-source="team" data-detail-container="' + escapeHtml(team.teamId) + '" data-detail-session="' + escapeHtml(team.orchestrator.sessionId) + '" role="button" tabindex="0" title="View team agents" aria-label="View team agents">&#x1f4dc;</span>'
    + '<span class="compact-age">' + countLabel + '</span>'
    + '</div>';
}

/** Archived workflow run: a compact row that un-dismisses (reopens the
 *  invoking conversation) on click, mirroring the team/session archive rows. */
export function renderWorkflowCompactRow(wf: PanelWorkflow, now: number): string {
  const age = formatAge(now - (wf.startTime + (wf.durationMs || 0)));
  return '<div class="workflow-compact-row" role="listitem" tabindex="0" data-run-id="' + escapeHtml(wf.runId) + '">'
    + '<span class="wf-badge">wf</span>'
    + '<span class="compact-name">' + escapeHtml(wf.name) + '</span>'
    + '<span class="compact-transcript" data-detail-source="workflow" data-detail-container="' + escapeHtml(wf.sessionId) + '" data-detail-session="' + escapeHtml(wf.sessionId) + '" role="button" tabindex="0" title="View run agents" aria-label="View run agents">&#x1f4dc;</span>'
    + '<span class="compact-age">' + age + '</span>'
    + '</div>';
}

/** Interleaved archive list (sessions + teams + workflow runs) as one
 *  recency-sorted HTML string. Each item carries a `ts` (last-activity epoch
 *  ms): sessions use lastActivity; teams the orchestrator's updatedAt;
 *  workflows their end time (start + duration). Teams and workflows are
 *  low-volume "container" archives exempt from the day-window (a team's
 *  updatedAt can predate its dismissal — the 7-day discovery gate is keyed on
 *  config mtime, not updatedAt — so age-windowing them would silently hide a
 *  just-dismissed team). They still take part in the recency sort; only their
 *  *visibility* is unconditional. The window stays on plain sessions, which
 *  are the high-volume case it exists to bound. */
export function archiveListHtml(
  archived: PanelSession[],
  archivedTeams: PanelTeam[],
  archivedWorkflows: PanelWorkflow[],
  now: number,
  archiveRange: string,
): string {
  const DAY_MS = 86400000;
  const rangeMs = RANGE_MS[archiveRange]; // 0 = no limit (all)

  interface ArchiveItem { ts: number; html: string; alwaysShow?: boolean }
  const items: ArchiveItem[] = [];
  for (const s of archived) {
    items.push({ ts: s.lastActivity, html: renderCompactRow(s, now) });
  }
  for (const team of archivedTeams) {
    items.push({ ts: team.updatedAt, html: renderTeamCompactRow(team), alwaysShow: true });
  }
  for (const wf of archivedWorkflows) {
    items.push({ ts: wf.startTime + (wf.durationMs || 0), html: renderWorkflowCompactRow(wf, now), alwaysShow: true });
  }

  // Newest first.
  items.sort((a, b) => b.ts - a.ts);

  // Window: containers and rows from the last day always show; older sessions
  // show only when the range allows (1d hides them; a wider/all range reveals).
  let archiveHtml = '';
  for (const item of items) {
    const age = now - item.ts;
    if (item.alwaysShow || age <= DAY_MS) {
      archiveHtml += item.html;
    } else if ((rangeMs === 0 || age <= rangeMs) && archiveRange !== '1d') {
      archiveHtml += item.html;
    }
  }
  return archiveHtml;
}

// ===== USAGE SECTION =====

/** Render companion-registered slots under the usage card.
 *  All companion-supplied strings go through escapeHtml — no HTML ever
 *  reaches the DOM as-is. */
export function renderFooterSlots(slots: PanelFooterSlot[]): string {
  if (!slots || slots.length === 0) { return ''; }
  let html = '<div class="usage-slots">';
  for (const slot of slots) {
    const cls = ['usage-slot-row'];
    if (slot.hasCommand) { cls.push('clickable'); }
    const role = slot.hasCommand ? ' role="button" tabindex="0"' : '';
    const tooltip = slot.tooltip ? ' title="' + escapeHtml(slot.tooltip) + '"' : '';
    html += '<div class="' + cls.join(' ') + '" data-slot-id="' + escapeHtml(slot.slotId) + '"' + role + tooltip + '>';
    if (slot.status) {
      html += '<span class="api-dot ' + slot.status + '" title="' + escapeHtml(slot.status) + '"></span>';
    }
    if (slot.icon) {
      html += '<span class="usage-slot-icon">' + escapeHtml(slot.icon) + '</span>';
    }
    html += '<span class="usage-slot-label">' + escapeHtml(slot.label) + '</span>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

/** Full inner HTML for the usage section, covering every state: loading
 *  ghost, platform-unsupported, API-disconnected, expired windows, live bars,
 *  and the footer (companion slots + updated-ago). */
export function renderUsageHtml(
  ctx: RenderContext,
  usage: UsageData | null,
  footerSlots: PanelFooterSlot[],
  now: number,
): string {
  // Companion-registered footer slots (e.g. the account-switcher row) are
  // independent of live-usage availability, so they must render in every
  // state — including platforms where the usage API is unsupported (Windows/
  // Linux) or disconnected. Otherwise a registered slot silently vanishes
  // wherever live usage can't be read.
  const slotsHtml = renderFooterSlots(footerSlots);
  const slotsFooter = slotsHtml ? '<div class="usage-footer">' + slotsHtml + '</div>' : '';

  // Ghost state when no data has arrived yet.
  if (!usage || !usage.loaded) {
    return '<div class="usage-ghost-msg" style="font-style:normal">Calling usage API…</div>' + slotsFooter;
  }

  const u = usage;
  let html = '';

  // Platform not supported — no OAuth credential access
  if (!u.platformSupported) {
    html += '<div class="usage-row"><div class="usage-row-label usage-row-disabled">Live usage not available. <a class="usage-link" href="https://claude.ai/settings/usage">View online.</a></div></div>';
    return html + slotsFooter;
  }

  // API disconnected state
  if (!u.apiConnected) {
    html += '<div class="usage-updated" style="text-align:left"><span class="api-dot disconnected"></span>Live usage unavailable · <a class="usage-link" href="https://claude.ai/settings/usage">view online</a></div>';
    return html + slotsFooter;
  }

  // --- Current session (5h) ---
  const sessionExpired = u.resetTime && u.resetTime <= now;
  if (sessionExpired) {
    // Ghost state: window expired
    html += '<div class="usage-row ghost">';
    html += '<div class="usage-row-label">Current session</div>';
    html += '<div class="usage-row-reset" style="color:#555555">window expired</div>';
    html += '</div>';
    html += '<div class="usage-bar-row">';
    html += '<div class="usage-bar-wrap ghost"></div>';
    html += '<span class="usage-bar-pct ghost">—</span>';
    html += '</div>';
    html += '<div class="usage-ghost-msg">Next interaction starts new session.</div>';
  } else {
    const sessionTickPct = getElapsedPct(u.resetTime, 5 * 60 * 60 * 1000);
    const sessionCls = quotaClass(u.quotaPct5h || 0, sessionTickPct, ctx.settings.usage.warnAtPercent, ctx.settings.usage.criticalAtPercent);
    const overQuota = (u.quotaPct5h || 0) >= 100;

    html += '<div class="usage-row">';
    html += '<div class="usage-row-label">Current session usage</div>';
    if (u.resetTime) {
      html += '<div class="usage-row-reset">Resets in ' + formatResetTime(u.resetTime) + '</div>';
    }
    html += '</div>';

    html += '<div class="usage-bar-row">';
    html += '<div class="usage-bar-wrap">';
    html += '<div class="usage-bar-fill ' + sessionCls + '" style="width:' + Math.min(100, u.quotaPct5h || 0) + '%"></div>';
    if (sessionTickPct > 0) html += '<div class="usage-bar-tick" style="left:' + sessionTickPct + '%" title="' + Math.round(sessionTickPct) + '% of window elapsed"></div>';
    html += '</div>';
    html += '<span class="usage-bar-pct ' + sessionCls + '">' + Math.round(u.quotaPct5h || 0) + '%<span class="usage-bar-elapsed"> / ' + Math.round(sessionTickPct) + '%</span></span>';
    html += '</div>';

    if (overQuota) {
      const overLabel = u.extraUsageEnabled ? 'EXTRA USAGE' : 'LIMIT REACHED';
      html += '<div class="usage-status critical">' + overLabel + '</div>';
    }
  }

  // --- Weekly ---
  if (!ctx.settings.usage.showWeekly) {
    // Skip the weekly block entirely; footer still appears below.
  } else {
  const weeklyExpired = u.weeklyResetTime && u.weeklyResetTime <= now;
  if (weeklyExpired) {
    // Ghost state: weekly window expired
    html += '<div class="usage-weekly-sep">';
    html += '<div class="usage-row ghost">';
    html += '<div class="usage-row-label">Weekly session usage</div>';
    html += '<div class="usage-row-reset" style="color:#555555">no active window</div>';
    html += '</div>';
    html += '<div class="usage-bar-row">';
    html += '<div class="usage-bar-wrap ghost"></div>';
    html += '<span class="usage-bar-pct ghost">—</span>';
    html += '</div>';
    html += '</div>';
  } else if ((u.quotaPctWeekly || 0) > 0 || u.weeklyResetTime) {
    const weeklyTickPct = getElapsedPct(u.weeklyResetTime, 7 * 24 * 60 * 60 * 1000);
    const weeklyCls = quotaClass(u.quotaPctWeekly || 0, weeklyTickPct, ctx.settings.usage.warnAtPercent, ctx.settings.usage.criticalAtPercent);

    html += '<div class="usage-weekly-sep">';
    html += '<div class="usage-row">';
    html += '<div class="usage-row-label">Weekly session usage</div>';
    if (u.weeklyResetTime) {
      html += '<div class="usage-row-reset">Resets in ' + formatResetTime(u.weeklyResetTime) + '</div>';
    }
    html += '</div>';
    html += '<div class="usage-bar-row">';
    html += '<div class="usage-bar-wrap">';
    html += '<div class="usage-bar-fill ' + weeklyCls + '" style="width:' + Math.min(100, u.quotaPctWeekly || 0) + '%"></div>';
    if (weeklyTickPct > 0) html += '<div class="usage-bar-tick" style="left:' + weeklyTickPct + '%" title="' + Math.round(weeklyTickPct) + '% of window elapsed"></div>';
    html += '</div>';
    html += '<span class="usage-bar-pct ' + weeklyCls + '">' + Math.round(u.quotaPctWeekly || 0) + '%<span class="usage-bar-elapsed"> / ' + Math.round(weeklyTickPct) + '%</span></span>';
    html += '</div>';
    html += '</div>';
  }

  // --- Weekly Fable (model-scoped weekly quota) ---
  const fableExpired = u.weeklyResetTimeFable && u.weeklyResetTimeFable <= now;
  if (fableExpired) {
    html += '<div class="usage-weekly-sep">';
    html += '<div class="usage-row ghost">';
    html += '<div class="usage-row-label">Weekly Fable usage</div>';
    html += '<div class="usage-row-reset" style="color:#555555">no active window</div>';
    html += '</div>';
    html += '<div class="usage-bar-row">';
    html += '<div class="usage-bar-wrap ghost"></div>';
    html += '<span class="usage-bar-pct ghost">—</span>';
    html += '</div>';
    html += '</div>';
  } else if (u.quotaPctWeeklyFable != null) {
    const fableTickPct = getElapsedPct(u.weeklyResetTimeFable, 7 * 24 * 60 * 60 * 1000);
    const fableCls = quotaClass(u.quotaPctWeeklyFable || 0, fableTickPct, ctx.settings.usage.warnAtPercent, ctx.settings.usage.criticalAtPercent);

    html += '<div class="usage-weekly-sep">';
    html += '<div class="usage-row">';
    html += '<div class="usage-row-label">Weekly Fable usage</div>';
    if (u.weeklyResetTimeFable) {
      html += '<div class="usage-row-reset">Resets in ' + formatResetTime(u.weeklyResetTimeFable) + '</div>';
    }
    html += '</div>';
    html += '<div class="usage-bar-row">';
    html += '<div class="usage-bar-wrap">';
    html += '<div class="usage-bar-fill ' + fableCls + '" style="width:' + Math.min(100, u.quotaPctWeeklyFable || 0) + '%"></div>';
    if (fableTickPct > 0) html += '<div class="usage-bar-tick" style="left:' + fableTickPct + '%" title="' + Math.round(fableTickPct) + '% of window elapsed"></div>';
    html += '</div>';
    html += '<span class="usage-bar-pct ' + fableCls + '">' + Math.round(u.quotaPctWeeklyFable || 0) + '%<span class="usage-bar-elapsed"> / ' + Math.round(fableTickPct) + '%</span></span>';
    html += '</div>';
    html += '</div>';
  }
  } // end showWeekly gate

  // Footer row: companion slots on the left, Updated-ago on the right
  let footer = '';
  if (u.lastPoll) {
    const stateClass = u.apiConnected ? 'connected' : 'cached';
    const stateLabel = u.apiConnected ? '' : ' <span class="cached-tag">(cached)</span>';
    footer += '<div class="usage-updated"><span class="api-dot ' + stateClass + '" title="API ' + stateClass + '"></span>Updated ' + formatAgeCoarse(now - u.lastPoll) + ' ago' + stateLabel + '</div>';
  }
  // slotsHtml computed once at the top (shared with the early-return states).
  if (footer || slotsHtml) {
    html += '<div class="usage-footer">' + slotsHtml + footer + '</div>';
  }

  return html;
}
