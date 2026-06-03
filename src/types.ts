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
  /** Topic extracted from the first user message */
  topic: string;
  /** Total context tokens from the most recent assistant message */
  contextTokens: number;
  /** Model ID from the most recent assistant message (e.g. "claude-opus-4-6") */
  modelId: string;
  /** First 2-3 user messages (up to 500 chars total) for title generation */
  firstUserMessages: string[];
  /** First assistant text response (up to 500 chars) for title generation */
  firstAssistantResponse: string;
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
  /** Hook enrichment (PreToolUse): the session's current permission mode
   *  (e.g. "default", "acceptEdits", "bypassPermissions"). Display-only. */
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
  /** Short model label (e.g. "Opus", "Sonnet", "Haiku") */
  modelLabel: string;
  /** Session title (from sessionRepair first-message extraction or custom-title JSONL record) */
  title: string | null;
  /** Native custom title set via Claude Code rename */
  customTitle: string;
  /** Claude Code's auto-generated title from `ai-title` JSONL records */
  aiTitle: string;
  /** How confident we are in the displayed status */
  confidence: StatusConfidence;
  /** When set, the session originates from a sibling worktree of the local
   *  repo. Equals the worktree's CWD; clicking the card opens VS Code there. */
  worktreeRoot?: string;
  /** Display label for the originating worktree (basename of worktreeRoot). */
  worktreeLabel?: string;
  /** Hook enrichment — outcome of the most recently completed tool (PostToolUse). */
  lastTool?: ToolOutcome;
  /** Hook enrichment — session's current permission mode (PreToolUse). */
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

// ── Team types (Agent Teams integration) ──────

/** Terminal exit status of a team agent. Agent Teams configs never carry one
 *  (members are removed on completion); the field/type are retained as the
 *  wire shape — non-null values were only ever set by the removed Cornice
 *  sidecar parser. */
export type AgentExitStatus = 'success' | 'failed' | 'cancelled';

/** Agent entry in a normalised team manifest. */
export interface TeamAgentEntry {
  /** Claude Code session ID. Null for Agent Teams members without session tracking. */
  sessionId: string | null;
  name: string;
  cwd: string;
  parentSessionId: string;
  depth: number;
  spawnedAt: number;       // epoch ms
  completedAt: number | null;
  exitStatus: AgentExitStatus | null;
  /** Whether the agent is currently active (from Agent Teams isActive field) */
  isActive: boolean | null;
}

/** Parsed team manifest (normalised from an Agent Teams config.json). */
export interface TeamManifest {
  /** Schema version. 0 = Agent Teams config (the only live source). */
  version: number;
  orchestrator: {
    sessionId: string;
    name: string;
    startedAt: number;     // epoch ms
    cwd: string;
  };
  agents: TeamAgentEntry[];
  updatedAt: number;       // epoch ms
}

/** Snapshot of a team agent sent to webview (manifest + JSONL state merged) */
export interface TeamAgentSnapshot {
  /** Null when session ID is not available (e.g. Agent Teams members) */
  sessionId: string | null;
  name: string;
  cwd: string;
  parentSessionId: string;
  depth: number;
  spawnedAt: number;
  status: DisplayStatus;
  activity: string;
  confidence: StatusConfidence;
  /** Session-level subagents within this agent (from its JSONL) */
  subagents: SubagentSnapshot[];
  contextTokens: number;
  exitStatus: AgentExitStatus | null;
}

/** Full team snapshot sent to webview */
export interface TeamSnapshot {
  /** Stable team id (`at:<team-name>` for Agent Teams). Not the orchestrator
   *  session id — that is `orchestrator.sessionId`. */
  teamId: string;
  name: string;
  orchestrator: {
    sessionId: string;
    status: DisplayStatus;
    activity: string;
    confidence: StatusConfidence;
    contextTokens: number;
    modelLabel: string;
  };
  agents: TeamAgentSnapshot[];
  /** Aggregated status counts across all agents */
  counts: Record<string, number>;
  /** Recency timestamp (epoch ms): the orchestrator's last activity, falling
   *  back to the config's updatedAt. Used to order the archive by recency. */
  updatedAt: number;
  dismissed: boolean;
}

// ── Workflow types (Opus 4.8 Workflow runs) ──────────────────────────
// A "workflow" is one invocation of the built-in Workflow tool inside a
// session. Claude Code writes a render-ready sidecar at
// <sessionDir>/workflows/wf_<runId>.json once the run completes; Serac
// reads it (Tier 1). A run observed before completion has no sidecar and is
// reconstructed minimally from its journal (Tier 2, source:'live').

/** Normalised run status (sidecar `status` mapped onto a closed union). */
export type WorkflowRunStatus = 'completed' | 'running' | 'failed' | 'incomplete';

/** A phase declared in the workflow script's `meta.phases` (1-based index). */
export interface WorkflowPhase {
  index: number;
  title: string;
  detail: string;
}

