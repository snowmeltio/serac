import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makePermissionTracker,
  PERMISSION_DELAY_MS,
  SLOW_PERMISSION_DELAY_MS,
  TOOL_RECENCY_MS,
} from './permissionTracker.js';
import { HookEventRouter } from '../hookEventRouter.js';

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

describe('PermissionTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires after base delay for a non-slow, non-exempt tool', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeUnknownTool']]) });
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS - 1);
    expect(h.getFired()).toBe(0);
    vi.advanceTimersByTime(2);
    expect(h.getFired()).toBe(1);
  });

  it('fires after slow delay for a slow tool', () => {
    const h = makeHost({ tools: new Map([['tu1', 'Bash']]) });
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);  // past base
    expect(h.getFired()).toBe(0);
    vi.advanceTimersByTime(SLOW_PERMISSION_DELAY_MS - PERMISSION_DELAY_MS);
    expect(h.getFired()).toBe(1);
  });

  it('does not fire for exempt tools (Read)', () => {
    const h = makeHost({ tools: new Map([['tu1', 'Read']]) });
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('does not fire when activeTools is empty', () => {
    const h = makeHost();
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('does not fire if tools cleared before timer expires', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = makePermissionTracker(h.host);
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
    const t = makePermissionTracker(h.host);
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
    const t = makePermissionTracker(h.host);
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
    const t = makePermissionTracker(h.host);
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
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(1);
  });

  // === Lifecycle ===

  it('cancel() clears the timer without firing', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS - 1_000);
    t.cancel();
    vi.advanceTimersByTime(10_000);
    expect(h.getFired()).toBe(0);
  });

  it('dispose() prevents subsequent reschedule from scheduling', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = makePermissionTracker(h.host);
    t.dispose();
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('dispose() is idempotent', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = makePermissionTracker(h.host);
    t.dispose();
    t.dispose();
    expect(h.getFired()).toBe(0);
  });

  it('reschedule() cancels existing timer before scheduling a new one', () => {
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = makePermissionTracker(h.host);
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
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(1);
  });

  it('all-exempt tools: timer does not schedule', () => {
    const h = makeHost({ tools: new Map([['tu1', 'Read'], ['tu2', 'Write']]) });
    const t = makePermissionTracker(h.host);
    t.reschedule();
    vi.advanceTimersByTime(20_000);
    expect(h.getFired()).toBe(0);
  });

  it('MCP tools default to slow delay', () => {
    const h = makeHost({ tools: new Map([['tu1', 'mcp__slack__post_message']]) });
    const t = makePermissionTracker(h.host);
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

describe('PermissionTracker (hook overlay)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const SID = 'session-uuid-hook';

  function setup(initialTools: Map<string, string> = new Map([['tu1', 'SomeTool']])) {
    const router = new HookEventRouter();
    const h = makeHost({ tools: initialTools });
    const t = makePermissionTracker(h.host, { hookRouter: router, sessionId: SID });
    return { router, host: h, tracker: t };
  }

  it('fires immediately on PermissionRequest (no 3-6s wait)', () => {
    const { router, host, tracker } = setup();
    tracker.reschedule();   // timer would fire in 3s
    router.onHookEvent(SID, 'PermissionRequest', { tool_use_id: 'tu1' });
    expect(host.getFired()).toBe(1);  // hook beat the timer
    tracker.dispose();
  });

  it('hook fires fast; timer still fires later as fallback (host idempotency handles it)', () => {
    const { router, host, tracker } = setup();
    tracker.reschedule();
    router.onHookEvent(SID, 'PermissionRequest', { tool_use_id: 'tu1' });
    expect(host.getFired()).toBe(1);
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    // Timer fires too — host's idempotency guard absorbs the duplicate.
    expect(host.getFired()).toBe(2);
    tracker.dispose();
  });

  it('does not fire when hook arrives but activeTools is empty', () => {
    const { router, host, tracker } = setup(new Map());
    router.onHookEvent(SID, 'PermissionRequest', {});
    expect(host.getFired()).toBe(0);
    tracker.dispose();
  });

  it('ignores PermissionRequest for other sessions', () => {
    const { router, host, tracker } = setup();
    tracker.reschedule();
    router.onHookEvent('different-session', 'PermissionRequest', {});
    expect(host.getFired()).toBe(0);
    tracker.dispose();
  });

  it('dispose unsubscribes; later hook events do nothing', () => {
    const { router, host, tracker } = setup();
    tracker.dispose();
    router.onHookEvent(SID, 'PermissionRequest', {});
    expect(host.getFired()).toBe(0);
  });

  it('falls back to timer when no hook arrives (silent-hook fallback path)', () => {
    const { host, tracker } = setup();
    tracker.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(host.getFired()).toBe(1);
    tracker.dispose();
  });

  it('factory without sessionId returns the timer-only variant', () => {
    const router = new HookEventRouter();
    const h = makeHost({ tools: new Map([['tu1', 'SomeTool']]) });
    const t = makePermissionTracker(h.host, { hookRouter: router });   // no sessionId
    router.onHookEvent('any', 'PermissionRequest', {});
    expect(h.getFired()).toBe(0);   // hook variant didn't construct
    t.reschedule();
    vi.advanceTimersByTime(PERMISSION_DELAY_MS + 100);
    expect(h.getFired()).toBe(1);   // timer still works
    t.dispose();
  });

  // === PR-E: parent filters out subagent events; subagent filters by agent_id ===

  it('parent tracker ignores PermissionRequest with agent_id (avoids false bubble)', () => {
    const { router, host, tracker } = setup();
    router.onHookEvent(SID, 'PermissionRequest', { agent_id: 'subagent-xyz' });
    expect(host.getFired()).toBe(0);
    tracker.dispose();
  });

  it('parent tracker fires on PermissionRequest with no agent_id (parent event)', () => {
    const { router, host, tracker } = setup();
    router.onHookEvent(SID, 'PermissionRequest', { /* no agent_id */ });
    expect(host.getFired()).toBe(1);
    tracker.dispose();
  });

  it('subagent tracker fires only when agent_id matches', () => {
    const router = new HookEventRouter();
    const host = makeHost({ tools: new Map([['tu1', 'Bash']]) });
    const tracker = makePermissionTracker(host.host, {
      hookRouter: router, sessionId: SID, agentId: 'subagent-123',
    });

    router.onHookEvent(SID, 'PermissionRequest', { agent_id: 'subagent-123' });
    expect(host.getFired()).toBe(1);

    router.onHookEvent(SID, 'PermissionRequest', { agent_id: 'subagent-OTHER' });
    expect(host.getFired()).toBe(1);   // unchanged

    router.onHookEvent(SID, 'PermissionRequest', { /* no agent_id, parent event */ });
    expect(host.getFired()).toBe(1);   // unchanged

    tracker.dispose();
  });

  it('subagent tracker also has timer fallback (silent-hook path)', () => {
    const router = new HookEventRouter();
    const host = makeHost({ tools: new Map([['tu1', 'Bash']]) });
    const tracker = makePermissionTracker(host.host, {
      hookRouter: router, sessionId: SID, agentId: 'subagent-abc',
    });
    tracker.reschedule();
    vi.advanceTimersByTime(SLOW_PERMISSION_DELAY_MS + 100);
    expect(host.getFired()).toBe(1);
    tracker.dispose();
  });
});
