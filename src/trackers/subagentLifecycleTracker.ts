/**
 * SubagentLifecycleTracker — owns subagent lifecycle signals (spawn / progress
 * / completion) and the targeted tailers on subagents' own transcripts.
 *
 * The JSONL variant wraps (does not rewrite) the existing
 * SubagentTailerManager. The lifecycle methods delegate as follows:
 *   - onSpawn               → no-op (pollDirect opens the tailer)
 *   - onProgress            → SubagentTailerManager.suppressForProgressRelay
 *   - onComplete            → SubagentTailerManager.disposeTailer (keeps agentId)
 *   - onRevive              → SubagentTailerManager.reopenTailerAt (completion watermark)
 *   - releaseTailer         → SubagentTailerManager.disposeTailer
 *   - pollDirect            → SubagentTailerManager.poll
 *   - needsPoll             → SubagentTailerManager.needsPoll
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
import type { HookEventRouter } from '../hookEventRouter.js';
import type { JsonlTailer } from '../jsonlTailer.js';

export type { SubagentRecordBatch } from '../subagentTailerManager.js';

/** Read-only context needed from the parent session. Mirrors TailerContext
 *  so existing callers can pass the same closure shape. */
export type SubagentLifecycleTrackerHost = TailerContext;

export interface SubagentLifecycleTracker {
  /** Subagent spawn detected. Nothing to arm: the next pollDirect() pairs
   *  the subagent with its transcript and opens a tailer. */
  onSpawn(subagent: SubagentInfo): void;
  /** agent_progress arrived — the legacy relay feeds this subagent, so stop
   *  tailing its file (pollDirect won't reopen it). */
  onProgress(subagent: SubagentInfo): void;
  /** Subagent finished — release its tailer. agentId is PRESERVED
   *  so a completed subagent keeps its rich tracked view (result preview, tool
   *  count) and stays resolvable in the detail-panel drill-in. agentId is only
   *  cleared on full teardown (disposeAll). */
  onComplete(subagent: SubagentInfo): void;
  /** Subagent revived after completing (SendMessage / Agent({resume}) /
   *  growth backstop) — reopen its tailer at the completion watermark
   *  (`completedFileSize`). `preopened` adopts the backstop's own tailer. */
  onRevive(subagent: SubagentInfo, preopened?: JsonlTailer): void;
  /** Release a single subagent's tailer without clearing its agentId. */
  releaseTailer(subagent: SubagentInfo): void;
  /** Open tailers for running subagents that lack one, then poll every open
   *  tailer and return the records grouped by subagent. Disposes tailers for
   *  subagents that are no longer running. */
  pollDirect(subagents: SubagentInfo[]): Promise<SubagentRecordBatch[]>;
  /** Whether pollDirect() has work (an open tailer, or a running subagent
   *  still to be paired and opened). */
  needsPoll(subagents: SubagentInfo[]): boolean;
  /** Number of subagents currently being tailed directly. */
  getActiveTailerCount(): number;
  /** Dispose all subagent tailer resources. Called on session reset or
   *  disposal. */
  disposeAll(subagents: SubagentInfo[]): void;
  /** Release the tracker's own subscriptions (hook variant: the router
   *  registration). Does NOT touch per-subagent tailers — those are released
   *  via disposeAll, which needs the subagents array. Idempotent. */
  dispose(): void;
}

export class JsonlDerivedSubagentLifecycleTracker implements SubagentLifecycleTracker {
  private readonly mgr: SubagentTailerManager;

  constructor(host: SubagentLifecycleTrackerHost) {
    this.mgr = new SubagentTailerManager(host);
  }

  onSpawn(_subagent: SubagentInfo): void { /* pollDirect opens the tailer */ }

  onProgress(subagent: SubagentInfo): void {
    this.mgr.suppressForProgressRelay(subagent);
  }

  onComplete(subagent: SubagentInfo): void {
    // Preserve agentId — only release the tailer. A completed
    // subagent must keep its agentId so its rich snapshot (resultPreview,
    // toolsCompleted) survives and the detail panel can still open its
    // transcript. agentId is nulled only on disposeAll (session teardown).
    this.mgr.disposeTailer(subagent);
  }

  onRevive(subagent: SubagentInfo, preopened?: JsonlTailer): void {
    void this.mgr.reopenTailerAt(subagent, subagent.completedFileSize, preopened);
  }

  releaseTailer(subagent: SubagentInfo): void {
    this.mgr.disposeTailer(subagent);
  }

  pollDirect(subagents: SubagentInfo[]): Promise<SubagentRecordBatch[]> {
    return this.mgr.poll(subagents);
  }

