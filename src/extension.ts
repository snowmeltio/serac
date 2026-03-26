import * as vscode from 'vscode';
import { SessionDiscovery } from './sessionDiscovery.js';
import { AgentPanelProvider } from './panelProvider.js';
import { renderTranscript } from './transcriptRenderer.js';
import { UsageProvider } from './usageProvider.js';
import { ensureSessionMetadata } from './sessionRepair.js';

export function activate(context: vscode.ExtensionContext) {
  const workspacePath: string | undefined = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) { return; }
  const wsPath: string = workspacePath;

  const log = vscode.window.createOutputChannel('Serac', { log: true });
  context.subscriptions.push(log);

  const discovery = new SessionDiscovery(wsPath, { log });
  const usageProvider = new UsageProvider(wsPath);
  const panelProvider = new AgentPanelProvider(context.extensionUri);

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentPanelProvider.viewType,
      panelProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Handle session focus: open Claude Code editor panel for the specific session.
  // claude-vscode.editor.open accepts (sessionId, initialPrompt, viewColumn).
  // When called with a session ID, it reveals the existing panel or creates one.
  // Track the previously focused session so we can acknowledge it when focus moves away
  let previouslyFocusedSessionId: string | null = null;

  function acknowledgePrevious() {
    if (previouslyFocusedSessionId) {
      discovery.acknowledgeIfDone(previouslyFocusedSessionId);
      discovery.acknowledgeSubagents(previouslyFocusedSessionId);
      previouslyFocusedSessionId = null;
    }
  }

  panelProvider.setFocusHandler((sessionId: string) => {
    // Acknowledge the previously focused session now that the user has moved off it
    if (previouslyFocusedSessionId && previouslyFocusedSessionId !== sessionId) {
      acknowledgePrevious();
    }
    previouslyFocusedSessionId = sessionId;
    // Ensure the JSONL has summary metadata so the Claude extension can discover it.
    // Skip for running sessions to avoid concurrent write risk.
    if (!discovery.isSessionRunning(sessionId)) {
      const jsonlPath = discovery.getSessionFilePath(sessionId);
      if (jsonlPath) { void ensureSessionMetadata(sessionId, jsonlPath); }
    }
    vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
      undefined,
      () => {
        vscode.window.showInformationMessage(
          'Could not focus Claude Code session. Is the Claude Code extension installed?'
        );
      },
    );
  });

  // Handle new chat: open a fresh Claude Code editor panel, then auto-focus
  // when the JSONL file appears (which happens on first message, not on panel open).
  // We snapshot known IDs and let the regular poll loop detect the new session.
  let pendingNewChatKnownIds: Set<string> | null = null;
  let pendingNewChatTimer: ReturnType<typeof setTimeout> | null = null;
  const NEW_CHAT_TIMEOUT_MS = 30_000;

  panelProvider.setNewChatHandler(() => {
    pendingNewChatKnownIds = new Set(discovery.getSnapshots().map(s => s.sessionId));
    // Clear stale pending state if user abandons the new chat (closes without sending)
    if (pendingNewChatTimer) { clearTimeout(pendingNewChatTimer); }
    pendingNewChatTimer = setTimeout(() => {
      pendingNewChatKnownIds = null;
      pendingNewChatTimer = null;
    }, NEW_CHAT_TIMEOUT_MS);
    vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined, vscode.ViewColumn.One).then(
      undefined,
      () => {
        pendingNewChatKnownIds = null;
        vscode.window.showInformationMessage(
          'Could not open new chat. Is the Claude Code extension installed?'
        );
      },
    );
  });

  // Handle cleanup: close all Claude Code editor tabs except the most recent
  panelProvider.setCleanupHandler(() => {
    const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);

    const claudeTabs = allTabs.filter(tab => {
      const input = tab.input;
      if (!input || typeof input !== 'object') { return false; }
      if ('viewType' in input) {
        const vt = (input as { viewType: string }).viewType;
        return vt.includes('claudeVSCode');
      }
      return false;
    });

    if (claudeTabs.length <= 1) { return; }

    // Keep the active tab if one exists, otherwise keep the first
    const activeTab = claudeTabs.find(t => t.isActive);
    const keepTab = activeTab || claudeTabs[0];
    const tabsToClose = claudeTabs.filter(t => t !== keepTab);

    for (const tab of tabsToClose) {
      vscode.window.tabGroups.close(tab);
    }
  });

  // Handle session dismiss
  panelProvider.setDismissHandler((sessionId: string) => {
    // If dismissing the focused session, acknowledge it
    if (previouslyFocusedSessionId === sessionId) {
      acknowledgePrevious();
    }
    discovery.dismissSession(sessionId);
    sendUpdate();
  });

  // Handle session undismiss — restores card to list, then focuses the editor
  panelProvider.setUndismissHandler((sessionId: string) => {
    discovery.undismissSession(sessionId);
    // Ensure metadata before opening (same as focus handler)
    if (!discovery.isSessionRunning(sessionId)) {
      const jsonlPath = discovery.getSessionFilePath(sessionId);
      if (jsonlPath) { void ensureSessionMetadata(sessionId, jsonlPath); }
    }
    // Open editor first, then update panel — avoids panel re-render stealing focus
    vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
      () => sendUpdate(),
      () => sendUpdate(),
    );
  });


  // Handle transcript view: render JSONL to markdown and open it
  panelProvider.setTranscriptHandler((sessionId: string) => {
    const jsonlPath = discovery.getSessionFilePath(sessionId);
    if (!jsonlPath) {
      vscode.window.showWarningMessage('Session file not found.');
      return;
    }
    renderTranscript(jsonlPath, sessionId, wsPath).then(
      outputPath => {
        vscode.workspace.openTextDocument(outputPath).then(
          doc => vscode.window.showTextDocument(doc, { preview: true }),
          err => log.warn('Failed to open transcript document:', err),
        );
      },
      err => {
        vscode.window.showErrorMessage(`Failed to render transcript: ${err}`);
      },
    );
  });

  // Handle archive range change
  panelProvider.setArchiveRangeHandler((rangeMs: number) => {
    discovery.setArchiveRange(rangeMs).then(
      changed => { if (changed) { sendUpdate(); } },
      err => log.warn('Failed to set archive range:', err),
    );
  });

  // Register refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.refresh', () => {
      sendUpdate();
    }),
  );

  // Register focus command (for external use)
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.focusSession', (sessionId: string) => {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId).then(
        undefined,
        err => log.warn('Failed to focus session:', err),
      );
    }),
  );

  // Start discovery and wire updates
  let lastSendTime = 0;
  function sendUpdate() {
    const now = Date.now();
    if (now - lastSendTime < 200) { return; }
    lastSendTime = now;
    const sessions = discovery.getSnapshots();
    const waitingCount = discovery.getWaitingCount();
    const usage = usageProvider.getSnapshot();
    const foreignWorkspaces = discovery.getForeignWorkspaces();
    panelProvider.updateSessions(sessions, waitingCount, wsPath, usage, foreignWorkspaces);

    // Auto-focus new session created via "+ New" button
    if (pendingNewChatKnownIds) {
      const freshSession = sessions.find(s => !pendingNewChatKnownIds!.has(s.sessionId));
      if (freshSession) {
        pendingNewChatKnownIds = null;
        if (pendingNewChatTimer) { clearTimeout(pendingNewChatTimer); pendingNewChatTimer = null; }
        panelProvider.focusSession(freshSession.sessionId);
      }
    }
  }

  discovery.start(() => sendUpdate()).catch(err => {
    log.error('SessionDiscovery start failed:', err);
  });
  usageProvider.start(() => sendUpdate());

  // Timestamp freshness timer (relative time labels in UI)
  const refreshTimer = setInterval(() => sendUpdate(), 5000);

  context.subscriptions.push({
    dispose() {
      discovery.stop();
      usageProvider.stop();
      clearInterval(refreshTimer);
    },
  });

  // Initial update after a short delay for panel to mount
  setTimeout(() => sendUpdate(), 500);
}

export function deactivate() {}
