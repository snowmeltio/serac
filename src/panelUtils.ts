/**
 * Pure utility functions extracted from panel.js for testability.
 * These have zero DOM dependencies and can run in Node or browser.
 */

// ===== Types for panel data =====

/** Session status values matching SessionStatus in types.ts (duplicated here to avoid
 *  importing extension-side types into the webview bundle). */
export type PanelSessionStatus = 'running' | 'waiting' | 'done' | 'stale';
export type PanelStatusConfidence = 'high' | 'medium' | 'low';

export interface PanelSession {
  sessionId: string;
  status: PanelSessionStatus;
  topic?: string;
  activity?: string;
  customTitle?: string;
  title?: string;
  /** Auto-generated title from Claude Code's `ai-title` JSONL records. */
  aiTitle?: string;
  slug?: string;
  cwd?: string;
  lastActivity: number;
  modelLabel?: string;
  contextTokens?: number;
  dismissed?: boolean;
  subagents?: PanelSubagent[];
  /** Count of background shells (`run_in_background: true`) the agent launched
   *  that are still running after its turn ended. Non-status: surfaced as a
   *  quiet badge so a `done` card can flag "a build is still going". */
  backgroundShellCount?: number;
  /** Branch pill / error badge / done-preview — glance-pack enrichment. */
  gitBranch?: string;
  toolErrorCount?: number;
  lastAssistantText?: string;
  /** Registry tri-state (see SessionSnapshot.processLive): annotates terminal
   *  cards' status pill with live/ended; absent = no annotation. */
  processLive?: boolean;
  /** Files this session has edited (latest file-history-snapshot). Feeds the
   *  same-file collision badge. */
  trackedFiles?: string[];
  /** Loop/wakeup enrichment (display-only chips; see SessionLoopTracker). */
  pendingWakeupAt?: number;
  pendingWakeupReason?: string;
  sessionCronCount?: number;
  sessionCronLabel?: string;
  workspaceKey?: string;
  confidence?: PanelStatusConfidence;
  /** CWD of the originating worktree (set for both local and sibling-worktree
   *  sessions; null/absent for cards coming from unrelated workspaces). */
  worktreeRoot?: string;
  /** Display label (basename of worktreeRoot). */
  worktreeLabel?: string;
}

export interface PanelSubagent {
  /** Maps to <session>/subagents/agent-<agentId>.jsonl; null until resolved.
   *  Present at runtime (host sends the full snapshot) — lets a card's inline
   *  agent row deep-link the detail panel to this specific agent. */
  agentId?: string | null;
  description: string;
  running: boolean;
  waitingOnPermission?: boolean;
  /** Detached run_in_background agent — can be running under a done card. */
  background?: boolean;
}

export interface UsageData {
  loaded: boolean;
  apiConnected?: boolean;
  /** False on platforms where quota polling isn't available (non-macOS). */
  platformSupported?: boolean;
  quotaPct5h?: number;
  quotaPctWeekly?: number;
  resetTime?: number;
  weeklyResetTime?: number;
  extraUsageEnabled?: boolean;
  lastPoll?: number;
}

// ===== Workspace key sanitisation =====

/** Sanitise a workspace path into a key safe for directory names.
 *  Claude Code uses this format for project directories under ~/.claude/projects/. */
export function sanitiseWorkspaceKey(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
}

// ===== HTML escaping =====

export function escapeHtml(str: string | undefined | null): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===== Markdown stripping =====

export function stripMarkdown(str: string | undefined | null): string {
  if (!str) return '';
  return str
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '');
}

// ===== Display name logic =====

export function isPlaceholderTitle(title: string): boolean {
  return /^Session [0-9a-f]{8}$/i.test(title);
}

