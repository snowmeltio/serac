/**
 * SessionLoopTracker — tracks loop/wakeup orchestration state so a card can
 * answer "is this session finished, or just sleeping?".
 *
 * Strictly **non-status** (same charter as `BackgroundShellTracker`): never
 * moves `running`/`waiting`/`done`. Two display-only signals:
 *
 *  - **Pending wakeup** (`ScheduleWakeup`, the /loop dynamic-pacing mode): the
 *    tool input carries `delaySeconds` + `reason`; the harness re-fires the
 *    prompt at scheduledAt + delay. The signal self-expires (a wakeup past its
 *    fire time is either firing right now or the process is gone), and any
 *    genuine user-text turn after scheduling clears it (fired early via
 *    task-notification, or the user interrupted).
 *  - **Session crons** (`CronCreate`/`CronDelete`, the /loop interval mode and
 *    one-shot reminders): counted from tool_use inputs; a CronDelete whose id
 *    was seen in a CronCreate result clears that entry. Recurring jobs
 *    auto-expire server-side after 7 days, so entries also carry a creation
 *    ceiling. One-shot fire times are NOT computed (no cron parser by design);
 *    a fired one-shot lingers until delete/death/ceiling — acceptable for a
 *    display chip.
 *
 * Hook enrichment: when the hook stream is live, every `Stop` payload carries
 * `session_crons` (ground truth at each turn end, CC ≥2.1.159 — see
 * all-hook-events-2026-06-10.jsonl). A Stop with an empty list clears the
 * JSONL-inferred entries; a populated list pins the count. Shape-lenient: only
 * the array length is required, `cron`/`id` fields are used when present.
 */
import type { HookEventRouter } from '../hookEventRouter.js';

/** Drop a cron entry this long after creation — mirrors the server-side 7-day
 *  auto-expiry of recurring jobs, so an unobserved delete can't stick forever. */
export const SESSION_CRON_CEILING_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap stored cron entries (a runaway create loop is a display bug, not a leak). */
const MAX_CRONS = 50;
const MAX_REASON_LEN = 200;
const MAX_LABEL_LEN = 100;

export interface PendingWakeup {
  /** Epoch ms the wakeup is due to fire. */
  fireAt: number;
  /** The agent's stated reason (capped), '' when absent. */
  reason: string;
}

interface CronEntry {
  /** Cron expression from the CronCreate input (display label). */
  cron: string;
  createdAt: number;
  /** Job id parsed from the result text, when recognisable. */
  jobId?: string;
}

export interface SessionLoopTracker {
  /** Feed every main-thread `tool_use` (name + input + record timestamp). */
  noteToolUse(name: string, toolUseId: string, input: unknown, at: number): void;
  /** Feed every main-thread `tool_result` (pairs CronCreate results to ids). */
  noteToolResult(toolUseId: string, text: string): void;
  /** Feed genuine user-text turns (NOT tool_results) — clears a pending wakeup
   *  scheduled before this turn (it fired, or the user interrupted). */
  noteUserTurn(at: number): void;
  /** The pending wakeup, or null when none / already past its fire time. */
  pendingWakeup(now: number): PendingWakeup | null;
  /** Count of believed-live session crons (after the creation ceiling). */
  cronCount(now: number): number;
  /** Display label: cron expressions, capped, oldest first. */
  cronLabels(now: number): string[];
  /** Clear everything — registry-confirmed process death (a dead session has
   *  no scheduler), or JSONL truncation reset. */
  clearAll(): void;
  dispose(): void;
}

export function makeSessionLoopTracker(
  opts: { hookRouter?: HookEventRouter; sessionId?: string } = {},
): SessionLoopTracker {
  return new JsonlSessionLoopTracker(opts.hookRouter, opts.sessionId);
}

class JsonlSessionLoopTracker implements SessionLoopTracker {
  private wakeup: { scheduledAt: number; fireAt: number; reason: string } | null = null;
  /** tool_use_id → entry (insertion order = creation order). */
  private readonly crons = new Map<string, CronEntry>();
  /** Parsed result job id → tool_use_id, for CronDelete pairing. */
  private readonly jobIndex = new Map<string, string>();
  private readonly unsubscribe: (() => void) | null = null;

