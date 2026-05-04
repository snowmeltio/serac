import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode before importing the module under test
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

// Mock crypto for getNonce
vi.mock('crypto', () => ({
  randomBytes: () => ({
    toString: () => 'dGVzdG5vbmNlMTIzNDU2Nzg=',
  }),
}));

import { AgentPanelProvider } from './panelProvider.js';
import {
  Uri,
  createMockWebviewView,
  createMockWebview,
  ViewColumn,
} from './__mocks__/vscode.js';
import type { SessionSnapshot, UsageSnapshot } from './types.js';

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'abc12345',
    slug: 'test-session',
    cwd: '/test/cwd',
    workspaceKey: 'test-workspace',
    topic: 'test topic',
    status: 'running',
    activity: 'editing files',
    subagents: [],
    lastActivity: Date.now(),
    firstActivity: Date.now() - 60_000,
    dismissed: false,
    contextTokens: 50_000,
    searchText: 'test topic editing files',
    modelLabel: 'Opus',
    title: null,
    customTitle: '',
    aiTitle: '',
    confidence: 'high',
    ...overrides,
  };
}

function makeUsage(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    quotaPct5h: 25,
    resetTime: Date.now() + 3_600_000,
    quotaPctWeekly: 10,
    weeklyResetTime: Date.now() + 86_400_000,
    quotaPctWeeklySonnet: null,
    weeklyResetTimeSonnet: null,
    extraUsageEnabled: false,
    extraUsageCredits: null,
    apiConnected: true,
    currentWorkspaceKey: 'test-workspace',
    loaded: true,
    lastPoll: Date.now(),
    ...overrides,
  };
}

