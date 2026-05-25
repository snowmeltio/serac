/**
 * CompactBoundaryTracker — owns "compaction is happening" signals for a session.
 *
 * JSONL variant fires on `system.subtype === 'compact_boundary'` records.
 * The hook variant (Phase 4) will fire on `SessionStart(source: "compact")`
 * events — confirmed in spike capture 2026-05-12 that `/compact` keeps
 * session_id and transcript_path stable and emits exactly this event.
 *
 * Effect on the host:
 *   - If status is not 'running', set it to running.
 *   - Append "Compacting context" to the activity line.
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

/** Construct the variant appropriate for the current environment.
 *
 *  Today: always returns `JsonlDerivedCompactBoundaryTracker`, which fires on
 *  `system.subtype === 'compact_boundary'` records in the JSONL stream.
 *
 *  Why the factory exists *before* a second variant does: Phase 4 will
 *  introduce a hook variant fed by `SessionStart(source: "compact")`
 *  events — confirmed in spike capture 2026-05-12 that `/compact` keeps
 *  session_id stable and emits this event. When that lands, the factory's
 *  body grows a feature-flag branch; the call site remains unchanged. */
export function makeCompactBoundaryTracker(
  host: CompactBoundaryTrackerHost,
): CompactBoundaryTracker {
  return new JsonlDerivedCompactBoundaryTracker(host);
}
