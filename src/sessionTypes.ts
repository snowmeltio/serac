/**
 * Session-domain types: status unions, live session state, snapshots, and
 * persisted per-session metadata. Part of the domain-split type modules —
 * import from './types.js' (the central re-export) unless you are inside
 * another type module.
 */

/** Status of a Claude Code session as inferred from JSONL records.
 *  Three internal statuses: running | waiting | done.
 *  'stale' is display-only (applied in SessionDiscovery.getSnapshots). */
export type SessionStatus = 'running' | 'waiting' | 'done';
export type DisplayStatus = SessionStatus | 'stale';

/** How confident we are in the displayed status.
 *  high = recent data confirms status. medium = some uncertainty. low = extended silence. */
export type StatusConfidence = 'high' | 'medium' | 'low';


/** A detected subagent within a session */
export interface SubagentInfo {
  /** The tool_use ID that spawned this subagent */
  parentToolUseId: string;
  /** Description extracted from the Agent tool call */
  description: string;
  /** Whether the subagent is still running */
  running: boolean;
  /** Whether the subagent is waiting on a permission prompt */
  waitingOnPermission: boolean;
  /** Timestamp of last activity */
  lastActivity: Date;
  /** Active tool_use IDs within this subagent (from sidechain records) */
  activeTools: Map<string, string>;
  /** Permission-wait tracker for this subagent (timer-derived; hook-driven in future).
   *  Always present after construction — the SessionManager builds it via the
   *  `createSubagent(...)` factory in the spawn site. Non-optional by design so
   *  the type system rejects partial subagents. */
  permissionTracker: import('./trackers/permissionTracker.js').PermissionTracker;
  /** Whether the user has acknowledged this subagent (triggers pruning when done) */
  acknowledged: boolean;
  /** [Phase 2] Targeted JSONL tailer for silent subagent detection.
   *  Activated when no agent_progress arrives within SUBAGENT_SILENCE_MS. */
  tailer: import('./jsonlTailer.js').JsonlTailer | null;
  /** [Phase 2] Silence timer: if no agent_progress arrives within threshold,
   *  open a targeted tailer for the subagent's own JSONL file. */
  silenceTimerId: ReturnType<typeof setTimeout> | undefined;
  /** [Phase 2] Agent ID mapping used to locate subagent JSONL files
   *  (<session>/subagents/agent-<agentId>.jsonl). */
  agentId: string | null;
  /** Timestamp when the subagent was spawned */
  startedAt: Date;
  /** Preview of the subagent's result (first ~120 chars of tool_result text) */
  resultPreview: string | null;
  /** Number of tools the subagent has completed */
  toolsCompleted: number;
  /** Detached agent launched with run_in_background: its Agent tool_result is
   *  just the launch banner, so it outlives the parent's turn. Completion comes
   *  from the harness's <task-notification> user record, not the tool_result. */
  background: boolean;
}

/** Full state of a single Claude Code session */
export interface SessionState {
  sessionId: string;
  /** Human-readable slug from the session (e.g. "rippling-bouncing-pie") */
  slug: string;
  /** Workspace path key (the sanitised directory name under ~/.claude/projects/) */
  workspaceKey: string;
  /** File path to the JSONL transcript */
  filePath: string;
  /** Inferred status */
  status: SessionStatus;
  /** What the session is currently doing (last tool name or text summary) */
  activity: string;
  /** Active tool_use IDs mapped to tool names */
  activeTools: Map<string, string>;
  /** Subagents spawned by this session */
  subagents: SubagentInfo[];
  /** Timestamp of last record processed */
  lastActivity: Date;
  /** Timestamp of first record */
  firstActivity: Date;
  /** Timer ID for idle detection */
  idleTimerId: ReturnType<typeof setTimeout> | undefined;
  /** Total context tokens from the most recent assistant message */
  contextTokens: number;
  /** Model ID from the most recent assistant message (e.g. "claude-opus-4-6") */
  modelId: string;
  /** True once modelId has been confirmed by a real assistant record. False
   *  while it's only a guess (constructor seed from the configured default,
   *  or carried over through a truncation/compaction reset) — the snapshot's
   *  modelLabel gets a trailing '*' in that state. */
  modelConfirmed: boolean;
  /** Native custom title from JSONL custom-title record */
  customTitle: string;
  /** Auto-generated title from JSONL `ai-title` records (Claude Code synthesises
   *  these from the conversation; may be overwritten on later turns). */
  aiTitle: string;
  /** Count of main-thread user turns (for title trigger) */
  userTurnCount: number;
  /** Hook enrichment (PostToolUse): outcome of the most recently completed tool.
   *  Display-only; never affects status. Undefined until a PostToolUse arrives. */
  lastTool?: ToolOutcome;
  /** The session's current permission mode (e.g. "default", "acceptEdits",
   *  "bypassPermissions"). Primed from JsonlRecord.permissionMode the instant
   *  a message is sent, then kept current by the hook-derived PreToolUse
   *  enrichment once the model invokes a tool (requires hook ingress).
   *  Display-only for the snapshot/UI consumer, but ALSO read internally by
   *  SessionManager.isAutoAcceptMode() (which ORs this against the
   *  independently-tracked jsonlPermissionMode) to gate the permission-typed
   *  'waiting' transitions — see toolProfiles.ts. */
  permissionMode?: string;
  /** Hook enrichment (SessionEnd): why the session ended
   *  ("clear" | "logout" | "prompt_input_exit" | "other"). Display-only. */
  endReason?: string;
  /** Status-stabiliser (PreCompact): true while a compaction is in progress, so
   *  the session holds `running`/high-confidence and is not demoted. Cleared on
   *  `compact_boundary` or a safety timeout. */
  compacting?: boolean;
}

