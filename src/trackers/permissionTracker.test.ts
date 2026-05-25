import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TimerPermissionTracker,
  makePermissionTracker,
  PERMISSION_DELAY_MS,
  SLOW_PERMISSION_DELAY_MS,
  TOOL_RECENCY_MS,
} from './permissionTracker.js';

function makeHost(opts: {
  tools?: Map<string, string>;
  lastToolResultAt?: number;
} = {}) {
  const tools = opts.tools ?? new Map<string, string>();
  let lastToolResultAt = opts.lastToolResultAt ?? 0;
  let fired = 0;
  return {
    tools,
    setLastToolResultAt(ms: number) { lastToolResultAt = ms; },
    getFired() { return fired; },
    host: {
      getActiveTools: () => tools,
      getLastToolResultAt: () => lastToolResultAt,
      onWaitingFired: () => { fired++; },
    },
  };
}

describe('TimerPermissionTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires after base delay for a non-slow, non-exempt tool', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeUnknownTool']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS - 1);
    expect(h.getFired()).toBe(0);
    vi.advanceTimersByTime(2);
    expect(h.getFired()).toBe(1);
  });

  it('fires after slow delay for a slow tool', () => {
    const h = makeHost({ tools: new Map([['tu1', 'Bash']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);  // past base
    expect(h.getFired()).toBe(0);
    vi.advanceTimersByTime(SLOW_PERMISSION_DELAY_MS - PERMISSION_DELAY_MS);
    expect(h.getFired()).toBe(1);
  });

  it('does not fire for exempt tools (Read)', () => {
    const h = makeHost({ tools: new Map([['tu1', 'Read']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('does not fire when activeTools is empty', () => {
    const h = makeHost();
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('does not fire if tools cleared before timer expires', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS - 500);
    h.tools.clear();   // simulate tool_result arriving
    vi.advanceTimersByTime(1_000);
    expect(h.getFired()).toBe(0);
  });

  // === Recency-window doubling (the previously-untested path) ===

  it('doubles delay when a tool_result arrived within TOOL_RECENCY_MS (non-slow)', () => {
    const h = makeHost({
      tools: new Map([['tu2', 'SomeTool']]),
      lastToolResultAt: Date.now() - 1_000,  // 1s ago, within 3s window
    });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    // Should NOT fire at base delay
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(0);
    // SHOULD fire at doubled delay
    vi.advanceTimersByTime(PERMISSION_DELAY_MS);  // total 2x base
    expect(h.getFired()).toBe(1);
  });

  it('doubles delay for slow tools when recency window is active', () => {
    const h = makeHost({
      tools: new Map([['tu2', 'Bash']]),
      lastToolResultAt: Date.now() - 1_000,
    });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    // Should NOT fire at slow delay (6s)
    vi.advanceTimersByTime(SLOW_PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(0);
    // SHOULD fire at doubled slow delay (12s)
    vi.advanceTimersByTime(SLOW_PERMISSION_DELAY_MS);
    expect(h.getFired()).toBe(1);
  });

  it('does NOT double delay when last tool_result is outside recency window', () => {
    const h = makeHost({
      tools: new Map([['tu1', 'SomeTool']]),
      lastToolResultAt: Date.now() - (TOOL_RECENCY_MS + 1_000),  // outside window
    });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    // Should fire at base delay, no doubling
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(1);
  });

  it('does NOT double delay when lastToolResultAt is 0 (no result yet)', () => {
    const h = makeHost({
      tools: new Map([['tu1', 'SomeTool']]),
      lastToolResultAt: 0,
    });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(1);
  });

  // === Lifecycle ===

  it('cancel() clears the timer without firing', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS - 1_000);
    t.cancel();
    vi.advanceTimersByTime(10_000);
    expect(h.getFired()).toBe(0);
  });

  it('dispose() prevents subsequent reschedule from scheduling', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = new TimerPermissionTracker(h.host);
    t.dispose();
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('dispose() is idempotent', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = new TimerPermissionTracker(h.host);
    t.dispose();
    t.dispose();
    expect(h.getFired()).toBe(0);
  });

  it('reschedule() cancels existing timer before scheduling a new one', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS - 1_000);
    // Add another tool; reschedule starts the timer from zero
    h.tools.set('tu2', 'AnotherTool');
    t.reschedule();
    vi.advanceTimersByTime(1_500);
    expect(h.getFired()).toBe(0);   // would have fired if not reset
    vi.advanceTimersByTime(PERMISSION_DELAY_MS);
    expect(h.getFired()).toBe(1);
  });

  it('mixed exempt + non-exempt tools: timer schedules on the non-exempt one', () => {
    const h = makeHost({ tools: new Map([['tu1', 'Read'], ['tu2', 'SomeTool']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(1);
  });

  it('all-exempt tools: timer does not schedule', () => {
    const h = makeHost({ tools: new Map([['tu1', 'Read'], ['tu2', 'Write']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('MCP tools default to slow delay', () => {
    const h = makeHost({ tools: new Map([['tu1', 'mcp__slack__post_message']]) });
    const t = new TimerPermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(0);
    vi.advanceTimersByTime(SLOW_PERMISSION_DELAY_MS - PERMISSION_DELAY_MS);
    expect(h.getFired()).toBe(1);
  });

  it('factory returns a working timer tracker', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(1);
  });
});
