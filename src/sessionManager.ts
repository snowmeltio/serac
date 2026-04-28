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
 * running       → waiting       permission timer (3s/6s, doubled to     resetPermissionTimer() timeout
 *                                6s/12s if recent tool result <3s ago)
 * running       → waiting       all subagents blocked                    resetSubagentPermissionTimer() timeout
 * running       → waiting       computeDemotion + active tools (no subs) demoteIfStale()
 *
 * running       → done          idle timer (output seen, 5s idle)         resetIdleTimer() timeout
 * running       → done          idle timer (no output, process dead)     resetIdleTimer() + isProcessAlive()
 * running       → done          idle timer (all-subagents-done)          resetIdleTimer() timeout
 * running       → done          all-subagents-done on user record        processUserRecord()
 * running       → done          computeDemotion (no active tools)        demoteIfStale()
 * running       → done          hard ceiling (3 min)                     computeDemotion()
 * waiting       → done          hard ceiling (10 min)                    computeDemotion()
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
 *   Future work: visual distinction for background subagents on done cards (#108 follow-up).
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
import { SubagentTailerManager } from './subagentTailerManager.js';
import { parseTimestamp, isMeaningfulRecord, getModelId, getInputTokens, getProgressType } from './jsonlValidator.js';
import { computeDemotion, getToolProfile, MAX_ACTIVE_TOOLS, HARD_CEILING_MS, NEEDS_INPUT_CEILING_MS } from './toolProfiles.js';
// Re-export for backward compatibility (tests import from sessionManager)
export { computeDemotion, getToolProfile } from './toolProfiles.js';
export type { ToolProfile } from './toolProfiles.js';

/** Idle threshold: if no new data for 5s after a turn, mark as idle/done */
const IDLE_DELAY_MS = 5000;
/** Permission-wait threshold: if tools are active but no progress after this delay.
 *  Calibrated from JSONL analysis: auto-approved Edit/Write resolves in <1s,
 *  so 3s gives comfortable margin. This timer is the primary permission detection
 *  mechanism (no authoritative signal exists in current Claude Code JSONL output). */
const PERMISSION_DELAY_MS = 3_000;
/** Extended threshold for slow tools (Bash auto-approve resolves in <4s;
 *  MCP tools need network round-trip). 6s covers execution + network
 *  while keeping worst-case doubled delay at 12s (down from 16s). */
const SLOW_PERMISSION_DELAY_MS = 6_000;
/** Recency window: only double permission delay if a tool result arrived
 *  within this window. Prevents stale flag from inflating delay on permission
 *  prompts that appear long after the last tool completed. */
const TOOL_RECENCY_MS = 3_000;
/** Topic extraction patterns [A3]:
 *  HANDOFF_PATTERN — matches "HANDOFF-PROMPT: <title>" or "HANDOFF-PROMPT <title>"
 *  CONTINUE_PATTERN — matches "Continuing: /path/to/project" from /continue prompts */
const HANDOFF_PATTERN = /^HANDOFF-PROMPT[:\s]*(.+)/m;
const CONTINUE_PATTERN = /^Continuing:\s*\/.*$/;
/** Confidence thresholds: how stale can a running/waiting session's lastActivity be
 *  before we degrade visual confidence? [#106] */
const CONFIDENCE_HIGH_MS = 5_000;
const CONFIDENCE_MEDIUM_MS = 30_000;


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
  /** Manages subagent JSONL tailers (silence timers, file discovery, polling). */
  private subagentTailers: SubagentTailerManager;

  constructor(
    sessionId: string,
    filePath: string,
    workspaceKey: string,
  ) {
    const now = new Date();
    this.tailer = new JsonlTailer(filePath);
    this.subagentTailers = new SubagentTailerManager({
      isDisposed: () => this.disposed,
      getSessionFilePath: () => this.state.filePath,
      getAllSubagents: () => this.state.subagents,
    });
    this.state = {
      sessionId,
      slug: sessionId.slice(0, 8),
      cwd: '',
      workspaceKey,
      filePath,
      status: 'done',
      activity: '',
      activeTools: new Map(),
      subagents: [],
      lastActivity: now,
      firstActivity: now,
      idleTimerId: undefined,
      permissionTimerId: undefined,
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
    this.state.status = 'done';
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
    // Dispose all subagent resources before clearing
    this.subagentTailers.disposeAll(this.state.subagents);
    for (const subagent of this.state.subagents) {
      if (subagent.permissionTimerId) {
        clearTimeout(subagent.permissionTimerId);
        subagent.permissionTimerId = undefined;
      }
    }
    this.state.subagents = [];
    this.clearSessionTimers();
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

    if (records.length === 0 && this.subagentTailers.getActiveTailerCount() === 0) {
      return this.tailer.truncated;
    }

    let changed = false;
    for (const record of records) {
      if (this.processRecord(record)) {
        changed = true;
      }
    }

    // Poll subagent tailers for direct JSONL reads (Phase 2: silent subagent detection)
    if (this.subagentTailers.getActiveTailerCount() > 0) {
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
  getSnapshot(): SessionSnapshot {
    return {
      sessionId: this.state.sessionId,
      slug: this.state.slug,
      cwd: this.state.cwd,
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
          description: s.description,
          running: s.running,
          waitingOnPermission: s.waitingOnPermission,
          startedAt: s.startedAt.getTime(),
          resultPreview: s.resultPreview,
          toolsCompleted: s.toolsCompleted,
          blocking: s.running && this.state.activeTools.has(s.parentToolUseId),
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
    };
  }

  /** Compute status confidence based on age of last activity [#106].
   *  Terminal statuses (done) are always high confidence.
   *  Running subagents boost confidence to high (direct evidence session is alive).
   *  Active statuses degrade with silence: high (<5s) → medium (<30s) → low. */
  private computeConfidence(): StatusConfidence {
    if (this.state.status === 'done') return 'high';
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
    const now = Date.now();
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
    this.state.status = 'waiting';
    this.appendActivity('Waiting for permission');
    return true;
  }

  /** Mark session as done and clean up all running state */
  private markSessionDone(): void {
    this.state.status = 'done';
    // Clear status-indicator text that would be misleading on a done card.
    // Preserve genuine activity (tool names, responses) for context.
    if (this.state.activity === 'Waiting for permission') {
      this.state.activity = '';
    }
    this.clearTools(this.state.activeTools);
    // Mark all subagents as completed and clean up their timers
    for (const subagent of this.state.subagents) {
      subagent.running = false;
      subagent.waitingOnPermission = false;
      this.clearTools(subagent.activeTools);
      if (subagent.permissionTimerId) {
        clearTimeout(subagent.permissionTimerId);
        subagent.permissionTimerId = undefined;
      }
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
    if (this.state.permissionTimerId) { clearTimeout(this.state.permissionTimerId); this.state.permissionTimerId = undefined; }
  }

  dispose(): void {
    this.disposed = true;
    this.clearSessionTimers();
    this.subagentTailers.disposeAll(this.state.subagents);
    for (const subagent of this.state.subagents) {
      if (subagent.permissionTimerId) {
        clearTimeout(subagent.permissionTimerId);
        subagent.permissionTimerId = undefined;
      }
    }
  }

  private processRecord(record: JsonlRecord): boolean {
    const timestamp = parseTimestamp(record.timestamp);

    // Update metadata from any record
    if (record.slug && record.slug !== this.state.slug) {
      this.state.slug = record.slug;
    }
    if (record.cwd) {
      this.state.cwd = record.cwd;
    }
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
        return this.processSystemRecord(record);
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
      default:
        return false;
    }
  }

  private processUserRecord(record: JsonlRecord, timestamp: Date): boolean {
    if (record.isSidechain) {
      return this.processSidechainUser(record);
    }

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
        const content = record.message?.content || [];
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
      const content = record.message?.content || [];
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
    const content = record.message?.content || [];
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        this.lastToolResultAt = Date.now();
        const toolName = this.state.activeTools.get(block.tool_use_id);
        this.removeTool(this.state.activeTools, block.tool_use_id);

        // Check if this completes a subagent (Task tool)
        if (toolName === 'Task' || toolName === 'Agent') {
          const subagent = this.state.subagents.find(
            s => s.parentToolUseId === block.tool_use_id
          );
          if (subagent) {
            subagent.running = false;
            subagent.waitingOnPermission = false;
            this.clearTools(subagent.activeTools);
            // Extract result preview from tool_result content
            subagent.resultPreview = SessionManager.extractResultPreview(block);
            // Clean up permission timer + tailer resources on completion
            if (subagent.permissionTimerId) {
              clearTimeout(subagent.permissionTimerId);
              subagent.permissionTimerId = undefined;
            }
            this.subagentTailers.disposeSubagent(subagent);
          }
        }

      }
    }

    // User input means the assistant turn finished — now running again
    // Reset turn-scoped flags: new turn starts, thinking phase begins
    this.seenOutputInTurn = false;
    this.lastToolResultAt = 0;
    this.setRunning();
    // Cancel any pending permission timer — tool results have arrived
    if (this.state.permissionTimerId) {
      clearTimeout(this.state.permissionTimerId);
      this.state.permissionTimerId = undefined;
    }

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

    const content = record.message?.content || [];

    // Capture first assistant text for title generation
    if (!this.state.firstAssistantResponse) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          this.state.firstAssistantResponse = block.text.trim().slice(0, 500);
          break;
        }
      }
    }

    let hasToolUse = false;

    for (const block of content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        hasToolUse = true;
        this.addTool(this.state.activeTools, block.id, block.name);

        // Detect subagent spawns (Agent or Task tool)
        if (block.name === 'Agent' || block.name === 'Task') {
          // Dedup by parentToolUseId to prevent duplicates on truncation replay [H3]
          const alreadyTracked = this.state.subagents.some(s => s.parentToolUseId === block.id);
          // Cap subagent tracking to prevent unbounded growth
          if (!alreadyTracked && this.state.subagents.length < 50) {
            const description = this.extractAgentDescription(block);
            const subagent: SubagentInfo = {
              parentToolUseId: block.id,
              description,
              running: true,
              waitingOnPermission: false,
              lastActivity: new Date(),
              activeTools: new Map(),
              permissionTimerId: undefined,
              acknowledged: false,
              tailer: null,
              silenceTimerId: undefined,
              agentId: null,
              startedAt: new Date(),
              resultPreview: null,
              toolsCompleted: 0,
            };

            // [Phase 2] Record agentId from resume input.
            const input = block.input as Record<string, unknown> | undefined;
            const resumeId = input?.resume;
            if (typeof resumeId === 'string') {
              subagent.agentId = resumeId;
            }

            this.state.subagents.push(subagent);
            this.subagentTailers.startSilenceTimer(subagent);
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

    if (hasToolUse) {
      // Check if any tool immediately needs user input
      const needsUserInput = [...this.state.activeTools.values()].some(
        name => getToolProfile(name).userInput
      );
      if (needsUserInput) {
        this.state.status = 'waiting';
        this.appendActivity('Waiting for your response');
      } else {
        this.setRunning();
        this.resetPermissionTimer();
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
          // records, and permission timers can't fire.
          const innerMsg = record.data?.message as Record<string, unknown> | undefined;
          const innerType = innerMsg?.type as string | undefined;
          const innerContent = (innerMsg?.message as Record<string, unknown>)?.content;
          if (Array.isArray(innerContent)) {
            if (innerType === 'assistant') {
              for (const block of innerContent as JsonlContentBlock[]) {
                if (block.type === 'tool_use' && block.id && block.name) {
                  this.addTool(subagent.activeTools, block.id, block.name);
                }
              }
            } else if (innerType === 'user') {
              for (const block of innerContent as JsonlContentBlock[]) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                  this.removeTool(subagent.activeTools, block.tool_use_id);
                  subagent.toolsCompleted++;
                }
              }
            }
          }

          this.resetSubagentPermissionTimer(subagent);

          // [Phase 2] Record agentId mapping and cancel silence timer.
          // agent_progress.data.agentId maps to the subagent JSONL filename.
          const agentId = record.data?.agentId as string | undefined;
          if (agentId && typeof agentId === 'string') {
            subagent.agentId = agentId;
            // Cancel silence timer + dispose tailer — we're getting progress
            this.subagentTailers.cancelProgressSilence(subagent);
          }
        }
      }
      // Reset permission timer — we're getting progress
      this.resetPermissionTimer();
      return true;
    }

    if (dataType === 'hook_progress' || dataType === 'bash_progress' || dataType === 'mcp_progress') {
      // Tool is making progress — reset permission timer
      this.resetPermissionTimer();
      return true;
    }

    return false;
  }

  private processSystemRecord(record: JsonlRecord): boolean {
    // Context compaction: session is still active, keep it running and reset idle timer
    if (record.subtype === 'compact_boundary') {
      if (this.state.status !== 'running') {
        this.setRunning();
      }
      this.appendActivity('Compacting context');
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
      this.state.status = 'done';
      this.enqueuedAt = Date.now();  // Track for stale guard (C3)
      return true;
    }
    if (record.operation === 'dequeue') {
      // Message dequeued = Claude is about to start processing. Set running
      // immediately so the session doesn't stay idle during extended thinking
      // (which can take 30-60+ seconds without writing JSONL records).
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
  private setRunning(): void {
    if (this.state.status !== 'running') {
      this.turnStartAt = Date.now();
      // Capture writer PID on first transition to running
      this.captureWriterPid();
    }
    this.state.status = 'running';
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

  /** Apply an assistant record to a subagent: add tools, update activity, reset permission timer. */
  private applySubagentAssistantRecord(subagent: SubagentInfo, record: JsonlRecord): void {
    this.updateSubagentActivity(subagent);
    this.seenOutputInTurn = true;
    const content = record.message?.content || [];
    for (const block of content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        this.addTool(subagent.activeTools, block.id, block.name);
      }
    }
    this.resetSubagentPermissionTimer(subagent);
  }

  /** Apply a user record to a subagent: remove tools, increment toolsCompleted,
   *  clear permission state, recover parent status if unblocked. */
  private applySubagentUserRecord(subagent: SubagentInfo, record: JsonlRecord): void {
    this.updateSubagentActivity(subagent);
    const content = record.message?.content || [];
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        this.removeTool(subagent.activeTools, block.tool_use_id);
        subagent.toolsCompleted++;
      }
    }
    // Tool result arrived — subagent is no longer waiting
    if (subagent.waitingOnPermission) {
      subagent.waitingOnPermission = false;
    }
    if (subagent.permissionTimerId) {
      clearTimeout(subagent.permissionTimerId);
      subagent.permissionTimerId = undefined;
    }
    // Re-evaluate parent status
    if (this.state.status === 'waiting') {
      const parentHasNonExempt = [...this.state.activeTools.values()].some(
        name => !getToolProfile(name).exempt
      );
      if (!parentHasNonExempt && !this.allRunningSubagentsBlocked()) {
        this.setRunning();
      }
    }
  }

  private resetSubagentPermissionTimer(subagent: SubagentInfo): void {
    if (subagent.permissionTimerId) { clearTimeout(subagent.permissionTimerId); }

    subagent.permissionTimerId = this.schedulePermissionTimer(subagent.activeTools, () => {
      if (subagent.running && subagent.activeTools.size > 0) {
        subagent.waitingOnPermission = true;
        // Only bubble to parent if ALL running subagents are blocked.
        if (this.state.status === 'running' && this.allRunningSubagentsBlocked()) {
          this.state.status = 'waiting';
          this.appendActivity('Subagent waiting for permission');
        }
      }
    });
  }

  private resetPermissionTimer(): void {
    if (this.state.permissionTimerId) { clearTimeout(this.state.permissionTimerId); }

    this.state.permissionTimerId = this.schedulePermissionTimer(this.state.activeTools, () => {
      if (this.state.status === 'running' && this.state.activeTools.size > 0) {
        this.state.status = 'waiting';
        this.appendActivity('Waiting for permission');
      }
    });
  }

  /** Shared permission timer scheduling. Returns timer ID or undefined if no non-exempt tools.
   *  When a tool result arrived recently (within TOOL_RECENCY_MS), doubles the delay to
   *  reduce false "waiting" on tool-heavy turns with brief inter-tool silence [#106/Phase 4].
   *  Unlike the previous boolean flag, recency-based doubling decays naturally so permission
   *  prompts arriving after a gap are detected at base speed. */
  private schedulePermissionTimer(
    tools: Map<string, string>,
    onExpired: () => void,
  ): ReturnType<typeof setTimeout> | undefined {
    const toolNames = [...tools.values()];
    const hasNonExempt = toolNames.some(name => !getToolProfile(name).exempt);
    if (!hasNonExempt || tools.size === 0) { return undefined; }

    const hasSlow = toolNames.some(name => getToolProfile(name).slow);
    let delay = hasSlow ? SLOW_PERMISSION_DELAY_MS : PERMISSION_DELAY_MS;
    // Only double if a tool result arrived recently — avoids stale inflation
    const recentToolResult = this.lastToolResultAt > 0 && (Date.now() - this.lastToolResultAt < TOOL_RECENCY_MS);
    if (recentToolResult) { delay *= 2; }

    return setTimeout(() => {
      if (this.disposed) { return; }
      onExpired();
    }, delay);
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

  // ── Phase 2: Subagent JSONL tailing (delegated to SubagentTailerManager) ──

  /** Process records from subagent tailers. Returns true if any state changed.
   *  SubagentTailerManager handles I/O; this method handles state mutations
   *  via the shared applySubagent*Record methods. */
  private async processSubagentTailerRecords(): Promise<boolean> {
    const batches = await this.subagentTailers.poll(this.state.subagents);
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
