/**
 * ══════════════════════════════════════════════════════════════════════
 * STATE TRANSITION TABLE
 * ══════════════════════════════════════════════════════════════════════
 *
 * Internal statuses: running | waiting | done
 * Display-only (SessionDiscovery.getSnapshots): stale
 *
 * From          → To            Trigger                                  Source
 * ─────────────────────────────────────────────────────────────────────────────
 * (init)        → done          constructor                              constructor()
 * any           → done          JSONL truncation                         resetState()
 * any           → done          queue-operation: enqueue                 processQueueOperation()
 *
 * done          → running       user record (main thread)                processUserRecord() → setRunning()
 * done          → running       queue-operation: dequeue                 processQueueOperation() → setRunning()
 * done          → running       assistant record (resumed)               processAssistantRecord() → setRunning()
 * waiting       → running       user record (tool_result arrives)        processUserRecord() → setRunning()
 * waiting       → running       sidechain user (subagent unblocked)      processSidechainUser() → setRunning()
 * !running      → running       system: compact_boundary                 processSystemRecord() → setRunning()
 *
 * running       → waiting       AskUserQuestion tool_use                 processAssistantRecord()
 * running       → waiting       permission timer (3s fast / 15s slow,    PermissionTracker fire (session)
 *                                doubled to 6s/30s if a tool result
 *                                arrived <3s ago; the PermissionRequest
 *                                hook pre-empts it when ingress is live)
 * running       → waiting       all subagents blocked                    PermissionTracker fire (subagent, bubbles)
 * running       → waiting       computeDemotion + active tools (no subs) demoteIfStale()
 *
 * running       → done          idle timer (output seen, 5s idle)         resetIdleTimer() timeout
 * running       → done          idle timer (no output, process dead)     resetIdleTimer() + isProcessAlive()
 * running       → done          idle timer (all-subagents-done)          resetIdleTimer() timeout
 * running       → done          all-subagents-done on user record        processUserRecord()
 * running       → done          Stop hook (turn ended; ignored while     TurnLifecycleTracker → onTurnEnded()
 *                                stop_hook_active continuation)
 *               (background agents: markSessionDone exempts live background agents;
 *                their completion arrives via the harness's <task-notification>
 *                user record — processTaskNotification() — or the dormant sweep)
 * running       → done          computeDemotion (no active tools)        demoteIfStale()
 * running       → done          hard ceiling (3 min)                     computeDemotion()
 * waiting       → done          hard ceiling (10 min)                    computeDemotion()
 * running       → done          registry-confirmed process death         demoteIfStale() + isConfirmedDeadByRegistry()
 * waiting       → done          registry-confirmed process death         demoteIfStale() + isConfirmedDeadByRegistry()
 *               (permission false-positive gate: a dead process can't be waiting on a prompt; also
 *                suppresses the permission timer firing 'waiting' on a confirmed-dead session)
 *
 * Display-layer (not in SessionManager):
 * done          → stale         acknowledged + 10s elapsed               getSnapshots()
 *
 * Subagent detection (Phase 1+2, v0.6.2):
 *   Phase 1: processProgressRecord extracts tool_use/tool_result from nested
 *            agent_progress content (data.message.message.content) to populate
 *            subagent activeTools for permission timer firing.
 *   Phase 2: If no agent_progress arrives within SUBAGENT_SILENCE_MS (8s),
 *            a targeted JsonlTailer opens the subagent's own JSONL file
 *            (<session>/subagents/agent-<agentId>.jsonl) for direct reads.
 *            Covers resumed subagents where Claude Code doesn't relay progress.
 *   Activity propagation: subagent activity updates session.lastActivity
 *            via updateSubagentActivity(), eliminating effectiveLastActivity loops.
 *   Acknowledgement: per-subagent (SubagentInfo.acknowledged), not session-level.
 *
 * Subagent demotion model (#108):
 *   Blocking subagent: parentToolUseId is in parent's activeTools (parent waiting for result).
 *     → Suppresses parent demotion. Parent stays "running" until subagent completes.
 *   Background subagent: parentToolUseId NOT in parent's activeTools (parent moved on).
 *     → Does NOT suppress demotion. Parent can demote to "done" normally.
 *   Confidence: ANY running subagent (blocking or background) keeps confidence "high".
 *
 * Detached (run_in_background) agents:
 *   The Agent tool_result of a background spawn is just the launch banner — it
 *   does NOT complete the subagent. Such agents are flagged `background: true`,
 *   stay running through markSessionDone (a done TURN doesn't end a detached
 *   agent), and complete via the harness's <task-notification> user record.
 *   Backstops: registry-confirmed death and a quiet-agent-file ceiling, both in
 *   sweepBackgroundWork(). The card's agents chip counts them as live (#108).
 *
 * activeTools mutation (A2 audit):
 *   All mutations go through 3 centralised methods: addTool(), removeTool(), clearTools().
 *   No direct .set()/.delete()/.clear() on activeTools Maps.
 *
 * Covered record types/subtypes (see sessionManager.transition.test.ts):
 *   user, assistant, progress (agent_progress, hook_progress, bash_progress, mcp_progress),
 *   system (compact_boundary), queue-operation (enqueue, dequeue), custom-title
 * ══════════════════════════════════════════════════════════════════════
 */

import type {
  SessionState,
  SessionStatus,
  StatusConfidence,
  SessionSnapshot,
  SubagentInfo,
  SubagentSnapshot,
  JsonlRecord,
  JsonlContentBlock,
} from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { JsonlTailer } from './jsonlTailer.js';
import { parseTimestamp, isMeaningfulRecord, getModelId, getInputTokens, getProgressType, getContentBlocks } from './jsonlValidator.js';
import { computeDemotion, getToolProfile, MAX_ACTIVE_TOOLS, HARD_CEILING_MS, NEEDS_INPUT_CEILING_MS } from './toolProfiles.js';
import { makeCwdTracker, type CwdTracker } from './trackers/cwdTracker.js';
import { makePermissionTracker, type PermissionTracker } from './trackers/permissionTracker.js';
import { makeSubagentLifecycleTracker, type SubagentLifecycleTracker } from './trackers/subagentLifecycleTracker.js';
import { makeCompactBoundaryTracker, type CompactBoundaryTracker } from './trackers/compactBoundaryTracker.js';
import { makeTurnLifecycleTracker, type TurnLifecycleTracker } from './trackers/turnLifecycleTracker.js';
import { makeToolOutcomeTracker, type ToolOutcomeTracker } from './trackers/toolOutcomeTracker.js';
import { makeSessionLifecycleTracker, type SessionLifecycleTracker } from './trackers/sessionLifecycleTracker.js';
import { makeBackgroundShellTracker, type BackgroundShellTracker, BACKGROUND_SHELL_CEILING_MS } from './trackers/backgroundShellTracker.js';
import { makeSessionLoopTracker, type SessionLoopTracker } from './trackers/sessionLoopTracker.js';
import type { HookEventRouter } from './hookEventRouter.js';
// Re-export for backward compatibility (tests import from sessionManager)
export { computeDemotion, getToolProfile } from './toolProfiles.js';
export type { ToolProfile } from './toolProfiles.js';

/** Idle threshold: if no new data for 5s after a turn, mark as idle/done */
const IDLE_DELAY_MS = 5000;

/** Cap on tracked-file paths kept from a file-history-snapshot record. */
const MAX_TRACKED_FILES = 200;
/** Safety bound on the PreCompact grace window. Compaction normally closes via
 *  the `compact_boundary` signal; if that never arrives (e.g. crash mid-compact),
 *  release the window after this long so the session isn't pinned `running`. */
const COMPACT_GRACE_TIMEOUT_MS = 60_000;
/** Permission timer constants moved to trackers/permissionTracker.ts. */
/** Topic extraction patterns [A3]:
 *  HANDOFF_PATTERN — matches "HANDOFF-PROMPT: <title>" or "HANDOFF-PROMPT <title>"
 *  CONTINUE_PATTERN — matches "Continuing: /path/to/project" from /continue prompts */
const HANDOFF_PATTERN = /^HANDOFF-PROMPT[:\s]*(.+)/m;
const CONTINUE_PATTERN = /^Continuing:\s*\/.*$/;
/** Background-agent surface strings (Claude Code wording, not an API — same
 *  brittleness charter as the background-shell tracker; fail-safe on a wording
 *  change is the old behaviour: banner treated as completion).
 *  LAUNCH — the instant tool_result of a run_in_background Agent spawn. Group 1
 *  captures the agentId so the tailer/sweep can find the agent's own JSONL.
 *  NOTIFICATION — the harness-injected user record delivered when a detached
 *  agent finishes; the real completion signal for background agents. */
const BACKGROUND_AGENT_LAUNCH_PATTERN = /^Async agent launched(?:.*?\bagentId:\s*([\w-]+))?/s;
const TASK_NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/;
/** How long a background agent's own JSONL may sit unmodified before the
 *  dormant sweep force-completes it (missed/never-written task-notification,
 *  e.g. killed CC). A working agent writes far more often than this. */
const BACKGROUND_AGENT_CEILING_MS = 15 * 60 * 1000;
/** Transient "blocked" activity strings set while a session waits on user input
 *  or permission. They become stale the instant the session resumes, so they're
 *  cleared on the waiting→running transition (and on a done card) rather than
 *  lingering as a misleading subtitle through the next thinking phase. */
