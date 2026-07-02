import { describe, it, expect } from 'vitest';
import { fmtTokens, fmtDuration, formatModelLabel, transcriptKey } from './detailShared.js';

describe('formatModelLabel', () => {
  it('derives tier + version from modern ids, stripping [1m] and date stamps', () => {
    expect(formatModelLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(formatModelLabel('claude-opus-4-8[1m]')).toBe('Opus 4.8');
    expect(formatModelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('handles legacy version-first ids and unfamiliar tiers', () => {
    expect(formatModelLabel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5');
  });

  it('degrades to the bare tier for aliases, empty for no input', () => {
    expect(formatModelLabel('sonnet')).toBe('Sonnet');
    expect(formatModelLabel('opus')).toBe('Opus');
    expect(formatModelLabel('')).toBe('');
  });
});

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
