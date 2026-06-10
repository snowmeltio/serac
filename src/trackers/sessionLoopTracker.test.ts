import { describe, it, expect } from 'vitest';
import { makeSessionLoopTracker, SESSION_CRON_CEILING_MS } from './sessionLoopTracker.js';
import { HookEventRouter } from '../hookEventRouter.js';

const T0 = 1_780_000_000_000;

describe('SessionLoopTracker — pending wakeup (ScheduleWakeup)', () => {
  it('exposes the wakeup until its fire time, then self-expires', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('ScheduleWakeup', 'tu1', { delaySeconds: 240, reason: 'waiting on CI', prompt: 'continue' }, T0);
    expect(t.pendingWakeup(T0 + 1000)).toEqual({ fireAt: T0 + 240_000, reason: 'waiting on CI' });
    expect(t.pendingWakeup(T0 + 240_000)).toBeNull(); // at/past fire time
  });

  it('a genuine user turn after scheduling clears it (fired or interrupted)', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('ScheduleWakeup', 'tu1', { delaySeconds: 600 }, T0);
    t.noteUserTurn(T0 + 30_000);
    expect(t.pendingWakeup(T0 + 31_000)).toBeNull();
  });

  it('a user turn BEFORE scheduling does not clear (replay order safety)', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('ScheduleWakeup', 'tu1', { delaySeconds: 600 }, T0);
    t.noteUserTurn(T0 - 5_000);
    expect(t.pendingWakeup(T0 + 1000)).not.toBeNull();
  });

  it('a later ScheduleWakeup replaces the earlier one; bad delays are ignored', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('ScheduleWakeup', 'tu1', { delaySeconds: 240 }, T0);
    t.noteToolUse('ScheduleWakeup', 'tu2', { delaySeconds: 1200, reason: 'second' }, T0 + 250_000);
    expect(t.pendingWakeup(T0 + 251_000)).toEqual({ fireAt: T0 + 250_000 + 1_200_000, reason: 'second' });
    t.noteToolUse('ScheduleWakeup', 'tu3', { delaySeconds: -5 }, T0 + 300_000);
    t.noteToolUse('ScheduleWakeup', 'tu4', { delaySeconds: 'soon' }, T0 + 300_000);
    expect(t.pendingWakeup(T0 + 301_000)).toEqual({ fireAt: T0 + 250_000 + 1_200_000, reason: 'second' }); // unchanged
  });
});

describe('SessionLoopTracker — session crons (CronCreate/CronDelete)', () => {
  it('counts creates and labels them by cron expression', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('CronCreate', 'tu1', { cron: '*/5 * * * *', prompt: 'check' }, T0);
    t.noteToolUse('CronCreate', 'tu2', { cron: '7 * * * *', prompt: 'hourly' }, T0);
    expect(t.cronCount(T0 + 1000)).toBe(2);
    expect(t.cronLabels(T0 + 1000)).toEqual(['*/5 * * * *', '7 * * * *']);
  });

  it('CronDelete clears the entry via the job id seen in the create result', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('CronCreate', 'tu1', { cron: '*/5 * * * *', prompt: 'p' }, T0);
    t.noteToolResult('tu1', 'Scheduled job cron_abc123 — every 5 minutes (expires in 7 days).');
    t.noteToolUse('CronDelete', 'tu9', { id: 'cron_abc123' }, T0 + 60_000);
    expect(t.cronCount(T0 + 61_000)).toBe(0);
  });

  it('an unrecognised delete id leaves the entry (ceiling will prune)', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('CronCreate', 'tu1', { cron: '7 * * * *', prompt: 'p' }, T0);
    t.noteToolUse('CronDelete', 'tu9', { id: 'never-seen' }, T0 + 1000);
    expect(t.cronCount(T0 + 2000)).toBe(1);
    expect(t.cronCount(T0 + SESSION_CRON_CEILING_MS + 1)).toBe(0); // 7-day ceiling
  });

  it('clearAll drops everything (registry-confirmed death)', () => {
    const t = makeSessionLoopTracker();
    t.noteToolUse('ScheduleWakeup', 'tu1', { delaySeconds: 600 }, T0);
    t.noteToolUse('CronCreate', 'tu2', { cron: '7 * * * *', prompt: 'p' }, T0);
    t.clearAll();
    expect(t.pendingWakeup(T0 + 1000)).toBeNull();
    expect(t.cronCount(T0 + 1000)).toBe(0);
  });
});

describe('SessionLoopTracker — Stop hook session_crons is authoritative', () => {
  const SID = 'sess-loop';
  function viaStop(crons: unknown[]): ReturnType<typeof makeSessionLoopTracker> {
    const router = new HookEventRouter();
    const t = makeSessionLoopTracker({ hookRouter: router, sessionId: SID });
    router.onHookEvent(SID, 'Stop', { hook_event_name: 'Stop', stop_hook_active: false, session_crons: crons });
    return t;
  }

  it('an empty list clears JSONL-inferred entries (turn-end ground truth)', () => {
    const router = new HookEventRouter();
    const t = makeSessionLoopTracker({ hookRouter: router, sessionId: SID });
    t.noteToolUse('CronCreate', 'tu1', { cron: '7 * * * *', prompt: 'p' }, T0);
    router.onHookEvent(SID, 'Stop', { hook_event_name: 'Stop', session_crons: [] });
    expect(t.cronCount(T0 + 1000)).toBe(0);
  });

  it('a populated list pins count and labels (shape-lenient)', () => {
    const t = viaStop([
      { id: 'cron_1', cron: '*/5 * * * *' },
      { unexpected: 'shape' },
    ]);
    expect(t.cronCount(Date.now())).toBe(2);
    expect(t.cronLabels(Date.now())).toEqual(['*/5 * * * *', '?']);
  });

  it('a delete by Stop-reported id works after the authoritative replace', () => {
    const t = viaStop([{ id: 'cron_9', cron: '7 * * * *' }]);
    t.noteToolUse('CronDelete', 'tu1', { id: 'cron_9' }, Date.now());
    expect(t.cronCount(Date.now())).toBe(0);
  });

  it('a malformed payload (no array) is ignored', () => {
    const router = new HookEventRouter();
    const t = makeSessionLoopTracker({ hookRouter: router, sessionId: SID });
    t.noteToolUse('CronCreate', 'tu1', { cron: '7 * * * *', prompt: 'p' }, T0);
    router.onHookEvent(SID, 'Stop', { hook_event_name: 'Stop', session_crons: 'nope' });
    expect(t.cronCount(T0 + 1000)).toBe(1);
  });
});