const WAITING_ACTIVITY_MESSAGES = new Set([
  'Waiting for your response',
  'Waiting for permission',
  'Subagent waiting for permission',
]);
/** Confidence thresholds: how stale can a running/waiting session's lastActivity be
 *  before we degrade visual confidence? [#106]
 *
 *  Module-level (not const) because they're user-tunable via
 *  `serac.sessions.{high,medium}ConfidenceSeconds`. sessionManager is
 *  vscode-free core, so extension.ts pushes the values in via
 *  {@link setConfidenceThresholds} on startup and on settings change. Defaults
 *  match the historical hardcoded values, so untouched settings are a no-op. */
let CONFIDENCE_HIGH_MS = 5_000;
let CONFIDENCE_MEDIUM_MS = 30_000;

/** Set the visual confidence-decay thresholds (in milliseconds). Shared across
 *  all SessionManager instances since the underlying setting is global. */
export function setConfidenceThresholds(highMs: number, mediumMs: number): void {
  CONFIDENCE_HIGH_MS = highMs;
  CONFIDENCE_MEDIUM_MS = mediumMs;
}


/**
 * Manages state for a single Claude Code session.
 * Processes JSONL records and infers status.
 */
export class SessionManager {
  private state: SessionState;
  private tailer: JsonlTailer;
  private disposed = false;
  private firstActivitySet = false;
  /** Last known mtime of the JSONL file (ms). Used for stat-based poll pruning. */
  private lastMtimeMs = 0;
  /** Timestamp when status last transitioned to 'running'. Used to anchor the
   *  30s idle grace period that covers extended thinking (30-60s without records).
   *  Only set on actual done/waiting → running transition, not on every setRunning(). */
  private turnStartAt = 0;
  /** Tracks when a message was enqueued. Used by display layer to avoid marking
   *  queued sessions as stale (C3: enqueue→done+acknowledged premature stale). */
  private enqueuedAt = 0;
  /** Timestamp (ms) of the most recent tool_result in this turn.
   *  Used to extend permission delay only when tools completed recently,
   *  avoiding stale flag inflation on later permission prompts. */
  private lastToolResultAt = 0;
  /** Whether an assistant or progress record has arrived in the current turn.
   *  Reset on user record. When false, the 30s extended thinking grace applies.
   *  When true, the 5s idle timer is used (thinking phase is over). */
  private seenOutputInTurn = false;
  /** PID of the Claude Code process writing to this session's JSONL file.
   *  Captured once via fuser at first activity. Used for zero-cost liveness
   *  checks (kill(pid, 0)) during the extended thinking grace period. */
  private writerPid: number | null = null;
  /** Whether PID capture has been attempted (to avoid repeated fuser calls). */
  private pidCaptureAttempted = false;
  /** Registry-backed liveness probe (injected by SessionDiscovery). Tri-state:
   *  true = a live process backs this session, false = registry is active but
   *  has no entry for it, null = registry inactive/unknown. Distinct from the
   *  fuser-based isProcessAlive(); see isConfirmedDeadByRegistry(). */
  private readonly livenessProbe?: () => boolean | null;
  /** Latch: have we ever observed this session live in the registry? Only then
   *  does a later "not live" reading mean it genuinely died (vs a session class
   *  the registry never tracked). Guards against muting a real prompt. Seeded
   *  from persisted session meta (survives reloads) and reported outward via
   *  onRegistrySeenLive the first time this instance arms it. */
  private everSeenLiveInRegistry = false;
  private readonly onRegistrySeenLive?: () => void;
  /** Tracks subagent lifecycle (spawn / progress / completion).
   *  JSONL-derived variant wraps SubagentTailerManager — hook variant
   *  (Phase 4) publishes lifecycle transitions from SubagentStart/Stop events. */
  private subagentLifecycle: SubagentLifecycleTracker;
  /** Tracks cwd / initialCwd. Hook variant (Phase 4) populates from SessionStart. */
  private cwdTracker: CwdTracker;
  /** Session-level permission timer. Hook variant (Phase 4) subscribes to PermissionRequest. */
  private permissionTracker: PermissionTracker;
  /** Tracks compact boundaries. Spike: extracted from processSystemRecord's
   *  compact_boundary branch. Hook variant will fire on SessionStart(source:"compact"). */
  private compactBoundaryTracker: CompactBoundaryTracker;
  /** Accelerates running→done via the `Stop` hook. No-op JSONL variant (the idle
   *  timer owns done from JSONL). */
  private turnLifecycleTracker: TurnLifecycleTracker;
  /** Turn-close guard. Set when `Stop` ends a turn; suppresses the trailing
   *  assistant record from re-firing `running` (which would flicker done→running
   *  →done). Cleared by a genuine new-turn reopener (user / dequeue / compact).
   *  See ARCHITECTURE.md "The `Stop` turn-close guard". */
  private turnEndedByStop = false;
  /** Enrichment from PostToolUse/PreToolUse. Display-only; never moves status. */
  private toolOutcomeTracker: ToolOutcomeTracker;
  /** SessionEnd (enrichment) + PreCompact (compacting grace window). */
  private sessionLifecycleTracker: SessionLifecycleTracker;
  /** SPIKE: outstanding backgrounded Bash shells. Display-only enrichment;
   *  never moves status — `done` still means the turn ended. See BACKLOG.md. */
  private backgroundShellTracker: BackgroundShellTracker;
  private readonly loopTracker: SessionLoopTracker;
  /** Safety timeout that closes the compacting grace window if no
   *  `compact_boundary` arrives. */
  private compactGraceTimerId?: ReturnType<typeof setTimeout>;
  /** Optional replay/observability hook fired on every status transition.
   *  Non-invasive: default no-op. Used by the replay harness to verify a
   *  captured transition stream is reproducible from JSONL. */
  private readonly onTransition?: (from: SessionStatus, to: SessionStatus, reason: string) => void;
  /** Optional hook-event router, passed to every tracker factory at
   *  construction; hook-capable trackers subscribe via it and fall back to
   *  JSONL inference when it is undefined (foreign workspaces, sibling
   *  worktrees owned by another window, tests). */
  private readonly hookRouter?: HookEventRouter;
  /** Tool_use IDs whose tool_result was processed before the tool_use record
   *  (Claude Code occasionally flushes tool_result ahead of tool_use for fast
   *  tools — same wall-clock millisecond, file order reversed). Without this
   *  set, the late tool_use leaks into activeTools and never clears, causing
   *  demoteIfStale to falsely flag the session as 'waiting' after 30s. */
  private earlyToolResults: Set<string> = new Set();
  /** Glance-pack capture (display-only): branch, tool-error count, last reply. */
  private gitBranch = '';
  /** File paths tracked by the LATEST file-history-snapshot record — the
   *  files this session has edited. Display-only: feeds the cross-session
   *  same-file collision badge. Capped; empty when none. */
  private trackedFiles: string[] = [];
  private toolErrorCount = 0;
  private lastAssistantText = '';
  /** Origin worktree metadata, set by SiblingWorktreeManager so emitted
   *  snapshots can be tagged for cross-worktree display. */
  private worktreeRoot?: string;
  private worktreeLabel?: string;

