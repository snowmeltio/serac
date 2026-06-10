import { describe, it, expect } from 'vitest';
import { isNearBottom, chooseReaderScrollTop, STICK_THRESHOLD_PX } from './detailViewScroll.js';

describe('isNearBottom', () => {
  it('is true exactly at the bottom', () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true); // 900 + 100 === 1000
  });
  it('is true within the threshold of the bottom', () => {
    expect(isNearBottom(900 - STICK_THRESHOLD_PX + 1, 100, 1000)).toBe(true);
  });
  it('is false when scrolled up beyond the threshold', () => {
    expect(isNearBottom(500, 100, 1000)).toBe(false); // 600 < 960
  });
  it('treats a non-overflowing pane (content shorter than viewport) as at-bottom', () => {
    expect(isNearBottom(0, 500, 200)).toBe(true);
  });
});

describe('chooseReaderScrollTop', () => {
  it('starts at the top when the agent changes (ignores prior position)', () => {
    expect(chooseReaderScrollTop({ isAgentChange: true, wasAtBottom: true, prevTop: 800, scrollHeight: 2000 })).toBe(0);
  });
  it('sticks to the bottom when the same agent was at the bottom (live tail)', () => {
    expect(chooseReaderScrollTop({ isAgentChange: false, wasAtBottom: true, prevTop: 800, scrollHeight: 2000 })).toBe(2000);
  });
  it('preserves the anchor when the same agent was scrolled up', () => {
    expect(chooseReaderScrollTop({ isAgentChange: false, wasAtBottom: false, prevTop: 640, scrollHeight: 2000 })).toBe(640);
  });
  it('agent-change wins over wasAtBottom', () => {
    expect(chooseReaderScrollTop({ isAgentChange: true, wasAtBottom: false, prevTop: 640, scrollHeight: 2000 })).toBe(0);
  });
});
