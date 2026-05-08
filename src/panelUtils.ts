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
  workspaceKey?: string;
  confidence?: PanelStatusConfidence;
  /** CWD of the originating worktree (set for both local and sibling-worktree
   *  sessions; null/absent for cards coming from unrelated workspaces). */
  worktreeRoot?: string;
  /** Display label (basename of worktreeRoot). */
  worktreeLabel?: string;
}

export interface PanelSubagent {
  description: string;
  running: boolean;
  waitingOnPermission?: boolean;
}

export interface UsageData {
  loaded: boolean;
  apiConnected?: boolean;
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
    case 'waiting': return 'Waiting';
    case 'running': return 'Running';
    case 'done': return 'Done \u00b7 ' + t(now - s.lastActivity);
    case 'stale': return 'Seen \u00b7 ' + t(now - s.lastActivity);
    default: return s.status;
  }
}

// ===== Foreign session detection =====

export function isForeignSession(s: PanelSession, workspaceKey: string): boolean {
  if (workspaceKey && s.workspaceKey && s.workspaceKey !== workspaceKey) return true;
  return false;
}

/** True when a card originated from a worktree other than the local one
 *  (could be a sibling worktree of the same repo, or a different repo). */
export function isFromOtherWorktree(s: PanelSession, localWorktreeRoot: string): boolean {
  if (!s.worktreeRoot) return false;
  if (!localWorktreeRoot) return false;
  return s.worktreeRoot !== localWorktreeRoot;
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
   *  number when > 1. Title attribute should list the member worktree paths. */
  worktreeCount?: number;
  /** Tooltip listing member worktree paths (only set on aggregated rows). */
  worktreeMembersLabel?: string;
}

export interface ForeignGroup<W extends GroupableWorkspace> {
  /** Header label shown above the rows (e.g. `repo/` or `~/code/foo/`). */
  headerLabel: string;
  /** Optional tooltip (full path for repo groups). */
  headerTitle?: string;
  workspaces: W[];
  /** Whether any workspace in this group has running/waiting sessions. */
  hasActive: boolean;
  /** Sort key — usually basename or directory tail. */
  sortKey: string;
}

export interface GroupedForeignWorkspaces<W extends GroupableWorkspace> {
  groups: ForeignGroup<W>[];
  singletons: W[];
}

function workspaceHasActive(w: GroupableWorkspace): boolean {
  return (w.counts['running'] || 0) > 0 || (w.counts['waiting'] || 0) > 0;
}

function basename(p: string): string {
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

/** Group foreign workspaces by repository (when 2+ share a repoRoot), then
 *  by parent directory (when 2+ share a parent and weren't already consumed
 *  by a repo group).
 *
 *  Repo groups collapse to a single synthetic row (returned in `singletons`)
 *  with summed counts and a `worktreeCount` field. Parent-directory groups
 *  still render as a header + indented members (`groups`). Workspaces that
 *  don't fit any group are returned as singletons unchanged. Pure function. */
export function groupForeignWorkspaces<W extends GroupableWorkspace>(
  workspaces: W[],
  tildeAbbrev: (p: string) => string = (p) => p,
): GroupedForeignWorkspaces<W> {
  const groups: ForeignGroup<W>[] = [];
  const consumed = new Set<W>();
  const aggregated: W[] = [];

  // 1. Repo groups: 2+ workspaces sharing a non-null repoRoot collapse into
  // one synthetic row with summed counts and a worktree count chip.
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
    const membersLabel = ws.map((m) => tildeAbbrev(m.cwd ?? m.displayName)).join('\n');
    // Use the first member as the prototype so any extra fields (workspaceKey,
    // etc.) come along with sensible defaults; then override the aggregate-
    // specific bits.
    const proto = ws[0];
    const synthetic = {
      ...proto,
      workspaceKey: 'repo:' + repoRoot,
      displayName: name,
      cwd: aggregatedCwd,
      counts: sumCounts(ws),
      confidence: aggregateConfidence(ws) ?? proto.confidence,
      repoRoot,
      worktreeCount: ws.length,
      worktreeMembersLabel: membersLabel,
    } as W;
    aggregated.push(synthetic);
  }

  // 2. Parent-directory groups for whatever's left (existing behaviour).
  const byParent = new Map<string, W[]>();
  for (const w of workspaces) {
    if (consumed.has(w)) { continue; }
    if (!w.cwd) { continue; }
    const trimmed = w.cwd.endsWith('/') ? w.cwd.slice(0, -1) : w.cwd;
    const idx = trimmed.lastIndexOf('/');
    if (idx === -1) { continue; }
    const parent = trimmed.slice(0, idx);
    if (!parent) { continue; }
    let bucket = byParent.get(parent);
    if (!bucket) { bucket = []; byParent.set(parent, bucket); }
    bucket.push(w);
  }
  for (const [parent, ws] of byParent) {
    if (ws.length < 2) { continue; }
    ws.sort((a, b) => a.displayName.localeCompare(b.displayName));
    for (const w of ws) { consumed.add(w); }
    groups.push({
      headerLabel: tildeAbbrev(parent) + '/',
      workspaces: ws,
      hasActive: ws.some(workspaceHasActive),
      sortKey: parent,
    });
  }

  groups.sort((a, b) => {
    if (a.hasActive !== b.hasActive) { return a.hasActive ? -1 : 1; }
    return a.sortKey.localeCompare(b.sortKey);
  });

  const remaining = workspaces.filter((w) => !consumed.has(w));
  const singletons = [...aggregated, ...remaining];
  singletons.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { groups, singletons };
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

export function quotaClass(quotaPct: number, elapsedPct: number): string {
  // Lock to critical at the cap — if you've used the whole quota, the bar
  // shouldn't fade as the reset approaches. You're still capped.
  if (quotaPct >= 100) return 'critical';
  if (!elapsedPct || elapsedPct <= 0) return 'ok';
  const burnRate = (quotaPct / elapsedPct) * 100;
  if (burnRate >= 100) return 'critical';
  if (burnRate >= 85) return 'warn';
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

