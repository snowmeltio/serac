import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import { readSettings, onSettingsChanged, ageGateDaysFor, foreignWindowGate, DEFAULT_SETTINGS } from './settings.js';
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
      'serac.archive.defaultRange': '30d',
      'serac.archive.maxDoneShown': 50,
      'serac.refresh.intervalSeconds': 2,
      'serac.discovery.ageGateDays': 14,
      'serac.discovery.foreignWorkspacesAgeGateDays': 2,
      'serac.discovery.worktreesAgeGateDays': 30,
      'serac.discovery.teamsAgeGateDays': 1,
      'serac.discovery.workflowsAgeGateDays': 90,
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
    expect(s.archive.defaultRange).toBe('30d');
    expect(s.archive.maxDoneShown).toBe(50);
    expect(s.refresh.intervalSeconds).toBe(2);
    expect(s.discovery.ageGateDays).toBe(14);
    expect(s.discovery.foreignWorkspacesAgeGateDays).toBe(2);
    expect(s.discovery.worktreesAgeGateDays).toBe(30);
    expect(s.discovery.teamsAgeGateDays).toBe(1);
    expect(s.discovery.workflowsAgeGateDays).toBe(90);
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

describe('ageGateDaysFor', () => {
  beforeEach(() => { _resetConfig(); });

  it('inherits the base ageGateDays for every section when no override is set', () => {
    _setConfigValues({ 'serac.discovery.ageGateDays': 14 });
    expect(ageGateDaysFor('foreignWorkspaces')).toBe(14);
    expect(ageGateDaysFor('worktrees')).toBe(14);
    expect(ageGateDaysFor('teams')).toBe(14);
    expect(ageGateDaysFor('workflows')).toBe(14);
  });

  it('uses a section override and leaves the other sections on the base', () => {
    _setConfigValues({
      'serac.discovery.ageGateDays': 7,
      'serac.discovery.foreignWorkspacesAgeGateDays': 2,
    });
    expect(ageGateDaysFor('foreignWorkspaces')).toBe(2); // overridden
    expect(ageGateDaysFor('worktrees')).toBe(7);         // inherits base
    expect(ageGateDaysFor('teams')).toBe(7);
    expect(ageGateDaysFor('workflows')).toBe(7);
  });

  it('resolves each section to its own override independently', () => {
    _setConfigValues({
      'serac.discovery.ageGateDays': 7,
      'serac.discovery.foreignWorkspacesAgeGateDays': 1,
      'serac.discovery.worktreesAgeGateDays': 30,
      'serac.discovery.teamsAgeGateDays': 3,
      'serac.discovery.workflowsAgeGateDays': 90,
    });
    expect(ageGateDaysFor('foreignWorkspaces')).toBe(1);
    expect(ageGateDaysFor('worktrees')).toBe(30);
    expect(ageGateDaysFor('teams')).toBe(3);
    expect(ageGateDaysFor('workflows')).toBe(90);
  });

  it('falls back to the base when an override is non-positive (never disables the gate)', () => {
    _setConfigValues({
      'serac.discovery.ageGateDays': 7,
      'serac.discovery.teamsAgeGateDays': 0,
    });
    expect(ageGateDaysFor('teams')).toBe(7);
  });

  it('falls back to the base when an override is non-finite (1e999 → Infinity)', () => {
    // A pathological manual edit (a value that overflows a double) must not
    // silently disable the gate by yielding an Infinity window.
    _setConfigValues({
      'serac.discovery.ageGateDays': 7,
      'serac.discovery.worktreesAgeGateDays': Infinity,
    });
    expect(ageGateDaysFor('worktrees')).toBe(7);
  });

  it('defaults to the base default (7) when nothing is configured', () => {
    expect(ageGateDaysFor('foreignWorkspaces')).toBe(DEFAULT_SETTINGS.discovery.ageGateDays);
  });

  it('accepts a pre-read settings snapshot to avoid re-reading config', () => {
    _setConfigValues({
      'serac.discovery.ageGateDays': 7,
      'serac.discovery.worktreesAgeGateDays': 21,
    });
    const snap = readSettings();
    expect(ageGateDaysFor('worktrees', snap)).toBe(21);
    expect(ageGateDaysFor('teams', snap)).toBe(7);
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

describe('foreignWindowGate', () => {
  beforeEach(() => { _resetConfig(); });
  const DAY = 24 * 60 * 60 * 1000;

  it('inherit (default) resolves to the existing day-count chain', () => {
    _setConfigValues({ 'serac.discovery.ageGateDays': 14 });
    expect(foreignWindowGate()).toEqual({ liveOnly: false, ageGateMs: 14 * DAY });
  });

  it('presets map to fixed windows regardless of the day-count settings', () => {
    _setConfigValues({
      'serac.discovery.ageGateDays': 14,
      'serac.discovery.foreignWorkspacesAgeGateDays': 3,
    });
    _setConfigValues({ 'serac.discovery.foreignWorkspacesWindow': '1d', 'serac.discovery.ageGateDays': 14, 'serac.discovery.foreignWorkspacesAgeGateDays': 3 });
    expect(foreignWindowGate().ageGateMs).toBe(DAY);
    _setConfigValues({ 'serac.discovery.foreignWorkspacesWindow': '7d' });
    expect(foreignWindowGate().ageGateMs).toBe(7 * DAY);
    _setConfigValues({ 'serac.discovery.foreignWorkspacesWindow': '30d' });
    expect(foreignWindowGate().ageGateMs).toBe(30 * DAY);
    _setConfigValues({ 'serac.discovery.foreignWorkspacesWindow': 'forever' });
    expect(foreignWindowGate().ageGateMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('live-only sets the flag and keeps the inherited window as registry fallback', () => {
    _setConfigValues({
      'serac.discovery.foreignWorkspacesWindow': 'live-only',
      'serac.discovery.foreignWorkspacesAgeGateDays': 2,
    });
    expect(foreignWindowGate()).toEqual({ liveOnly: true, ageGateMs: 2 * DAY });
  });

  it('an unrecognised value degrades to inherit, not a crash or a blank gate', () => {
    _setConfigValues({ 'serac.discovery.foreignWorkspacesWindow': 'yesterday' });
    expect(foreignWindowGate()).toEqual({ liveOnly: false, ageGateMs: 7 * DAY });
  });
});