describe('AgentPanelProvider', () => {
  let provider: AgentPanelProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AgentPanelProvider(extensionUri);
  });

  describe('viewType', () => {
    it('has the correct static view type', () => {
      expect(AgentPanelProvider.viewType).toBe('agentActivity.panel');
    });
  });

  describe('resolveWebviewView', () => {
    it('sets webview options with scripts enabled', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      expect(webview.options).toEqual({
        enableScripts: true,
        localResourceRoots: [extensionUri],
      });
    });

    it('generates HTML with CSP, nonce, and external script', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      const html = webview.html;
      expect(html).toContain('Content-Security-Policy');
      expect(html).toContain('nonce-');
      expect(html).toContain('panel.js');
      expect(html).toContain('panel.css');
      expect(html).toContain(webview.cspSource);
      expect(html).toContain("'unsafe-inline'");
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('sends initial update after resolving', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'update' }),
      );
    });

    it('registers message handler on webview', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      expect(webview.onDidReceiveMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('message handling', () => {
    let webview: ReturnType<typeof createMockWebview>;

    function setupWithHandlers() {
      webview = createMockWebview();
      const view = createMockWebviewView(webview);

      const handlers = {
        focus: vi.fn(),
        dismiss: vi.fn(),
        undismiss: vi.fn(),
        transcript: vi.fn(),
        newChat: vi.fn(),
        cleanup: vi.fn(),
      };

      provider.setFocusHandler(handlers.focus);
      provider.setDismissHandler(handlers.dismiss);
      provider.setUndismissHandler(handlers.undismiss);
      provider.setTranscriptHandler(handlers.transcript);
      provider.setNewChatHandler(handlers.newChat);
      provider.setCleanupHandler(handlers.cleanup);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      return handlers;
    }

    it('routes focusSession to focus handler', () => {
      const h = setupWithHandlers();
      webview._fireMessage({ type: 'focusSession', sessionId: 'abc123' });
      expect(h.focus).toHaveBeenCalledWith('abc123');
    });

    it('routes dismissSession to dismiss handler', () => {
      const h = setupWithHandlers();
      webview._fireMessage({ type: 'dismissSession', sessionId: 'abc123' });
      expect(h.dismiss).toHaveBeenCalledWith('abc123');
    });

    it('routes undismissSession to undismiss handler', () => {
      const h = setupWithHandlers();
      webview._fireMessage({ type: 'undismissSession', sessionId: 'abc123' });
      expect(h.undismiss).toHaveBeenCalledWith('abc123');
    });

    it('routes viewTranscript to transcript handler', () => {
      const h = setupWithHandlers();
      webview._fireMessage({ type: 'viewTranscript', sessionId: 'abc123' });
      expect(h.transcript).toHaveBeenCalledWith('abc123');
    });

    it('routes newChat to new chat handler', () => {
      const h = setupWithHandlers();
      webview._fireMessage({ type: 'newChat' });
      expect(h.newChat).toHaveBeenCalled();
    });

    it('routes cleanup to cleanup handler', () => {
      const h = setupWithHandlers();
      webview._fireMessage({ type: 'cleanup' });
      expect(h.cleanup).toHaveBeenCalled();
    });

    it('routes requestUpdate to sendUpdate', () => {
      setupWithHandlers();
      webview.postMessage.mockClear();
      webview._fireMessage({ type: 'requestUpdate' });
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'update' }),
      );
    });

    it('ignores invalid messages', () => {
      const h = setupWithHandlers();
      webview._fireMessage(null);
      webview._fireMessage({ type: 'unknownCommand' });
      webview._fireMessage({ type: 'focusSession' }); // missing sessionId
      webview._fireMessage({ type: 'focusSession', sessionId: '../traversal' }); // invalid ID
      expect(h.focus).not.toHaveBeenCalled();
    });

    it('ignores copyToClipboard with oversized text', () => {
      setupWithHandlers();
      webview._fireMessage({ type: 'copyToClipboard', text: 'x'.repeat(1001) });
      // Should not throw, should be silently rejected by validation
    });
  });

  describe('updateSessions', () => {
    it('sends update message with session data', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      webview.postMessage.mockClear();

      const sessions = [makeSnapshot()];
      provider.updateSessions(sessions, 1, '/test/ws', makeUsage());

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update',
          sessions,
          waitingCount: 1,
          workspacePath: '/test/ws',
        }),
      );
    });

    it('sets badge when waiting count > 0', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      provider.updateSessions([], 3, '/test/ws', null);

      expect(view.badge).toEqual({
        value: 3,
        tooltip: '3 sessions waiting',
      });
    });

    it('clears badge when waiting count is 0', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      provider.updateSessions([], 2, '/test/ws', null);
      expect(view.badge).toBeDefined();

      provider.updateSessions([], 0, '/test/ws', null);
      expect(view.badge).toBeUndefined();
    });

    it('singular tooltip for 1 session', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);

      provider.updateSessions([], 1, '/test/ws', null);
      expect(view.badge?.tooltip).toBe('1 session waiting');
    });

    it('does not send if view not resolved', () => {
      // No resolveWebviewView called — should not throw
      provider.updateSessions([], 0, '/test/ws', null);
    });
  });

  describe('focusSession', () => {
    it('posts focusSession message to webview', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      webview.postMessage.mockClear();

      provider.focusSession('test-id');

      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'focusSession',
        sessionId: 'test-id',
      });
    });

    it('does not throw if view not resolved', () => {
      provider.focusSession('test-id');
    });
  });

  describe('footer slot bridge', () => {
    it('includes footerSlots in update messages when payloads are present', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      const slot = { slotId: 's1', label: 'm@murray.sh', hasCommand: false };
      provider.setFooterSlotBridge(() => [slot], () => {});
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      webview.postMessage.mockClear();
      provider.updateSessions([], 0, '/ws', null);
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ footerSlots: [slot] }),
      );
    });

    it('omits footerSlots when no payloads are registered', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.setFooterSlotBridge(() => [], () => {});
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      webview.postMessage.mockClear();
      provider.updateSessions([], 0, '/ws', null);
      const msg = webview.postMessage.mock.calls[0][0];
      expect(msg.footerSlots).toBeUndefined();
    });

    it('routes footerSlotClick messages to the registered click handler', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      const onClick = vi.fn();
      provider.setFooterSlotBridge(() => [], onClick);
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      webview._fireMessage({ type: 'footerSlotClick', slotId: 'snowmelt-account' });
      expect(onClick).toHaveBeenCalledWith('snowmelt-account');
    });

    it('rejects malformed footerSlotClick messages', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      const onClick = vi.fn();
      provider.setFooterSlotBridge(() => [], onClick);
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      webview._fireMessage({ type: 'footerSlotClick' });
      webview._fireMessage({ type: 'footerSlotClick', slotId: '' });
      webview._fireMessage({ type: 'footerSlotClick', slotId: '../etc' });
      expect(onClick).not.toHaveBeenCalled();
    });

    it('refresh() sends a fresh update message', () => {
      const webview = createMockWebview();
      const view = createMockWebviewView(webview);
      provider.resolveWebviewView(view as any, {} as any, {} as any);
      webview.postMessage.mockClear();
      provider.refresh();
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'update' }),
      );
    });
  });
});
