import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import * as vscode from 'vscode';
import { claudeOpenArgs, claudeOpenArgsFor, preferredClaudeLocation } from './claudeOpen.js';
import * as mock from './__mocks__/vscode.js';

describe('claudeOpenArgsFor', () => {
  it('panel: the historical call, no options', () => {
    expect(claudeOpenArgsFor('s1', 'panel')).toEqual(['s1', undefined, vscode.ViewColumn.One]);
  });

  it('sidebar: asks Claude Code to honour the preferred location', () => {
    expect(claudeOpenArgsFor('s1', 'sidebar')).toEqual([
      's1', undefined, vscode.ViewColumn.One, undefined, undefined,
      { programmatic: 'honor-preferred-location' },
    ]);
  });

  it("sidebar 'tab' purpose: keeps tab semantics without resetting the setting", () => {
    expect(claudeOpenArgsFor('s1', 'sidebar', 'tab')).toEqual([
      's1', undefined, vscode.ViewColumn.One, undefined, undefined,
      { programmatic: 'pin-to-panel' },
    ]);
  });

  it("panel ignores the purpose: 'tab' is still the historical call", () => {
    expect(claudeOpenArgsFor('s1', 'panel', 'tab')).toEqual(['s1', undefined, vscode.ViewColumn.One]);
  });

  it('new chat (no session id) keeps the same shape', () => {
    expect(claudeOpenArgsFor(undefined, 'sidebar')[0]).toBeUndefined();
    expect(claudeOpenArgsFor(undefined, 'sidebar')).toHaveLength(6);
  });
});

describe('preferredClaudeLocation', () => {
  beforeEach(() => { mock._resetConfig(); });

  it('defaults to panel when unset', () => {
    expect(preferredClaudeLocation()).toBe('panel');
  });

  it('reads sidebar', () => {
    mock._setConfigValues({ 'claudeCode.preferredLocation': 'sidebar' });
    expect(preferredClaudeLocation()).toBe('sidebar');
  });

  it('treats an unknown value as panel', () => {
    mock._setConfigValues({ 'claudeCode.preferredLocation': 'terminal' });
    expect(preferredClaudeLocation()).toBe('panel');
  });

  it('claudeOpenArgs follows the live setting', () => {
    mock._setConfigValues({ 'claudeCode.preferredLocation': 'sidebar' });
    expect(claudeOpenArgs('s2')).toHaveLength(6);
    mock._setConfigValues({ 'claudeCode.preferredLocation': 'panel' });
    expect(claudeOpenArgs('s2')).toHaveLength(3);
  });
});
