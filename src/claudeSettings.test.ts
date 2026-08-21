import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { readCompactSettings, readDefaultModel, readRemoteControlAtStartup } from './claudeSettings.js';

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

describe('readDefaultModel', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns empty string when file is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readDefaultModel()).toBe('');
  });

  it('returns the model alias when set', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ model: 'sonnet' }));
    expect(readDefaultModel()).toBe('sonnet');
  });

  it('returns empty string when model is absent', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ theme: 'dark' }));
    expect(readDefaultModel()).toBe('');
  });

  it('returns empty string when model is not a string', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ model: 42 }));
    expect(readDefaultModel()).toBe('');
  });

  it('handles malformed JSON gracefully', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not json');
    expect(readDefaultModel()).toBe('');
  });
});

describe('readRemoteControlAtStartup', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  /** Route reads: the workspace layers are matched by their full '/ws/…'
   *  path; anything else ending in settings.json is the user file (the real
   *  state dir is ~/.claude, so a bare suffix match would collide). */
  function mockFiles(files: Record<string, string | null>): void {
    vi.mocked(fs.readFileSync).mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      const key = s.startsWith('/ws/') ? s.slice(3) : s.endsWith('/settings.json') ? '/settings.json' : undefined;
      if (key === undefined || !(key in files) || files[key] === null) { throw new Error('ENOENT'); }
      return files[key] as string;
    }) as typeof fs.readFileSync);
  }

  it('returns null when the user settings.json is unreadable — nothing is known', () => {
    mockFiles({});
    expect(readRemoteControlAtStartup('/ws')).toBeNull();
  });

  it('returns false when the user file is readable but the key is absent (Claude Code default)', () => {
    mockFiles({ '/settings.json': JSON.stringify({ model: 'opus' }), '/.claude/settings.json': null, '/.claude/settings.local.json': null });
    expect(readRemoteControlAtStartup('/ws')).toBe(false);
  });

  it('reads true from the user file', () => {
    mockFiles({ '/settings.json': JSON.stringify({ remoteControlAtStartup: true }), '/.claude/settings.json': null, '/.claude/settings.local.json': null });
    expect(readRemoteControlAtStartup('/ws')).toBe(true);
  });

  it('project and local files override the user file, local winning', () => {
    mockFiles({
      '/.claude/settings.local.json': JSON.stringify({ remoteControlAtStartup: false }),
      '/.claude/settings.json': JSON.stringify({ remoteControlAtStartup: true }),
      '/settings.json': JSON.stringify({ remoteControlAtStartup: true }),
    });
    expect(readRemoteControlAtStartup('/ws')).toBe(false);
  });

  it('a malformed project file keeps the user value', () => {
    mockFiles({
      '/.claude/settings.json': '{not json',
      '/.claude/settings.local.json': null,
      '/settings.json': JSON.stringify({ remoteControlAtStartup: true }),
    });
    expect(readRemoteControlAtStartup('/ws')).toBe(true);
  });
});
