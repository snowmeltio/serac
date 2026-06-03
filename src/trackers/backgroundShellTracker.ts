/**
 * BackgroundShellTracker — tracks outstanding backgrounded Bash shells
 * (`Bash` invoked with `run_in_background: true`).
 *
 * SPIKE (2026-06-03). Closes the observed "card shows DONE while a background
 * build is still running" gap. A backgrounded shell returns its `tool_result`
 * immediately ("Command running in background with ID: <id>"), so the turn ends
 * and the idle/`Stop` path correctly marks the session `done` — but real work
 * continues in a detached shell the JSONL stays silent about until the agent
 * retrieves it in a later turn.
 *
 * Strictly **non-status**, same charter as `ToolOutcomeTracker`: it never moves
 * `running`/`waiting`/`done`. It exposes one display-only signal — "this done
 * card has N outstanding background shells" — via a dedicated snapshot field.
 * The status machine is unchanged; `done` still means the turn ended, which is
 * the truth. (Whether to also surface this as a visible badge, or to hold a
 * distinct sub-state, is a deliberate follow-up — see BACKLOG.md.)
 *
 * Detection is string-matched from main-thread `tool_result` text, so it is
 * brittle by nature: the markers are Claude Code surface strings, not a stable
 * API. Two signals, both carried in `tool_result` blocks of user records:
 *   - START:      "Command running in background with ID: <id>"
 *   - COMPLETION: a retrieval result carrying `<task_id><id></task_id>` together
 *                 with a terminal `<status>completed|failed|killed|…</status>`.
 *                 A `<status>running</status>` poll does NOT clear the shell.
 *
 * Hard ceiling: a shell never observed completing is dropped after
 * `BACKGROUND_SHELL_CEILING_MS` (assume abandoned, or we missed the retrieval).
 * This mirrors the status machine's other ceilings so the signal cannot stick
 * on a card forever.
 *
 * No hook variant today (no hook reports background-shell lifecycle); the
 * factory keeps the seam open. No host callbacks — the slice is read, not
 * pushed.
 */

/** Drop an outstanding shell after this long with no observed completion. A
 *  background build/deploy can legitimately run for minutes, so the ceiling is
 *  generous relative to the 3-min running / 10-min waiting status ceilings. */
export const BACKGROUND_SHELL_CEILING_MS = 15 * 60 * 1000;

const START_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/;
const TASK_ID_RE = /<task_id>\s*([A-Za-z0-9_-]+)\s*<\/task_id>/;
const STATUS_RE = /<status>\s*([A-Za-z_]+)\s*<\/status>/;

/** Terminal retrieval states that clear an outstanding shell. Anything else
 *  (notably `running`) is a mid-flight poll and leaves the shell outstanding. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'error', 'timeout', 'cancelled']);

/** Extract the shell id from a launch `tool_result`, or null if not a launch. */
export function parseBackgroundStart(text: string): string | null {
  const m = START_RE.exec(text);
  return m ? m[1] : null;
}

/** Extract the shell id from a terminal retrieval `tool_result`, or null if the
 *  text is not a retrieval or reports a non-terminal (e.g. `running`) status. */
export function parseBackgroundCompletion(text: string): string | null {
  const idMatch = TASK_ID_RE.exec(text);
  if (!idMatch) { return null; }
  const statusMatch = STATUS_RE.exec(text);
  if (!statusMatch || !TERMINAL_STATUSES.has(statusMatch[1].toLowerCase())) { return null; }
  return idMatch[1];
}

export interface BackgroundShellTracker {
  /** Feed every main-thread `tool_result`'s text. Idempotent per shell id:
   *  re-seeing a launch does not reset its start time, and an unknown
   *  completion id is a harmless no-op (covers `local_agent` task retrievals
   *  that share the `<task_id>` shape but were never tracked as shells). */
  noteToolResult(text: string, now: number): void;
  /** Drop shells launched more than `ceilingMs` ago — abandoned, or we missed
   *  the completion retrieval. Call on the poll cadence with a monotonic-ish
   *  `now` (the demote path already has one). */
  prune(now: number, ceilingMs: number): void;
  /** True when at least one background shell is still outstanding. */
  hasOutstanding(): boolean;
  /** Outstanding shell ids, launch-order. For display/debugging. */
  outstandingIds(): string[];
  /** Count of outstanding shells (snapshot enrichment field). */
  count(): number;
  /** Clear all state (JSONL truncation / compaction reset). */
  reset(): void;
  dispose(): void;
}

class JsonlBackgroundShellTracker implements BackgroundShellTracker {
  /** shell id → launch timestamp (ms). Insertion order = launch order. */
  private readonly startedAt = new Map<string, number>();

  noteToolResult(text: string, now: number): void {
    if (!text) { return; }
    // A retrieval result and a fresh launch are distinct tool_results in
    // practice; handle completion first and return, so an output that happens
    // to echo the launch banner can't re-add a just-finished shell.
    const completed = parseBackgroundCompletion(text);
    if (completed) { this.startedAt.delete(completed); return; }
    const started = parseBackgroundStart(text);
    if (started && !this.startedAt.has(started)) { this.startedAt.set(started, now); }
  }

  prune(now: number, ceilingMs: number): void {
    for (const [id, startedAt] of this.startedAt) {
      if (now - startedAt > ceilingMs) { this.startedAt.delete(id); }
    }
  }

  hasOutstanding(): boolean { return this.startedAt.size > 0; }
  outstandingIds(): string[] { return [...this.startedAt.keys()]; }
  count(): number { return this.startedAt.size; }
  reset(): void { this.startedAt.clear(); }
  dispose(): void { this.startedAt.clear(); }
}

export function makeBackgroundShellTracker(): BackgroundShellTracker {
  return new JsonlBackgroundShellTracker();
}
