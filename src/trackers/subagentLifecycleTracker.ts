/**
 * SubagentLifecycleTracker — owns subagent lifecycle signals (spawn / progress
 * / completion) and the targeted-tailer fallback used when progress relay is
 * silent.
 *
 * Spike extraction (Path C / Option B): wrap (do not rewrite) the existing
 * SubagentTailerManager so the lifecycle contract is consumed through a
 * tracker interface. Once hook events are wired in a follow-up PR, the hook
 * variant of this tracker will publish lifecycle transitions from the
 * `SubagentStart` / `SubagentStop` events; the JSONL variant remains the
 * authoritative fallback.
 *
 * Behaviour preserved verbatim from sessionManager.ts:
 *   - onSpawn               → SubagentTailerManager.startSilenceTimer
 *   - onProgress            → SubagentTailerManager.cancelProgressSilence
 *   - onComplete            → SubagentTailerManager.disposeSubagent
 *   - pollDirect            → SubagentTailerManager.poll
 *   - getActiveTailerCount  → SubagentTailerManager.getActiveTailerCount
 *   - disposeAll            → SubagentTailerManager.disposeAll
 *
 * Hook-variant filter rule (future, not implemented here): ignore phantom
 * `SubagentStop` events with `agent_type === ""` — these come from background
 * title-generation subagents (confirmed in spike capture 2026-05-12).
 */

import {
  SubagentTailerManager,
  type SubagentRecordBatch,
  type TailerContext,
} from '../subagentTailerManager.js';
import type { SubagentInfo } from '../types.js';

export type { SubagentRecordBatch } from '../subagentTailerManager.js';

/** Read-only context needed from the parent session. Mirrors TailerContext
 *  so existing callers can pass the same closure shape. */
export type SubagentLifecycleTrackerHost = TailerContext;

export interface SubagentLifecycleTracker {
  /** Subagent spawn detected — start the silence timer that will open a
   *  targeted tailer if no agent_progress arrives in time. */
  onSpawn(subagent: SubagentInfo): void;
  /** agent_progress arrived — cancel silence timer and dispose any open
   *  tailer (progress relay is working). */
  onProgress(subagent: SubagentInfo): void;
  /** Subagent finished — release tailer, silence timer, and agentId. */
  onComplete(subagent: SubagentInfo): void;
  /** Poll all active subagent tailers and return their records grouped by
   *  subagent. Disposes tailers for subagents that are no longer running. */
  pollDirect(subagents: SubagentInfo[]): Promise<SubagentRecordBatch[]>;
  /** Number of subagents currently being tailed directly. */
  getActiveTailerCount(): number;
  /** Dispose all subagent tailer resources. Called on session reset or
   *  disposal. */
  disposeAll(subagents: SubagentInfo[]): void;
}

export class JsonlDerivedSubagentLifecycleTracker implements SubagentLifecycleTracker {
  private readonly mgr: SubagentTailerManager;

  constructor(host: SubagentLifecycleTrackerHost) {
    this.mgr = new SubagentTailerManager(host);
  }

  onSpawn(subagent: SubagentInfo): void {
    this.mgr.startSilenceTimer(subagent);
  }

  onProgress(subagent: SubagentInfo): void {
    this.mgr.cancelProgressSilence(subagent);
  }

  onComplete(subagent: SubagentInfo): void {
    this.mgr.disposeSubagent(subagent);
  }

  pollDirect(subagents: SubagentInfo[]): Promise<SubagentRecordBatch[]> {
    return this.mgr.poll(subagents);
  }

  getActiveTailerCount(): number {
    return this.mgr.getActiveTailerCount();
  }

  disposeAll(subagents: SubagentInfo[]): void {
    this.mgr.disposeAll(subagents);
  }
}

/** Future seam: returns the hook variant when hooks are wired, JSONL-derived
 *  otherwise. For now, always returns the JSONL-derived variant. */
export function makeSubagentLifecycleTracker(
  host: SubagentLifecycleTrackerHost,
): SubagentLifecycleTracker {
  return new JsonlDerivedSubagentLifecycleTracker(host);
}