/** Outcome of a completed tool, captured from the `PostToolUse` hook. */
export interface ToolOutcome {
  name: string;
  durationMs: number;
  isError: boolean;
}

/** Serialisable snapshot sent to the webview */
export interface SessionSnapshot {
  sessionId: string;
  slug: string;
  cwd: string;
  /** Initial cwd that round-trips to workspaceKey (see SessionState.initialCwd).
   *  Empty/absent when no record has matched yet — consumers should fall back
   *  to `cwd` only for *display* purposes, never for routing/click-through. */
  initialCwd?: string;
  workspaceKey: string;
  topic: string;
  status: DisplayStatus;
  activity: string;
  subagents: SubagentSnapshot[];
  lastActivity: number; // epoch ms
  firstActivity: number; // epoch ms
  dismissed: boolean;
  /** Total context tokens from the last assistant message (input + cache) */
  contextTokens: number;
  /** Concatenated searchable text (topic + slug + all activities) */
  searchText: string;
  /** Model label with version (e.g. "Opus 4.8", "Sonnet 4", "Fable 5") */
  modelLabel: string;
  /** Session title (from sessionRepair first-message extraction or custom-title JSONL record) */
  title: string | null;
  /** Native custom title set via Claude Code rename */
  customTitle: string;
  /** Claude Code's auto-generated title from `ai-title` JSONL records */
  aiTitle: string;
  /** How confident we are in the displayed status */
  confidence: StatusConfidence;
  /** The session's originating worktree CWD. TAGGING INVARIANT: every local
   *  snapshot producer stamps this — local sessions carry
   *  worktreeRoot === workspacePath (sessionDiscovery.getSnapshots and
   *  scanExtendedArchive), sibling sessions their own worktree CWD (via
   *  setWorktreeOrigin). `!worktreeRoot` is NOT a local test — that
   *  assumption killed new-chat auto-focus for two releases; the panel-side
   *  fallback survives only as a defensive default for degraded hosts.
   *  Optional in the type because foreign/team snapshots legitimately omit
   *  it; a test pins the local producers' stamping. */
  worktreeRoot?: string;
  /** Display label for the originating worktree (basename of worktreeRoot). */
  worktreeLabel?: string;
  /** Hook enrichment — outcome of the most recently completed tool (PostToolUse). */
  lastTool?: ToolOutcome;
  /** Session's current permission mode — primed from the JSONL
   *  `permissionMode` field, then kept current by the PreToolUse hook.
   *  Display-only here (webview never derives behaviour from it) — see
   *  SessionState.permissionMode for the internal status-gating consumer. */
  permissionMode?: string;
  /** Hook enrichment — why the session ended (SessionEnd). */
  endReason?: string;
  /** True while a compaction is in progress (PreCompact grace window). */
  compacting?: boolean;
  /** SPIKE — count of outstanding backgrounded Bash shells (`run_in_background`)
   *  whose completion has not yet been observed. Display-only enrichment; does
   *  NOT affect `status`. Present (and > 0) typically on a `done`/`stale` card
   *  whose turn ended while a detached build/deploy keeps running. Undefined
   *  when none outstanding. See BACKLOG.md for the UI/policy follow-up. */
  backgroundShellCount?: number;
  /** Git branch from the most recent JSONL record carrying one. Display-only
   *  (meta-row pill) — distinguishes same-repo sessions on different branches. */
  gitBranch?: string;
  /** Count of tool_result blocks flagged `is_error: true` across the session.
   *  Display-only triage signal ("done, but with errors"). */
  toolErrorCount?: number;
  /** Trimmed text of the most recent assistant message — the done-card
   *  preview, so a finished card says WHAT it finished with at a glance. */
  lastAssistantText?: string;
  /** Registry tri-state: true = the CC process is registered live right now
   *  (a done card is resumable in its terminal); false = it was seen live and
   *  is now gone (genuinely ended); undefined = registry can't say (no probe,
   *  scan degraded, or the session was never seen live). Display-only — the
   *  status pill annotates terminal cards; never affects status itself. */
  processLive?: boolean;
  /** True when the session's registered live process (~/.claude/sessions/<pid>.json)
   *  is confirmed to be a child of a *different* VS Code window's extension host
   *  than this one — i.e. another window is already driving this session right
   *  now. Live-only; undefined when there's no live process or ownership can't be
   *  determined. Gates the live-editor hand-off (openClaudeEditor) to prevent two
   *  processes appending to the same JSONL. */
  externalWriter?: boolean;
  /** Paths from the latest file-history-snapshot record — the files this
   *  session has edited. Feeds the same-file collision badge (two active
   *  sessions touching one file). Capped at 200; absent when none. */
  trackedFiles?: string[];
  /** Epoch ms a ScheduleWakeup is due to re-invoke the session — the card is
   *  sleeping, not finished. Absent when none pending / already fired. */
  pendingWakeupAt?: number;
  /** The agent's stated wakeup reason (capped). */
  pendingWakeupReason?: string;
  /** Count of believed-live session crons (CronCreate / Stop session_crons). */
  sessionCronCount?: number;
  /** Display label: the cron expressions, comma-joined, capped. */
  sessionCronLabel?: string;
}

