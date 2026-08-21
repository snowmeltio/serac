import { describe, it, expect } from 'vitest';
import {
  rcTerminalEnvOverrides, locateClaudeCli, rcStartCommand, rcInstallCommand, rcQuickPickItems,
  findLiveRcTerminal, rcWatchTick, rcWatchStarted, RC_TERMINAL_NAME, RC_WATCH_IDLE, RC_STOPPED_GRACE_MS,
} from './rcLauncher.js';

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

describe('findLiveRcTerminal', () => {
  const open = (name: string) => ({ name });
  const dead = (name: string) => ({ name, exitStatus: { code: 0 } });

  it('finds the RC terminal already open in this window', () => {
    const mine = open(RC_TERMINAL_NAME);
    expect(findLiveRcTerminal([open('zsh'), mine, open('npm watch')])).toBe(mine);
  });

  it('skips one whose shell has exited — that tab cannot run anything', () => {
    expect(findLiveRcTerminal([dead(RC_TERMINAL_NAME)])).toBeUndefined();
    const live = open(RC_TERMINAL_NAME);
    expect(findLiveRcTerminal([dead(RC_TERMINAL_NAME), live])).toBe(live);
  });

  it('ignores other terminals, including the installer', () => {
    expect(findLiveRcTerminal([open('Remote Control installer'), open('zsh')])).toBeUndefined();
    expect(findLiveRcTerminal([])).toBeUndefined();
  });
});

describe('rcWatchTick', () => {
  const t0 = 1_000_000;

  it('does nothing while disarmed — Serac only watches what it started', () => {
    expect(rcWatchTick(RC_WATCH_IDLE, false, t0)).toEqual({ state: RC_WATCH_IDLE, notify: false });
    expect(rcWatchTick(RC_WATCH_IDLE, true, t0)).toEqual({ state: RC_WATCH_IDLE, notify: false });
  });

  it('stays silent forever while the registry has never confirmed the server', () => {
    // rcDetector cannot see a server that has not registered a session yet, so
    // absence here is ignorance, not death.
    let state = rcWatchStarted();
    for (let i = 0; i < 20; i++) {
      const out = rcWatchTick(state, false, t0 + i * RC_STOPPED_GRACE_MS);
      expect(out.notify).toBe(false);
      state = out.state;
    }
    expect(state.confirmed).toBe(false);
  });

  it('confirms on the first serving tick, then waits out the grace before saying it is gone', () => {
    let out = rcWatchTick(rcWatchStarted(), true, t0);
    expect(out.state.confirmed).toBe(true);
    expect(out.notify).toBe(false);

    out = rcWatchTick(out.state, false, t0 + 1000);
    expect(out).toMatchObject({ notify: false, state: { missingSince: t0 + 1000 } });

    // A later tick inside the window does not slide the deadline.
    out = rcWatchTick(out.state, false, t0 + 1000 + RC_STOPPED_GRACE_MS - 1);
    expect(out).toMatchObject({ notify: false, state: { missingSince: t0 + 1000 } });

    out = rcWatchTick(out.state, false, t0 + 1000 + RC_STOPPED_GRACE_MS);
    expect(out.notify).toBe(true);
  });

  it('rearms rather than warning when the server comes back inside the grace', () => {
    const confirmed = rcWatchTick(rcWatchStarted(), true, t0).state;
    const missing = rcWatchTick(confirmed, false, t0 + 1000).state;
    const back = rcWatchTick(missing, true, t0 + 2000);
    expect(back.state.missingSince).toBeNull();
    expect(rcWatchTick(back.state, false, t0 + 3000 + RC_STOPPED_GRACE_MS - 1).notify).toBe(false);
  });

  it('says it once: the state goes idle with the notification', () => {
    const confirmed = rcWatchTick(rcWatchStarted(), true, t0).state;
    const missing = rcWatchTick(confirmed, false, t0).state;
    const fired = rcWatchTick(missing, false, t0 + RC_STOPPED_GRACE_MS);
    expect(fired).toEqual({ state: RC_WATCH_IDLE, notify: true });
    expect(rcWatchTick(fired.state, false, t0 + RC_STOPPED_GRACE_MS * 10).notify).toBe(false);
  });
});