  needsPoll(subagents: SubagentInfo[]): boolean {
    return this.mgr.needsPoll(subagents);
  }

  getActiveTailerCount(): number {
    return this.mgr.getActiveTailerCount();
  }

  disposeAll(subagents: SubagentInfo[]): void {
    this.mgr.disposeAll(subagents);
  }

  dispose(): void { /* no hook subscriptions */ }
}

/**
 * Hook-overlay variant. Composes `JsonlDerivedSubagentLifecycleTracker`
 * as the authoritative fallback and accelerates `onComplete` via
 * `SubagentStop` hook events.
 *
 * Routing (confirmed 2026-05-25 subagent spike):
 *   `SubagentStart` / `SubagentStop` payloads carry `session_id =
 *   <parent>` and `agent_id = <subagent>`. We subscribe by the parent's
 *   session_id and look up the SubagentInfo via `host.getAllSubagents()`,
 *   matching on agentId.
 *
 * Why only SubagentStop is hook-accelerated:
 *   - `SubagentStart` doesn't gain much from hooks. The tailer opens on
 *     the first poll after the spawn is seen; spawn is
 *     normally detected within 1-2 s via `tool_use(Task)` in the JSONL.
 *   - `SubagentStop` is the high-value signal — it lets us tear down a
 *     potentially-open targeted tailer immediately rather than waiting
 *     for the next poll cycle to notice the subagent has disappeared.
 *
 * Phantom-stop filter: the router already drops `SubagentStop` events
 * with `agent_type === ""`; nothing extra needed here.
 */
class HookSubagentLifecycleTracker implements SubagentLifecycleTracker {
  private readonly fallback: JsonlDerivedSubagentLifecycleTracker;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    host: SubagentLifecycleTrackerHost,
    sessionId: string,
    router: HookEventRouter,
  ) {
    this.fallback = new JsonlDerivedSubagentLifecycleTracker(host);
    this.unsubscribe = router.register(sessionId, 'SubagentStop', (event: unknown) => {
      if (this.disposed) { return; }
      if (typeof event !== 'object' || event === null) { return; }
      const agentId = (event as Record<string, unknown>).agent_id;
      if (typeof agentId !== 'string' || agentId.length === 0) { return; }
      const match = host.getAllSubagents().find(s => s.agentId === agentId);
      // A revived agent's earlier SubagentStop can land after the revival
      // (observed 20s+ later); only a running subagent has a tailer to release.
      if (!match || !match.running) { return; }
      this.fallback.onComplete(match);
    });
  }

  onSpawn(subagent: SubagentInfo): void { this.fallback.onSpawn(subagent); }
  onProgress(subagent: SubagentInfo): void { this.fallback.onProgress(subagent); }
  onComplete(subagent: SubagentInfo): void { this.fallback.onComplete(subagent); }
  onRevive(subagent: SubagentInfo, preopened?: JsonlTailer): void { this.fallback.onRevive(subagent, preopened); }
  releaseTailer(subagent: SubagentInfo): void { this.fallback.releaseTailer(subagent); }
  pollDirect(subagents: SubagentInfo[]): Promise<SubagentRecordBatch[]> { return this.fallback.pollDirect(subagents); }
  needsPoll(subagents: SubagentInfo[]): boolean { return this.fallback.needsPoll(subagents); }
  getActiveTailerCount(): number { return this.fallback.getActiveTailerCount(); }
  disposeAll(subagents: SubagentInfo[]): void { this.fallback.disposeAll(subagents); }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.unsubscribe();
    this.fallback.dispose();
  }
}

export interface SubagentLifecycleTrackerFactoryOptions {
  /** Hook router for the owning workspace. */
  hookRouter?: HookEventRouter;
  /** Parent session_id (the same id used everywhere else in the session).
   *  Hook subscription is keyed by this — subagent events ride the
   *  parent's session_id per the 2026-05-25 spike. */
  sessionId?: string;
}

/** Construct the variant appropriate for the current environment.
 *
 *  - hookRouter + sessionId → `HookSubagentLifecycleTracker` (overlay)
 *  - otherwise → `JsonlDerivedSubagentLifecycleTracker` */
export function makeSubagentLifecycleTracker(
  host: SubagentLifecycleTrackerHost,
  opts: SubagentLifecycleTrackerFactoryOptions = {},
): SubagentLifecycleTracker {
  if (opts.hookRouter && opts.sessionId) {
    return new HookSubagentLifecycleTracker(host, opts.sessionId, opts.hookRouter);
  }
  return new JsonlDerivedSubagentLifecycleTracker(host);
}