export interface SubagentSnapshot {
  parentToolUseId: string;
  /** Maps 1:1 to <session>/subagents/agent-<agentId>.jsonl. Null until the
   *  agent id is known. Used by the detail panel's subagents source. */
  agentId: string | null;
  description: string;
  running: boolean;
  waitingOnPermission: boolean;
  /** Epoch ms when spawned */
  startedAt: number;
  /** Preview of result (null while running) */
  resultPreview: string | null;
  /** Number of tools completed */
  toolsCompleted: number;
  /** Whether this subagent is blocking the parent (tool_use still pending).
   *  False = background subagent (parent has moved on). */
  blocking: boolean;
  /** Detached run_in_background agent — may still be running after the parent
   *  turn ended (its card can read `done` while this agent works). */
  background?: boolean;
}

/** Persistent per-session metadata stored in session-meta.json */
export interface SessionMeta {
  /** User-set or auto-generated title. Null = fall back to topic extraction. */
  title: string | null;
  /** Whether the user has dismissed/archived this session */
  dismissed: boolean;
  /** Whether the user has acknowledged (focused) this session after completion */
  acknowledged: boolean;
  /** Epoch ms when acknowledged, or null. Used for the 10s done→stale delay. */
  acknowledgedAt: number | null;
  /** Epoch ms when the extension first detected this session */
  firstSeen: number;
  /** True once the session has EVER been observed live in the process
   *  registry. Persists the SessionManager seen-live latch across window
   *  reloads so the registry death gate stays armed (absent on older metas). */
  seenLive?: boolean;
  /** Cached auto-generated title from JSONL `ai-title` records. Persisted so
   *  the display name survives the 7-day archive cutoff, when the lightweight
   *  scanner stops parsing JSONL. Absent = never observed. */
  aiTitle?: string;
  /** Cached native custom title from JSONL `custom-title` records. Same
   *  rationale as aiTitle. */
  customTitle?: string;
}

/** Shape of the session-meta.json file on disk */
export interface SessionMetaFile {
  sessions: Record<string, SessionMeta>;
}
