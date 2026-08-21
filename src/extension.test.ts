import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (vi.mock is hoisted, so no external variable references in factories) ---

vi.mock('vscode', () => {
  const tabGroups = {
    all: [] as Array<{ tabs: Array<{ input: unknown; isActive: boolean }> }>,
    activeTabGroup: { activeTab: undefined as unknown },
    close: vi.fn().mockResolvedValue(true),
  };
  return {
    Uri: {
      file: (p: string) => ({ scheme: 'file', fsPath: p }),
      joinPath: (base: { fsPath: string }, ...segs: string[]) => ({
        scheme: 'file',
        fsPath: [base.fsPath, ...segs].join('/'),
      }),
    },
    ViewColumn: { One: 1, Active: -1 },
    TextEditorRevealType: { InCenter: 2 },
    Selection: class { constructor(public anchor: unknown, public active: unknown) {} },
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    // nativeDocs.ts's NativeDocsProvider (Phase 4, DESIGN-DETAIL-PANE-V2.md)
    // constructs one of these at activation — declared, never fired (see its
    // own docstring on why a snapshot-only virtual doc never emits).
    EventEmitter: class {
      private listeners: Array<(e: unknown) => void> = [];
      event = (listener: (e: unknown) => void) => {
        this.listeners.push(listener);
        return { dispose: vi.fn() };
      };
      fire(e: unknown) { for (const l of this.listeners) { l(e); } }
      dispose() { this.listeners = []; }
    },
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/test/ws' }, name: 'ws', index: 0 }],
      openTextDocument: vi.fn().mockResolvedValue({}),
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: vi.fn(),
        onDidCreate: vi.fn(),
        onDidDelete: vi.fn(),
        dispose: vi.fn(),
      })),
      // Minimal getConfiguration stub: returns defaults from settings.ts.
      // Tests that care about specific config values can spy/override.
      getConfiguration: vi.fn(() => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(), trace: vi.fn(), debug: vi.fn(),
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn(),
      })),
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      showInformationMessage: vi.fn(),
      showQuickPick: vi.fn().mockResolvedValue(undefined),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
      createTerminal: vi.fn(),
      setStatusBarMessage: vi.fn(),
      tabGroups,
    },
    commands: {
      executeCommand: vi.fn().mockResolvedValue(undefined),
      registerCommand: vi.fn((_cmd: string, _cb: (...args: unknown[]) => void) => ({ dispose: vi.fn() })),
    },
    env: { clipboard: { writeText: vi.fn() }, language: 'en-AU' },
  };
});

const mockDiscovery = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  getSnapshots: vi.fn().mockReturnValue([]),
  getWaitingCount: vi.fn().mockReturnValue(0),
  getSiblingWaitingCount: vi.fn().mockReturnValue(0),
  getForeignWorkspaces: vi.fn().mockReturnValue([]),
  getForeignWaitingSnapshots: vi.fn().mockReturnValue([]),
  getForeignRunningSnapshots: vi.fn().mockReturnValue([]),
  getForeignWorkspaceCwd: vi.fn().mockReturnValue(null),
  dismissSession: vi.fn(),
  undismissSession: vi.fn(),
  acknowledgeIfDone: vi.fn(),
  acknowledgeSubagents: vi.fn(),
  isSessionRunning: vi.fn().mockReturnValue(false),
  isExternalWriterFresh: vi.fn().mockResolvedValue(false),
  resolveOpenGate: vi.fn().mockResolvedValue({ kind: 'clear' }),
  isMarkedExternalWriter: vi.fn().mockReturnValue(false),
  isMarkedDualWriter: vi.fn().mockReturnValue(false),
  isDualWriterFresh: vi.fn().mockResolvedValue(false),
  getProcessesForSession: vi.fn().mockReturnValue([]),
  getOwnershipOf: vi.fn().mockReturnValue(undefined),
  getOwnerPidOf: vi.fn().mockReturnValue(undefined),
  getSessionFilePath: vi.fn().mockReturnValue(null),
  setArchiveRange: vi.fn().mockResolvedValue(true),
  getTeamSnapshots: vi.fn().mockReturnValue([]),
  dismissTeam: vi.fn(),
  undismissTeam: vi.fn(),
  getTeamSessionFilePath: vi.fn().mockReturnValue(null),
  isTeamSessionRunning: vi.fn().mockReturnValue(false),
  getWorkflowSnapshots: vi.fn().mockReturnValue([]),
  dismissWorkflow: vi.fn(),
  undismissWorkflow: vi.fn(),
  getWorkflowAgentFilePath: vi.fn().mockReturnValue(null),
  getSubagentFilePath: vi.fn().mockReturnValue(null),
  getTeamAgentFilePath: vi.fn().mockReturnValue(null),
  getOlderSessionCount: vi.fn().mockReturnValue(0),
  getLocalRepoRoot: vi.fn().mockReturnValue(null),
  getDiscoveredWorktrees: vi.fn().mockReturnValue([]),
  getRcServing: vi.fn().mockReturnValue(false),
};

const mockUsageProvider = {
  start: vi.fn(),
  stop: vi.fn(),
  getSnapshot: vi.fn().mockReturnValue(null),
};

const mockPanelProvider = {
  updateSessions: vi.fn(),
  focusSession: vi.fn(),
  setFocusHandler: vi.fn(),
  setResolveDualWriterHandler: vi.fn(),
  setRcIndicatorClickHandler: vi.fn(),
  setDismissHandler: vi.fn(),
  setUndismissHandler: vi.fn(),
  setTranscriptHandler: vi.fn(),
  setNewChatHandler: vi.fn(),
  setCleanupHandler: vi.fn(),
  setArchiveRangeHandler: vi.fn(),
  setUndismissTeamHandler: vi.fn(),
  setOpenDetailHandler: vi.fn(),
  setDismissWorkflowHandler: vi.fn(),
  setUndismissWorkflowHandler: vi.fn(),
  setOpenWorkspaceHandler: vi.fn(),
  setFooterSlotBridge: vi.fn(),
  refresh: vi.fn(),
};

vi.mock('./sessionDiscovery.js', () => ({
  SessionDiscovery: vi.fn(function () { return mockDiscovery; }),
}));

vi.mock('./usageProvider.js', () => ({
  UsageProvider: vi.fn(function () { return mockUsageProvider; }),
}));

vi.mock('./panelProvider.js', () => ({
  AgentPanelProvider: Object.assign(vi.fn(function () { return mockPanelProvider; }), {
    viewType: 'agentActivity.panel',
  }),
}));

vi.mock('./transcriptRenderer.js', () => ({
  renderTranscript: vi.fn().mockResolvedValue('/test/transcript.md'),
}));

