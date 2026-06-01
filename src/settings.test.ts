import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import { readSettings, onSettingsChanged, DEFAULT_SETTINGS } from './settings.js';
import { _setConfigValues, _resetConfig, _fireConfigChange } from './__mocks__/vscode.js';

describe('readSettings', () => {
  beforeEach(() => { _resetConfig(); });

  it('returns the documented defaults when no keys are set', () => {
    const s = readSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to defaults per-section when only some keys are set', () => {
    _setConfigValues({ 'serac.show.usage': false });
    const s = readSettings();
    expect(s.show.usage).toBe(false);
    expect(s.show.foreignWorkspaces).toBe(DEFAULT_SETTINGS.show.foreignWorkspaces);
    expect(s.archive.defaultRange).toBe(DEFAULT_SETTINGS.archive.defaultRange);
  });

  it('reads every section through with user-provided values', () => {
    _setConfigValues({
      'serac.show.foreignWorkspaces': false,
      'serac.show.worktrees': false,
      'serac.show.usage': false,
      'serac.show.subagents': false,
      'serac.show.teams': false,
      'serac.archive.defaultRange': '30d',
      'serac.archive.maxDoneShown': 50,
      'serac.refresh.intervalSeconds': 2,
      'serac.discovery.ageGateDays': 14,
      'serac.foreignWorkspaces.maxHeightPx': 0,
      'serac.worktrees.maxHeightPx': 500,
      'serac.worktrees.autoCollapseAfterSeconds': 60,
      'serac.usage.showWeekly': false,
      'serac.usage.warnAtPercent': 70,
      'serac.usage.criticalAtPercent': 90,
      'serac.animations.enabled': false,
      'serac.cleanup.confirmRequired': false,
    });
    const s = readSettings();
    expect(s.show.foreignWorkspaces).toBe(false);
    expect(s.show.worktrees).toBe(false);
    expect(s.show.usage).toBe(false);
    expect(s.show.subagents).toBe(false);
    expect(s.show.teams).toBe(false);
    expect(s.archive.defaultRange).toBe('30d');
    expect(s.archive.maxDoneShown).toBe(50);
    expect(s.refresh.intervalSeconds).toBe(2);
    expect(s.discovery.ageGateDays).toBe(14);
    expect(s.foreignWorkspaces.maxHeightPx).toBe(0);
    expect(s.worktrees.maxHeightPx).toBe(500);
    expect(s.worktrees.autoCollapseAfterSeconds).toBe(60);
    expect(s.usage.showWeekly).toBe(false);
    expect(s.usage.warnAtPercent).toBe(70);
    expect(s.usage.criticalAtPercent).toBe(90);
    expect(s.animations.enabled).toBe(false);
    expect(s.cleanup.confirmRequired).toBe(false);
  });
});

describe('onSettingsChanged', () => {
  beforeEach(() => { _resetConfig(); });

  it('fires the callback with a fresh snapshot when serac.* changes', () => {
    const calls: Array<ReturnType<typeof readSettings>> = [];
    const sub = onSettingsChanged(s => calls.push(s));

    _setConfigValues({ 'serac.show.usage': false });
    _fireConfigChange('serac');

    expect(calls).toHaveLength(1);
    expect(calls[0].show.usage).toBe(false);
    sub.dispose();
  });

  it('does not fire for unrelated config sections', () => {
    const cb = vi.fn();
    const sub = onSettingsChanged(cb);

    _fireConfigChange('editor.fontSize');

    expect(cb).not.toHaveBeenCalled();
    sub.dispose();
  });

  it('fires for nested keys (e.g. serac.show.foreignWorkspaces)', () => {
    const cb = vi.fn();
    const sub = onSettingsChanged(cb);

    _fireConfigChange('serac.show.foreignWorkspaces');

    expect(cb).toHaveBeenCalledTimes(1);
    sub.dispose();
  });

  it('disposes cleanly — subsequent changes do not fire the callback', () => {
    const cb = vi.fn();
    const sub = onSettingsChanged(cb);

    sub.dispose();
    _fireConfigChange('serac');

    expect(cb).not.toHaveBeenCalled();
  });
});
