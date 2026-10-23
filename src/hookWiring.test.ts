import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

const mockHandle = {
  isLeader: true,
  socketPath: '/test/.serac/hook.sock',
  dispose: vi.fn().mockResolvedValue(undefined),
  releaseSync: vi.fn(),
  ownsLock: vi.fn(() => true),
  skipped: undefined as 'socket-path-too-long' | undefined,
};

vi.mock('./hookIngress/index.js', () => ({
  startHookIngress: vi.fn(async () => mockHandle),
}));

vi.mock('./hookSettings/patcher.js', () => ({
  applyForwarderPatch: vi.fn(() => ({ changed: true, settingsPath: '/test/.claude/settings.json' })),
  removeForwarderPatch: vi.fn(() => ({ changed: true, settingsPath: '/test/.claude/settings.json' })),
}));

import * as vscode from 'vscode';
import { _setConfigValues, _resetConfig } from './__mocks__/vscode.js';
import { wireHookIngress } from './hookWiring.js';
import { startHookIngress } from './hookIngress/index.js';
import { applyForwarderPatch, removeForwarderPatch } from './hookSettings/patcher.js';

function makeLog(): vscode.LogOutputChannel {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    append: vi.fn(), appendLine: vi.fn(), clear: vi.fn(), show: vi.fn(), hide: vi.fn(),
    dispose: vi.fn(), name: 'test', logLevel: 0, onDidChangeLogLevel: vi.fn(),
    replace: vi.fn(),
  } as unknown as vscode.LogOutputChannel;
}

function wire() {
  return wireHookIngress({ wsPath: '/test/workspace', forwarderPath: '/ext/bin/fwd.cjs', log: makeLog() });
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('wireHookIngress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetConfig();
    mockHandle.isLeader = true;
    mockHandle.skipped = undefined;
  });

  it('returns the router and registers the header-bar toggle commands', () => {
    const wiring = wire();
    expect(wiring.router).toBeDefined();
    expect(wiring.disposables.length).toBeGreaterThanOrEqual(5);
    const cmds = vi.mocked(vscode.commands.registerCommand).mock.calls.map(c => c[0]);
    expect(cmds).toContain('agentActivity.enableHooks');
    expect(cmds).toContain('agentActivity.disableHooks');
  });

  it('patches settings on leader bind when hooks are enabled', async () => {
    _setConfigValues({ 'serac.hooks.enabled': true });
    wire();
    await flush();
    expect(vi.mocked(startHookIngress)).toHaveBeenCalled();
    expect(vi.mocked(applyForwarderPatch)).toHaveBeenCalledWith('/test/workspace', '/ext/bin/fwd.cjs');
  });

  it('does not patch when hooks are disabled', async () => {
    wire();
    await flush();
    expect(vi.mocked(applyForwarderPatch)).not.toHaveBeenCalled();
  });

  it('does not patch as a follower even with hooks enabled', async () => {
    _setConfigValues({ 'serac.hooks.enabled': true });
    mockHandle.isLeader = false;
    wire();
    await flush();
    expect(vi.mocked(applyForwarderPatch)).not.toHaveBeenCalled();
  });

  it('unpatches before closing the socket on dispose (leader only)', async () => {
    _setConfigValues({ 'serac.hooks.enabled': true });
    const wiring = wire();
    await flush();
    for (const d of wiring.disposables) { d.dispose(); }
    expect(vi.mocked(removeForwarderPatch)).toHaveBeenCalledWith('/test/workspace');
    expect(mockHandle.releaseSync).toHaveBeenCalled();
  });

  it('releases the lock even when the log channel is already closed', async () => {
    // 22-23 Oct: the Serac channel was disposed first, its log.info threw
    // "Channel has been closed" inside the unpatch, and the lock was never
    // released, so every later window stayed a follower with no hooks.
    _setConfigValues({ 'serac.hooks.enabled': true });
    const log = makeLog();
    const wiring = wireHookIngress({ wsPath: '/test/workspace', forwarderPath: '/ext/bin/fwd.cjs', log });
    await flush();
    const closed = () => { throw new Error('Channel has been closed'); };
    vi.mocked(log.info).mockImplementation(closed);
    vi.mocked(log.error).mockImplementation(closed);
    expect(() => { for (const d of wiring.disposables) { d.dispose(); } }).not.toThrow();
    expect(vi.mocked(removeForwarderPatch)).toHaveBeenCalled();
    expect(mockHandle.releaseSync).toHaveBeenCalled();
  });

  it('leaves the settings patch to a successor that took the lock over', async () => {
    _setConfigValues({ 'serac.hooks.enabled': true });
    const wiring = wire();
    await flush();
    mockHandle.ownsLock.mockReturnValueOnce(false);
    for (const d of wiring.disposables) { d.dispose(); }
    expect(vi.mocked(removeForwarderPatch)).not.toHaveBeenCalled();
    expect(mockHandle.releaseSync).toHaveBeenCalled();
  });

  it('releases the lock when the unpatch itself throws', async () => {
    _setConfigValues({ 'serac.hooks.enabled': true });
    const wiring = wire();
    await flush();
    vi.mocked(removeForwarderPatch).mockImplementationOnce(() => { throw new Error('EACCES'); });
    for (const d of wiring.disposables) { d.dispose(); }
    expect(mockHandle.releaseSync).toHaveBeenCalled();
  });

  it('live-toggles the patch when serac.hooks.enabled changes', async () => {
    _setConfigValues({ 'serac.hooks.enabled': true });
    wire();
    await flush();
    vi.mocked(applyForwarderPatch).mockClear();

    const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)![0];

    // Flip off → unpatch.
    _setConfigValues({ 'serac.hooks.enabled': false });
    listener({ affectsConfiguration: (s: string) => s === 'serac.hooks.enabled' } as vscode.ConfigurationChangeEvent);
    expect(vi.mocked(removeForwarderPatch)).toHaveBeenCalled();

    // Flip back on → patch (still leader).
    _setConfigValues({ 'serac.hooks.enabled': true });
    listener({ affectsConfiguration: (s: string) => s === 'serac.hooks.enabled' } as vscode.ConfigurationChangeEvent);
    expect(vi.mocked(applyForwarderPatch)).toHaveBeenCalled();
  });
});
