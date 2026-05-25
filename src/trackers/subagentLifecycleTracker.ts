/**
 * SubagentLifecycleTracker — owns subagent lifecycle signals (spawn / progress
 * / completion) and the targeted-tailer fallback used when progress relay is
 * silent.
 *
 * The JSONL variant wraps (does not rewrite) the existing
 * SubagentTailerManager. The lifecycle methods delegate as follows:
 *   - onSpawn               → SubagentTailerManager.startSilenceTimer
 *   - onProgress            → SubagentTailerManager.cancelProgressSilence
 *   - onComplete            → SubagentTailerManager.disposeSubagent
 *   - pollDirect            → SubagentTailerManager.poll
 *   - getActiveTailerCount  → SubagentTailerManager.getActiveTailerCount
 *   - disposeAll            → SubagentTailerManager.disposeAll
 *
 * The hook variant (Phase 4) publishes lifecycle transitions from
 * `SubagentStart` / `SubagentStop` events; the JSONL variant remains the
 * authoritative fallback.
 *
 * Hook-variant filter rule (Phase 4, not implemented here): ignore phantom
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

/** Construct the variant appropriate for the current environment.
 *
 *  Today: always returns `JsonlDerivedSubagentLifecycleTracker`, which wraps
 *  the existing `SubagentTailerManager`.
 *
 *  Why the factory exists *before* a second variant does: Phase 4 will
 *  introduce `HookSubagentLifecycleTracker`, driven by Claude Code's
 *  `SubagentStart` / `SubagentStop` events. When that lands, the factory's
 *  body grows a feature-flag branch; the single call site at the
 *  SessionManager constructor remains unchanged. */
export function makeSubagentLifecycleTracker(
  host: SubagentLifecycleTrackerHost,
): SubagentLifecycleTracker {
  return new JsonlDerivedSubagentLifecycleTracker(host);
}
