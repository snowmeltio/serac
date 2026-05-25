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
});
