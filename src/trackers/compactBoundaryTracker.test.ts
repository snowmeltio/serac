import { describe, it, expect } from 'vitest';
import {
  JsonlDerivedCompactBoundaryTracker,
  makeCompactBoundaryTracker,
} from './compactBoundaryTracker.js';

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
