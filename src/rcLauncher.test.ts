import { describe, it, expect } from 'vitest';
import { rcTerminalEnvOverrides, locateClaudeCli, rcStartCommand, rcInstallCommand, rcQuickPickItems } from './rcLauncher.js';

describe('rcTerminalEnvOverrides', () => {
  it('nulls every VSCODE_* and ELECTRON_RUN_AS_NODE, keeps CLAUDE_CONFIG_DIR and the rest', () => {
    const out = rcTerminalEnvOverrides({
      VSCODE_PID: '1', VSCODE_IPC_HOOK: 'x', ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CONFIG_DIR: '/Users/x/.claude-account/a', PATH: '/bin', HOME: '/Users/x',
    });
    expect(out).toEqual({ VSCODE_PID: null, VSCODE_IPC_HOOK: null, ELECTRON_RUN_AS_NODE: null });
    expect(out).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(out).not.toHaveProperty('PATH');
  });

  it('is empty for a clean environment', () => {
    expect(rcTerminalEnvOverrides({ PATH: '/bin' })).toEqual({});
  });
});

describe('locateClaudeCli', () => {
  it('prefers the native install at ~/.local/bin/claude when present', () => {
    expect(locateClaudeCli('/Users/x', p => p === '/Users/x/.local/bin/claude')).toBe('/Users/x/.local/bin/claude');
  });
  it('falls back to PATH lookup otherwise', () => {
    expect(locateClaudeCli('/Users/x', () => false)).toBe('claude');
  });
});

describe('rcStartCommand / rcInstallCommand', () => {
  it('starts with --spawn worktree, matching the launchd wrapper', () => {
    expect(rcStartCommand('claude')).toBe('claude rc --spawn worktree');
    expect(rcStartCommand('/Users/x/.local/bin/claude')).toBe('/Users/x/.local/bin/claude rc --spawn worktree');
  });
  it('single-quotes paths with spaces or quotes', () => {
    expect(rcStartCommand("/Users/o'brien/bin/claude")).toBe("'/Users/o'\\''brien/bin/claude' rc --spawn worktree");
    expect(rcInstallCommand('/ext/serac 1.22', '/Users/x/repo'))
      .toBe("bash '/ext/serac 1.22/scripts/rc-headless/install.sh' /Users/x/repo");
  });
  it('install runs the shipped script via bash (no execute bit assumed)', () => {
    expect(rcInstallCommand('/ext', '/ws')).toBe('bash /ext/scripts/rc-headless/install.sh /ws');
  });
});

describe('rcQuickPickItems', () => {
  it('offers start + install + settings when everything is off on macOS', () => {
    const actions = rcQuickPickItems({ autoEnrol: false, serving: false }, 'darwin').map(i => i.action);
    expect(actions).toEqual(['start', 'install', 'settings']);
  });
  it('omits the launchd installer off macOS', () => {
    const actions = rcQuickPickItems({ autoEnrol: false, serving: false }, 'linux').map(i => i.action);
    expect(actions).toEqual(['start', 'settings']);
  });
  it('the common case — auto-enrol on, no server — offers only the server routes', () => {
    const actions = rcQuickPickItems({ autoEnrol: true, serving: false }, 'darwin').map(i => i.action);
    expect(actions).toEqual(['start', 'install']);
  });
  it('the inverse — server on, auto-enrol off — offers only settings', () => {
    const actions = rcQuickPickItems({ autoEnrol: false, serving: true }, 'darwin').map(i => i.action);
    expect(actions).toEqual(['settings']);
  });
  it('unreadable settings still offers the settings route, and says why', () => {
    const items = rcQuickPickItems({ autoEnrol: null, serving: true }, 'darwin');
    expect(items.map(i => i.action)).toEqual(['settings']);
    expect(items[0].description).toContain('could not read');
  });
  it('offers nothing when both facts are on', () => {
    expect(rcQuickPickItems({ autoEnrol: true, serving: true }, 'darwin')).toEqual([]);
  });
  it('never claims Serac will stop a server or write the flag', () => {
    for (const item of rcQuickPickItems({ autoEnrol: false, serving: false }, 'darwin')) {
      const text = item.label + ' ' + item.description + ' ' + (item.detail ?? '');
      expect(text).not.toMatch(/Serac (will )?(stop|write)s?\b(?! this| it for)/);
    }
    const start = rcQuickPickItems({ autoEnrol: true, serving: false }, 'darwin')[0];
    expect(start.detail).toContain('never stops it');
  });
});
