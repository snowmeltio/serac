import { describe, it, expect } from 'vitest';
import {
  JsonlDerivedCompactBoundaryTracker,
  makeCompactBoundaryTracker,
} from './compactBoundaryTracker.js';
import { HookEventRouter } from '../hookEventRouter.js';

function makeHost() {
  let fired = 0;
  return {
    getFired() { return fired; },
    host: {
      onCompactDetected: () => { fired++; },
    },
  };
}

describe('JsonlDerivedCompactBoundaryTracker', () => {
  it('starts with lastCompactAt === 0', () => {
    const t = new JsonlDerivedCompactBoundaryTracker(makeHost().host);
    expect(t.getLastCompactAt()).toBe(0);
  });

  it('onCompactBoundary records timestamp and fires host callback', () => {
    const h = makeHost();
    const t = new JsonlDerivedCompactBoundaryTracker(h.host);
    const ts = 1_700_000_000_000;
    t.onCompactBoundary(ts);
    expect(t.getLastCompactAt()).toBe(ts);
    expect(h.getFired()).toBe(1);
  });

  it('repeated onCompactBoundary updates timestamp and fires each time', () => {
    const h = makeHost();
    const t = new JsonlDerivedCompactBoundaryTracker(h.host);
    t.onCompactBoundary(1_000);
    t.onCompactBoundary(2_000);
    expect(t.getLastCompactAt()).toBe(2_000);
    expect(h.getFired()).toBe(2);
  });

  it('factory returns a working JSONL-derived tracker', () => {
    const h = makeHost();
    const t = makeCompactBoundaryTracker(h.host);
    t.onCompactBoundary(123);
    expect(t.getLastCompactAt()).toBe(123);
    expect(h.getFired()).toBe(1);
  });

  it('dispose is idempotent and does not throw', () => {
    const t = new JsonlDerivedCompactBoundaryTracker(makeHost().host);
    t.dispose();
    t.dispose();
  });
});

describe('CompactBoundaryTracker (hook overlay)', () => {
  const SID = 'session-uuid-compact';

  function setup(now: () => number = () => 12345) {
    const router = new HookEventRouter();
    const h = makeHost();
    const tracker = makeCompactBoundaryTracker(h.host, { hookRouter: router, sessionId: SID });
    return { router, host: h, tracker, now };
  }

  it('fires onCompactDetected on SessionStart(source: "compact")', () => {
    const { router, host, tracker } = setup();
    router.onHookEvent(SID, 'SessionStart', { source: 'compact' });
    expect(host.getFired()).toBe(1);
    tracker.dispose();
  });

  it('ignores SessionStart(source: "startup")', () => {
    const { router, host, tracker } = setup();
    router.onHookEvent(SID, 'SessionStart', { source: 'startup' });
    expect(host.getFired()).toBe(0);
    tracker.dispose();
  });

  it('ignores SessionStart with no source field', () => {
    const { router, host, tracker } = setup();
    router.onHookEvent(SID, 'SessionStart', {});
    expect(host.getFired()).toBe(0);
    tracker.dispose();
  });

  it('still accepts onCompactBoundary() from the JSONL path', () => {
    const { host, tracker } = setup();
    tracker.onCompactBoundary(1000);
    expect(host.getFired()).toBe(1);
    expect(tracker.getLastCompactAt()).toBe(1000);
    tracker.dispose();
  });

  it('ignores SessionStart for other sessions', () => {
    const { router, host, tracker } = setup();
    router.onHookEvent('other-session', 'SessionStart', { source: 'compact' });
    expect(host.getFired()).toBe(0);
    tracker.dispose();
  });

  it('dispose unsubscribes; later events do nothing', () => {
    const { router, host, tracker } = setup();
    tracker.dispose();
    router.onHookEvent(SID, 'SessionStart', { source: 'compact' });
    expect(host.getFired()).toBe(0);
  });
});
