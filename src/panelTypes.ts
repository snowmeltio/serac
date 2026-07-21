/**
 * Panel/webview wire types: usage, workspace grouping, panel update payloads,
 * webview messages, and the public extension API surface. Part of the
 * domain-split type modules — import from './types.js' (the central
 * re-export) unless you are inside another type module.
 */

import type { SessionSnapshot, StatusConfidence } from './sessionTypes.js';
import type { TeamSnapshot } from './teamTypes.js';
import type { WorkflowSnapshot } from './workflowTypes.js';
import type { DetailSource } from './detailShared.js';

/** Full usage snapshot sent to the webview */
export interface UsageSnapshot {
  /** 5-hour session utilisation as 0-100 (from Anthropic API) */
  quotaPct5h: number;
  /** Session reset time as epoch ms */
  resetTime: number | null;
  /** Weekly all-models utilisation as 0-100 (from Anthropic API) */
  quotaPctWeekly: number;
  /** Weekly all-models reset time as epoch ms */
  weeklyResetTime: number | null;
  /** Weekly Sonnet utilisation as 0-100, or null if not applicable */
  quotaPctWeeklySonnet: number | null;
  /** Weekly Sonnet reset time as epoch ms */
  weeklyResetTimeSonnet: number | null;
  /** Weekly Fable utilisation as 0-100, or null if this account has never
   *  been observed with a Fable-scoped quota. Sourced from the API's generic
   *  `limits[]` array (a `weekly` entry scoped to model "Fable"), not a flat
   *  field like the other weekly quotas above — the entry is only present
   *  once there's been Fable usage in the current window, so a confirmed
   *  account falls back to 0 (not null) once that window's entry disappears,
   *  rather than the row vanishing on zero usage. */
  quotaPctWeeklyFable: number | null;
  /** Weekly Fable reset time as epoch ms */
  weeklyResetTimeFable: number | null;
  /** Whether extra usage billing is enabled */
  extraUsageEnabled: boolean;
  /** Extra usage credits consumed this month (units unknown — likely cents) */
  extraUsageCredits: number | null;
  /** Whether the API connection succeeded on last poll */
  apiConnected: boolean;
  /** Whether the current platform supports OAuth credential access */
  platformSupported: boolean;
  /** Sanitised workspace key for the current workspace */
  currentWorkspaceKey: string;
  /** Whether usage data has loaded at least once */
  loaded: boolean;
  /** Timestamp of last successful poll */
  lastPoll: number;
}

/** Summary of sessions in a foreign workspace */
export interface WorkspaceGroup {
  /** Sanitised workspace key */
  workspaceKey: string;
  /** Human-readable workspace name (derived from key) */
  displayName: string;
  /** Full CWD path for parent-directory grouping (null if unknown) */
  cwd: string | null;
  /** Status counts for this workspace */
  counts: Record<string, number>;
  /** Highest confidence across sessions in this workspace */
  confidence: StatusConfidence;
  /** Resolved git repository root for this workspace's CWD, or null when the
   *  CWD isn't part of a git repo. Worktrees of the same repo share a value. */
  repoRoot: string | null;
  /** Set on synthetic rows produced by aggregating multiple worktrees of the
   *  same repo (created in panelUtils.groupForeignWorkspaces, never sent
   *  directly by the extension). Counts on such rows are already summed. */
  worktreeCount?: number;
  /** Tooltip listing member worktree paths (only set on aggregated rows). */
  worktreeMembersLabel?: string;
  /** True when a live VS Code window (ide/<port>.lock, pid-verified) has this
   *  workspace open — the row gets a quiet "IDE" tag. Display-only. */
  ideOpen?: boolean;
  /** Every worktree of this repo as discovered from `.git/worktrees/*`, set on
   *  rows whose `repoRoot` resolved to a real repo. Drives the inline picker
   *  shown when the user clicks an aggregated row — entries with no Claude
   *  Code activity still appear so the picker is a faithful map of the repo.
   *  Lightweight shape (path/branch/isMain) to avoid leaking node fs types
   *  into the webview bundle; mirrors WorktreeInfo from gitWorktreeUtil. */
  worktrees?: Array<{ path: string; branch: string | null; isMain: boolean }>;
  /** Original per-worktree WorkspaceGroups preserved through aggregation.
   *  Only set on synthetic rows produced by groupForeignWorkspaces. The picker
   *  matches each worktree path against a member cwd to look up per-row counts
   *  and confidence. Inactive worktrees (no Claude Code activity in 7d) have
   *  no member here — the picker renders them as no-activity rows. */
  members?: WorkspaceGroup[];
  /** Set on synthetic rows that consolidate non-git scratch dirs (under
   *  /private/tmp) rather than git worktrees. The picker is driven by
   *  `members` and the chip is relabelled — there are no `worktrees`. */
  pseudoRepo?: boolean;
}

/** One sidebar refresh — everything the host pushes to the panel per tick.
 *  Named fields by design: sessions, foreignWaiting, and foreignRunning all
 *  share the type SessionSnapshot[], so the previous 12-positional signature
 *  let a transposition type-check silently into a wrong-section render. */
export interface PanelUpdate {
  sessions: SessionSnapshot[];
  waitingCount: number;
  workspacePath: string;
  usage: UsageSnapshot | null;
  foreignWorkspaces?: WorkspaceGroup[];
  compactSettings?: import('./claudeSettings.js').CompactSettings;
  teams?: TeamSnapshot[];
  foreignWaiting?: SessionSnapshot[];
  olderSessionCount?: number;
  foreignRunning?: SessionSnapshot[];
  worktrees?: WorktreeRow[];
  workflows?: WorkflowSnapshot[];
}