  constructor(
    sessionId: string,
    filePath: string,
    workspaceKey: string,
    opts: {
      onTransition?: (from: SessionStatus, to: SessionStatus, reason: string) => void;
      hookRouter?: HookEventRouter;
      livenessProbe?: () => boolean | null;
      /** Seed for the seen-live-in-registry latch, persisted across window
       *  reloads via session-meta.json — without it every reload disarmed the
       *  registry death gate until the session was re-observed live. */
      registrySeenLive?: boolean;
      /** Fired once, the first time this instance observes the session live in
       *  the registry — the caller persists the latch. */
      onRegistrySeenLive?: () => void;
    } = {},
  ) {
    const now = new Date();
    this.onTransition = opts.onTransition;
    this.hookRouter = opts.hookRouter;
    this.livenessProbe = opts.livenessProbe;
    this.everSeenLiveInRegistry = opts.registrySeenLive === true;
    this.onRegistrySeenLive = opts.onRegistrySeenLive;
    this.tailer = new JsonlTailer(filePath);
    this.subagentLifecycle = makeSubagentLifecycleTracker({
      isDisposed: () => this.disposed,
      getSessionFilePath: () => this.state.filePath,
      getAllSubagents: () => this.state.subagents,
    }, { hookRouter: this.hookRouter, sessionId });
    this.cwdTracker = makeCwdTracker(workspaceKey, { hookRouter: this.hookRouter, sessionId });
    this.permissionTracker = makePermissionTracker({
      getActiveTools: () => this.state.activeTools,
      getLastToolResultAt: () => this.lastToolResultAt,
      onWaitingFired: (toolName?: string) => {
        if (this.state.status !== 'running') { return; }
        // A registry-confirmed-dead process can't be blocked on a prompt — don't
        // flash 'waiting'; demoteIfStale will resolve it to done. (Permission FP.)
        if (this.isConfirmedDeadByRegistry()) { return; }
        // Key the label off the triggering tool. AskUserQuestion (userInput:
        // true) is a direct prompt to the user, not a permission gate, so it
        // must read "Waiting for your response" — matching the JSONL path in
        // processAssistantRecord(). Prefer the hook's tool_name; fall back to
        // scanning activeTools for the timer variant (no single tool_name).
        const needsUserInput = toolName
          ? getToolProfile(toolName).userInput
          : [...this.state.activeTools.values()].some(name => getToolProfile(name).userInput);
        // Require an active tool, EXCEPT for direct-input tools accelerated by a
        // hook ahead of the JSONL tool_use record (activeTools still empty). The
        // JSONL path re-affirms their `waiting` state, so there is no flip risk.
        if (this.state.activeTools.size === 0 && !needsUserInput) { return; }
        this.setStatus('waiting', needsUserInput ? 'needs_user_input' : 'permission_fired');
        this.appendActivity(needsUserInput ? 'Waiting for your response' : 'Waiting for permission');
      },
    }, { hookRouter: this.hookRouter, sessionId });
    this.compactBoundaryTracker = makeCompactBoundaryTracker({
      onCompactDetected: () => {
        // Compaction is a legitimate running-reopener — clear the Stop guard so
        // the session resumes rather than being held done by a stale turn end.
        this.turnEndedByStop = false;
        // `compact_boundary` means compaction finished — close the grace window.
        this.closeCompactWindow();
        if (this.state.status !== 'running') {
          this.setRunning();
        }
        this.appendActivity('Compacting context');
      },
    }, { hookRouter: this.hookRouter, sessionId });
    this.turnLifecycleTracker = makeTurnLifecycleTracker({
      onTurnEnded: () => {
        // `Stop` fired: the turn ended. Mark done now (accelerating the idle
        // timer) and raise the guard so the turn's trailing JSONL records,
        // polled 0.5-2s later, can't re-open the session to running.
        this.turnEndedByStop = true;
        this.markSessionDone();
      },
    }, { hookRouter: this.hookRouter, sessionId });
    this.toolOutcomeTracker = makeToolOutcomeTracker({
      // Enrichment only — these never touch status or the activity line.
      onToolOutcome: (outcome) => { this.state.lastTool = outcome; },
      onPermissionMode: (mode) => { this.state.permissionMode = mode; },
    }, { hookRouter: this.hookRouter, sessionId });
    this.sessionLifecycleTracker = makeSessionLifecycleTracker({
      onSessionEnd: (reason) => { this.state.endReason = reason; },
      onPreCompact: () => { this.openCompactWindow(); },
    }, { hookRouter: this.hookRouter, sessionId });
    this.backgroundShellTracker = makeBackgroundShellTracker();
    this.loopTracker = makeSessionLoopTracker({ hookRouter: this.hookRouter, sessionId });
    this.state = {
      sessionId,
      slug: sessionId.slice(0, 8),
      workspaceKey,
      filePath,
      status: 'done',
      activity: '',
      activeTools: new Map(),
      subagents: [],
      lastActivity: now,
      firstActivity: now,
      idleTimerId: undefined,
      topic: '',
      contextTokens: 0,
      modelId: '',
      firstUserMessages: [],
      firstAssistantResponse: '',
      customTitle: '',
      aiTitle: '',
      userTurnCount: 0,
    };
  }

  /** Reset derived state (called on JSONL truncation to avoid corrupt accumulation) [H1]
   *  Preserves topic, customTitle, and aiTitle so display names survive compaction. */
  private resetState(): void {
    const now = new Date();
    this.setStatus('done', 'reset_state');
    this.state.activity = '';
    this.clearTools(this.state.activeTools);
    this.state.userTurnCount = 0;
    this.state.firstUserMessages = [];
    this.state.firstAssistantResponse = '';
    // Preserve customTitle, aiTitle, and topic across compaction — clearing
    // them causes the display name to fall back to the compacted summary text.
    this.state.contextTokens = 0;
    this.state.modelId = '';
    this.state.lastActivity = now;
    this.state.firstActivity = now;
    this.firstActivitySet = false;
    this.seenOutputInTurn = false;
    this.lastToolResultAt = 0;
    this.turnEndedByStop = false;
    this.earlyToolResults.clear();
    this.backgroundShellTracker.reset();
    this.loopTracker.clearAll();
    // Glance enrichment rebuilds from the replayed records — stale values must
    // not survive a truncation they may no longer be true of.
    this.gitBranch = '';
    this.toolErrorCount = 0;
    this.lastAssistantText = '';
    this.trackedFiles = [];
    // Dispose all subagent resources before clearing
    this.subagentLifecycle.disposeAll(this.state.subagents);
    for (const subagent of this.state.subagents) {
      subagent.permissionTracker.dispose();
    }
    this.state.subagents = [];
    this.clearSessionTimers();
    // Compaction rewrites the JSONL, which lands here as a truncation. If a
    // PreCompact grace window is open, this reset IS the compaction — keep the
    // session running and re-arm the window instead of leaving it `done`.
    if (this.state.compacting) { this.openCompactWindow(); }
  }

  /** Process all new records from the JSONL file. Returns true if state changed. */
  async update(): Promise<boolean> {
    const records = await this.tailer.readNewRecords();

    // Record mtime from the tailer's stat (avoids redundant syscall)
    if (this.tailer.lastMtimeMs > 0) {
      this.lastMtimeMs = this.tailer.lastMtimeMs;
    }

    // Reset on truncation to avoid corrupt state from replayed records [H1]
    if (this.tailer.truncated) {
      this.resetState();
    }

    if (records.length === 0 && this.subagentLifecycle.getActiveTailerCount() === 0) {
      return this.tailer.truncated;
    }

    let changed = false;
    for (const record of records) {
      if (this.processRecord(record)) {
        changed = true;
      }
    }

    // Poll subagent tailers for direct JSONL reads (Phase 2: silent subagent detection)
    if (this.subagentLifecycle.getActiveTailerCount() > 0) {
      if (await this.processSubagentTailerRecords()) {
        changed = true;
      }
    }

    if (changed) {
      this.resetIdleTimer();
    }

    return changed;
  }

  /** Get a serialisable snapshot for the webview */
  /** Latest-wins capture of the snapshot's tracked file set. The record is
   *  written by Claude Code as it backs up files it edits; keys are paths. */
  private processFileHistorySnapshot(record: JsonlRecord): boolean {
    const snap = (record as { snapshot?: { trackedFileBackups?: unknown } }).snapshot;
    const backups = snap?.trackedFileBackups;
    if (!backups || typeof backups !== 'object' || Array.isArray(backups)) { return false; }
    const files = Object.keys(backups).filter(k => k.length > 0).slice(0, MAX_TRACKED_FILES);
    const changed = files.length !== this.trackedFiles.length
      || files.some((f, i) => f !== this.trackedFiles[i]);
    this.trackedFiles = files;
    return changed;
  }

  getSnapshot(): SessionSnapshot {
    return {
      sessionId: this.state.sessionId,
      slug: this.state.slug,
      ...this.cwdTracker.getState(),
      workspaceKey: this.state.workspaceKey,
      topic: this.state.topic,
      status: this.state.status,
      activity: this.state.activity,
      subagents: this.state.subagents
        // R4: Prune individually acknowledged completed subagents.
        // Running subagents always show. Done subagents show until individually acknowledged.
        .filter(s => s.running || !s.acknowledged)
        .map(s => ({
          parentToolUseId: s.parentToolUseId,
          agentId: s.agentId,
          description: s.description,
          running: s.running,
          waitingOnPermission: s.waitingOnPermission,
          startedAt: s.startedAt.getTime(),
          resultPreview: s.resultPreview,
          toolsCompleted: s.toolsCompleted,
          blocking: s.running && this.state.activeTools.has(s.parentToolUseId),
          background: s.background || undefined,
        } satisfies SubagentSnapshot)),
      lastActivity: this.state.lastActivity.getTime(),
      firstActivity: this.state.firstActivity.getTime(),
      dismissed: false,
      contextTokens: this.state.contextTokens,
      searchText: [this.state.topic, this.state.slug].join(' '),
      modelLabel: this.formatModelLabel(this.state.modelId),
      title: null,  // Populated by SessionDiscovery from session-meta.json
      customTitle: this.state.customTitle,
      aiTitle: this.state.aiTitle,
      confidence: this.computeConfidence(),
      worktreeRoot: this.worktreeRoot,
      worktreeLabel: this.worktreeLabel,
      lastTool: this.state.lastTool,
      permissionMode: this.state.permissionMode,
      endReason: this.state.endReason,
      compacting: this.state.compacting,
      backgroundShellCount: this.backgroundShellTracker.count() || undefined,
      gitBranch: this.gitBranch || undefined,
      toolErrorCount: this.toolErrorCount || undefined,
      lastAssistantText: this.lastAssistantText || undefined,
      processLive: this.registryLiveness(),
      trackedFiles: this.trackedFiles.length > 0 ? this.trackedFiles : undefined,
      ...this.loopSnapshotFields(),
    };
  }

  /** Display-only loop/wakeup enrichment (see SessionLoopTracker). */
  private loopSnapshotFields(): Pick<SessionSnapshot, 'pendingWakeupAt' | 'pendingWakeupReason' | 'sessionCronCount' | 'sessionCronLabel'> {
    const now = Date.now();
    const wakeup = this.loopTracker.pendingWakeup(now);
    const cronCount = this.loopTracker.cronCount(now);
    return {
      pendingWakeupAt: wakeup ? wakeup.fireAt : undefined,
      pendingWakeupReason: wakeup && wakeup.reason ? wakeup.reason : undefined,
      sessionCronCount: cronCount > 0 ? cronCount : undefined,
      sessionCronLabel: cronCount > 0 ? this.loopTracker.cronLabels(now).join(', ') : undefined,
    };
  }

  /** Tag this session's snapshots with its originating worktree. Called by
   *  SiblingWorktreeManager so the panel can render a worktree pill on the card. */
  setWorktreeOrigin(root: string, label: string): void {
    this.worktreeRoot = root;
    this.worktreeLabel = label;
  }

