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
  // Low confidence: show elapsed time only, no status label [#106]
  if (s.confidence === 'low' && (s.status === 'running' || s.status === 'waiting')) {
    return formatAge(now - s.lastActivity) + '\u2026';
  }
  switch (s.status) {
    case 'waiting': return 'Waiting';
    case 'running': return 'Running';
    case 'done': return 'Done \u00b7 ' + formatAge(now - s.lastActivity);
    case 'stale': return 'Seen \u00b7 ' + formatAge(now - s.lastActivity);
    default: return s.status;
  }
}

// ===== Foreign session detection =====

export function isForeignSession(s: PanelSession, workspaceKey: string): boolean {
  if (workspaceKey && s.workspaceKey && s.workspaceKey !== workspaceKey) return true;
  return false;
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

