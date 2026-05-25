/**
 * CompactBoundaryTracker — owns "compaction is happening" signals for a session.
 *
 * Spike extraction (Path C / Option B): the JSONL variant fires on
 * `system.subtype === 'compact_boundary'`. The hook variant (future PR) will
 * fire on `SessionStart(source: "compact")` events from Claude Code hooks
 * — confirmed in spike capture 2026-05-12 that `/compact` keeps session_id
 * and transcript_path stable and emits exactly this event.
 *
 * Behaviour preserved verbatim from sessionManager.ts:840-846:
 *   - If status is not 'running', set it to running
 *   - Append "Compacting context" to the activity line
 *
 * State: `lastCompactAt` (ms) — populated for future use (panel display,
 * debouncing repeated compact events, hook/JSONL reconciliation). Current
 * production code does not consume it.
 */

export interface CompactBoundaryTrackerHost {
  /** Compact boundary detected — host applies its side effects (status,
   *  activity line). Called once per onCompactBoundary() call. */
  onCompactDetected(): void;
}

export interface CompactBoundaryTracker {
  /** A compact boundary has been observed at `timestampMs`. */
  onCompactBoundary(timestampMs: number): void;
  /** Timestamp (ms) of the most recent compact boundary. 0 if never. */
  getLastCompactAt(): number;
  /** Stop the tracker. Idempotent. */
  dispose(): void;
}

export class JsonlDerivedCompactBoundaryTracker implements CompactBoundaryTracker {
  private lastCompactAt = 0;

  constructor(private readonly host: CompactBoundaryTrackerHost) {}

  onCompactBoundary(timestampMs: number): void {
    this.lastCompactAt = timestampMs;
    this.host.onCompactDetected();
  }

  getLastCompactAt(): number { return this.lastCompactAt; }

  dispose(): void { /* no resources */ }
}

/** Future seam: returns the hook variant when hooks are wired, JSONL-derived
 *  otherwise. For now, always returns the JSONL-derived variant. */
export function makeCompactBoundaryTracker(
  host: CompactBoundaryTrackerHost,
): CompactBoundaryTracker {
  return new JsonlDerivedCompactBoundaryTracker(host);
}