  /** Compute status confidence based on age of last activity [#106].
   *  Terminal statuses (done) are always high confidence.
   *  Running subagents boost confidence to high (direct evidence session is alive).
   *  Active statuses degrade with silence: high (<5s) → medium (<30s) → low. */
  private computeConfidence(): StatusConfidence {
    if (this.state.status === 'done') return 'high';
    // Compaction is a known-busy silence gap — don't let confidence decay.
    if (this.state.compacting) return 'high';
    // Running subagents = strong evidence the session is alive [#108]
    if (this.hasActiveSubagents()) return 'high';
    const age = Date.now() - this.state.lastActivity.getTime();
    if (age < CONFIDENCE_HIGH_MS) return 'high';
    if (age < CONFIDENCE_MEDIUM_MS) return 'medium';
    return 'low';
  }

  getSessionId(): string {
    return this.state.sessionId;
  }

  getStatus(): SessionStatus {
    return this.state.status;
  }

  getFilePath(): string {
    return this.state.filePath;
  }

  getLastActivity(): Date {
    return this.state.lastActivity;
  }

  getEnqueuedAt(): number {
    return this.enqueuedAt;
  }

  /** Stat-based mtime check. Returns true if the file has been modified since last update.
   *  Used by poll pruning: dormant sessions only need a stat(), not a full update(). */
  async checkMtime(): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(this.state.filePath);
      return stat.mtimeMs > this.lastMtimeMs;
    } catch {
      return false; // file gone — will be pruned by discovery
    }
  }

  /** Mark completed subagents as acknowledged (triggers pruning from snapshot) */
  acknowledgeSubagents(): void {
    for (const s of this.state.subagents) {
      if (!s.running) { s.acknowledged = true; }
    }
  }

  /** Demote sessions stuck on 'running' or 'waiting' with no new records.
   *  Subagent activity propagates to session.lastActivity via updateSubagentActivity(),
   *  so no effectiveLastActivity loop is needed. */
  demoteIfStale(thresholdMs: number): boolean {
    // Compacting grace window: never demote — compaction is expected silence.
    if (this.state.compacting) { return false; }
    const now = Date.now();
    // SPIKE: drop background shells past the hard ceiling so the display-only
    // signal can't stick on a card forever (abandoned / missed completion).
    this.backgroundShellTracker.prune(now, BACKGROUND_SHELL_CEILING_MS);

    // Registry-confirmed process death: a process that has exited cannot be
    // running, nor waiting on a permission/input prompt. Resolve to done at
    // once rather than waiting out the hard ceiling (10 min for 'waiting') —
    // this is the permission-false-positive gate (a dead session must not keep
    // showing "Waiting for your response"). Conservative: fires only when we
    // previously saw THIS session live in the registry and it is now gone.
    if ((this.state.status === 'waiting' || this.state.status === 'running')
        && this.isConfirmedDeadByRegistry()) {
      this.markSessionDone();
      return true;
    }

    const result = computeDemotion(
      this.state.status,
      this.state.lastActivity.getTime(),
      this.state.activeTools.size,
      this.hasBlockingSubagents(),
      now,
      thresholdMs,
      this.turnStartAt,
      this.seenOutputInTurn,
    );

    if (result === null) {
      // Turn guard suppressed demotion — verify process is still alive.
      // If process is dead mid-turn, force done (avoids stuck "running" forever).
      if (this.turnStartAt > 0 && !this.seenOutputInTurn
          && (now - this.state.lastActivity.getTime()) > thresholdMs
          && !this.isProcessAlive()) {
        this.markSessionDone();
        return true;
      }
      return false;
    }

    if (result === 'done') {
      this.markSessionDone();
      return true;
    }

    // result === 'waiting'
    this.setStatus('waiting', 'demote_waiting');
    this.appendActivity('Waiting for permission');
    return true;
  }

  /** Per-poll background-WORK maintenance for a DORMANT (done/stale/idle)
   *  session, decoupled from mtime/new-data. Covers both detached kinds:
   *  backgrounded shells and run_in_background agents.
   *
   *  `demoteIfStale()` is the only caller of the shell tracker's `prune()`, and
   *  the poll loop only runs it for active or freshly-woken sessions. So an idle
   *  `done` card with an outstanding background shell — the exact case the badge
   *  targets — would otherwise never prune (the 15-min ceiling never fires) nor
   *  clear on process death. This runs both, every poll:
   *    (a) prune shells past the hard ceiling, and
   *    (b) when the backing process is confirmed dead via the registry, clear
   *        every outstanding shell at once — a dead parent has no detached
   *        children worth flagging — rather than waiting out the ceiling.
   *  Background agents get the same treatment via sweepBackgroundAgents():
   *  registry-confirmed death completes them at once; a quiet agent file past
   *  its ceiling force-completes as the missed-notification backstop.
   *
   *  Returns true iff something actually dropped, so the caller can push the
   *  change to the UI. The demote path can't: on a `done` card `computeDemotion`
   *  short-circuits to null and `demoteIfStale` returns false, so a sweep-driven
   *  drop would never set `changed`. Cheap — returns early unless the session
   *  actually has outstanding shells or live background agents. */
  sweepBackgroundWork(now: number): boolean {
    let changed = false;
    if (this.backgroundShellTracker.hasOutstanding()) {
      const before = this.backgroundShellTracker.count();
      this.backgroundShellTracker.prune(now, BACKGROUND_SHELL_CEILING_MS);
      // Confirmed process death is decisive. Conservative tri-state (see
      // isConfirmedDeadByRegistry): fires only when this session was previously
      // seen live in the registry and is now gone — never for a session class the
      // registry doesn't track, which falls back to the ceiling prune above.
      if (this.isConfirmedDeadByRegistry()) {
        this.backgroundShellTracker.reset();
        this.loopTracker.clearAll(); // a dead session has no scheduler
      }
      changed = this.backgroundShellTracker.count() < before;
    }
    if (this.hasLiveBackgroundAgents() && this.sweepBackgroundAgents(now)) {
      changed = true;
    }
    return changed;
  }

  /** Backstop for background agents whose <task-notification> never arrives
   *  (CC killed, harness crash). Registry-confirmed death completes them all at
   *  once — a dead parent has no detached children. Otherwise an agent whose
   *  own JSONL has sat unmodified past the ceiling is force-completed. The
   *  agent FILE's mtime is the liveness source: it stays accurate even when a
   *  dormant parent's tailers aren't being pumped, and survives replay (unlike
   *  subagent.lastActivity, which is re-stamped to ~now on every reload). */
  private sweepBackgroundAgents(now: number): boolean {
    const dead = this.isConfirmedDeadByRegistry();
    let changed = false;
    for (const subagent of this.state.subagents) {
      if (!subagent.background || !subagent.running) { continue; }
      if (dead) {
        this.completeSubagent(subagent, subagent.resultPreview);
        changed = true;
        continue;
      }
      const lastWriteMs = this.backgroundAgentFileMtime(subagent)
        ?? subagent.lastActivity.getTime();
      if (now - lastWriteMs > BACKGROUND_AGENT_CEILING_MS) {
        this.completeSubagent(subagent, subagent.resultPreview);
        changed = true;
      }
    }
    return changed;
  }

  /** mtime of a background agent's own JSONL, or null when unknown/absent.
   *  Sync stat is fine here: the sweep only reaches this for sessions that
   *  actually have live background agents (rare, few per session). */
  private backgroundAgentFileMtime(subagent: SubagentInfo): number | null {
    if (!subagent.agentId) { return null; }
    const sessionDir = this.state.filePath.replace(/\.jsonl$/, '');
    const file = path.join(sessionDir, 'subagents', `agent-${subagent.agentId}.jsonl`);
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Mark session as done and clean up all running state */
  private markSessionDone(): void {
    this.setStatus('done', 'session_done');
    // Clear status-indicator text that would be misleading on a done card.
    // Preserve genuine activity (tool names, responses) for context.
    if (WAITING_ACTIVITY_MESSAGES.has(this.state.activity)) {
      this.state.activity = '';
    }
    this.clearTools(this.state.activeTools);
    // Mark all subagents as completed and clean up their trackers
    for (const subagent of this.state.subagents) {
      // A live background agent outlives the turn by design — `done` here means
      // the TURN ended, not the detached agent. Keep it running (tailer,
      // permission tracker and all) so the card's agents chip and roster stay
      // truthful; it completes via task-notification or the dormant sweep.
      if (subagent.background && subagent.running) { continue; }
      // Turn-end completion preserves whatever resultPreview the subagent
      // already accumulated (or null). agentId survives so drill-in still works.
      this.completeSubagent(subagent, subagent.resultPreview);
    }
    this.clearSessionTimers();
  }

  /** Capture the PID of the process writing to this session's JSONL file.
   *  Called once on first activity. Uses fuser (macOS/Linux) to identify the
   *  writer, then stores the PID for zero-cost liveness checks via kill(pid, 0). */
  private captureWriterPid(): void {
    if (this.pidCaptureAttempted) return;
    this.pidCaptureAttempted = true;

    execFile('fuser', [this.state.filePath], (err, stdout) => {
      if (err || !stdout) return; // fuser not available or no process — fall back to grace-only
      // fuser output: "path: pid1 pid2 ..." or just "pid1 pid2 ..."
      const cleaned = stdout.replace(/.*:/, '').trim();
      const pid = parseInt(cleaned.split(/\s+/)[0], 10);
      if (!isNaN(pid) && pid > 0) {
        this.writerPid = pid;
      }
    });
  }

  /** Registry-backed death check, distinct from the fuser-based isProcessAlive().
   *  Returns true ONLY when we have positive prior evidence this session
   *  registered a live process AND it is now absent — i.e. it genuinely exited.
   *  A session the registry never tracked (probe never returned true) is never
   *  "confirmed dead", so a real prompt on an unregistered session class is
   *  never silently muted. Also latches everSeenLiveInRegistry as a side effect
   *  whenever it observes the session live. */
  private isConfirmedDeadByRegistry(): boolean {
    return this.registryLiveness() === false;
  }

  /** Registry tri-state shared by the death-gate and the snapshot's
   *  processLive annotation: true = registered live now, false = seen live
   *  before and now absent (confirmed ended), undefined = can't say.
   *  Latches everSeenLiveInRegistry as a side effect on every live sighting. */
  private registryLiveness(): boolean | undefined {
    if (!this.livenessProbe) { return undefined; }
    const live = this.livenessProbe();
    if (live === true) {
      if (!this.everSeenLiveInRegistry) {
        this.everSeenLiveInRegistry = true;
        this.onRegistrySeenLive?.();           // persist the latch across reloads
      }
      return true;
    }
    if (live === null) { return undefined; }   // registry degraded/unknown
    return this.everSeenLiveInRegistry ? false : undefined;
  }

  /** Check if the Claude Code process is still alive.
   *  Returns true if PID was never captured (conservative: assume alive). */
  private isProcessAlive(): boolean {
    if (this.writerPid === null) return true;
    try {
      process.kill(this.writerPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Clear all session-level timers (idle + permission). Subagent timers are
   *  handled separately by disposeSubagent(). Centralises timer ownership [A5]. */
  private clearSessionTimers(): void {
    if (this.state.idleTimerId) { clearTimeout(this.state.idleTimerId); this.state.idleTimerId = undefined; }
    if (this.compactGraceTimerId) { clearTimeout(this.compactGraceTimerId); this.compactGraceTimerId = undefined; }
    this.permissionTracker.cancel();
  }

  /** Open the PreCompact grace window: hold the session `running` through the
   *  compaction silence/truncation, suppress demotion, and arm a safety timeout.
   *  Idempotent — re-arming on a repeated PreCompact is fine. */
  private openCompactWindow(): void {
    this.state.compacting = true;
    this.turnEndedByStop = false;  // compaction supersedes a pending turn-end
    if (this.state.status !== 'running') { this.setRunning('precompact'); }
    this.appendActivity('Compacting context');
    if (this.compactGraceTimerId) { clearTimeout(this.compactGraceTimerId); }
    this.compactGraceTimerId = setTimeout(() => {
      if (this.disposed) { return; }
      this.closeCompactWindow();
    }, COMPACT_GRACE_TIMEOUT_MS);
  }

  /** Close the grace window. Idempotent. */
  private closeCompactWindow(): void {
    this.state.compacting = false;
    if (this.compactGraceTimerId) { clearTimeout(this.compactGraceTimerId); this.compactGraceTimerId = undefined; }
  }

  dispose(): void {
    this.disposed = true;
    this.clearSessionTimers();
    // All eight hook-capable trackers release their router subscriptions here
    // — a pruned manager must leave no closures retaining its state graph.
    this.permissionTracker.dispose();
    this.turnLifecycleTracker.dispose();
    this.loopTracker.dispose();
    this.toolOutcomeTracker.dispose();
    this.sessionLifecycleTracker.dispose();
    this.backgroundShellTracker.dispose();
    this.cwdTracker.dispose();
    this.compactBoundaryTracker.dispose();
    this.subagentLifecycle.dispose();
    this.subagentLifecycle.disposeAll(this.state.subagents);
    for (const subagent of this.state.subagents) {
      subagent.permissionTracker.dispose();
    }
  }

  private processRecord(record: JsonlRecord): boolean {
    const timestamp = parseTimestamp(record.timestamp);

    // Update metadata from any record
    if (record.slug && record.slug !== this.state.slug) {
      this.state.slug = record.slug;
    }
    this.cwdTracker.onCwd(record.cwd);
    const branch = (record as { gitBranch?: unknown }).gitBranch;
    // CC stamps the literal "HEAD" in non-git workspaces (and detached HEAD)
    // — everything is in HEAD by definition there, so the pill differentiates
    // nothing. Suppress it; a real branch name overwrites as usual.
    if (typeof branch === 'string' && branch && branch !== 'HEAD') { this.gitBranch = branch; }
    if (record.sessionId && record.sessionId !== this.state.sessionId) {
      return false;
    }

    // Only update lastActivity for meaningful records (user/assistant turns).
    if (isMeaningfulRecord(record)) {
      this.state.lastActivity = timestamp;
    }

    switch (record.type) {
      case 'user':
        return this.processUserRecord(record, timestamp);
      case 'assistant':
        return this.processAssistantRecord(record);
      case 'progress':
        return this.processProgressRecord(record);
      case 'system':
        return this.processSystemRecord(record, timestamp);
      case 'queue-operation':
        return this.processQueueOperation(record, timestamp);
      case 'custom-title':
        if (record.customTitle && typeof record.customTitle === 'string') {
          this.state.customTitle = record.customTitle;
          return true;
        }
        return false;
      case 'ai-title':
        if (record.aiTitle && typeof record.aiTitle === 'string') {
          this.state.aiTitle = record.aiTitle;
          return true;
        }
        return false;
      case 'file-history-snapshot':
        return this.processFileHistorySnapshot(record);
      default:
        return false;
    }
  }

  private processUserRecord(record: JsonlRecord, timestamp: Date): boolean {
    if (record.isSidechain) {
      return this.processSidechainUser(record);
    }

    // Harness-injected background-agent completion. Processed before the
    // generic turn handling so the agent's running flag is already correct by
    // the time setRunning() and the [F2] all-subagents-done check run below.
    this.processTaskNotification(record);

    // Count main-thread user turns
    this.state.userTurnCount++;

    // First user record sets first activity [F1: use boolean, not timestamp comparison]
    if (!this.firstActivitySet) {
      this.state.firstActivity = timestamp;
      this.firstActivitySet = true;
    }

    // Capture first 2-3 user messages for title generation (up to 500 chars total)
    if (this.state.firstUserMessages.length < 3) {
      const totalChars = this.state.firstUserMessages.reduce((sum, m) => sum + m.length, 0);
      if (totalChars < 500) {
        const content = getContentBlocks(record);
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text.startsWith('<')) continue; // Skip system injections
            const remaining = 500 - totalChars;
            if (remaining > 0) {
              this.state.firstUserMessages.push(text.slice(0, remaining));
            }
            break;
          }
        }
      }
    }

    // Extract topic from first user message with text content
    if (!this.state.topic) {
      const content = getContentBlocks(record);
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          // Skip system injections and path-style prompts
          const text = block.text.trim();
          if (text.startsWith('<') || text.startsWith('HANDOFF-PROMPT')) {
            // Use first line after any prefix for HANDOFF-PROMPT
            if (text.startsWith('HANDOFF-PROMPT')) {
              const match = text.match(HANDOFF_PATTERN);
              if (match) {
                this.state.topic = match[1].trim().slice(0, 60);
                break;
              }
            }
            continue;
          }
          // Take first line, up to 60 chars
          const firstLine = text.split('\n')[0].trim();
          if (firstLine.length > 0) {
            // Strip leading "Continuing: " prefix from /continue prompts
            let topic = firstLine;
            const continueMatch = topic.match(CONTINUE_PATTERN);
            if (continueMatch) {
              // Extract just the project folder name from the path
              const pathParts = topic.split('/').filter(Boolean);
              const folder = pathParts[pathParts.length - 1] || '';
              topic = folder ? `Continuing: ${folder}` : 'Continuing session';
            }
            this.state.topic = topic.slice(0, 60);
            break;
          }
        }
      }
    }

    // Process tool_result blocks — mark tools as complete
    const content = getContentBlocks(record);
    let hadToolResult = false;
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        hadToolResult = true;
        if (block.is_error === true) { this.toolErrorCount++; }
        this.lastToolResultAt = Date.now();
        // SPIKE: detect backgrounded-Bash launch/completion from the result text
        // (display-only; never affects status). A launch banner adds an
        // outstanding shell; a terminal retrieval clears it.
        const resultText = SessionManager.extractToolResultText(block);
        if (resultText) {
          // Anchor the shell's start to the RECORD's own timestamp, not wall-clock
          // at processing time. A reload replays the whole JSONL, so Date.now()
          // would re-stamp every past launch to ~now and reset its 15-min ceiling
          // (a genuinely-abandoned shell would get a fresh grace on every restart).
          // The record timestamp reflects true launch age and survives reloads.
          const launchedAt = parseTimestamp(record.timestamp).getTime();
          this.backgroundShellTracker.noteToolResult(resultText, launchedAt);
          this.loopTracker.noteToolResult(block.tool_use_id, resultText);
        }
        const toolName = this.state.activeTools.get(block.tool_use_id);
        if (toolName === undefined) {
          // tool_result arrived before its tool_use record (out-of-order JSONL writes).
          // Track the id so the late tool_use is recognised as already complete.
          this.earlyToolResults.add(block.tool_use_id);
          continue;
        }
        this.removeTool(this.state.activeTools, block.tool_use_id);

        // Check if this completes a subagent (Task tool)
        if (toolName === 'Task' || toolName === 'Agent') {
          const subagent = this.state.subagents.find(
            s => s.parentToolUseId === block.tool_use_id
          );
          if (subagent) {
            // A run_in_background spawn returns its tool_result instantly — and
            // it's only the launch banner, not the agent's result. Mark the
            // subagent as a live background agent instead of completing it
            // (mistaking the banner for completion made cards read DONE while
            // detached agents kept working). Real completion arrives later as a
            // <task-notification> user record; see processTaskNotification().
            const launchMatch = resultText?.match(BACKGROUND_AGENT_LAUNCH_PATTERN);
            if (launchMatch) {
              subagent.background = true;
              // The banner carries the agentId — adopt it so the Phase 2 tailer
              // can open the agent's JSONL at its exact path (no directory scan)
              // and the dormant sweep can stat the file for liveness.
              if (!subagent.agentId && launchMatch[1]) {
                subagent.agentId = launchMatch[1];
              }
              this.updateSubagentActivity(subagent);
            } else {
              this.completeSubagent(subagent, SessionManager.extractResultPreview(block));
            }
          }
        }

      }
    }

    // User input means the assistant turn finished — now running again
    // Reset turn-scoped flags: new turn starts, thinking phase begins
    this.seenOutputInTurn = false;
    // Reset tool-result recency only on a GENUINE human turn. A user record
    // carrying tool_result blocks is tool plumbing mid-sequence — zeroing it
    // here killed the permission timer's recency doubling on the very records
    // that establish recency (the stamp set above never survived the method).
    if (!hadToolResult) {
      this.lastToolResultAt = 0;
      // A genuine user-text turn after scheduling means the wakeup fired (the
      // harness re-enqueued the prompt) or the user interrupted — either way
      // the session is no longer sleeping.
      this.loopTracker.noteUserTurn(timestamp.getTime());
    }
    // A user record is a genuine new-turn reopener — release the Stop guard.
    this.turnEndedByStop = false;
    this.setRunning();
    // Cancel any pending permission timer — tool results have arrived
    this.permissionTracker.cancel();

    // [F2] Check AFTER status = 'running' so markSessionDone() isn't overwritten.
    // If all subagents are done and only Agent/Task tool IDs remain in activeTools,
    // the session's orchestration is complete.
    if (this.allSubagentsDoneAndOnlyOrchestrationTools()) {
      this.markSessionDone();
    }

    return true;
  }

  private processAssistantRecord(record: JsonlRecord): boolean {
    // Sidechain records come from subagents — process for permission detection
    if (record.isSidechain) {
      return this.processSidechainAssistant(record);
    }

    // Extract model name and context token usage from the message
    const modelId = getModelId(record);
    if (modelId) { this.state.modelId = modelId; }
    const inputTokens = getInputTokens(record);
    if (inputTokens !== null) { this.state.contextTokens = inputTokens; }

    // Mark that output has arrived in this turn (thinking phase over)
    this.seenOutputInTurn = true;

    const content = getContentBlocks(record);

    // Capture first assistant text for title generation
    if (!this.state.firstAssistantResponse) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          this.state.firstAssistantResponse = block.text.trim().slice(0, 500);
          break;
        }
      }
    }
    // And the most recent assistant text — the done-card preview.
    for (const block of content) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        this.lastAssistantText = block.text.trim().slice(0, 200);
      }
    }

    let hasToolUse = false;

    for (const block of content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        // Loop/wakeup orchestration is display-only and must observe the call
        // even when the activeTools guards below skip it (trailing tool of a
        // Stop-closed turn, out-of-order results).
        if (block.name === 'ScheduleWakeup' || block.name === 'CronCreate' || block.name === 'CronDelete') {
          this.loopTracker.noteToolUse(block.name, block.id, block.input, parseTimestamp(record.timestamp).getTime());
        }
        // Out-of-order JSONL writes: tool_result may have been processed before
        // its tool_use record. Skip tracking to avoid leaking activeTools.
        if (this.earlyToolResults.has(block.id)) {
          this.earlyToolResults.delete(block.id);
          continue;
        }
        // Trailing tool_use of a Stop-closed turn: don't repopulate activeTools
        // on a done session (would trip demoteIfStale → waiting after 30s).
        if (this.turnEndedByStop) { continue; }
        hasToolUse = true;
        this.addTool(this.state.activeTools, block.id, block.name);

        // Detect subagent spawns (Agent or Task tool)
        if (block.name === 'Agent' || block.name === 'Task') {
          // Dedup by parentToolUseId to prevent duplicates on truncation replay [H3]
          const alreadyTracked = this.state.subagents.some(s => s.parentToolUseId === block.id);
          // Cap subagent tracking to prevent unbounded growth
          if (!alreadyTracked && this.state.subagents.length < 50) {
            const description = this.extractAgentDescription(block);
            // [Phase 2] Pre-extract agentId from resume input so createSubagent
            // returns a fully-formed struct (no post-construction mutation).
            const input = block.input as Record<string, unknown> | undefined;
            const resumeId = input?.resume;
            const agentId = typeof resumeId === 'string' ? resumeId : null;

            const subagent = this.createSubagent(block.id, description, agentId);
            this.state.subagents.push(subagent);
            this.subagentLifecycle.onSpawn(subagent);
          }
        }

        // Update activity description
        this.appendActivity(this.describeToolUse(block));
      }

      if (block.type === 'text' && block.text) {
        // Use the first ~80 chars of text as activity if no tool use
        if (!hasToolUse) {
          this.appendActivity(block.text.slice(0, 80).replace(/\n/g, ' ').trim());
        }
      }
    }

    if (this.turnEndedByStop) {
      // Trailing record of a turn the `Stop` hook already closed. A genuine new
      // turn always arrives via a user/dequeue/compact record first (which
      // clears the guard), so this record is stale: it must not re-open the
      // session to running. See ARCHITECTURE.md "The `Stop` turn-close guard".
    } else if (hasToolUse) {
      // Check if any tool immediately needs user input
      const needsUserInput = [...this.state.activeTools.values()].some(
        name => getToolProfile(name).userInput
      );
      if (needsUserInput) {
        this.setStatus('waiting', 'needs_user_input');
        this.appendActivity('Waiting for your response');
      } else {
        this.setRunning();
        this.permissionTracker.reschedule();
      }
    } else {
      // Text-only response — could be finishing
      this.setRunning();
    }

    return true;
  }

  private processProgressRecord(record: JsonlRecord): boolean {
    // Progress records mean the agent is actively working (thinking phase over)
    this.seenOutputInTurn = true;
    const dataType = getProgressType(record);

    if (dataType === 'agent_progress') {
      // Subagent is still running — update its last activity
      const parentId = record.parentToolUseID;
      if (parentId) {
        const subagent = this.state.subagents.find(
          s => s.parentToolUseId === parentId
        );
        if (subagent) {
          this.updateSubagentActivity(subagent);
          subagent.running = true;
          // Progress means subagent is working, not blocked
          if (subagent.waitingOnPermission) {
            subagent.waitingOnPermission = false;
          }

          // [Phase 1] Extract tool_use/tool_result from nested agent_progress content.
          // agent_progress records wrap the subagent's messages at data.message.message.content.
          // Without this extraction, subagent activeTools is never populated from progress
          // records, and permission timers can't fire. The helpers are shared
          // with the sidechain and direct-tailer channels so the
          // cancel-vs-reschedule decision and parent recovery stay identical
          // across all three delivery paths.
          const innerMsg = record.data?.message as Record<string, unknown> | undefined;
          const innerType = innerMsg?.type as string | undefined;
          const innerContent = (innerMsg?.message as Record<string, unknown>)?.content;
          if (Array.isArray(innerContent) && innerType === 'assistant') {
            this.applySubagentToolUseBlocks(subagent, innerContent as JsonlContentBlock[]);
          } else if (Array.isArray(innerContent) && innerType === 'user') {
            this.applySubagentToolResultBlocks(subagent, innerContent as JsonlContentBlock[]);
          } else {
            // Progress without tool blocks (thinking/text relay) still means
            // the subagent is working — push the permission timer out.
            subagent.permissionTracker.reschedule();
          }

          // [Phase 2] Record agentId mapping and cancel silence timer.
          // agent_progress.data.agentId maps to the subagent JSONL filename.
          const agentId = record.data?.agentId as string | undefined;
          if (agentId && typeof agentId === 'string') {
            subagent.agentId = agentId;
            // Cancel silence timer + dispose tailer — we're getting progress
            this.subagentLifecycle.onProgress(subagent);
          }
        }
      }
      // Reset permission timer — we're getting progress
      this.permissionTracker.reschedule();
      return true;
    }

    if (dataType === 'hook_progress' || dataType === 'bash_progress' || dataType === 'mcp_progress') {
      // Tool is making progress — reset permission timer
      this.permissionTracker.reschedule();
      return true;
    }

    return false;
  }

  private processSystemRecord(record: JsonlRecord, timestamp: Date): boolean {
    // Context compaction: session is still active, keep it running and reset idle timer
    if (record.subtype === 'compact_boundary') {
      this.compactBoundaryTracker.onCompactBoundary(timestamp.getTime());
      return true;
    }

    // Extension point: turn_duration was previously handled here but was never
    // observed in production JSONL (confirmed across 30 sessions). Removed in v0.9.
    // If Claude Code adds turn_duration in the future, re-add handling here.

    return false;
  }

  private processQueueOperation(record: JsonlRecord, timestamp: Date): boolean {
    if (record.operation === 'enqueue') {
      this.state.firstActivity = timestamp;
      this.setStatus('done', 'enqueue');
      // Track for stale guard (C3). Anchored to the RECORD's timestamp, not
      // wall-clock at processing — a reload replays the JSONL, and Date.now()
      // would re-arm the done→stale display guard for every historic enqueue
      // (same replay reasoning as the background-shell launch anchor).
      this.enqueuedAt = timestamp.getTime();
      return true;
    }
    if (record.operation === 'dequeue') {
      // Message dequeued = Claude is about to start processing. Set running
      // immediately so the session doesn't stay idle during extended thinking
      // (which can take 30-60+ seconds without writing JSONL records).
      // A dequeue is a genuine new-turn reopener — release the Stop guard.
      this.turnEndedByStop = false;
      this.setRunning();
      this.appendActivity('Processing');
      return true;
    }
    // 'remove' = queued message removed without dispatch (user cancelled).
    // No state change: session remains in whatever state the prior enqueue left it.
    return false;
  }

  /** Whether any subagent is actively running (not blocked on permission).
   *  Includes both blocking and background subagents. Used for confidence. */
  private hasActiveSubagents(): boolean {
    return this.state.subagents.some(s => s.running && !s.waitingOnPermission);
  }

  /** Whether any subagent is blocking the parent (tool_use still in parent's activeTools).
   *  Background subagents (parent has moved on) return false.
   *  Used for demotion suppression: only blocking subagents keep the parent "running". */
  private hasBlockingSubagents(): boolean {
    return this.state.subagents.some(
      s => s.running && !s.waitingOnPermission && this.state.activeTools.has(s.parentToolUseId),
    );
  }

  /** Whether all running subagents are blocked on permission prompts */
  private allRunningSubagentsBlocked(): boolean {
    const running = this.state.subagents.filter(s => s.running);
    return running.length > 0 && running.every(s => s.waitingOnPermission);
  }

  /** Construct a fully-formed SubagentInfo, including its PermissionTracker.
   *  Centralised so `permissionTracker` can be non-optional in the type system —
   *  no spawn path can produce a partial subagent.
   *
   *  Construction order: the tracker's host closures reference `subagent`,
   *  but the subagent literal references `tracker`. We resolve this by
   *  building `activeTools` first (a stable Map reference shared by both),
   *  declaring `subagent` with a forward declaration, then assigning. The
   *  closure body only executes when the timer fires — well after assignment. */
  private createSubagent(parentToolUseId: string, description: string, agentId: string | null): SubagentInfo {
    const activeTools = new Map<string, string>();
    let subagent!: SubagentInfo;  // definite-assignment: filled below before any closure runs
    // Subagent permission tracker: hook variant only when we know the
    // agent_id at construction time. PR-E spike (2026-05-25) confirmed
    // subagent PermissionRequest events ride the parent's session_id and
    // carry the subagent's agent_id; the hook variant filters on that.
    const trackerOpts = (this.hookRouter && agentId)
      ? { hookRouter: this.hookRouter, sessionId: this.state.sessionId, agentId }
      : {};
    const tracker = makePermissionTracker({
      getActiveTools: () => activeTools,
      getLastToolResultAt: () => this.lastToolResultAt,
      onWaitingFired: () => this.bubbleSubagentWaitingIfAllBlocked(subagent),
    }, trackerOpts);
    subagent = {
      parentToolUseId,
      description,
      running: true,
      waitingOnPermission: false,
      lastActivity: new Date(),
      activeTools,
      permissionTracker: tracker,
      acknowledged: false,
      tailer: null,
      silenceTimerId: undefined,
      agentId,
      startedAt: new Date(),
      resultPreview: null,
      toolsCompleted: 0,
      background: false,
    };
    return subagent;
  }

  /** Mark a subagent finished and release its trackers + tailer. Shared by the
   *  inline Agent/Task tool_result path, the background-agent task-notification
   *  path, and the dormant sweep's force-complete backstop. */
  private completeSubagent(subagent: SubagentInfo, resultPreview: string | null): void {
    subagent.running = false;
    subagent.waitingOnPermission = false;
    this.clearTools(subagent.activeTools);
    subagent.resultPreview = resultPreview;
    subagent.permissionTracker.dispose();
    this.subagentLifecycle.onComplete(subagent);
  }

  /** Detect a harness-injected <task-notification> user record — the genuine
   *  completion signal for a run_in_background agent. Carries <task-id> (the
   *  agentId), <tool-use-id> (the spawning tool_use), a terminal <status>, and
   *  a <result> body. Returns true when a tracked subagent was completed. */
  private processTaskNotification(record: JsonlRecord): boolean {
    let completed = false;
    for (const block of getContentBlocks(record)) {
      if (block.type !== 'text' || !block.text) { continue; }
      const match = block.text.match(TASK_NOTIFICATION_PATTERN);
      if (!match) { continue; }
      const body = match[1];
      const taskId = body.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim();
      const toolUseId = body.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim();
      const status = body.match(/<status>([^<]+)<\/status>/)?.[1]?.trim();
      const result = body.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim();
      const subagent = this.state.subagents.find(s =>
        (taskId && s.agentId === taskId)
        || (toolUseId && s.parentToolUseId === toolUseId));
      if (!subagent || !subagent.running) { continue; }
      const preview = (status && status !== 'completed' ? `[${status}] ` : '')
        + (result ?? '').replace(/\s+/g, ' ');
      this.completeSubagent(subagent, preview.trim().slice(0, 200) || null);
      completed = true;
    }
    return completed;
  }

  /** Whether any detached run_in_background agent is still working. Used by
   *  the discovery poll loop to keep pumping a dormant (done) parent's
   *  subagent tailers, and by the dormant sweep. */
  hasLiveBackgroundAgents(): boolean {
    return this.state.subagents.some(s => s.background && s.running);
  }

  /** Subagent's PermissionTracker fired. Mark this subagent as blocked, and
   *  bubble "waiting" up to the parent session only when ALL running subagents
   *  are blocked. Centralises the policy so it's discoverable from a stack
   *  trace and testable via `sessionManager.bubble.test.ts`. */
  private bubbleSubagentWaitingIfAllBlocked(subagent: SubagentInfo): void {
    if (!subagent.running || subagent.activeTools.size === 0) { return; }
    subagent.waitingOnPermission = true;
    if (this.state.status === 'running' && this.allRunningSubagentsBlocked()) {
      this.setStatus('waiting', 'subagent_permission_bubble');
      this.appendActivity('Subagent waiting for permission');
    }
  }

  /** Fix 4: All subagents completed and only Agent/Task tool IDs remain */
  private allSubagentsDoneAndOnlyOrchestrationTools(): boolean {
    return this.state.subagents.length > 0
      && this.state.subagents.every(s => !s.running)
      && this.state.activeTools.size > 0
      && [...this.state.activeTools.values()].every(
        name => getToolProfile(name).orchestration
      );
  }

  /** Set status to running and anchor turn start for idle grace period.
   *  turnStartAt only updates on actual status transition (not repeated calls
   *  while already running) to preserve the 30s extended thinking grace. */
  private setRunning(reason: string = 'set_running'): void {
    if (this.state.status !== 'running') {
      this.turnStartAt = Date.now();
      // Capture writer PID on first transition to running
      this.captureWriterPid();
      // The session is resuming, so any "Waiting for …" subtitle is now stale.
      // Replace it with a neutral running label so the card doesn't keep
      // showing "Waiting for your response" through the next thinking phase.
      // (A tool_use record overwrites activity before reaching here, so this
      // only fires when the resume carried no fresh activity text.)
      if (WAITING_ACTIVITY_MESSAGES.has(this.state.activity)) {
        this.state.activity = 'Processing';
      }
    }
    this.setStatus('running', reason);
  }

  /** Single mutation point for `state.status` so the optional onTransition
   *  callback fires on every real change. Same-status assignments are no-ops. */
  private setStatus(next: SessionStatus, reason: string): void {
    const prev = this.state.status;
    if (prev === next) { return; }
    this.state.status = next;
    this.onTransition?.(prev, next, reason);
  }

  /** Whether the session should transition to done: no active tools, or all
   *  subagents completed and only orchestration tools (Agent/Task) remain. */
  private shouldMarkDone(): boolean {
    return this.state.activeTools.size === 0
      || this.allSubagentsDoneAndOnlyOrchestrationTools();
  }

  private resetIdleTimer(): void {
    if (this.state.idleTimerId) { clearTimeout(this.state.idleTimerId); }

    // Two modes:
    // 1. Output seen (seenOutputInTurn=true): thinking is over, use 5s idle.
    // 2. No output yet: extended thinking grace. Wait 30s from turn start,
    //    then check process liveness before marking done.
    const delay = this.seenOutputInTurn
      ? IDLE_DELAY_MS
      : Math.max(IDLE_DELAY_MS, 30_000 - (Date.now() - this.turnStartAt));

    this.state.idleTimerId = setTimeout(() => {
      if (this.disposed) { return; }
      // Compacting grace window: re-arm instead of demoting through the gap.
      if (this.state.compacting) { this.resetIdleTimer(); return; }
      if (this.state.status !== 'running' || !this.shouldMarkDone()) { return; }

      if (this.seenOutputInTurn) {
        // Past thinking phase, 5s idle expired — mark done
        this.markSessionDone();
      } else {
        // Grace period expired — check if process is still alive
        if (this.isProcessAlive()) {
          // Process alive, likely still thinking — re-arm for another 30s
          // (will be capped by the 3min hard ceiling via computeDemotion)
          this.resetIdleTimer();
        } else {
          // Process dead — mark done immediately
          this.markSessionDone();
        }
      }
    }, delay);
  }

  /** Update a subagent's last activity and propagate to session.
   *  Ensures demoteIfStale uses the most recent activity across session + subagents
   *  without needing a loop. */
  private updateSubagentActivity(subagent: SubagentInfo): void {
    const now = new Date();
    subagent.lastActivity = now;
    this.state.lastActivity = now;
  }

  /** Find the subagent that owns a sidechain record via parentToolUseID */
  private findSubagentForSidechain(record: JsonlRecord): SubagentInfo | undefined {
    const parentId = record.parentToolUseID;
    if (parentId) {
      return this.state.subagents.find(s => s.parentToolUseId === parentId);
    }
    return undefined;
  }

  /** Process sidechain assistant records — detect subagent tool_use for permission tracking */
  private processSidechainAssistant(record: JsonlRecord): boolean {
    const subagent = this.findSubagentForSidechain(record);
    if (!subagent || !subagent.running) return false;
    this.applySubagentAssistantRecord(subagent, record);
    return true;
  }

  /** Process sidechain user records — clear subagent tool_use on tool_result */
  private processSidechainUser(record: JsonlRecord): boolean {
    const subagent = this.findSubagentForSidechain(record);
    if (!subagent || !subagent.running) return false;
    this.applySubagentUserRecord(subagent, record);
    return true;
  }

  // ── Shared subagent record processing (sidechain + tailer paths) ──

  /** Apply an assistant record to a subagent: add tools, update activity, reset permission timer.
   *  Deliberately does NOT touch the parent's seenOutputInTurn: that flag means
   *  "the MAIN thread has produced output this turn" and gates the idle timer's
   *  5s-vs-30s mode — a streaming subagent must not cancel the parent's
   *  extended-thinking grace (main-thread agent_progress records already keep
   *  the turn alive via processProgressRecord). */
  private applySubagentAssistantRecord(subagent: SubagentInfo, record: JsonlRecord): void {
    this.updateSubagentActivity(subagent);
    this.applySubagentToolUseBlocks(subagent, getContentBlocks(record));
  }

  /** Apply a user record to a subagent: remove tools, increment toolsCompleted,
   *  clear permission state, recover parent status if unblocked. */
  private applySubagentUserRecord(subagent: SubagentInfo, record: JsonlRecord): void {
    this.updateSubagentActivity(subagent);
    this.applySubagentToolResultBlocks(subagent, getContentBlocks(record));
  }

  /** Apply a subagent's tool_use blocks: add to activeTools (respecting
   *  early-tool-result reordering) and push the permission timer out. The
   *  single implementation behind all three delivery channels — agent_progress
   *  relay, sidechain records, and the direct tailer. */
  private applySubagentToolUseBlocks(subagent: SubagentInfo, blocks: JsonlContentBlock[]): void {
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && block.name) {
        if (this.earlyToolResults.has(block.id)) {
          this.earlyToolResults.delete(block.id);
          continue;
        }
        this.addTool(subagent.activeTools, block.id, block.name);
      }
    }
    subagent.permissionTracker.reschedule();
  }

  /** Apply a subagent's tool_result blocks: remove from activeTools, count
   *  completions, CANCEL the permission timer (a result means the gate
   *  resolved — rescheduling here would re-fire and re-block), and recover a
   *  bubbled parent. The single implementation behind all three delivery
   *  channels: the relay copy used to reschedule instead of cancel and skip
   *  parent recovery, leaving a bubbled parent stuck on "Subagent waiting for
   *  permission" when relay was the only live channel. */
  private applySubagentToolResultBlocks(subagent: SubagentInfo, blocks: JsonlContentBlock[]): void {
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        if (subagent.activeTools.has(block.tool_use_id)) {
          this.removeTool(subagent.activeTools, block.tool_use_id);
        } else {
          this.earlyToolResults.add(block.tool_use_id);
        }
        subagent.toolsCompleted++;
      }
    }
    // Tool result arrived — subagent is no longer waiting
    if (subagent.waitingOnPermission) {
      subagent.waitingOnPermission = false;
    }
    subagent.permissionTracker.cancel();
    // Re-evaluate parent status: recover waiting→running unless a non-exempt
    // parent tool holds the gate or the bubble condition still holds.
    if (this.state.status === 'waiting') {
      const parentHasNonExempt = [...this.state.activeTools.values()].some(
        name => !getToolProfile(name).exempt
      );
      if (!parentHasNonExempt && !this.allRunningSubagentsBlocked()) {
        this.setRunning();
      }
    }
  }

  private extractAgentDescription(block: JsonlContentBlock): string {
    const input = block.input as Record<string, unknown> | undefined;
    if (input?.description && typeof input.description === 'string') {
      return input.description;
    }
    if (input?.prompt && typeof input.prompt === 'string') {
      return input.prompt.slice(0, 60).replace(/\n/g, ' ').trim();
    }
    return 'Subagent';
  }

  /** Extract the full text of a tool_result block (all text parts joined),
   *  bounded so a large background-shell output can't blow up the scan. Unlike
   *  extractResultPreview this does NOT stop at the first block — the
   *  background-shell markers (`<task_id>` … `<status>`) can span parts. The
   *  bound comfortably covers the structured retrieval header, which always
   *  precedes the `<output>` body. */
  static extractToolResultText(block: JsonlContentBlock): string | null {
    const content = block.content;
    if (typeof content === 'string') { return content.slice(0, 2000); }
    if (!Array.isArray(content)) { return null; }
    const parts: string[] = [];
    let len = 0;
    for (const item of content) {
      let part = '';
      if (typeof item === 'string') { part = item; }
      else if (item && typeof item === 'object' && typeof (item as { text?: string }).text === 'string') {
        part = (item as { text: string }).text;
      }
      if (!part) { continue; }
      parts.push(part);
      len += part.length;
      if (len >= 2000) { break; }
    }
    return parts.length ? parts.join('\n').slice(0, 2000) : null;
  }

  /** Extract a short result preview from a tool_result block */
  static extractResultPreview(block: JsonlContentBlock): string | null {
    // tool_result content can be a string or array of content blocks
    const content = block.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'string') { text += item; break; }
        if (item && typeof item === 'object' && typeof (item as { text?: string }).text === 'string') {
          text += (item as { text: string }).text;
          break;
        }
      }
    }
    if (!text) { return null; }
    // Clean and truncate
    const cleaned = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) { return null; }
    return cleaned.length > 120 ? cleaned.slice(0, 117) + '...' : cleaned;
  }

  private describeToolUse(block: JsonlContentBlock): string {
    const name = block.name || 'Unknown';
    const input = block.input as Record<string, unknown> | undefined;

    switch (name) {
      case 'Read':
        return `Reading ${this.basename(input?.file_path as string)}`;
      case 'Write':
        return `Writing ${this.basename(input?.file_path as string)}`;
      case 'Edit':
        return `Editing ${this.basename(input?.file_path as string)}`;
      case 'Bash':
        return `Running command`;
      case 'Grep':
        return `Searching: ${(input?.pattern as string)?.slice(0, 40) || 'files'}`;
      case 'Glob':
        return `Finding files: ${(input?.pattern as string)?.slice(0, 40) || ''}`;
      case 'Agent':
      case 'Task':
        return `Spawning subagent`;
      case 'WebSearch':
        return `Searching web`;
      case 'WebFetch':
        return `Fetching URL`;
      case 'TodoWrite':
        return `Updating tasks`;
      default:
        return `Using ${name}`;
    }
  }

  private formatModelLabel(modelId: string): string {
    if (!modelId) return '';
    if (modelId.includes('opus')) return 'Opus';
    if (modelId.includes('sonnet')) return 'Sonnet';
    if (modelId.includes('haiku')) return 'Haiku';
    const parts = modelId.replace('claude-', '').split('-');
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }

  // ── Centralised activeTools mutation (A2 audit fix) ──────────────

  /** Add a tool to a Map, evicting the oldest entry if at capacity [C2] */
  private addTool(tools: Map<string, string>, id: string, name: string): void {
    if (tools.size >= MAX_ACTIVE_TOOLS) {
      const oldest = tools.keys().next().value;
      if (oldest !== undefined) { tools.delete(oldest); }
    }
    tools.set(id, name);
  }

  /** Remove a completed tool from a Map. */
  private removeTool(tools: Map<string, string>, id: string): void {
    tools.delete(id);
  }

  /** Clear all active tools from a Map. */
  private clearTools(tools: Map<string, string>): void {
    tools.clear();
  }

  private appendActivity(text: string): void {
    this.state.activity = text;
  }

  private basename(filePath: string | undefined): string {
    if (!filePath) { return 'file'; }
    return path.basename(filePath) || 'file';
  }

  // ── Phase 2: Subagent JSONL tailing (delegated to SubagentLifecycleTracker) ──

  /** Process records from subagent tailers. Returns true if any state changed.
   *  SubagentLifecycleTracker handles I/O; this method handles state mutations
   *  via the shared applySubagent*Record methods. */
  private async processSubagentTailerRecords(): Promise<boolean> {
    const batches = await this.subagentLifecycle.pollDirect(this.state.subagents);
    let changed = false;

    for (const { subagent, records } of batches) {
      for (const record of records) {
        if (record.type === 'assistant') {
          this.applySubagentAssistantRecord(subagent, record);
          changed = true;
        } else if (record.type === 'user') {
          this.applySubagentUserRecord(subagent, record);
          changed = true;
        }
      }
    }

    return changed;
  }
}
