import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (vi.mock is hoisted, so no external variable references in factories) ---

vi.mock('vscode', () => {
  const tabGroups = {
    all: [] as Array<{ tabs: Array<{ input: unknown; isActive: boolean }> }>,
    close: vi.fn(),
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
    workspace: {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/test/ws' }, name: 'ws', index: 0 }],
      openTextDocument: vi.fn().mockResolvedValue({}),
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(), trace: vi.fn(), debug: vi.fn(),
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn(),
      })),
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
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
  getForeignWorkspaces: vi.fn().mockReturnValue([]),
  dismissSession: vi.fn(),
  undismissSession: vi.fn(),
  acknowledgeIfDone: vi.fn(),
  acknowledgeSubagents: vi.fn(),
  isSessionRunning: vi.fn().mockReturnValue(false),
  getSessionFilePath: vi.fn().mockReturnValue(null),
  setArchiveRange: vi.fn().mockResolvedValue(true),
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
  setDismissHandler: vi.fn(),
  setUndismissHandler: vi.fn(),
  setTranscriptHandler: vi.fn(),
  setNewChatHandler: vi.fn(),
  setCleanupHandler: vi.fn(),
  setArchiveRangeHandler: vi.fn(),
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

import { activate, deactivate } from './extension.js';
import * as vscode from 'vscode';
import { renderTranscript } from './transcriptRenderer.js';
import { ensureSessionMetadata } from './sessionRepair.js';

describe('extension', () => {
  let context: { extensionUri: { scheme: string; fsPath: string }; subscriptions: Array<{ dispose: () => void }> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    context = {
      extensionUri: { scheme: 'file', fsPath: '/test/ext' },
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
    it('calls ensureSessionMetadata for non-running sessions', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.isSessionRunning.mockReturnValue(false);
      mockDiscovery.getSessionFilePath.mockReturnValue('/test/session.jsonl');

      focusHandler('test-session');

      expect(ensureSessionMetadata).toHaveBeenCalledWith('test-session', '/test/session.jsonl');
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'claude-vscode.editor.open', 'test-session', undefined, 1,
      );
    });

    it('skips ensureSessionMetadata for running sessions', () => {
      activate(context as any);
      const focusHandler = vi.mocked(mockPanelProvider.setFocusHandler).mock.calls[0][0];
      mockDiscovery.isSessionRunning.mockReturnValue(true);

      focusHandler('test-session');

      expect(ensureSessionMetadata).not.toHaveBeenCalled();
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
    it('undismisses and opens editor', () => {
      activate(context as any);
      mockDiscovery.isSessionRunning.mockReturnValue(false);
      mockDiscovery.getSessionFilePath.mockReturnValue('/test/session.jsonl');

      const handler = vi.mocked(mockPanelProvider.setUndismissHandler).mock.calls[0][0];
      handler('test-session');

      expect(mockDiscovery.undismissSession).toHaveBeenCalledWith('test-session');
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'claude-vscode.editor.open', 'test-session', undefined, 1,
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

  describe('new chat auto-focus', () => {
    it('auto-focuses when new session appears after new chat', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([{ sessionId: 'existing-1' }]);

      const newChatHandler = vi.mocked(mockPanelProvider.setNewChatHandler).mock.calls[0][0];
      newChatHandler();

      // New session appears
      mockDiscovery.getSnapshots.mockReturnValue([
        { sessionId: 'existing-1' },
        { sessionId: 'new-session' },
      ]);

      // Trigger update via start callback
      vi.advanceTimersByTime(500);
      const startCb = vi.mocked(mockDiscovery.start).mock.calls[0][0];
      startCb();

      expect(mockPanelProvider.focusSession).toHaveBeenCalledWith('new-session');
    });

    it('clears pending new chat after 30s timeout', () => {
      activate(context as any);
      mockDiscovery.getSnapshots.mockReturnValue([{ sessionId: 'existing-1' }]);

      const newChatHandler = vi.mocked(mockPanelProvider.setNewChatHandler).mock.calls[0][0];
      newChatHandler();

      vi.advanceTimersByTime(30_000);

      mockDiscovery.getSnapshots.mockReturnValue([
        { sessionId: 'existing-1' },
        { sessionId: 'late-session' },
      ]);
      vi.advanceTimersByTime(200);
      const startCb = vi.mocked(mockDiscovery.start).mock.calls[0][0];
      startCb();

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
});