export function formatSlug(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function getDisplayName(s: PanelSession): string {
  if (s.customTitle && !isPlaceholderTitle(s.customTitle)) return s.customTitle;
  if (s.title && !isPlaceholderTitle(s.title)) return s.title;
  if (s.aiTitle && !isPlaceholderTitle(s.aiTitle)) return s.aiTitle;
  if (s.topic) return s.topic;
  if (s.cwd) {
    const parts = s.cwd.split('/');
    const folder = parts[parts.length - 1];
    if (folder && folder !== 'claudecode') return folder;
  }
  if (s.slug && s.slug !== s.sessionId.slice(0, 8)) return formatSlug(s.slug);
  return s.sessionId.slice(0, 8);
}

// ===== Ghost detection =====

export function isGhost(s: PanelSession): boolean {
  // Dismissed (archived) sessions are never ghosts — they should always appear in the archive list
  if (s.dismissed) { return false; }
  return !s.topic && !s.activity && (s.status === 'done' || s.status === 'stale');
}

// ===== Time formatting =====

export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h';
  const days = Math.floor(hours / 24);
  return days + 'd';
}

export function formatAgeCoarse(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h';
  const days = Math.floor(hours / 24);
  return days + 'd';
}

// ===== Status label =====

/** A running card silent for this long gets the "quiet" qualifier — long past
 *  the 30s extended-thinking grace, so silence is now a real signal: a hung
 *  tool, a stuck MCP server, or output the JSONL isn't seeing. Distinct from
 *  `waiting` (blocked on the user) — this is "blocked on nothing visible". */
export const RUNNING_QUIET_MS = 5 * 60 * 1000;

export function getStatusLabel(s: PanelSession, now: number): string {
  // Wrap the elapsed-time chunk so the pill's text-transform: uppercase
  // doesn't capitalise the unit letters (h/m/s/d) \u2014 those should remain
  // lowercase to match the rest of the UI.
  const t = (ms: number) => '<span class="status-pill-time">' + formatAge(ms) + '</span>';
  // Low confidence: show elapsed time only, no status label [#106]
  if (s.confidence === 'low' && (s.status === 'running' || s.status === 'waiting')) {
    return t(now - s.lastActivity) + '\u2026';
  }
  switch (s.status) {
    // Waiting-age: with several blocked cards, WHICH has waited longest is
    // the triage question — 10s and 20min must not read identically.
    case 'waiting': return 'Waiting \u00b7 ' + t(now - s.lastActivity);
    // Stall surfacing: a running card with no records for RUNNING_QUIET_MS is
    // neither healthy-running nor waiting — flag the silence, neutrally
    // ("quiet", not "stalled": a long silent build is legitimate, but you
    // want to KNOW it's been 12 minutes either way).
    case 'running':
      return now - s.lastActivity > RUNNING_QUIET_MS
        ? 'Running \u00b7 quiet ' + t(now - s.lastActivity)
        : 'Running';
    // Orphan/live annotation (terminal cards only): a done card whose CC
    // process is still attached is resumable in its terminal; one confirmed
    // gone needs a cold start. Unknown stays unannotated — never guess.
    case 'done': return 'Done \u00b7 ' + t(now - s.lastActivity) + liveQualifier(s);
    case 'stale': return 'Seen \u00b7 ' + t(now - s.lastActivity) + liveQualifier(s);
    default: return s.status;
  }
}

function liveQualifier(s: PanelSession): string {
  if (s.processLive === true) { return ' \u00b7 <span class="status-pill-time">live</span>'; }
  if (s.processLive === false) { return ' \u00b7 <span class="status-pill-time">ended</span>'; }
  return '';
}

// ===== Same-file collision detection =====

/** Cross-session same-file collisions among ACTIVE (running/waiting) sessions:
 *  two agents editing one file is a merge conflict in the making. Returns a
 *  map of sessionId → colliding file paths (sorted, deduped). Terminal
 *  sessions are ignored — a finished session's edits aren't a live conflict. */
export function computeFileCollisions(sessions: PanelSession[]): Map<string, string[]> {
  const active = sessions.filter(s =>
    (s.status === 'running' || s.status === 'waiting')
    && Array.isArray(s.trackedFiles) && s.trackedFiles.length > 0);
  const out = new Map<string, string[]>();
  if (active.length < 2) { return out; }
  const byFile = new Map<string, string[]>(); // file → sessionIds
  for (const s of active) {
    for (const f of new Set(s.trackedFiles)) {
      const owners = byFile.get(f);
      if (owners) { owners.push(s.sessionId); } else { byFile.set(f, [s.sessionId]); }
    }
  }
  for (const [file, owners] of byFile) {
    if (owners.length < 2) { continue; }
    for (const sid of owners) {
      const list = out.get(sid);
      if (list) { list.push(file); } else { out.set(sid, [file]); }
    }
  }
  for (const list of out.values()) { list.sort(); }
  return out;
}

