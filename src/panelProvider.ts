import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { SessionSnapshot, UsageSnapshot, WebviewMessage, WebviewCommand, WorkspaceGroup, TeamSnapshot } from './types.js';
import type { CompactSettings } from './claudeSettings.js';
import { parseWebviewCommand } from './validation.js';

/**
 * WebviewViewProvider for the Agent Activity sidebar panel.
 * Renders session cards with Snowmelt colour tokens.
 */
export class AgentPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentActivity.panel';

  private view: vscode.WebviewView | undefined;
  private sessions: SessionSnapshot[] = [];
  private waitingCount = 0;
  private usage: UsageSnapshot | null = null;
  private foreignWorkspaces: WorkspaceGroup[] = [];
  private teams: TeamSnapshot[] = [];
  private compactSettings: CompactSettings | undefined;
  private onFocusSession: ((sessionId: string) => void) | undefined;
  private onDismissSession: ((sessionId: string) => void) | undefined;
  private onUndismissSession: ((sessionId: string) => void) | undefined;
  private onViewTranscript: ((sessionId: string) => void) | undefined;
  private onNewChat: (() => void) | undefined;
  private onCleanup: (() => void) | undefined;
  private onArchiveRange: ((rangeMs: number) => void) | undefined;
  private onDismissTeam: ((teamId: string) => void) | undefined;
  private onUndismissTeam: ((teamId: string) => void) | undefined;
  private workspacePath = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
  ) {}

  setFocusHandler(handler: (sessionId: string) => void): void {
    this.onFocusSession = handler;
  }

  setDismissHandler(handler: (sessionId: string) => void): void {
    this.onDismissSession = handler;
  }

  setUndismissHandler(handler: (sessionId: string) => void): void {
    this.onUndismissSession = handler;
  }

  setTranscriptHandler(handler: (sessionId: string) => void): void {
    this.onViewTranscript = handler;
  }

  setNewChatHandler(handler: () => void): void {
    this.onNewChat = handler;
  }

  setCleanupHandler(handler: () => void): void {
    this.onCleanup = handler;
  }

  setArchiveRangeHandler(handler: (rangeMs: number) => void): void {
    this.onArchiveRange = handler;
  }

  setDismissTeamHandler(handler: (teamId: string) => void): void {
    this.onDismissTeam = handler;
  }

  setUndismissTeamHandler(handler: (teamId: string) => void): void {
    this.onUndismissTeam = handler;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewCommand(raw);
      if (!message) { return; }

      if (message.type === 'focusSession' && this.onFocusSession) {
        this.onFocusSession(message.sessionId);
      } else if (message.type === 'dismissSession' && this.onDismissSession) {
        this.onDismissSession(message.sessionId);
      } else if (message.type === 'undismissSession' && this.onUndismissSession) {
        this.onUndismissSession(message.sessionId);
      } else if (message.type === 'viewTranscript' && this.onViewTranscript) {
        this.onViewTranscript(message.sessionId);
      } else if (message.type === 'newChat' && this.onNewChat) {
        this.onNewChat();
      } else if (message.type === 'cleanup' && this.onCleanup) {
        this.onCleanup();
      } else if (message.type === 'copyToClipboard' && message.text) {
        vscode.env.clipboard.writeText(message.text);
      } else if (message.type === 'archiveRange' && this.onArchiveRange) {
        this.onArchiveRange(message.rangeMs);
      } else if (message.type === 'dismissTeam' && this.onDismissTeam) {
        this.onDismissTeam(message.teamId);
      } else if (message.type === 'undismissTeam' && this.onUndismissTeam) {
        this.onUndismissTeam(message.teamId);
      } else if (message.type === 'requestUpdate') {
        this.sendUpdate();
      }
    });

    // Send initial state
    this.sendUpdate();
  }

  /** Update the panel with new session data */
  updateSessions(sessions: SessionSnapshot[], waitingCount: number, workspacePath: string, usage: UsageSnapshot | null, foreignWorkspaces?: WorkspaceGroup[], compactSettings?: CompactSettings, teams?: TeamSnapshot[]): void {
    this.sessions = sessions;
    this.waitingCount = waitingCount;
    this.workspacePath = workspacePath;
    this.usage = usage;
    this.foreignWorkspaces = foreignWorkspaces ?? [];
    this.teams = teams ?? [];
    this.compactSettings = compactSettings;

    // Update badge
    if (this.view) {
      this.view.badge = waitingCount > 0
        ? { value: waitingCount, tooltip: `${waitingCount} session${waitingCount > 1 ? 's' : ''} waiting` }
        : undefined;
    }

    this.sendUpdate();
  }

  /** Tell the webview to focus a specific session card */
  focusSession(sessionId: string): void {
    if (!this.view) { return; }
    this.view.webview.postMessage({ type: 'focusSession', sessionId });
  }

  private sendUpdate(): void {
    if (!this.view) { return; }

    const message: WebviewMessage = {
      type: 'update',
      sessions: this.sessions,
      waitingCount: this.waitingCount,
      workspacePath: this.workspacePath,
      usage: this.usage,
      foreignWorkspaces: this.foreignWorkspaces.length > 0 ? this.foreignWorkspaces : undefined,
      teams: this.teams.length > 0 ? this.teams : undefined,
      compactSettings: this.compactSettings,
    };

    this.view.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'),
    );
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root">
    <div class="empty-state">
      <div class="icon">\u2298</div>
      <div>Loading...</div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    return randomBytes(16).toString('base64');
  }
}
