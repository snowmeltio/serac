import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { readCompactSettings } from './claudeSettings.js';

vi.mock('fs');

describe('readCompactSettings', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns defaults when file is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readCompactSettings()).toEqual({ autoCompactWindow: 200_000, autoCompactPct: 95 });
  });

  it('returns defaults when env key is absent', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ model: 'opus' }));
    expect(readCompactSettings()).toEqual({ autoCompactWindow: 200_000, autoCompactPct: 95 });
  });

  it('reads custom window from env', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' },
    }));
    const result = readCompactSettings();
    expect(result.autoCompactWindow).toBe(500_000);
    expect(result.autoCompactPct).toBe(95);
  });

  it('reads custom percentage from env', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' },
    }));
    const result = readCompactSettings();
    expect(result.autoCompactWindow).toBe(200_000);
    expect(result.autoCompactPct).toBe(80);
  });

  it('reads both overrides', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      env: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      },
    }));
    expect(readCompactSettings()).toEqual({ autoCompactWindow: 1_000_000, autoCompactPct: 60 });
  });

  it('ignores invalid percentage (> 100)', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '150' },
    }));
    expect(readCompactSettings().autoCompactPct).toBe(95);
  });

  it('ignores non-numeric values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'banana' },
    }));
    expect(readCompactSettings().autoCompactWindow).toBe(200_000);
  });

  it('handles malformed JSON gracefully', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not json');
    expect(readCompactSettings()).toEqual({ autoCompactWindow: 200_000, autoCompactPct: 95 });
  });
});
