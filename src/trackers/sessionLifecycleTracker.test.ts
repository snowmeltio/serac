import { describe, it, expect, vi } from 'vitest';
import { HookEventRouter } from '../hookEventRouter.js';
import { makeSessionLifecycleTracker } from './sessionLifecycleTracker.js';

function mkHost() {
  return { onSessionEnd: vi.fn(), onPreCompact: vi.fn() };
}

describe('SessionLifecycleTracker', () => {
  it('JSONL variant (no router) is a no-op', () => {
    const host = mkHost();
    const t = makeSessionLifecycleTracker(host);
    t.dispose();
    expect(host.onSessionEnd).not.toHaveBeenCalled();
    expect(host.onPreCompact).not.toHaveBeenCalled();
  });

  it('SessionEnd → onSessionEnd with the reason', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeSessionLifecycleTracker(host, { hookRouter: router, sessionId: 's1' });
    router.onHookEvent('s1', 'SessionEnd', { hook_event_name: 'SessionEnd', reason: 'clear' });
    expect(host.onSessionEnd).toHaveBeenCalledWith('clear');
  });

  it('SessionEnd without a reason defaults to "other"', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeSessionLifecycleTracker(host, { hookRouter: router, sessionId: 's1' });
    router.onHookEvent('s1', 'SessionEnd', { hook_event_name: 'SessionEnd' });
    expect(host.onSessionEnd).toHaveBeenCalledWith('other');
  });

  it('PreCompact → onPreCompact with the trigger', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeSessionLifecycleTracker(host, { hookRouter: router, sessionId: 's1' });
    router.onHookEvent('s1', 'PreCompact', { hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(host.onPreCompact).toHaveBeenCalledWith('auto');
  });

  it('dispose unsubscribes', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    const t = makeSessionLifecycleTracker(host, { hookRouter: router, sessionId: 's1' });
    t.dispose();
    router.onHookEvent('s1', 'SessionEnd', { reason: 'logout' });
    router.onHookEvent('s1', 'PreCompact', { trigger: 'manual' });
    expect(host.onSessionEnd).not.toHaveBeenCalled();
    expect(host.onPreCompact).not.toHaveBeenCalled();
  });
});
