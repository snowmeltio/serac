import { describe, it, expect } from 'vitest';
import { fmtTokens, fmtDuration, transcriptKey } from './detailShared.js';

describe('fmtTokens', () => {
  it('passes small counts through and abbreviates thousands', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(12345)).toBe('12k');
  });
});

describe('fmtDuration', () => {
  it('formats seconds and minute combinations, empty for null/zero', () => {
    expect(fmtDuration(null)).toBe('');
    expect(fmtDuration(0)).toBe('');
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(60_000)).toBe('1m');
    expect(fmtDuration(90_000)).toBe('1m 30s');
  });
});

describe('transcriptKey', () => {
  it('is owner-prefixed so identical agent ids in different containers cannot collide', () => {
    const a = transcriptKey('team', 'at:alpha', '', 'defender');
    const b = transcriptKey('team', 'at:beta', '', 'defender');
    expect(a).not.toBe(b);
    expect(a).toBe('team:at:alpha||defender');
  });
});
