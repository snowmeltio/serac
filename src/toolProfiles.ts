/**
 * Tool metadata and session demotion logic.
 *
 * Extracted from sessionManager.ts for clarity. Contains:
 * - ToolProfile interface and TOOL_PROFILES map
 * - getToolProfile() lookup with MCP prefix handling
 * - computeDemotion() pure function for status transitions
 * - MAX_ACTIVE_TOOLS cap
 */

import type { SessionStatus } from './types.js';

// ── Demotion ceilings ────────────────────────────────────────────────

/** Hard ceiling: 3 min of no activity forces done.
 *  Covers: laptop sleep, quota hits, VS Code quit. */
export const HARD_CEILING_MS = 180_000;

/** Extended ceiling for waiting sessions: 10 min.
 *  Genuine permission waits resolve within seconds to minutes. */
export const NEEDS_INPUT_CEILING_MS = 600_000;

// ── Tool profiles ────────────────────────────────────────────────────

/** Tool metadata: consolidates exempt/slow/userInput/orchestration into a single lookup. */
export interface ToolProfile {
  /** Never triggers permission timer (read-only, orchestration, internal) */
  exempt: boolean;
  /** Gets longer permission delay (network, shell) */
  slow: boolean;
  /** Immediately transitions to 'waiting' (AskUserQuestion) */
  userInput: boolean;
  /** Orchestration tool (Agent, Task) — session done when all subagents done
   *  and only orchestration tools remain. */
  orchestration: boolean;
}

const TOOL_PROFILES = new Map<string, ToolProfile>([
  // Exempt + orchestration (Agent/Task spawns and Agent Teams coordination)
  ['Agent',           { exempt: true,  slow: false, userInput: false, orchestration: true }],
  ['Task',            { exempt: true,  slow: false, userInput: false, orchestration: true }],
  ['TaskOutput',      { exempt: true,  slow: false, userInput: false, orchestration: true }],
  ['TaskStop',        { exempt: true,  slow: false, userInput: false, orchestration: true }],
  ['TeamCreate',      { exempt: true,  slow: false, userInput: false, orchestration: true }],
  ['TeamDelete',      { exempt: true,  slow: false, userInput: false, orchestration: true }],
  ['SendMessage',     { exempt: true,  slow: false, userInput: false, orchestration: true }],
  // Exempt (read-only, internal, or instant local writes)
  ['Read',            { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['Glob',            { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['Grep',            { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['Edit',            { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['Write',           { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['NotebookEdit',    { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['TodoWrite',       { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['ToolSearch',      { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['EnterPlanMode',   { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['ExitPlanMode',    { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['EnterWorktree',   { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['ExitWorktree',    { exempt: true,  slow: false, userInput: false, orchestration: false }],
  // Exempt (instant fire-and-forget — schedule/cron/notification primitives)
  ['ScheduleWakeup',  { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['CronCreate',      { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['CronDelete',      { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['CronList',        { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['RemoteTrigger',   { exempt: true,  slow: false, userInput: false, orchestration: false }],
  ['PushNotification',{ exempt: true,  slow: false, userInput: false, orchestration: false }],
  // Slow (network/shell/streaming)
  ['Bash',            { exempt: false, slow: true,  userInput: false, orchestration: false }],
  ['WebSearch',       { exempt: false, slow: true,  userInput: false, orchestration: false }],
  ['WebFetch',        { exempt: false, slow: true,  userInput: false, orchestration: false }],
  ['Skill',           { exempt: false, slow: true,  userInput: false, orchestration: false }],
  ['Monitor',         { exempt: false, slow: true,  userInput: false, orchestration: false }],
  // User input
  ['AskUserQuestion', { exempt: false, slow: false, userInput: true,  orchestration: false }],
]);

/** Default profiles for unknown tools */
const DEFAULT_TOOL_PROFILE: ToolProfile = { exempt: false, slow: false, userInput: false, orchestration: false };
const MCP_TOOL_PROFILE: ToolProfile = { exempt: false, slow: true, userInput: false, orchestration: false };

/** Look up tool profile by name. MCP tools default to slow. */
export function getToolProfile(name: string): ToolProfile {
  const profile = TOOL_PROFILES.get(name);
  if (profile) return profile;
  if (name.startsWith('mcp__')) return MCP_TOOL_PROFILE;
  return DEFAULT_TOOL_PROFILE;
}

/** Maximum activeTools entries per session/subagent. Prevents unbounded growth
 *  from pathological tool_use without matching tool_result. */
export const MAX_ACTIVE_TOOLS = 500;

// ── Demotion logic ───────────────────────────────────────────────────

/** Pure function: determine demotion outcome for a session.
 *  Returns 'done', 'waiting', or null (no change). */
export function computeDemotion(
  status: SessionStatus,
  lastActivityMs: number,
  activeToolCount: number,
  hasBlockingSubagents: boolean,
  nowMs: number,
  thresholdMs: number,
  turnStartMs = 0,
  seenOutputInTurn = true,
): SessionStatus | null {
  if (status !== 'running' && status !== 'waiting') return null;

  const age = nowMs - lastActivityMs;

  // Hard ceiling: 3 min for running, 10 min for waiting
  const ceiling = status === 'waiting' ? NEEDS_INPUT_CEILING_MS : HARD_CEILING_MS;
  if (age > ceiling) return 'done';

  // Below ceiling: only demote 'running'
  if (status !== 'running') return null;

  // Turn in progress with no output yet (extended thinking / streaming).
  // Coherence check: turnStartMs must be close to lastActivityMs (within threshold).
  const turnCoherent = turnStartMs > 0 && (turnStartMs - lastActivityMs) < thresholdMs;
  if (turnCoherent && !seenOutputInTurn && activeToolCount === 0 && age <= ceiling) return null;

  if (age > thresholdMs) {
    if (hasBlockingSubagents) return null;
    if (activeToolCount > 0) return 'waiting';
    if (activeToolCount === 0) return 'done';
  }

  return null;
}
