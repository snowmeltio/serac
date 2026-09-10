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

/** Remote Control bridge enrolment state, read from the transcript's
 *  `bridge-session` records (see jsonlTypes.ts for the shapes).
 *  - `enrolled` — the last record carried a `cse_…` id: the session is listed
 *    on the phone / claude.ai.
 *  - `dropped` — the last record carried an EMPTY id. Claude Code's own
 *    `clearBridgeSession` writes that when the bridge tears down (observed
 *    when Remote Control is toggled off for the session — the X on the
 *    "Remote Control is active" popup or `/remote-control` in the chat; seen
 *    as "spontaneous" on 2026-08-20 until the exthost log showed the toggle).
 *    The session is then no longer listed on the phone, and a further turn
 *    does NOT re-enrol it; `/remote-control` again (in-process, new `cse_`)
 *    or closing and reopening the chat does, as a new phone row.
 *  - unset — no record seen: a pre-Remote-Control transcript, or none yet.
 *  Never a status/activity signal. */
export type BridgeState = 'enrolled' | 'dropped';

/** Emitted by SessionManager when a session's BridgeState changes (first
 *  enrolment, drop, re-enrolment). Re-emitted identical records do not fire.
 *  `replay` is true when the record came from the startup replay of an
 *  existing transcript rather than a live append — history, not an event —
 *  and since the record itself carries no timestamp, `lastActivity` (the
 *  newest turn timestamp seen so far) is the lower bound on when it happened. */
export interface BridgeTransition {
  from: BridgeState | undefined;
  to: BridgeState;
  /** The new `cse_…` id on enrolment; undefined on a drop. */
  bridgeSessionId?: string;
  replay: boolean;
  lastActivity: Date;
}


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
  /** Remote Control bridge session id (`cse_...`) from the transcript's
   *  `bridge-session` records. Set on enrolment, cleared on a drop (see
   *  bridgeState). NOTE: with account-wide Remote Control enabled this is
   *  stamped on EVERY new session, which is why a positive "enrolled" chip was
   *  shelved (2026-08-20) — the renderable state is the *negative* one. */
  bridgeSessionId?: string;
  /** Remote Control enrolment tri-state — see BridgeState. `dropped` is the
   *  one renderable value (Remote Control was turned off for this session;
   *  it will not come back on its own). Unset until a `bridge-session`
   *  record is seen. */
  bridgeState?: BridgeState;
  /** Most recent `entrypoint` seen on the transcript's records (see
   *  JsonlRecord.entrypoint). `'sdk-cli'` = a phone-driven session hosted by
   *  a `claude rc` server, which the Claude Code panel cannot restore.
   *  Most-recent-seen rather than first-seen so the value self-corrects once
   *  a transferred session resumes here and starts writing `claude-vscode`. */
  entrypoint?: string;
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
  /** Absolute path to the session's JSONL transcript. Feeds the copy pill —
   *  a path is self-identifying where a bare UUID gets mistaken for other id
   *  kinds when pasted into another session. Optional: producers that never
   *  render a copy pill (team/foreign degraded snapshots) may omit it, and the
   *  pill falls back to the session id. */
  filePath?: string;
  /** Remote Control bridge session id — see SessionState.bridgeSessionId for
   *  semantics and the shelved-chip caveat. Data-only: no consumer renders it. */
  bridgeSessionId?: string;
  /** Remote Control enrolment tri-state — see BridgeState. Instrumented
   *  (logged on transition) since v1.21.x; the dropped-chip surface is the
   *  next step (plan: serac-rc-reconnect-plan). */
  bridgeState?: BridgeState;
  /** Most recent transcript `entrypoint` — see SessionState.entrypoint.
   *  `'sdk-cli'` renders the 📡→ bring-here chip (gated). */
  entrypoint?: string;
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
  /** True when the session has live registered processes confirmed in BOTH
   *  this window AND a different one at once — two interactive processes able
   *  to append the same JSONL. Mutually exclusive with externalWriter (each
   *  window sees the same 'dual' verdict and surfaces the resolve chip).
   *  Live-only; undefined when not confirmed. */
  dualWriter?: boolean;
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

/** The glance pack's contribution to a SessionSnapshot (display-only:
 *  topic/branch/tracked-files/tool-errors/last-reply preview — see
 *  trackers/glanceTracker.ts, which owns the runtime behaviour and imports
 *  this type back from `types.ts`). Lives here rather than in
 *  glanceTracker.ts so CachedSessionState below can `extend` it without a
 *  domain-type module reaching into `trackers/` (and trackers/glanceTracker.ts
 *  importing SessionSnapshot from `../types.js`, which re-exports THIS file,
 *  would otherwise be a real import cycle). */