vi.mock('./sessionRepair.js', () => ({
  ensureSessionMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./claudeSettings.js', () => ({
  readCompactSettings: vi.fn().mockReturnValue({ autoCompactWindow: 200_000, autoCompactPct: 95 }),
  getClaudeSettingsPath: vi.fn().mockReturnValue('/mock/.claude/settings.json'),
  readRemoteControlAtStartup: vi.fn().mockReturnValue(true),
}));

// Deterministic env signals: the real module reads ~/.claude on THIS machine —
// tests must control it.
vi.mock('./workspaceOpener.js', () => ({
  openWorkspaceFolder: vi.fn().mockResolvedValue({ kind: 'spawned', cli: '/mock/cli' }),
  writeFocusHint: vi.fn().mockResolvedValue(undefined),
  consumeFocusHint: vi.fn().mockResolvedValue(null),
  focusHintPath: vi.fn().mockReturnValue('/test/hints/focus-hint.json'),
  addressedFocusHintPath: vi.fn((_dir: string, _key: string, pid: number) => `/test/hints/focus-hint-${pid}.json`),
  writeAddressedFocusHint: vi.fn().mockResolvedValue(undefined),
  addressedReleaseHintPath: vi.fn((_dir: string, _key: string, pid: number) => `/test/hints/release-hint-${pid}.json`),
  writeAddressedReleaseHint: vi.fn().mockResolvedValue(undefined),
  sweepStaleAddressedHints: vi.fn().mockResolvedValue(undefined),
  deriveUserDataDir: vi.fn().mockReturnValue('/test/user-data'),
}));

vi.mock('./claudeEnvSignals.js', () => ({
  readIdeOpenFolders: vi.fn(() => new Set<string>()),
}));

// extension.ts imports only isExtensionHostPid from here (the dual-writer
// keep-here addressability check); the real one spawns `ps`.
vi.mock('./writerOwnership.js', () => ({
  isExtensionHostPid: vi.fn().mockResolvedValue(true),
}));

import { activate, deactivate } from './extension.js';
import * as vscode from 'vscode';
import { renderTranscript } from './transcriptRenderer.js';
import { ensureSessionMetadata } from './sessionRepair.js';