// ===== Foreign session detection =====

export function isForeignSession(s: PanelSession, workspaceKey: string): boolean {
  if (workspaceKey && s.workspaceKey && s.workspaceKey !== workspaceKey) return true;
  return false;
}

// ===== Foreign workspace grouping =====

/** Minimal shape needed by the grouping logic; matches `WorkspaceGroup` from
 *  types.ts but redeclared here so the webview bundle stays decoupled. */
export interface GroupableWorkspace {
  workspaceKey: string;
  displayName: string;
  cwd?: string | null;
  counts: Record<string, number>;
  confidence?: string;
  repoRoot?: string | null;
  /** Set on synthetic rows produced by aggregating multiple worktrees of the
   *  same repo. Counts are already summed; renderer shows a chip with this
   *  number when > 1. Reflects every worktree of the repo that's tracked,
   *  regardless of whether its sessions are dismissed — the chip is a fact
   *  about the repo's shape, not about live work. */
  worktreeCount?: number;
  /** Tooltip listing every member worktree path (only set on aggregated rows). */
  worktreeMembersLabel?: string;
  /** Every worktree of this repo as discovered from `.git/worktrees/*`. Drives
   *  the inline picker shown when an aggregated row is expanded. Includes the
   *  main checkout and worktrees with no Claude Code activity. */
  worktrees?: Array<{ path: string; branch: string | null; isMain: boolean }>;
  /** Original per-worktree workspaces preserved through aggregation. The
   *  picker matches each `worktrees[i].path` against a member `cwd` to pull
   *  per-row counts/confidence. Inactive worktrees have no matching member. */
  members?: GroupableWorkspace[];
  /** Set on synthetic rows that consolidate non-git scratch dirs (e.g. those
   *  under /private/tmp) rather than real git worktrees. The picker is driven
   *  by `members` (one child per scratch dir) and the chip is relabelled,
   *  since there are no `worktrees` to enumerate. */
  pseudoRepo?: boolean;
}

/** Last path segment, tolerating a trailing slash. Pure helper, shared with
 *  the webview bundle (panel.ts). */