  constructor(router?: HookEventRouter, sessionId?: string) {
    if (router && sessionId) {
      // Stop payloads carry session_crons — ground truth at every turn end.
      this.unsubscribe = router.register(sessionId, 'Stop', (event: unknown) => {
        if (typeof event !== 'object' || event === null) { return; }
        const crons = (event as Record<string, unknown>).session_crons;
        if (Array.isArray(crons)) { this.applyAuthoritativeCrons(crons); }
      });
    }
  }

  noteToolUse(name: string, toolUseId: string, input: unknown, at: number): void {
    const inp = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
    if (name === 'ScheduleWakeup') {
      const delay = inp.delaySeconds;
      if (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0) { return; }
      this.wakeup = {
        scheduledAt: at,
        fireAt: at + delay * 1000,
        reason: typeof inp.reason === 'string' ? inp.reason.slice(0, MAX_REASON_LEN) : '',
      };
    } else if (name === 'CronCreate') {
      if (this.crons.size >= MAX_CRONS) { return; }
      this.crons.set(toolUseId, {
        cron: typeof inp.cron === 'string' ? inp.cron.slice(0, MAX_LABEL_LEN) : '?',
        createdAt: at,
      });
    } else if (name === 'CronDelete') {
      const id = inp.id;
      if (typeof id !== 'string') { return; }
      const owner = this.jobIndex.get(id);
      if (owner) { this.crons.delete(owner); this.jobIndex.delete(id); }
    }
  }

  noteToolResult(toolUseId: string, text: string): void {
    const entry = this.crons.get(toolUseId);
    if (!entry || entry.jobId || !text) { return; }
    // The CronCreate result carries a job id in an unspecified surface format.
    // Index every plausible token — CronDelete's input.id names one of them
    // exactly, so over-indexing is harmless and under-indexing only means the
    // entry waits for the ceiling/death clear instead.
    for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]{5,63}/g)) {
      if (!this.jobIndex.has(m[0])) { this.jobIndex.set(m[0], toolUseId); }
    }
    entry.jobId = 'indexed';
  }

  noteUserTurn(at: number): void {
    if (this.wakeup && at > this.wakeup.scheduledAt) { this.wakeup = null; }
  }

  pendingWakeup(now: number): PendingWakeup | null {
    if (!this.wakeup || this.wakeup.fireAt <= now) { return null; }
    return { fireAt: this.wakeup.fireAt, reason: this.wakeup.reason };
  }

  cronCount(now: number): number {
    this.pruneCrons(now);
    return this.crons.size;
  }

  cronLabels(now: number): string[] {
    this.pruneCrons(now);
    return [...this.crons.values()].slice(0, 5).map(c => c.cron);
  }

  clearAll(): void {
    this.wakeup = null;
    this.crons.clear();
    this.jobIndex.clear();
  }

  dispose(): void {
    this.clearAll();
    this.unsubscribe?.();
  }

  /** A Stop payload's session_crons is authoritative: empty clears, populated
   *  replaces (count from the array; labels from `cron` fields when present). */
  private applyAuthoritativeCrons(crons: unknown[]): void {
    this.crons.clear();
    this.jobIndex.clear();
    const now = Date.now();
    let i = 0;
    for (const c of crons.slice(0, MAX_CRONS)) {
      const rec = (c && typeof c === 'object') ? c as Record<string, unknown> : {};
      const key = typeof rec.id === 'string' ? rec.id : 'stop-cron-' + i;
      this.crons.set(key, {
        cron: typeof rec.cron === 'string' ? rec.cron.slice(0, MAX_LABEL_LEN) : '?',
        createdAt: now,
      });
      if (typeof rec.id === 'string') { this.jobIndex.set(rec.id, key); }
      i++;
    }
  }

  private pruneCrons(now: number): void {
    for (const [key, entry] of this.crons) {
      if (now - entry.createdAt > SESSION_CRON_CEILING_MS) { this.crons.delete(key); }
    }
  }
}