export type GlanceSnapshotFields = Pick<
  SessionSnapshot,
  'gitBranch' | 'toolErrorCount' | 'lastAssistantText' | 'trackedFiles'
>;

/** A file's identity for staleness comparison: byte size + mtime, both from
 *  one `fs.Stat`. Shared by `ReplayCacheEntry` (replayCache.ts), the
 *  `hydratedFrom` stamp, and `SessionManager.getReadStamp()`, compared via
 *  replayCache.ts's `sameStamp()`. mtimeMs round-trips losslessly through
 *  `JSON.stringify`/`JSON.parse` (both float64, same representable range). */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** A done subagent's contribution to a cached session snapshot — the fields
 *  needed to redraw its roster row, nothing needed to keep it running (it
 *  never is; see CachedSessionState). Picked from SubagentSnapshot (the same
 *  fields a live done subagent already renders) plus two fields
 *  SubagentSnapshot doesn't carry: `background` (a done `run_in_background`
 *  agent's flag has no live-status implication once `running` is false, but
 *  losing it on hydrate would make a hydrated card's roster diverge from
 *  what a live replay of the same file would have produced) and
 *  `lastActivity` (restored verbatim so hydrate() doesn't stamp "now"). */
export interface CachedSubagentState extends Pick<SubagentSnapshot,
  'parentToolUseId' | 'agentId' | 'description' | 'resultPreview' | 'toolsCompleted' | 'startedAt' | 'background'
> {
  /** Epoch ms — SubagentInfo.lastActivity. Not part of SubagentSnapshot (the
   *  webview never renders it), but needed so a restored subagent matches
   *  what a live replay would have produced. */
  lastActivity: number;
}

/** `SessionState` keys copied VERBATIM (identical type, no Date<->epoch-ms
 *  conversion, no derivation) between a live session and its cached entry —
 *  the single source of truth `SessionManager.exportCachedState()` and
 *  `hydrate()` both drive their plain-copy half from, instead of two
 *  independently hand-maintained ~20-field mirrors. See the exhaustiveness
 *  check below: adding a `SessionState` field that isn't listed here, in
 *  `SessionStateConvertedKey`, or in `SessionStateExcludedFromCacheKey` is a
 *  compile error, forcing an explicit cache-or-exclude decision. */
export const CACHED_PLAIN_KEYS = [
  'slug', 'activity', 'contextTokens',
  'customTitle', 'aiTitle', 'userTurnCount', 'permissionMode', 'entrypoint',
  'bridgeSessionId', 'bridgeState', 'endReason',
] as const satisfies readonly (keyof SessionState)[];
export type CachedPlainKey = typeof CACHED_PLAIN_KEYS[number];

/** `SessionState` keys that ARE cached but need conversion (Date<->epoch ms,
 *  forced-`done` status, identity fields threaded as `fromCache()` params
 *  rather than through the cached blob, or a dedicated structure) — handled
 *  by hand in `hydrate()`/`exportCachedState()`, not by `CACHED_PLAIN_KEYS`.
 *  Part of the exhaustiveness check below, not a runtime value. */
type SessionStateConvertedKey =
  | 'sessionId' | 'workspaceKey' | 'filePath'   // identity — fromCache() params, not re-derived from the blob
  | 'status'                                     // forced 'done' — see CachedSessionState.status
  | 'lastActivity' | 'firstActivity'             // Date <-> epoch ms
  | 'activeTools' | 'idleTimerId'                // runtime-only; always empty/unset on a cached (done) session
  | 'subagents'                                  // CachedSubagentState[], see above
  | 'modelId' | 'modelConfirmed';                // handled as a pair, conditional on confirmation — see CachedSessionState.modelId

/** `SessionState` keys deliberately NEVER cached — see CachedSessionState's
 *  doc comment for the reasoning behind each. Part of the exhaustiveness
 *  check below, not a runtime value. */
type SessionStateExcludedFromCacheKey =
  | 'compacting'   // exportCachedState() refuses while compacting — never true of a cached entry
  | 'lastTool';    // PostToolUse enrichment; cosmetic, not worth the bytes

/** Compile-time exhaustiveness assertion: every `SessionState` key must be
 *  accounted for above (copied plain, converted, or deliberately excluded).
 *  If this line fails to compile, a new `SessionState` field was added
 *  without an explicit decision about whether the replay cache carries it —
 *  add the key to `CACHED_PLAIN_KEYS`, `SessionStateConvertedKey`, or
 *  `SessionStateExcludedFromCacheKey` above. */
type UncoveredSessionStateKey = Exclude<keyof SessionState, CachedPlainKey | SessionStateConvertedKey | SessionStateExcludedFromCacheKey>;
const _assertNoUncoveredSessionStateKeys: UncoveredSessionStateKey extends never ? true : never = true;

/** Dormant-session replay cache payload for one JSONL file. Produced by
 *  `SessionManager.exportCachedState()` for a boring, fully-quiet `done`
 *  session and consumed by `SessionManager.fromCache()`/`hydrate()` to paint
 *  a card without replaying the transcript from byte 0. See `replayCache.ts`
 *  and ARCHITECTURE.md's "Replay cache" section for the full contract.
 *
 *  Restores exactly what a dormant done card and the discovery gates need:
 *  identity, cwd/initialCwd (foreign cwdCache, click-through), topic/activity
 *  (the ghost filter needs at least one — `panelUtils.ts:isGhost`), status
 *  (always `done` — see below), lastActivity/firstActivity/enqueuedAt (zone
 *  sort, the done→stale display window), the `CACHED_PLAIN_KEYS` fields
 *  (model/title/permission-mode/bridge/entrypoint/end-reason), the glance
 *  pack (`GlanceSnapshotFields` — gitBranch/toolErrorCount/lastAssistantText/
 *  trackedFiles), and done subagents.
 *
 *  Deliberately NOT cached — see `SessionStateExcludedFromCacheKey` above for
 *  the `SessionState` fields, and this list for everything else that's
 *  either recomputed fresh every snapshot or simply never true of an
 *  eligible (boring, quiet, `done`) session:
 *   - probe-derived flags (processLive, externalWriter, dualWriter) — these
 *     read the LIVE process registry; a cached value would go stale the
 *     instant a process starts or stops. Always recomputed in getSnapshot().
 *   - confidence — derived fresh from status + lastActivity age
 *     (computeConfidence()); always 'high' for a done card regardless.
 *   - background shells / pending wakeups / session crons — exportCachedState
 *     refuses to cache a session carrying any of these (see its eligibility
 *     gates), so a cached entry never has them; a hydrated card simply shows
 *     none until a live record repopulates them.
 *   - worktreeRoot/worktreeLabel — set by the OWNING manager
 *     (SiblingWorktreeManager etc.) after construction, not the session's
 *     own state.
 *   - meta overlay (title, dismissed) — lives in session-meta.json, merged in
 *     by SessionDiscovery at snapshot time, never by SessionManager itself.
 *   - derived searchText/modelLabel — cheap to recompute from the other
 *     cached fields at getSnapshot() time; caching them risks staleness if
 *     the derivation logic changes without a REPLAY_CACHE_VERSION bump.
 *
 *  `status` is the literal `'done'` (not the full `SessionStatus`) — a cache
 *  entry parsed with any other value is REJECTED outright
 *  (`replayCache.ts:tryNormaliseEntry`), so `hydrate()` can assign it as a
 *  plain fact rather than a value it must defensively coerce. */
export interface CachedSessionState extends GlanceSnapshotFields {
  sessionId: string;
  slug: string;
  workspaceKey: string;
  cwd: string;
  initialCwd: string;
  topic: string;
  activity: string;
  status: 'done';
  /** Epoch ms. */
  lastActivity: number;
  /** Epoch ms. */
  firstActivity: number;
  /** Epoch ms; 0 = never enqueued. */
  enqueuedAt: number;
  contextTokens: number;
  /** Meaningful ONLY when `modelConfirmed` is true — written empty otherwise.
   *  An unconfirmed model is just the OWNING window's config-derived
   *  `defaultModelGuess` at construction time; caching that guess verbatim
   *  would freeze a stale model pill forever on a hydrated enqueue-only
   *  session (the file never changes again, so nothing ever re-derives it) —
   *  even after the user changes the default model setting and reloads.
   *  `hydrate()` re-derives it from the CURRENT `defaultModelGuess` instead
   *  when unconfirmed, exactly as the ordinary constructor does. */
  modelId: string;
  modelConfirmed: boolean;
  customTitle: string;
  aiTitle: string;
  userTurnCount: number;
  permissionMode?: string;
  jsonlPermissionMode?: string;
  entrypoint?: string;
  bridgeSessionId?: string;
  bridgeState?: BridgeState;
  endReason?: string;
  subagents: CachedSubagentState[];
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
  /** True once the active scan has loaded this session as a card. Absent on
   *  entries created only by the extended-archive title backfill, and on
   *  metas written before the flag existed (`seenLive` stands in for those).
   *  An undismissed tracked session survives the scan age gate: the user has
   *  a card for it and has not archived it, so it stays a card at any age. */
  tracked?: boolean;
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
