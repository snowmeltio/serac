import { describe, it, expect } from 'vitest';
import { HookEventRouter } from './hookEventRouter.js';

describe('HookEventRouter', () => {
  it('delivers an event to a subscriber registered before the event', () => {
    const r = new HookEventRouter();
    const received: unknown[] = [];
    r.register('sess-1', 'PermissionRequest', e => received.push(e));
    r.onHookEvent('sess-1', 'PermissionRequest', { tool: 'Bash' });
    expect(received).toEqual([{ tool: 'Bash' }]);
  });

  it('does not deliver to subscribers on other sessions or event types', () => {
    const r = new HookEventRouter();
    const a: unknown[] = [];
    const b: unknown[] = [];
    r.register('sess-1', 'PermissionRequest', e => a.push(e));
    r.register('sess-2', 'PermissionRequest', e => b.push(e));
    r.onHookEvent('sess-1', 'PermissionRequest', 1);
    r.onHookEvent('sess-2', 'PermissionRequest', 2);
    r.onHookEvent('sess-1', 'PreToolUse', 'ignored');
    expect(a).toEqual([1]);
    expect(b).toEqual([2]);
  });

  it('fans out to multiple subscribers for the same key', () => {
    const r = new HookEventRouter();
    const a: number[] = [];
    const b: number[] = [];
    r.register('s', 'E', e => a.push(e as number));
    r.register('s', 'E', e => b.push(e as number));
    r.onHookEvent('s', 'E', 7);
    expect(a).toEqual([7]);
    expect(b).toEqual([7]);
  });

  it('buffers events that arrive before a subscriber registers, then replays', () => {
    const r = new HookEventRouter();
    r.onHookEvent('s', 'E', 'first');
    r.onHookEvent('s', 'E', 'second');
    expect(r.getBufferedCount('s')).toBe(2);

    const received: unknown[] = [];
    r.register('s', 'E', e => received.push(e));
    expect(received).toEqual(['first', 'second']);
    expect(r.getBufferedCount('s')).toBe(0);
  });

  it('only replays buffered events matching the subscriber event type', () => {
    const r = new HookEventRouter();
    r.onHookEvent('s', 'E1', 'a');
    r.onHookEvent('s', 'E2', 'b');
    const received: unknown[] = [];
    r.register('s', 'E1', e => received.push(e));
    expect(received).toEqual(['a']);
    expect(r.getBufferedCount('s')).toBe(1);
  });

  it('expires buffered events past TTL', () => {
    let clock = 1_000_000;
    const r = new HookEventRouter({ bufferTtlMs: 100, now: () => clock });
    r.onHookEvent('s', 'E', 'old');
    clock += 200;
    expect(r.getBufferedCount('s')).toBe(0);

    const received: unknown[] = [];
    r.register('s', 'E', e => received.push(e));
    expect(received).toEqual([]);
  });

  it('unregister stops further deliveries', () => {
    const r = new HookEventRouter();
    const received: unknown[] = [];
    const cb = (e: unknown) => received.push(e);
    const off = r.register('s', 'E', cb);
    r.onHookEvent('s', 'E', 1);
    off();
    r.onHookEvent('s', 'E', 2);
    expect(received).toEqual([1]);
  });

  it('drops phantom SubagentStop with agent_type === ""', () => {
    const r = new HookEventRouter();
    const received: unknown[] = [];
    r.register('s', 'SubagentStop', e => received.push(e));
    r.onHookEvent('s', 'SubagentStop', { agent_type: '', session_id: 'x' });
    r.onHookEvent('s', 'SubagentStop', { agent_type: 'general-purpose' });
    expect(received).toEqual([{ agent_type: 'general-purpose' }]);
  });

  it('survives throwing subscriber callbacks (errors isolated)', () => {
    const r = new HookEventRouter();
    const received: number[] = [];
    r.register('s', 'E', () => { throw new Error('boom'); });
    r.register('s', 'E', e => received.push(e as number));
    r.onHookEvent('s', 'E', 42);
    expect(received).toEqual([42]);
  });

  it('dispose makes the router inert', () => {
    const r = new HookEventRouter();
    const received: unknown[] = [];
    r.register('s', 'E', e => received.push(e));
    r.dispose();
    r.onHookEvent('s', 'E', 1);
    expect(received).toEqual([]);
    // Re-register after dispose returns a no-op unsubscribe; nothing fires.
    const off = r.register('s', 'E', e => received.push(e));
    r.onHookEvent('s', 'E', 2);
    expect(received).toEqual([]);
    off();
  });

  // === PR-E: debug observer ===

  it('debug observer fires once per routed event (after phantom filter)', () => {
    const r = new HookEventRouter();
    const observed: Array<{ sessionId: string; eventType: string; event: unknown }> = [];
    r.setDebugObserver((sessionId, eventType, event) => observed.push({ sessionId, eventType, event }));
    r.onHookEvent('s1', 'PreToolUse', { tool: 'Bash' });
    r.onHookEvent('s1', 'PermissionRequest', { tool_use_id: 'tu1' });
    expect(observed).toHaveLength(2);
    expect(observed[0].eventType).toBe('PreToolUse');
    expect(observed[1].eventType).toBe('PermissionRequest');
  });

  it('debug observer does not fire for phantom SubagentStop', () => {
    const r = new HookEventRouter();
    let fired = 0;
    r.setDebugObserver(() => { fired++; });
    r.onHookEvent('s', 'SubagentStop', { agent_type: '' });  // phantom
    expect(fired).toBe(0);
    r.onHookEvent('s', 'SubagentStop', { agent_type: 'general-purpose' });
    expect(fired).toBe(1);
  });

  it('debug observer errors are isolated — routing still proceeds', () => {
    const r = new HookEventRouter();
    r.setDebugObserver(() => { throw new Error('boom'); });
    const received: unknown[] = [];
    r.register('s', 'E', e => received.push(e));
    r.onHookEvent('s', 'E', { x: 1 });
    expect(received).toEqual([{ x: 1 }]);
  });

  it('setDebugObserver(undefined) clears the observer', () => {
    const r = new HookEventRouter();
    let fired = 0;
    r.setDebugObserver(() => { fired++; });
    r.onHookEvent('s', 'E', null);
    expect(fired).toBe(1);
    r.setDebugObserver(undefined);
    r.onHookEvent('s', 'E', null);
    expect(fired).toBe(1);   // unchanged
  });

  it('debug observer fires for events that have no matching subscriber too', () => {
    const r = new HookEventRouter();
    let fired = 0;
    r.setDebugObserver(() => { fired++; });
    r.onHookEvent('no-subscriber', 'E', {});
    expect(fired).toBe(1);
  });

  it('caps distinct buffered sessions, evicting the stalest (audit security-sideeffects-1)', () => {
    let clock = 0;
    const r = new HookEventRouter({ bufferTtlMs: 1_000_000, now: () => clock });
    // Fill well past the 64-session cap; each session a little newer.
    for (let i = 0; i < 200; i++) {
      clock = i;
      r.onHookEvent(`sess-${i}`, 'E', { i });
    }
    // The earliest sessions were evicted; the newest survive.
    expect(r.getBufferedCount('sess-0')).toBe(0);
    expect(r.getBufferedCount('sess-199')).toBe(1);
    // Bound holds: at most 64 sessions retain a buffer.
    let retained = 0;
    for (let i = 0; i < 200; i++) {
      if (r.getBufferedCount(`sess-${i}`) > 0) { retained++; }
    }
    expect(retained).toBeLessThanOrEqual(64);
  });

  it('cap insert sweeps expired buffers before evicting live ones', () => {
    let clock = 0;
    const r = new HookEventRouter({ bufferTtlMs: 100, now: () => clock });
    for (let i = 0; i < 64; i++) {
      r.onHookEvent(`old-${i}`, 'E', { i });
    }
    clock = 10_000; // all of the above are now expired
    r.onHookEvent('fresh', 'E', {});
    expect(r.getBufferedCount('fresh')).toBe(1);
    expect(r.getBufferedCount('old-0')).toBe(0);
  });
});