/** Snapshot of one workflow agent (from a `workflow_agent` progress entry). */
export interface WorkflowAgentSnapshot {
  /** Maps 1:1 to subagents/workflows/<runId>/agent-<agentId>.jsonl */
  agentId: string;
  label: string;
  /** 1-based phase this agent belongs to; null when grouping is unavailable. */
  phaseIndex: number | null;
  phaseTitle: string | null;
  model: string;
  agentType: string | null;
  status: DisplayStatus;
  startedAt: number;            // epoch ms
  durationMs: number | null;
  tokens: number;
  toolCalls: number;
  attempt: number;
  promptPreview: string;
  resultPreview: string | null;
  lastToolName: string | null;
  lastToolSummary: string | null;
}

/** Full workflow-run snapshot sent to the webview. */
export interface WorkflowSnapshot {
  runId: string;                // wf_<hash>; webview key + dismiss key
  /** Parent session that owns the run (the dir the sidecar lives under). */
  sessionId: string;
  taskId: string | null;
  name: string;                 // workflowName
  summary: string;
  status: WorkflowRunStatus;
  /** Which tier produced this snapshot. */
  source: 'sidecar' | 'live';
  startTime: number;            // epoch ms
  durationMs: number | null;
  defaultModel: string;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  phases: WorkflowPhase[];
  agents: WorkflowAgentSnapshot[];
  /** Aggregated agent status counts. */
  counts: Record<string, number>;
  /** log() narrator lines (sidecar only; empty for live runs). */
  logs: string[];
  dismissed: boolean;
}

// ── Detail panel (source-keyed agent navigator) ──────────────────────
// One editor-area webview serves three drill-ins that share the same
// parent→children shape: workflow runs, agent teams, and a session's Task
// subagents. The host normalises each source into a DetailModel; the webview
// renders it generically (left = groups→agents, right = transcript reader).

/** Which kind of parent a detail-panel view is drilling into. */
export type DetailSource = 'workflow' | 'team' | 'subagents';

/** One selectable agent row in the detail navigator. */
export interface DetailAgentView {
  /** Resolution key within (source, containerId, groupKey) — used to locate the
   *  transcript JSONL. runId-agent for workflow, agent-hash for subagents,
   *  member name for team. */
  agentId: string;
  label: string;
  status: DisplayStatus;
  tokens: number;
  toolCalls: number;
  durationMs: number | null;
  model: string;
  /** Optional enrichments (workflow carries these; team/subagents may omit). */
  phaseTitle?: string | null;
  attempt?: number;
  promptPreview?: string;
  resultPreview?: string | null;
}

/** A left-pane group: a workflow phase, or a single flat group (team/subagents). */
export interface DetailGroupView {
  /** Group identity passed back on viewAgent (runId for workflow; '' when flat). */
  key: string;
  /** Section heading; null renders the agents as a flat list with no header. */
  title: string | null;
  status: string | null;
  agents: DetailAgentView[];
}

/** Normalised detail-panel payload (host → webview). */
export interface DetailModel {
  source: DetailSource;
  /** sessionId (workflow/subagents) or teamId (team). */
  containerId: string;
  /** The invoking conversation to open from the panel header. */
  sessionId: string;
  title: string;
  chips: string[];
  metrics: string;
  groups: DetailGroupView[];
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
      usage: UsageSnapshot | null;
      /** Foreign workspace summaries (empty when no other workspaces active) */
      foreignWorkspaces?: WorkspaceGroup[];
      /** Foreign sessions waiting on user input — surfaced inline at top of the panel */
      foreignWaiting?: SessionSnapshot[];
      /** Foreign sessions currently running — surfaced as a compact strip below local cards */
      foreignRunning?: SessionSnapshot[];
      /** Agent team snapshots (empty when no teams active) */
      teams?: TeamSnapshot[];
      /** Opus 4.8 Workflow runs, keyed to their parent session (empty when none) */
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
  | { type: 'dismissTeam'; teamId: string }
  | { type: 'undismissTeam'; teamId: string }
  | { type: 'openWorkspace'; cwd: string; sessionId?: string }
  | { type: 'footerSlotClick'; slotId: string }
  | { type: 'openDetail'; source: DetailSource; containerId: string; sessionId: string }
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

/** Known JSONL record types that the extension processes */
export type JsonlRecordType =
  | 'user'
  | 'assistant'
  | 'progress'
  | 'system'
  | 'queue-operation'
  | 'tool_result'
  | 'result'
  | 'custom-title'
  | 'ai-title'
  | 'last-prompt'
  | 'summary'
  | 'agent-name'
  | (string & {}); // allows any string but provides autocomplete for known types

/** Raw JSONL record from Claude Code transcript files */
export interface JsonlRecord {
  type: JsonlRecordType;
  sessionId?: string;
  slug?: string;
  cwd?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  message?: {
    content?: JsonlContentBlock[];
  };
  data?: {
    type?: string;
    [key: string]: unknown;
  };
  toolUseID?: string;
  parentToolUseID?: string;
  subtype?: string;
  operation?: string;
  customTitle?: string;
  /** Auto-generated title from `ai-title` records */
  aiTitle?: string;
  /** Auto-generated agent display name from `agent-name` records */
  agentName?: string;
  [key: string]: unknown;
}

export interface JsonlContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  [key: string]: unknown;
}