export function basename(p: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Aggregate counts across a set of workspaces. Returns a Record where each
 *  key sums to the total of that key across the input. Pure helper. */
function sumCounts(workspaces: GroupableWorkspace[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of workspaces) {
    for (const [k, v] of Object.entries(w.counts)) {
      out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

/** Pick the highest-priority confidence across a set of workspaces.
 *  high > medium > low; any unset values are treated as 'medium'. */
function aggregateConfidence(workspaces: GroupableWorkspace[]): string | undefined {
  const order = { high: 3, medium: 2, low: 1 } as const;
  let best: keyof typeof order | undefined;
  for (const w of workspaces) {
    const c = (w.confidence as keyof typeof order | undefined);
    if (!c) { continue; }
    if (!best || order[c] > order[best]) { best = c; }
  }
  return best;
}

/** Pick the cwd for an aggregated repo row. Prefer a member whose cwd matches
 *  repoRoot exactly (the "main" worktree) so clicking opens the canonical
 *  checkout; fall back to repoRoot itself, then to the first member's cwd. */
function pickAggregatedCwd<W extends GroupableWorkspace>(repoRoot: string, members: W[]): string | null {
  const main = members.find((m) => m.cwd === repoRoot);
  if (main?.cwd) { return main.cwd; }
  if (repoRoot) { return repoRoot; }
  return members[0]?.cwd ?? null;
}

/** Synthetic repoRoot used to consolidate scratch sessions that live under the
 *  macOS temp dir but aren't git repos. `/tmp` is a symlink to `/private/tmp`,
 *  so realpathed cwds land here. Gated behind `serac.worktrees.consolidateTmp`;
 *  the overlay is applied extension-side in ForeignWorkspaceManager.
 *  See {@link isTmpScratchPath}. */
export const PSEUDO_TMP_REPO_ROOT = '/private/tmp';

/** True when `cwd` is a directory beneath the temp root (`/private/tmp/...` or
 *  `/tmp/...`). The root itself (no sub-path) is excluded — there's nothing to
 *  consolidate. Used to assign {@link PSEUDO_TMP_REPO_ROOT} as a pseudo-repo. */
export function isTmpScratchPath(cwd: string | null | undefined): boolean {
  if (!cwd) { return false; }
  return cwd.startsWith('/private/tmp/') || cwd.startsWith('/tmp/');
}

/** Collapse 2+ workspaces that share a non-null `repoRoot` into a single
 *  synthetic row (summed counts, worktreeCount chip, members tooltip). Other
 *  workspaces pass through unchanged. Result is sorted alphabetically by
 *  displayName. Pure function.
 *
 *  Parent-directory grouping was tried and removed: nesting unrelated repos
 *  that happened to share a parent (e.g. cornice/firn) was more confusing
 *  than helpful. */
export function groupForeignWorkspaces<W extends GroupableWorkspace>(
  workspaces: W[],
  tildeAbbrev: (p: string) => string = (p) => p,
): W[] {
  const consumed = new Set<W>();
  const aggregated: W[] = [];

  const byRepo = new Map<string, W[]>();
  for (const w of workspaces) {
    if (!w.repoRoot) { continue; }
    let bucket = byRepo.get(w.repoRoot);
    if (!bucket) { bucket = []; byRepo.set(w.repoRoot, bucket); }
    bucket.push(w);
  }
  for (const [repoRoot, ws] of byRepo) {
    if (ws.length < 2) { continue; }
    ws.sort((a, b) => a.displayName.localeCompare(b.displayName));
    for (const w of ws) { consumed.add(w); }
    const name = basename(repoRoot);
    const aggregatedCwd = pickAggregatedCwd(repoRoot, ws);
    // Worktree count + tooltip reflect every tracked worktree of the repo,
    // including ones whose sessions are all dismissed — the chip is a stable
    // "this repo has N worktrees" fact, not a count of live work.
    const proto = ws[0];
    // Worktree array is identical across members of the same repo (all
    // resolved by the extension from the shared repoRoot). Preserve it on
    // the synthetic row so the picker has full per-repo data, including
    // worktrees with no Claude Code activity. Strip nested members/worktrees
    // from each preserved member so the payload stays flat.
    const memberRecords = ws.map((m) => {
      const { members: _members, worktrees: _wts, ...rest } = m as W & {
        members?: GroupableWorkspace[];
        worktrees?: Array<{ path: string; branch: string | null; isMain: boolean }>;
      };
      return rest as GroupableWorkspace;
    });
    const isPseudo = repoRoot === PSEUDO_TMP_REPO_ROOT;
    // Prefer the enumerated worktree list (every worktree of the repo, including
    // ones with no Claude Code activity) so the chip count + tooltip match the
    // picker rows the row expands to. Fall back to the active-member count for
    // pseudo (tmp) rows and repos with no enumeration.
    const protoWts = (proto as W & { worktrees?: Array<{ path: string; branch: string | null; isMain: boolean }> }).worktrees;
    const enumeratedWts = !isPseudo && Array.isArray(protoWts) && protoWts.length > 0;
    const worktreeCount = enumeratedWts ? protoWts!.length : ws.length;
    const membersLabel = enumeratedWts
      ? protoWts!.map((w) => tildeAbbrev(w.path)).join('\n')
      : ws.map((m) => tildeAbbrev(m.cwd ?? m.displayName)).join('\n');
    const synthetic = {
      ...proto,
      workspaceKey: 'repo:' + repoRoot,
      displayName: name,
      // Pseudo rows have no canonical checkout to open — expanding to pick a
      // member dir is the only sensible action, so withhold a direct cwd.
      cwd: isPseudo ? null : aggregatedCwd,
      counts: sumCounts(ws),
      confidence: aggregateConfidence(ws) ?? proto.confidence,
      repoRoot,
      worktreeCount,
      worktreeMembersLabel: membersLabel,
      worktrees: isPseudo ? undefined : proto.worktrees,
      members: memberRecords,
      pseudoRepo: isPseudo ? true : undefined,
    } as W;
    aggregated.push(synthetic);
  }

  const remaining = workspaces.filter((w) => !consumed.has(w));
  const result = [...aggregated, ...remaining];
  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

// ===== Status debounce =====

const STATUS_DEBOUNCE_MS = 2000;

export function debounceStatuses(
  sessions: PanelSession[],
  needsInputSince: Record<string, number>,
  now: number,
): PanelSession[] {
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.status === 'waiting') {
      if (!needsInputSince[s.sessionId]) {
        needsInputSince[s.sessionId] = now;
      }
    } else if (s.status === 'running' && needsInputSince[s.sessionId]) {
      if (now - needsInputSince[s.sessionId] < STATUS_DEBOUNCE_MS) {
        s.status = 'waiting';
      } else {
        delete needsInputSince[s.sessionId];
      }
    } else {
      delete needsInputSince[s.sessionId];
    }
  }
  return sessions;
}

// ===== Workflow-live status override =====

/** A session is not finished while a workflow it launched is still running:
 *  the Workflow tool runs in the background, so the lead's turn ends (idle
 *  timer → done/stale) while its agents are mid-sweep. Upgrade such cards to
 *  running — with high confidence; a live run is direct evidence — so the
 *  card reads (and sorts) as the active session it is. Dismissed runs don't
 *  pin a card. Applied host-side at the sessions↔workflows merge point.
 *  Generic + structural so the host passes SessionSnapshot/WorkflowSnapshot
 *  without coupling this webview-shared module to extension-side types. */
/** Aggregate the needs-input badge count across every surface that renders
 *  attention-demanding sessions: local waiting sessions, team members and
 *  orchestrators (dismissed teams excluded), the foreign waiting strip, and
 *  sibling-worktree cards (they render in the main feed like local cards).
 *  Structural team shape so the webview bundle never pulls types.ts. */
export function computeWaitingCount(opts: {
  localWaiting: number;
  teams: ReadonlyArray<{ dismissed?: boolean; orchestrator: { status: string }; agents: ReadonlyArray<{ status: string }> }>;
  foreignWaitingCount: number;
  siblingWaitingCount: number;
}): number {
  let n = opts.localWaiting;
  for (const team of opts.teams) {
    if (team.dismissed) { continue; }
    for (const agent of team.agents) {
      if (agent.status === 'waiting') { n++; }
    }
    if (team.orchestrator.status === 'waiting') { n++; }
  }
  return n + opts.foreignWaitingCount + opts.siblingWaitingCount;
}

export function applyWorkflowLiveStatus<S extends { sessionId: string; status: string; confidence?: string }>(
  sessions: S[],
  workflows: Array<{ sessionId: string; status: string; dismissed?: boolean }> | undefined,
): S[] {
  if (!workflows || workflows.length === 0) { return sessions; }
  const liveSessions = new Set(
    workflows.filter(w => w.status === 'running' && !w.dismissed).map(w => w.sessionId),
  );
  if (liveSessions.size === 0) { return sessions; }
  return sessions.map(s =>
    liveSessions.has(s.sessionId) && (s.status === 'done' || s.status === 'stale')
      ? { ...s, status: 'running', confidence: 'high' } as S
      : s,
  );
}

// ===== Context window helpers =====

/** Model's theoretical maximum context window (tokens). */
const MODEL_CAPACITY: Record<string, number> = {
  'Opus': 1_000_000,
  'Sonnet': 1_000_000,
  'Haiku': 200_000,
};
const DEFAULT_CAPACITY = 200_000;

/** Return the model's theoretical maximum context window in tokens. */
export function getModelCapacity(modelLabel: string | undefined): number {
  if (!modelLabel) return DEFAULT_CAPACITY;
  for (const [key, cap] of Object.entries(MODEL_CAPACITY)) {
    if (modelLabel.includes(key)) return cap;
  }
  return DEFAULT_CAPACITY;
}

/** Compute the effective token count at which Claude Code auto-compacts.
 *  autoCompactWindow defaults to 200K; autoCompactPct defaults to 95. */
export function getCompactThreshold(autoCompactWindow: number, autoCompactPct: number): number {
  return Math.round(autoCompactWindow * (autoCompactPct / 100));
}

/** Format a token count as a human-readable label (e.g. 190000 → "190K", 1000000 → "1M"). */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000) + 'M';
  return Math.round(n / 1000) + 'K';
}

// ===== Usage helpers =====

export function getElapsedPct(resetMs: number | undefined, windowMs: number): number {
  if (!resetMs || !windowMs) return 0;
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return 100;
  const elapsed = windowMs - remaining;
  if (elapsed <= 0) return 0;
  return Math.min(100, Math.max(0, (elapsed / windowMs) * 100));
}

export function quotaClass(
  quotaPct: number,
  elapsedPct: number,
  warnAtPercent = 85,
  criticalAtPercent = 100,
): string {
  // Lock to critical at the cap — if you've used the whole quota, the bar
  // shouldn't fade as the reset approaches. You're still capped.
  if (quotaPct >= 100) return 'critical';
  if (!elapsedPct || elapsedPct <= 0) return 'ok';
  // Early-window floor: pacing ratios are meaningless when almost no time has
  // elapsed, so don't let a near-empty window amplify trivial usage into red
  // (the post-reset flash). 5% of the window (~15 min of a 5h window) before
  // pace colouring kicks in.
  const effectiveElapsed = Math.max(elapsedPct, 5);
  const burnRate = (quotaPct / effectiveElapsed) * 100;
  if (burnRate >= criticalAtPercent) return 'critical';
  if (burnRate >= warnAtPercent) return 'warn';
  if (burnRate >= 60) return 'good';
  return 'ok';
}

export function formatResetTime(resetMs: number | undefined): string {
  if (!resetMs) return '';
  const diff = resetMs - Date.now();
  if (diff <= 0) return 'reset';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return hours + 'h' + (remMins > 0 ? ' ' + remMins + 'm' : '');
  const days = Math.floor(hours / 24);
  return days + 'd ' + (hours % 24) + 'h';
}


/** Path with any trailing slashes stripped — the panel's canonical form for
 *  comparing cwds and worktree paths. */
export function normPath(p: string): string {
  return p.replace(/\/+$/, '');
}

/** The compact W/R/D/S status-count chips shared by workspace, worktree, and
 *  picker rows. Pure; returns '' when every count is zero. */
export function countsChipsHtml(counts: Record<string, number | undefined>): string {
  const waiting = counts['waiting'] || 0;
  const running = counts['running'] || 0;
  const done = counts['done'] || 0;
  const stale = counts['stale'] || 0;
  let html = '';
  if (waiting) html += '<span class="status-count waiting-count">' + waiting + 'W</span>';
  if (running) html += '<span class="status-count running-count">' + running + 'R</span>';
  if (done) html += '<span class="status-count done-count">' + done + 'D</span>';
  if (stale) html += '<span class="status-count stale-count">' + stale + 'S</span>';
  return html;
}

/** One inline picker child row — shared scaffolding for the worktree and
 *  scratch-dir pickers (same classes, data attributes, and confidence
 *  gating; the pickers differ only in label, title, and optional chips). */
export function pickerChildRow(opts: {
  cwd: string;
  parentKey: string;
  label: string;
  title: string;
  counts: Record<string, number | undefined>;
  confidence?: string;
  extraChipsHtml?: string;
}): string {
  const waiting = opts.counts['waiting'] || 0;
  const hasLive = (opts.counts['running'] || 0) > 0 || waiting > 0;
  const cls = 'ws-row ws-picker-child ws-row-clickable' + (waiting > 0 ? ' ws-row-waiting' : '');
  return '<div class="' + cls + '"'
    + (hasLive ? ' data-confidence="' + escapeHtml(opts.confidence ?? 'medium') + '"' : '')
    + ' data-cwd="' + escapeHtml(opts.cwd) + '"'
    + ' data-parent-key="' + escapeHtml(opts.parentKey) + '"'
    + ' tabindex="0" role="button"'
    + ' title="' + escapeHtml(opts.title) + '">'
    + '<span class="ws-name">' + escapeHtml(opts.label) + '</span>'
    + (opts.extraChipsHtml ?? '')
    + '<div class="ws-counts">' + countsChipsHtml(opts.counts) + '</div>'
    + '</div>';
}
