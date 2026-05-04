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
  /** Timer ID for subagent permission-wait detection */
  permissionTimerId: ReturnType<typeof setTimeout> | undefined;
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
  /** Working directory of the session */
  cwd: string;
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
  /** Timer ID for permission-wait detection */
  permissionTimerId: ReturnType<typeof setTimeout> | undefined;
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
}

/** Serialisable snapshot sent to the webview */
export interface SessionSnapshot {
  sessionId: string;
  slug: string;
  cwd: string;
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
}

export interface SubagentSnapshot {
  parentToolUseId: string;
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
}

// ── Team types (Cornice orchestrator + Agent Teams integration) ──────

/** Exit status of a Cornice-spawned agent */
export type AgentExitStatus = 'success' | 'failed' | 'cancelled';

/** Agent entry in a team manifest (Cornice sidecar or Agent Teams config) */
export interface TeamAgentEntry {
  /** Claude Code session ID. Null for Agent Teams members without session tracking. */
  sessionId: string | null;
  name: string;
  cwd: string;
  parentSessionId: string;
  depth: number;
  spawnedAt: number;       // epoch ms (parsed from ISO or epoch)
  completedAt: number | null;
  exitStatus: AgentExitStatus | null;
  /** Whether the agent is currently active (from Agent Teams isActive field) */
  isActive: boolean | null;
}

/** Parsed team manifest (from Cornice sidecar or Agent Teams config.json) */
export interface TeamManifest {
  /** Schema version (1 for Cornice sidecar, 0 for Agent Teams config) */
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
  /** Orchestrator session ID */
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
  dismissed: boolean;
}

/** Message types sent from extension to webview */
export type WebviewMessage =
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
      /** Cornice agent team snapshots (empty when no teams active) */
      teams?: TeamSnapshot[];
      /** Claude Code auto-compact settings (from ~/.claude/settings.json env overrides) */
      compactSettings?: import('./claudeSettings.js').CompactSettings;
      /** Companion-registered footer slots (rendered under the usage card) */
      footerSlots?: FooterSlotPayload[];
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
  | { type: 'footerSlotClick'; slotId: string };

// ─── Public extension API surface (returned by activate()) ──────────────

/** Spec a companion submits when registering a footer slot. */
export interface FooterSlotSpec {
  /** Required. Plain text, truncated to 80 chars. Use for the account label. */
  label: string;
  /** Optional single glyph (max 4 codepoints). Companions pick their own icons. */
  icon?: string;
  /** Optional coloured status dot rendered before the icon. Reuses the snowmelt
   *  palette: arctic-teal/frozen-peach/salmon-red. */
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