/** A row in the Worktrees pane: one worktree of the current repo. Built in
 *  extension.ts from `discoverWorktrees()` + session counts; the panel just
 *  renders. Includes worktrees with no CC history (counts all zero) so the
 *  pane stays a faithful map of the repo's worktrees. */
export interface WorktreeRow {
  /** Absolute path to the worktree's working tree (canonical). */
  path: string;
  /** Branch name when HEAD is a symbolic ref; null when detached. */
  branch: string | null;
  /** Display label — branch name when available, else the dir basename. */
  displayName: string;
  /** Status counts (waiting/running/done/stale) for sessions in this worktree. */
  counts: Record<string, number>;
  /** Highest status confidence across this worktree's sessions. */
  confidence: StatusConfidence;
  /** True when this is the worktree the user has VS Code open in. */
  isCurrent: boolean;
  /** True for the main checkout (where `.git` is a directory). */
  isMain: boolean;
}

/** Message types sent from extension to webview */
export type WebviewMessage =
  | {
      type: 'settings';
      settings: import('./settings.js').SeracSettings;
    }
  | {
      type: 'update';
      sessions: SessionSnapshot[];
      waitingCount: number;
      workspacePath: string;
      /** Host home directory, so the webview can ~-abbreviate paths (it has no
       *  process.env). */
      home?: string;
      usage: UsageSnapshot | null;
      /** Foreign workspace summaries (empty when no other workspaces active) */
      foreignWorkspaces?: WorkspaceGroup[];
      /** Foreign sessions waiting on user input — surfaced inline at top of the panel */
      foreignWaiting?: SessionSnapshot[];
      /** Foreign sessions currently running — surfaced as a compact strip below local cards */
      foreignRunning?: SessionSnapshot[];
      /** Agent team snapshots (empty when no teams active) */
      teams?: TeamSnapshot[];
      /** Workflow runs, keyed to their parent session (empty when none) */
      workflows?: WorkflowSnapshot[];
      /** Claude Code auto-compact settings (from ~/.claude/settings.json env overrides) */
      compactSettings?: import('./claudeSettings.js').CompactSettings;
      /** Companion-registered footer slots (rendered under the usage card) */
      footerSlots?: FooterSlotPayload[];
      /** Count of local JSONL files older than the active scan window.
       *  When sessions is empty but this is > 0, the panel reveals the
       *  time-range bar so the user can widen the range to surface them. */
      olderSessionCount?: number;
      /** Worktrees of the current repo. Includes the main checkout and every
       *  linked worktree (even ones with no CC history). Empty/undefined when
       *  the workspace isn't a git repo or has no linked worktrees. */
      worktrees?: WorktreeRow[];
    }
  | {
      type: 'focusSession';
      sessionId: string;
    };

/** Message types sent from webview to extension */
export type WebviewCommand =
  | { type: 'focusSession'; sessionId: string }
  | { type: 'dismissSession'; sessionId: string }
  | { type: 'undismissSession'; sessionId: string }
  | { type: 'viewTranscript'; sessionId: string }
  | { type: 'newChat' }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'requestUpdate' }
  | { type: 'cleanup' }
  | { type: 'archiveRange'; rangeMs: number }
  | { type: 'undismissTeam'; teamId: string }
  | { type: 'openWorkspace'; cwd: string; sessionId?: string }
  | { type: 'footerSlotClick'; slotId: string }
  | { type: 'openDetail'; source: DetailSource; containerId: string; sessionId: string; agentId?: string; groupKey?: string }
  | { type: 'dismissWorkflow'; runId: string }
  | { type: 'undismissWorkflow'; runId: string };

// ─── Public extension API surface (returned by activate()) ──────────────

/** Spec a companion submits when registering a footer slot. */
export interface FooterSlotSpec {
  /** Required. Plain text, truncated to 80 chars. Use for the account label. */
  label: string;
  /** Optional single glyph (max 4 codepoints). Companions pick their own icons. */
  icon?: string;
  /** Optional coloured status dot rendered before the icon: ok (teal),
   *  warn (amber), critical (red). */
  status?: 'ok' | 'warn' | 'critical';
  /** VS Code command id invoked on click (no args). Omit for non-clickable. */
  command?: string;
  /** Optional native tooltip. */
  tooltip?: string;
}

/** Handle returned by registerUsageFooterSlot. */
export interface UsageFooterSlot {
  /** Replace the slot's spec; re-renders on the next webview tick. */
  update(spec: FooterSlotSpec): void;
  /** Remove the slot. Subsequent update() calls are no-ops. */
  dispose(): void;
}

/** Wire format for slot data pushed to the webview. The `command` field is
 *  intentionally not forwarded — only `hasCommand` so the webview knows
 *  whether to attach a click handler. */
export interface FooterSlotPayload {
  slotId: string;
  label: string;
  icon?: string;
  status?: 'ok' | 'warn' | 'critical';
  hasCommand: boolean;
  tooltip?: string;
}

/** The object returned by Serac's `activate()`. Companions read this via
 *  `vscode.extensions.getExtension('snowmeltio.serac-claude-code').exports`. */
export interface SeracExports {
  /** Numeric API version. v1 is the initial shape. */
  readonly apiVersion: 1;
  /** Register a slot under the usage card. Throws if slotId is malformed or
   *  already registered. */
  registerUsageFooterSlot(slotId: string, initial: FooterSlotSpec): UsageFooterSlot;
}