describe('extension', () => {
  let context: {
    extensionUri: { scheme: string; fsPath: string };
    extensionPath: string;
    globalStorageUri: { scheme: string; fsPath: string };
    subscriptions: Array<{ dispose: () => void }>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    context = {
      extensionUri: { scheme: 'file', fsPath: '/test/ext' },
      extensionPath: '/test/ext',
      globalStorageUri: { scheme: 'file', fsPath: '/test/data/User/globalStorage/snowmeltio.serac' },
      subscriptions: [],
    };
    (vscode.window.tabGroups as any).all = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns early when no workspace folders', () => {
    const orig = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = undefined;
    activate(context as any);
    expect(mockDiscovery.start).not.toHaveBeenCalled();
    (vscode.workspace as any).workspaceFolders = orig;
  });

  it('creates output channel, discovery, usage provider, and panel', () => {
    activate(context as any);
    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Serac', { log: true });
    expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalled();
    expect(mockDiscovery.start).toHaveBeenCalled();
    expect(mockUsageProvider.start).toHaveBeenCalled();
  });

  it('registers subscriptions for disposal', () => {
    activate(context as any);
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(3);
  });

  it('registers refresh and focusSession commands', () => {
    activate(context as any);
    const cmds = vi.mocked(vscode.commands.registerCommand).mock.calls.map(c => c[0]);
    expect(cmds).toContain('agentActivity.refresh');
    expect(cmds).toContain('agentActivity.focusSession');
  });

  describe('focus handler', () => {
    it('calls ensureSessionMetadata for non-running sessions', async () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.isSessionRunning.mockReturnValue(false);
      mockDiscovery.getSessionFilePath.mockReturnValue('/test/session.jsonl');

      focusHandler('test-session');

      expect(ensureSessionMetadata).toHaveBeenCalledWith('test-session', '/test/session.jsonl');
      // openClaudeEditor awaits the fresh external-writer check before opening —
      // one microtask tick, even though isExternalWriterFresh resolves false.
      await vi.waitFor(() => {
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'claude-vscode.editor.open', 'test-session', undefined, 1,
        );
      });
    });

    it('skips ensureSessionMetadata for running sessions', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.isSessionRunning.mockReturnValue(true);

      focusHandler('test-session');

      expect(ensureSessionMetadata).not.toHaveBeenCalled();
    });

    it('hands off (writes an addressed hint under the OWNER\'s workspace key, never opens here) when the external owner is addressable', async () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.resolveOpenGate.mockResolvedValueOnce(
        { kind: 'external', ownerPid: 4321, ownerCwd: '/owner/worktree-b', addressable: true, quietUnlocked: false });

      focusHandler('test-session');

      const opener = await import('./workspaceOpener.js');
      const { sanitiseWorkspaceKey } = await import('./panelUtils.js');
      await vi.waitFor(() => {
        // Keyed by the owner's registered cwd — a sibling-worktree owner
        // watches its own folder's key, not the clicking window's.
        expect(vi.mocked(opener.writeAddressedFocusHint)).toHaveBeenCalledWith(
          expect.any(String), sanitiseWorkspaceKey('/owner/worktree-b'), 4321, 'test-session');
      });
      // The gate ran with owner classification requested (the facade path
      // never pays that ps cost; the handoff must).
      expect(mockDiscovery.resolveOpenGate).toHaveBeenCalledWith('test-session', { classifyOwner: true });
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'claude-vscode.editor.open', expect.anything(), expect.anything(), expect.anything(),
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('refuses with a warning when the external owner is not addressable and still recently active', async () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.resolveOpenGate.mockResolvedValueOnce(
        { kind: 'external', ownerPid: null, ownerCwd: null, addressable: false, quietUnlocked: false });

      focusHandler('test-session');

      await vi.waitFor(() => {
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          expect.stringContaining('another VS Code window'),
        );
      });
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'claude-vscode.editor.open', expect.anything(), expect.anything(), expect.anything(),
      );
    });

    it('opens locally when a non-addressable owner has been quiet past the window (legacy unlock)', async () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.resolveOpenGate.mockResolvedValueOnce(
        { kind: 'external', ownerPid: null, ownerCwd: null, addressable: false, quietUnlocked: true });

      focusHandler('test-session');

      await vi.waitFor(() => {
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'claude-vscode.editor.open', 'test-session', undefined, 1,
        );
      });
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('addressed-hint receiver: self-foregrounds, reveals the card, and re-runs the gate (no bypass)', async () => {
      const opener = await import('./workspaceOpener.js');
      // Only the ADDRESSED hint (basename carries our pid) yields — the legacy
      // focus-hint.json consume shares the mock and must stay empty.
      vi.mocked(opener.consumeFocusHint).mockImplementation(async (p: string) =>
        p.includes(`focus-hint-${process.pid}`) ? { sessionId: 'handoff-sess', requestedAt: Date.now() } : null);
      activate(context as any);

      await vi.advanceTimersByTimeAsync(900); // past the 800ms startup consume

      expect(vi.mocked(opener.openWorkspaceFolder)).toHaveBeenCalledWith(
        expect.any(String), { userDataDir: '/test/user-data', cliOnly: true });
      expect(mockPanelProvider.focusSession).toHaveBeenCalledWith('handoff-sess');
      // The receiver re-runs the open gate: own-window precedence in
      // aggregateWriterOwnership makes that safe (no hint ping-pong), and it
      // keeps forwarding/blocking behaviour for drifted ownership.
      expect(mockDiscovery.resolveOpenGate).toHaveBeenCalledWith('handoff-sess', { classifyOwner: true });
      await vi.waitFor(() => {
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'claude-vscode.editor.open', 'handoff-sess', undefined, 1,
        );
      });
    });

    it('addressed-hint receiver: rejects a hint whose sessionId fails validation', async () => {
      const opener = await import('./workspaceOpener.js');
      vi.mocked(opener.consumeFocusHint).mockImplementation(async (p: string) =>
        p.includes(`focus-hint-${process.pid}`) ? { sessionId: '../../evil', requestedAt: Date.now() } : null);
      activate(context as any);

      await vi.advanceTimersByTimeAsync(900);

      expect(vi.mocked(opener.openWorkspaceFolder)).not.toHaveBeenCalledWith(
        expect.any(String), expect.objectContaining({ cliOnly: true }));
      expect(mockPanelProvider.focusSession).not.toHaveBeenCalled();
    });

    it('skips the ensureSessionMetadata write for an externally-owned session — viewing must never claim', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.isSessionRunning.mockReturnValue(false);
      mockDiscovery.getSessionFilePath.mockReturnValue('/test/session.jsonl');
      mockDiscovery.isMarkedExternalWriter.mockReturnValueOnce(true);

      focusHandler('test-session');

      expect(ensureSessionMetadata).not.toHaveBeenCalled();
    });

    it('does not run acknowledge bookkeeping for an externally-owned click — hand-off, not a view', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];

      focusHandler('session-a');
      // External card click: must neither acknowledge session-a nor become
      // the "previously focused" session itself.
      mockDiscovery.isMarkedExternalWriter.mockReturnValueOnce(true);
      focusHandler('session-b');
      expect(mockDiscovery.acknowledgeIfDone).not.toHaveBeenCalled();

      // A later normal focus still acknowledges session-a, proving the
      // external click never overwrote the tracked previous session.
      focusHandler('session-c');
      expect(mockDiscovery.acknowledgeIfDone).toHaveBeenCalledWith('session-a');
      expect(mockDiscovery.acknowledgeIfDone).not.toHaveBeenCalledWith('session-b');
    });

    it('acknowledges previous session when focus changes', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];

      focusHandler('session-a');
      focusHandler('session-b');

      expect(mockDiscovery.acknowledgeIfDone).toHaveBeenCalledWith('session-a');
      expect(mockDiscovery.acknowledgeSubagents).toHaveBeenCalledWith('session-a');
    });

    it('does not acknowledge when refocusing same session', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];

      focusHandler('session-a');
      focusHandler('session-a');

      expect(mockDiscovery.acknowledgeIfDone).not.toHaveBeenCalled();
    });
  });

  describe('dual-writer resolve handler', () => {
    const claudeTab = (uri: string, isActive = false) =>
      ({ input: { viewType: 'mainThreadWebview-claudeVSCode.editor', uri }, isActive });
    const getHandler = () =>
      vi.mocked(mockPanelProvider.setResolveDualWriterHandler).mock.calls[0][0] as (id: string) => void;

    it('bails with a status message (no picker) when the fresh check says the conflict is gone', async () => {
      activate(context as any);
      mockDiscovery.isDualWriterFresh.mockResolvedValueOnce(false);
      getHandler()('dual-sess');
      await vi.waitFor(() => {
        expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
          expect.stringContaining('no longer live in two windows'), expect.any(Number));
      });
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });

    it('release-here closes this window\'s session tab, matched by session id in the tab input', async () => {
      activate(context as any);
      mockDiscovery.isDualWriterFresh.mockResolvedValue(true);
      mockDiscovery.getProcessesForSession.mockReturnValue([
        { pid: 111, sessionId: 'dual-sess', cwd: '/owner/dir', startedAt: Date.now() },
        { pid: 222, sessionId: 'dual-sess', cwd: '/test/ws', startedAt: Date.now() },
      ]);
      mockDiscovery.getOwnershipOf.mockImplementation((pid: number) => pid === 111 ? true : false);
      mockDiscovery.getOwnerPidOf.mockImplementation((pid: number) => pid === 111 ? 4321 : undefined);
      vi.mocked(vscode.window.showQuickPick).mockImplementation(
        async (items: any) => (items as any[]).find(i => i.action === 'release'));
      const tab = claudeTab('claude-chat://dual-sess');
      (vscode.window.tabGroups as any).all = [{ tabs: [claudeTab('claude-chat://other-sess'), tab] }];

      getHandler()('dual-sess');

      await vi.waitFor(() => {
        expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(tab);
      });
    });

    it('keep-here writes an addressed release hint under the OTHER window\'s workspace key', async () => {
      activate(context as any);
      mockDiscovery.isDualWriterFresh.mockResolvedValue(true);
      mockDiscovery.getProcessesForSession.mockReturnValue([
        { pid: 111, sessionId: 'dual-sess', cwd: '/owner/dir', startedAt: Date.now() },
        { pid: 222, sessionId: 'dual-sess', cwd: '/test/ws', startedAt: Date.now() },
      ]);
      mockDiscovery.getOwnershipOf.mockImplementation((pid: number) => pid === 111 ? true : false);
      mockDiscovery.getOwnerPidOf.mockImplementation((pid: number) => pid === 111 ? 4321 : undefined);
      vi.mocked(vscode.window.showQuickPick).mockImplementation(
        async (items: any) => (items as any[]).find(i => i.action === 'keep'));

      getHandler()('dual-sess');

      const opener = await import('./workspaceOpener.js');
      const { sanitiseWorkspaceKey } = await import('./panelUtils.js');
      await vi.waitFor(() => {
        expect(vi.mocked(opener.writeAddressedReleaseHint)).toHaveBeenCalledWith(
          expect.any(String), sanitiseWorkspaceKey('/owner/dir'), 4321, 'dual-sess');
      });
      expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
    });

    it('keep-here warns instead of writing when the other window is not addressable', async () => {
      activate(context as any);
      const { isExtensionHostPid } = await import('./writerOwnership.js');
      vi.mocked(isExtensionHostPid).mockResolvedValueOnce(false);
      mockDiscovery.isDualWriterFresh.mockResolvedValue(true);
      mockDiscovery.getProcessesForSession.mockReturnValue([
        { pid: 111, sessionId: 'dual-sess', cwd: '/owner/dir', startedAt: Date.now() },
      ]);
      mockDiscovery.getOwnershipOf.mockReturnValue(true);
      mockDiscovery.getOwnerPidOf.mockReturnValue(4321);
      vi.mocked(vscode.window.showQuickPick).mockImplementation(
        async (items: any) => (items as any[]).find(i => i.action === 'keep'));

      getHandler()('dual-sess');

      await vi.waitFor(() => {
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          expect.stringContaining('could not be addressed'));
      });
      const opener = await import('./workspaceOpener.js');
      expect(vi.mocked(opener.writeAddressedReleaseHint)).not.toHaveBeenCalled();
    });

    it('release-hint receiver: consumes the addressed hint and closes the session tab', async () => {
      mockDiscovery.isDualWriterFresh.mockResolvedValue(true);
      const opener = await import('./workspaceOpener.js');
      let armed = false;
      vi.mocked(opener.consumeFocusHint).mockImplementation(async (p: string) =>
        armed && p.includes(`release-hint-${process.pid}`)
          ? { sessionId: 'released-sess', requestedAt: Date.now() } : null);
      const tab = claudeTab('claude-chat://released-sess');
      (vscode.window.tabGroups as any).all = [{ tabs: [tab] }];
      activate(context as any);
      armed = true; // after activation so the focus-hint startup consumes see null

      // Fire the release watcher's onDidCreate — matched by its watched basename.
      const watcherCalls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock;
      const idx = watcherCalls.calls.findIndex(c =>
        (c[0] as { pattern?: string })?.pattern === `release-hint-${process.pid}.json`);
      expect(idx).toBeGreaterThanOrEqual(0);
      const watcher = watcherCalls.results[idx].value as { onDidCreate: ReturnType<typeof vi.fn> };
      (watcher.onDidCreate.mock.calls[0][0] as () => void)();

      await vi.waitFor(() => {
        expect(vscode.window.tabGroups.close).toHaveBeenCalledWith(tab);
      });
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('Released a session'), expect.any(Number));
    });

    it('release-hint receiver: ignores a hint when the session is no longer dual at pickup', async () => {
      mockDiscovery.isDualWriterFresh.mockResolvedValue(false);
      const opener = await import('./workspaceOpener.js');
      let armed = false;
      vi.mocked(opener.consumeFocusHint).mockImplementation(async (p: string) =>
        armed && p.includes(`release-hint-${process.pid}`)
          ? { sessionId: 'stale-sess', requestedAt: Date.now() } : null);
      activate(context as any);
      armed = true;

      const watcherCalls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock;
      const idx = watcherCalls.calls.findIndex(c =>
        (c[0] as { pattern?: string })?.pattern === `release-hint-${process.pid}.json`);
      const watcher = watcherCalls.results[idx].value as { onDidCreate: ReturnType<typeof vi.fn> };
      (watcher.onDidCreate.mock.calls[0][0] as () => void)();

      await vi.advanceTimersByTimeAsync(50);
      expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
      // The focus-then-close fallback must not run either — it would OPEN
      // the session in a window whose copy is already gone.
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'claude-vscode.editor.open', expect.anything(), expect.anything(), expect.anything());
    });

    it('mutual keep: a release hint arriving after this window requested keep is refused', async () => {
      mockDiscovery.isDualWriterFresh.mockResolvedValue(true);
      mockDiscovery.getProcessesForSession.mockReturnValue([
        { pid: 111, sessionId: 'dual-sess', cwd: '/owner/dir', startedAt: Date.now() },
        { pid: 222, sessionId: 'dual-sess', cwd: '/test/ws', startedAt: Date.now() },
      ]);
      mockDiscovery.getOwnershipOf.mockImplementation((pid: number) => pid === 111 ? true : false);
      mockDiscovery.getOwnerPidOf.mockImplementation((pid: number) => pid === 111 ? 4321 : undefined);
      vi.mocked(vscode.window.showQuickPick).mockImplementation(
        async (items: any) => (items as any[]).find(i => i.action === 'keep'));
      const opener = await import('./workspaceOpener.js');
      let armed = false;
      vi.mocked(opener.consumeFocusHint).mockImplementation(async (p: string) =>
        armed && p.includes(`release-hint-${process.pid}`)
          ? { sessionId: 'dual-sess', requestedAt: Date.now() } : null);
      activate(context as any);

      // This window picks "keep here" (arming the guard)…
      getHandler()('dual-sess');
      await vi.waitFor(() => {
        expect(vi.mocked(opener.writeAddressedReleaseHint)).toHaveBeenCalled();
      });

      // …then the OTHER window's mirror-image release hint arrives.
      armed = true;
      const watcherCalls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock;
      const idx = watcherCalls.calls.findIndex(c =>
        (c[0] as { pattern?: string })?.pattern === `release-hint-${process.pid}.json`);
      const watcher = watcherCalls.results[idx].value as { onDidCreate: ReturnType<typeof vi.fn> };
      (watcher.onDidCreate.mock.calls[0][0] as () => void)();

      await vi.waitFor(() => {
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
          expect.stringContaining('Both windows chose to keep'));
      });
      expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
    });

    it('release-hint receiver: rejects a hint whose sessionId fails validation', async () => {
      const opener = await import('./workspaceOpener.js');
      vi.mocked(opener.consumeFocusHint).mockImplementation(async (p: string) =>
        p.includes(`release-hint-${process.pid}`)
          ? { sessionId: '../../evil', requestedAt: Date.now() } : null);
      activate(context as any);

      const watcherCalls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock;
      const idx = watcherCalls.calls.findIndex(c =>
        (c[0] as { pattern?: string })?.pattern === `release-hint-${process.pid}.json`);
      const watcher = watcherCalls.results[idx].value as { onDidCreate: ReturnType<typeof vi.fn> };
      (watcher.onDidCreate.mock.calls[0][0] as () => void)();

      await vi.advanceTimersByTimeAsync(50);
      expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
      // Never falls through to the focus-then-close fallback either.
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'claude-vscode.editor.open', expect.anything(), expect.anything(), expect.anything());
    });
  });

  describe('Remote Control indicator click handler', () => {
    const getHandler = () =>
      vi.mocked(mockPanelProvider.setRcIndicatorClickHandler).mock.calls[0][0] as () => void;
    const makeTerminal = () => {
      const terminal = { show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() };
      vi.mocked(vscode.window.createTerminal).mockReturnValue(terminal as any);
      return terminal;
    };

    it('offers only what is off: auto-enrol on + no server → server routes, no settings row', async () => {
      activate(context as any);
      mockDiscovery.getRcServing.mockReturnValue(false);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
      getHandler()();
      await vi.waitFor(() => expect(vscode.window.showQuickPick).toHaveBeenCalled());
      const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as Array<{ action: string }>;
      const actions = items.map(i => i.action);
      expect(actions).toContain('start');
      expect(actions).not.toContain('settings');
      expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    });

    it('"start" opens a visible terminal in the workspace with the exthost env stripped and runs claude rc', async () => {
      activate(context as any);
      mockDiscovery.getRcServing.mockReturnValue(false);
      const terminal = makeTerminal();
      vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(
        async (items: any) => (items as Array<{ action: string }>).find(i => i.action === 'start'));
      const saved = { VSCODE_PID: process.env.VSCODE_PID, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE };
      process.env.VSCODE_PID = '4242';
      process.env.ELECTRON_RUN_AS_NODE = '1';
      try {
        getHandler()();
        await vi.waitFor(() => expect(terminal.sendText).toHaveBeenCalled());
      } finally {
        if (saved.VSCODE_PID === undefined) { delete process.env.VSCODE_PID; } else { process.env.VSCODE_PID = saved.VSCODE_PID; }
        if (saved.ELECTRON_RUN_AS_NODE === undefined) { delete process.env.ELECTRON_RUN_AS_NODE; } else { process.env.ELECTRON_RUN_AS_NODE = saved.ELECTRON_RUN_AS_NODE; }
      }
      const opts = vi.mocked(vscode.window.createTerminal).mock.calls[0][0] as any;
      expect(opts.cwd).toBe('/test/ws');
      expect(opts.env).toMatchObject({ VSCODE_PID: null, ELECTRON_RUN_AS_NODE: null });
      expect(opts.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(terminal.show).toHaveBeenCalled();
      const cmd = terminal.sendText.mock.calls[0][0] as string;
      expect(cmd).toMatch(/claude rc --spawn worktree$/);
      // Serac starts; it never stops. No process handle is kept, no kill path exists.
      expect(terminal.dispose).not.toHaveBeenCalled();
    });

    it('"install" runs the shipped installer from the extension path against this workspace', async () => {
      activate(context as any);
      mockDiscovery.getRcServing.mockReturnValue(false);
      const terminal = makeTerminal();
      vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(
        async (items: any) => (items as Array<{ action: string }>).find(i => i.action === 'install'));
      getHandler()();
      await vi.waitFor(() => expect(terminal.sendText).toHaveBeenCalled());
      const cmd = terminal.sendText.mock.calls[0][0] as string;
      expect(cmd).toBe('bash /test/ext/scripts/rc-headless/install.sh /test/ws');
    });

    it('"settings" opens settings.json at the key and writes nothing', async () => {
      const { readRemoteControlAtStartup } = await import('./claudeSettings.js');
      vi.mocked(readRemoteControlAtStartup).mockReturnValueOnce(false);
      activate(context as any);
      mockDiscovery.getRcServing.mockReturnValue(true);
      const text = '{\n  "model": "opus",\n  "remoteControlAtStartup": false\n}\n';
      const doc = { getText: () => text, positionAt: vi.fn((i: number) => ({ offset: i })) };
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValueOnce(doc as any);
      const editor = { selection: undefined as unknown, revealRange: vi.fn() };
      vi.mocked(vscode.window.showTextDocument).mockResolvedValueOnce(editor as any);
      vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(
        async (items: any) => {
          const actions = (items as Array<{ action: string }>).map(i => i.action);
          // Server is on, so only the settings route is offered.
          expect(actions).toEqual(['settings']);
          return (items as Array<{ action: string }>)[0];
        });
      getHandler()();
      await vi.waitFor(() => expect(editor.revealRange).toHaveBeenCalled());
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: '/mock/.claude/settings.json' }));
      expect(doc.positionAt).toHaveBeenCalledWith(text.indexOf('remoteControlAtStartup'));
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Serac does not change it'));
      expect(vscode.window.createTerminal).not.toHaveBeenCalled();
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1);
    });

    it('says so and offers nothing when both facts are already on', async () => {
      activate(context as any);
      mockDiscovery.getRcServing.mockReturnValue(true);
      getHandler()();
      await vi.waitFor(() => expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('already fully on'), expect.any(Number)));
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });

    it('passes rcAutoEnrol to the panel on every update, re-read when a settings file changes', async () => {
      const { readRemoteControlAtStartup } = await import('./claudeSettings.js');
      activate(context as any);
      const startCb = vi.mocked(mockDiscovery.start).mock.calls[0][0];
      vi.advanceTimersByTime(700);
      startCb();
      const lastCall = () => vi.mocked(mockPanelProvider.updateSessions).mock.calls.at(-1)![0] as any;
      expect(lastCall()).toHaveProperty('rcAutoEnrol', true);
      expect(readRemoteControlAtStartup).toHaveBeenCalledWith('/test/ws');

      // Both the user settings.json watcher and the workspace .claude/settings
      // watcher re-read the flag; fire the project-layer one.
      const watchers = vi.mocked(vscode.workspace.createFileSystemWatcher).mock;
      const projectIdx = watchers.calls.findIndex(c => (c[0] as any)?.pattern === 'settings{,.local}.json');
      expect(projectIdx).toBeGreaterThanOrEqual(0);
      const onDidChange = vi.mocked((watchers.results[projectIdx].value as any).onDidChange);
      vi.mocked(readRemoteControlAtStartup).mockReturnValue(false);
      vi.advanceTimersByTime(300);
      (onDidChange.mock.calls[0][0] as () => void)();
      expect(lastCall()).toHaveProperty('rcAutoEnrol', false);
      vi.mocked(readRemoteControlAtStartup).mockReturnValue(true);
    });
  });

  describe('dismiss handler', () => {
    it('dismisses session and triggers update', () => {
      activate(context as any);
      const dismissHandler = vi.mocked(mockPanelProvider.setDismissHandler).mock.calls[0][0];
      dismissHandler('test-session');

      expect(mockDiscovery.dismissSession).toHaveBeenCalledWith('test-session');
      expect(mockPanelProvider.updateSessions).toHaveBeenCalled();
    });

    it('acknowledges focused session on dismiss', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      const dismissHandler = vi.mocked(mockPanelProvider.setDismissHandler).mock.calls[0][0];

      focusHandler('session-a');
      dismissHandler('session-a');

      expect(mockDiscovery.acknowledgeIfDone).toHaveBeenCalledWith('session-a');
    });
  });

  describe('cleanup handler', () => {
    it('closes all Claude Code tabs except the active one', () => {
      activate(context as any);
      (vscode.window.tabGroups as any).all = [{
        tabs: [
          { input: { viewType: 'claudeVSCode.editor' }, isActive: true },
          { input: { viewType: 'claudeVSCode.editor' }, isActive: false },
          { input: { viewType: 'claudeVSCode.editor' }, isActive: false },
          { input: { viewType: 'markdown' }, isActive: false },
        ],
      }];

      const cleanupHandler = vi.mocked(mockPanelProvider.setCleanupHandler).mock.calls[0][0];
      cleanupHandler();

      expect(vscode.window.tabGroups.close).toHaveBeenCalledTimes(2);
    });

    it('does not close when only 1 Claude tab exists', () => {
      activate(context as any);
      (vscode.window.tabGroups as any).all = [{
        tabs: [{ input: { viewType: 'claudeVSCode.editor' }, isActive: true }],
      }];

      const cleanupHandler = vi.mocked(mockPanelProvider.setCleanupHandler).mock.calls[0][0];
      cleanupHandler();

      expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
    });

    it('keeps first tab when no active tab', () => {
      activate(context as any);
      (vscode.window.tabGroups as any).all = [{
        tabs: [
          { input: { viewType: 'claudeVSCode.editor' }, isActive: false },
          { input: { viewType: 'claudeVSCode.editor' }, isActive: false },
        ],
      }];

      const cleanupHandler = vi.mocked(mockPanelProvider.setCleanupHandler).mock.calls[0][0];
      cleanupHandler();

      // Should close 1 (keeps first)
      expect(vscode.window.tabGroups.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('new chat handler', () => {
    it('opens Claude Code editor', () => {
      activate(context as any);
      const newChatHandler = vi.mocked(mockPanelProvider.setNewChatHandler).mock.calls[0][0];
      newChatHandler();

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'claude-vscode.editor.open', undefined, undefined, 1,
      );
    });
  });

  describe('transcript handler', () => {
    it('renders and opens transcript', async () => {
      activate(context as any);
      mockDiscovery.getSessionFilePath.mockReturnValue('/test/session.jsonl');

      const handler = vi.mocked(mockPanelProvider.setTranscriptHandler).mock.calls[0][0];
      handler('test-session');

      expect(renderTranscript).toHaveBeenCalledWith('/test/session.jsonl', 'test-session', '/test/ws');
      await vi.waitFor(() => {
        expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
      });
    });

    it('shows warning when session file not found', () => {
      activate(context as any);
      mockDiscovery.getSessionFilePath.mockReturnValue(null);

      const handler = vi.mocked(mockPanelProvider.setTranscriptHandler).mock.calls[0][0];
      handler('test-session');

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Session file not found.');
    });

    it('shows error on render failure', async () => {
      activate(context as any);
      mockDiscovery.getSessionFilePath.mockReturnValue('/test/session.jsonl');
      vi.mocked(renderTranscript).mockRejectedValue(new Error('boom'));

      const handler = vi.mocked(mockPanelProvider.setTranscriptHandler).mock.calls[0][0];
      handler('test-session');
      await vi.waitFor(() => {
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
          expect.stringContaining('boom'),
        );
      });
    });
  });

  describe('undismiss handler', () => {
    it('undismisses and opens editor', async () => {
      activate(context as any);
      mockDiscovery.isSessionRunning.mockReturnValue(false);
      mockDiscovery.getSessionFilePath.mockReturnValue('/test/session.jsonl');

      const handler = vi.mocked(mockPanelProvider.setUndismissHandler).mock.calls[0][0];
      handler('test-session');

      expect(mockDiscovery.undismissSession).toHaveBeenCalledWith('test-session');
      await vi.waitFor(() => {
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'claude-vscode.editor.open', 'test-session', undefined, 1,
        );
      });
    });
  });

  describe('openWorkspace confinement (audit security-webview-1)', () => {
    async function getHandler(): Promise<(cwd: string, sessionId?: string) => Promise<void>> {
      activate(context as any);
      return vi.mocked(mockPanelProvider.setOpenWorkspaceHandler).mock.calls[0][0];
    }

    it('opens a discovered foreign workspace cwd', async () => {
      const handler = await getHandler();
      mockDiscovery.getForeignWorkspaces.mockReturnValue([
        { workspaceKey: 'k', displayName: 'repo', cwd: '/foreign/repo', counts: {}, confidence: 'low', repoRoot: null },
      ]);
      await handler('/foreign/repo');
      const opener = await import('./workspaceOpener.js');
      // Pinned to this window's own instance (multi-profile: a bare CLI call
      // could route to a different profile's window).
      expect(vi.mocked(opener.openWorkspaceFolder)).toHaveBeenCalledWith('/foreign/repo', { userDataDir: '/test/user-data' });
    });

    it('opens a discovered worktree path from the picker', async () => {
      const handler = await getHandler();
      mockDiscovery.getForeignWorkspaces.mockReturnValue([
        { workspaceKey: 'k', displayName: 'repo', cwd: '/foreign/repo', counts: {}, confidence: 'low', repoRoot: '/foreign/repo', worktrees: [{ path: '/foreign/repo-wt', branch: 'fix', isMain: false }] },
      ]);
      await handler('/foreign/repo-wt');
      const opener = await import('./workspaceOpener.js');
      expect(vi.mocked(opener.openWorkspaceFolder)).toHaveBeenCalledWith('/foreign/repo-wt', { userDataDir: '/test/user-data' });
    });

    it('rejects a path outside the discovered workspace set', async () => {
      const handler = await getHandler();
      await handler('/etc');
      const opener = await import('./workspaceOpener.js');
      expect(vi.mocked(opener.openWorkspaceFolder)).not.toHaveBeenCalled();
    });

    it('rejects traversal into an undiscovered parent of a discovered cwd', async () => {
      const handler = await getHandler();
      mockDiscovery.getForeignWorkspaces.mockReturnValue([
        { workspaceKey: 'k', displayName: 'repo', cwd: '/foreign/repo', counts: {}, confidence: 'low', repoRoot: null },
      ]);
      await handler('/foreign/repo/../../private/launchd');
      const opener = await import('./workspaceOpener.js');
      expect(vi.mocked(opener.openWorkspaceFolder)).not.toHaveBeenCalled();
    });
  });

  describe('team archive handlers', () => {
    it('dismissing the orchestrator session card archives the team too', () => {
      activate(context as any);
      mockDiscovery.getTeamSnapshots.mockReturnValue([
        { teamId: 'at:my-team', dismissed: false, orchestrator: { sessionId: 'lead-1' }, agents: [] },
      ]);
      const handler = vi.mocked(mockPanelProvider.setDismissHandler).mock.calls[0][0];
      handler('lead-1');
      expect(mockDiscovery.dismissSession).toHaveBeenCalledWith('lead-1');
      expect(mockDiscovery.dismissTeam).toHaveBeenCalledWith('at:my-team');
    });

    it('dismissing a non-orchestrator session leaves teams alone', () => {
      activate(context as any);
      mockDiscovery.getTeamSnapshots.mockReturnValue([
        { teamId: 'at:my-team', dismissed: false, orchestrator: { sessionId: 'lead-1' }, agents: [] },
      ]);
      const handler = vi.mocked(mockPanelProvider.setDismissHandler).mock.calls[0][0];
      handler('other-session');
      expect(mockDiscovery.dismissTeam).not.toHaveBeenCalled();
    });

    it('undismissTeam reopens the orchestrator session resolved from the snapshot', async () => {
      activate(context as any);
      // teamId is NOT the orchestrator session id (Agent Teams use `at:<name>`);
      // the lead session is resolved from the snapshot's orchestrator.sessionId.
      mockDiscovery.getTeamSnapshots.mockReturnValue([
        { teamId: 'at:my-team', orchestrator: { sessionId: 'lead-session' }, agents: [], dismissed: false },
      ]);

      const handler = vi.mocked(mockPanelProvider.setUndismissTeamHandler).mock.calls[0][0];
      handler('at:my-team');

      expect(mockDiscovery.undismissTeam).toHaveBeenCalledWith('at:my-team');
      await vi.waitFor(() => {
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'claude-vscode.editor.open', 'lead-session', undefined, 1,
        );
      });
    });

    it('undismissTeam still undismisses when the team has no resolvable orchestrator', () => {
      activate(context as any);
      mockDiscovery.getTeamSnapshots.mockReturnValue([]);

      const handler = vi.mocked(mockPanelProvider.setUndismissTeamHandler).mock.calls[0][0];
      handler('at:orphan');

      expect(mockDiscovery.undismissTeam).toHaveBeenCalledWith('at:orphan');
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'claude-vscode.editor.open', expect.anything(), undefined, 1,
      );
    });
  });

  describe('workflow archive handlers', () => {
    it('dismissWorkflow archives the run via discovery', () => {
      activate(context as any);
      const handler = vi.mocked(mockPanelProvider.setDismissWorkflowHandler).mock.calls[0][0];
      handler('wf_run-001');
      expect(mockDiscovery.dismissWorkflow).toHaveBeenCalledWith('wf_run-001');
    });

    it('undismissWorkflow reopens the invoking conversation resolved from the snapshot', async () => {
      activate(context as any);
      // The runId is NOT a sessionId — the parent session is resolved from the
      // snapshot's sessionId, then reopened.
      mockDiscovery.getWorkflowSnapshots.mockReturnValue([
        { runId: 'wf_run-002', sessionId: 'owner-session' },
      ]);

      const handler = vi.mocked(mockPanelProvider.setUndismissWorkflowHandler).mock.calls[0][0];
      handler('wf_run-002');

      expect(mockDiscovery.undismissWorkflow).toHaveBeenCalledWith('wf_run-002');
      await vi.waitFor(() => {
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          'claude-vscode.editor.open', 'owner-session', undefined, 1,
        );
      });
    });

    it('undismissWorkflow still undismisses when the run has no resolvable session', () => {
      activate(context as any);
      mockDiscovery.getWorkflowSnapshots.mockReturnValue([]);

      const handler = vi.mocked(mockPanelProvider.setUndismissWorkflowHandler).mock.calls[0][0];
      handler('wf_orphan');

      expect(mockDiscovery.undismissWorkflow).toHaveBeenCalledWith('wf_orphan');
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        'claude-vscode.editor.open', expect.anything(), undefined, 1,
      );
    });
  });

  describe('sendUpdate debounce', () => {
    it('debounces rapid updates to 200ms', () => {
      activate(context as any);
      const startCb = vi.mocked(mockDiscovery.start).mock.calls[0][0];

      // Advance past the initial 500ms setTimeout + let debounce window expire
      vi.advanceTimersByTime(700);
      mockPanelProvider.updateSessions.mockClear();

      // First call should go through
      startCb();
      expect(vi.mocked(mockPanelProvider.updateSessions).mock.calls.length).toBe(1);

      // Immediate second call should be debounced
      startCb();
      expect(vi.mocked(mockPanelProvider.updateSessions).mock.calls.length).toBe(1);

      // After 200ms, should go through
      vi.advanceTimersByTime(200);
      startCb();
      expect(vi.mocked(mockPanelProvider.updateSessions).mock.calls.length).toBe(2);
    });
  });

  describe('new-session auto-focus', () => {
    function tick() {
      const startCb = vi.mocked(mockDiscovery.start).mock.calls[0][0];
      startCb();
      // sendUpdate is debounced to 200ms — flush so each tick is one update.
      vi.advanceTimersByTime(250);
    }
    // A snapshot that mirrors what production actually emits for a LOCAL session:
    // firstActivity defaults to "just now" (reads as a genuinely new chat), and
    // worktreeRoot is tagged with the current workspace path — sessionDiscovery
    // sets `snapshot.worktreeRoot = localCwd` for every local session, so a test
    // omitting it would not exercise the local/sibling gate. The mock workspace
    // is '/test/ws'. Override either field per test (e.g. a sibling worktreeRoot).
    const WS = '/test/ws';
    function snap(over: Record<string, unknown>) {
      return { firstActivity: Date.now(), worktreeRoot: WS, ...over };
    }
    // Flush the one-shot startup timers (deferred sendUpdate @500ms, focus hint
    // @800ms) so they can't consume the 200ms sendUpdate debounce window on a
    // later tick(). Call after the seed tick, before any further diff tick.
    function drainStartupTimers() {
      vi.advanceTimersByTime(1000);
      mockPanelProvider.focusSession.mockClear();
    }

    it('does not focus on the seeding (first) update', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
      ]);
      tick();
      expect(mockPanelProvider.focusSession).not.toHaveBeenCalled();
    });

    it('focuses a single newly discovered live local session — no arming needed', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
      ]);
      tick(); // seed

      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'new-session', status: 'running' }),
      ]);
      tick();

      expect(mockPanelProvider.focusSession).toHaveBeenCalledWith('new-session');
    });

    it('focuses a new chat that arrived non-live, then dequeued to live (enqueue→dequeue race)', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
      ]);
      tick(); // seed
      drainStartupTimers();

      // A new chat's first JSONL record is `enqueue` → status 'done'. It must
      // not be focused while still non-live, and must not be absorbed away.
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'new-chat', status: 'done' }),
      ]);
      tick();
      expect(mockPanelProvider.focusSession).not.toHaveBeenCalled();

      // The moment it dequeues to running it is the new card to focus.
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'new-chat', status: 'running' }),
      ]);
      tick();
      expect(mockPanelProvider.focusSession).toHaveBeenCalledWith('new-chat');
    });

    it('ignores sibling-worktree and non-live newcomers', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
      ]);
      tick(); // seed

      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'wt-session', status: 'running', worktreeRoot: '/repos/serac-wt' }),
        snap({ sessionId: 'old-run', status: 'done' }),
      ]);
      tick();

      expect(mockPanelProvider.focusSession).not.toHaveBeenCalled();
    });

    it('skips a burst of multiple new live sessions', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
      ]);
      tick(); // seed

      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'burst-a', status: 'running' }),
        snap({ sessionId: 'burst-b', status: 'waiting' }),
      ]);
      tick();

      expect(mockPanelProvider.focusSession).not.toHaveBeenCalled();
    });

    it('does not pick a winner when two new chats dequeue to live on the same tick', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
      ]);
      tick(); // seed
      drainStartupTimers();

      // Both arrive non-live (parked, not absorbed)...
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'chat-a', status: 'done' }),
        snap({ sessionId: 'chat-b', status: 'done' }),
      ]);
      tick();
      // ...then dequeue together — the burst guard still picks no winner.
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'chat-a', status: 'running' }),
        snap({ sessionId: 'chat-b', status: 'running' }),
      ]);
      tick();

      expect(mockPanelProvider.focusSession).not.toHaveBeenCalled();
    });

    it('does not re-fire when an OLD re-discovered session is promoted to live', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
      ]);
      tick(); // seed

      // A session re-discovered from outside the scan window replays to an old
      // firstActivity. It arrives done then goes running — but a resume must
      // never yank focus, so the stale firstActivity excludes it.
      const oldFirstActivity = Date.now() - 10 * 60_000;
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'sleeper', status: 'done', firstActivity: oldFirstActivity }),
      ]);
      tick();
      mockDiscovery.getSnapshots.mockReturnValue([
        snap({ sessionId: 'existing-1', status: 'running' }),
        snap({ sessionId: 'sleeper', status: 'running', firstActivity: oldFirstActivity }),
      ]);
      tick();

      expect(mockPanelProvider.focusSession).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('is a no-op function', () => {
      expect(() => deactivate()).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('stops discovery and usage provider', () => {
      activate(context as any);

      // The last subscription should be the dispose wrapper
      const lastSub = context.subscriptions[context.subscriptions.length - 1];
      lastSub.dispose();

      expect(mockDiscovery.stop).toHaveBeenCalled();
      expect(mockUsageProvider.stop).toHaveBeenCalled();
    });
  });

  describe('footer slot exports (A2)', () => {
    it('returns a SeracExports object with apiVersion=1', () => {
      const exports = activate(context as any);
      expect(exports?.apiVersion).toBe(1);
      expect(typeof exports?.registerUsageFooterSlot).toBe('function');
    });

    it('returns the exports surface even when no workspace folder is present', () => {
      const orig = vscode.workspace.workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;
      try {
        const exports = activate(context as any);
        expect(exports?.apiVersion).toBe(1);
        expect(typeof exports?.registerUsageFooterSlot).toBe('function');
      } finally {
        (vscode.workspace as any).workspaceFolders = orig;
      }
    });

    it('registerUsageFooterSlot returns a handle and triggers panel refresh', () => {
      const exports = activate(context as any);
      mockPanelProvider.refresh.mockClear();
      const handle = exports!.registerUsageFooterSlot('s1', { label: 'm@murray.sh' });
      expect(typeof handle.update).toBe('function');
      expect(typeof handle.dispose).toBe('function');
      expect(mockPanelProvider.refresh).toHaveBeenCalledTimes(1);
    });

    it('wires the footer-slot bridge so payloads and clicks reach the registry', () => {
      const exports = activate(context as any);
      const bridgeArgs = mockPanelProvider.setFooterSlotBridge.mock.calls[0];
      expect(bridgeArgs).toBeDefined();
      const [getPayloads, onClick] = bridgeArgs as [() => unknown[], (id: string) => void];

      // No slots → empty payload list
      expect(getPayloads()).toEqual([]);

      // Register a slot with a command and verify the bridge surfaces it
      exports!.registerUsageFooterSlot('account', {
        label: 'murray@snowmelt.io',
        icon: '❄️',
        status: 'warn',
        command: 'snowmelt.openSwitcher',
      });
      const payloads = getPayloads() as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        slotId: 'account',
        label: 'murray@snowmelt.io',
        hasCommand: true,
      });

      // Click → command bus
      const exec = vi.mocked(vscode.commands.executeCommand);
      exec.mockClear();
      // Fix the async return so the .then(undefined, …) chain in extension.ts settles
      exec.mockReturnValue(Promise.resolve(undefined) as any);
      onClick('account');
      expect(exec).toHaveBeenCalledWith('snowmelt.openSwitcher');
    });

    it('drops clicks for unknown slot ids without invoking executeCommand', () => {
      activate(context as any);
      const [, onClick] = mockPanelProvider.setFooterSlotBridge.mock.calls[0] as [
        unknown,
        (id: string) => void,
      ];
      const exec = vi.mocked(vscode.commands.executeCommand);
      exec.mockClear();
      onClick('does-not-exist');
      expect(exec).not.toHaveBeenCalled();
    });
  });
});

