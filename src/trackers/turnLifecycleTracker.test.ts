import { describe, it, expect, vi } from 'vitest';
import { HookEventRouter } from '../hookEventRouter.js';
import { makeTurnLifecycleTracker } from './turnLifecycleTracker.js';

describe('TurnLifecycleTracker', () => {
  it('JSONL variant (no router) is a no-op and never fires onTurnEnded', () => {
    const onTurnEnded = vi.fn();
    const t = makeTurnLifecycleTracker({ onTurnEnded });
    // No way to trigger it; just prove dispose is safe and nothing fired.
    t.dispose();
    expect(onTurnEnded).not.toHaveBeenCalled();
  });

  it('hook variant fires onTurnEnded on a genuine Stop', () => {
    const router = new HookEventRouter();
    const onTurnEnded = vi.fn();
    makeTurnLifecycleTracker({ onTurnEnded }, { hookRouter: router, sessionId: 's1' });

    router.onHookEvent('s1', 'Stop', { hook_event_name: 'Stop', stop_hook_active: false });
    expect(onTurnEnded).toHaveBeenCalledTimes(1);
  });

  it('ignores a continuation-triggered Stop (stop_hook_active: true)', () => {
    const router = new HookEventRouter();
    const onTurnEnded = vi.fn();
    makeTurnLifecycleTracker({ onTurnEnded }, { hookRouter: router, sessionId: 's1' });

    router.onHookEvent('s1', 'Stop', { hook_event_name: 'Stop', stop_hook_active: true });
    expect(onTurnEnded).not.toHaveBeenCalled();
  });

  it('does not fire for another session\'s Stop', () => {
    const router = new HookEventRouter();
    const onTurnEnded = vi.fn();
    makeTurnLifecycleTracker({ onTurnEnded }, { hookRouter: router, sessionId: 's1' });

    router.onHookEvent('other', 'Stop', { stop_hook_active: false });
    expect(onTurnEnded).not.toHaveBeenCalled();
  });

  it('dispose unsubscribes — no further callbacks', () => {
    const router = new HookEventRouter();
    const onTurnEnded = vi.fn();
    const t = makeTurnLifecycleTracker({ onTurnEnded }, { hookRouter: router, sessionId: 's1' });

    t.dispose();
    router.onHookEvent('s1', 'Stop', { stop_hook_active: false });
    expect(onTurnEnded).not.toHaveBeenCalled();
  });

  it('tolerates a malformed Stop payload', () => {
    const router = new HookEventRouter();
    const onTurnEnded = vi.fn();
    makeTurnLifecycleTracker({ onTurnEnded }, { hookRouter: router, sessionId: 's1' });

    expect(() => router.onHookEvent('s1', 'Stop', null)).not.toThrow();
    expect(onTurnEnded).not.toHaveBeenCalled();
  });
});