describe('extension — activation wiring assertions (test-gap single)', () => {
  let context: { subscriptions: Array<{ dispose(): void }>; extensionUri: unknown };

  beforeEach(() => {
    vi.clearAllMocks();
    context = { subscriptions: [], extensionUri: { scheme: 'file', fsPath: '/ext' } };
  });
  afterEach(() => {
    deactivate();
    for (const d of context.subscriptions) { try { d.dispose(); } catch { /* already disposed */ } }
  });

  it('exports apiVersion 1 with a working slot registrar even with NO workspace (companion contract)', () => {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
    try {
      const exports = activate(context as never);
      expect(exports.apiVersion).toBe(1);
      expect(() => exports.registerUsageFooterSlot('pre-ws-slot', { label: 'x' })).not.toThrow();
    } finally {
      (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders =
        [{ uri: { scheme: 'file', fsPath: '/test/ws' }, name: 'ws', index: 0 }];
    }
  });

  it('wires the footer-slot bridge: a companion-registered slot reaches the panel payloads', () => {
    const exports = activate(context as never);
    expect(mockPanelProvider.setFooterSlotBridge).toHaveBeenCalledTimes(1);
    const [getPayloads] = mockPanelProvider.setFooterSlotBridge.mock.calls[0] as
      [() => Array<{ slotId: string; label: string }>];
    exports.registerUsageFooterSlot('companion-x', { label: 'Companion · ok', status: 'ok' });
    expect(getPayloads().map(p => p.slotId)).toContain('companion-x');
  });

  it('wires every panel handler the webview can invoke (no dead postMessage paths)', () => {
    activate(context as never);
    for (const setter of [
      'setFocusHandler', 'setDismissHandler', 'setUndismissHandler', 'setTranscriptHandler',
      'setNewChatHandler', 'setCleanupHandler', 'setArchiveRangeHandler',
      'setUndismissTeamHandler', 'setOpenDetailHandler',
      'setDismissWorkflowHandler', 'setUndismissWorkflowHandler', 'setOpenWorkspaceHandler',
    ] as const) {
      expect(mockPanelProvider[setter], setter + ' must be wired during activate()')
        .toHaveBeenCalled();
    }
  });
});
