import * as vscode from 'vscode';
import * as os from 'os';
import { randomBytes } from 'crypto';
import type { SessionSnapshot, UsageSnapshot, WebviewMessage, WorkspaceGroup, TeamSnapshot, WorkflowSnapshot, FooterSlotPayload, WorktreeRow, DetailSource } from './types.js';
import type { CompactSettings } from './claudeSettings.js';
import { parseWebviewCommand } from './validation.js';
import { readSettings, type SeracSettings } from './settings.js';

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
  private foreignWaiting: SessionSnapshot[] = [];
  private foreignRunning: SessionSnapshot[] = [];
  private teams: TeamSnapshot[] = [];
  private workflows: WorkflowSnapshot[] = [];
  private compactSettings: CompactSettings | undefined;
  private olderSessionCount = 0;
  private worktrees: WorktreeRow[] | undefined;
  private onFocusSession: ((sessionId: string) => void) | undefined;
  private onDismissSession: ((sessionId: string) => void) | undefined;
  private onUndismissSession: ((sessionId: string) => void) | undefined;
  private onViewTranscript: ((sessionId: string) => void) | undefined;
  private onNewChat: (() => void) | undefined;
  private onCleanup: (() => void) | undefined;
  private onArchiveRange: ((rangeMs: number) => void) | undefined;
  private onDismissTeam: ((teamId: string) => void) | undefined;
  private onUndismissTeam: ((teamId: string) => void) | undefined;
  private onDismissWorkflow: ((runId: string) => void) | undefined;
  private onUndismissWorkflow: ((runId: string) => void) | undefined;
  private onOpenDetail: ((source: DetailSource, containerId: string, sessionId: string) => void) | undefined;
  private onOpenWorkspace: ((cwd: string, sessionId?: string) => void) | undefined;
  private onFooterSlotClick: ((slotId: string) => void) | undefined;
  private getFooterSlotPayloads: (() => FooterSlotPayload[]) | undefined;
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

  getNewChatHandler(): (() => void) | undefined {
    return this.onNewChat;
  }

  setCleanupHandler(handler: () => void): void {
    this.onCleanup = handler;
  }

  getCleanupHandler(): (() => void) | undefined {
    return this.onCleanup;
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

  setDismissWorkflowHandler(handler: (runId: string) => void): void {
    this.onDismissWorkflow = handler;
  }

  setUndismissWorkflowHandler(handler: (runId: string) => void): void {
    this.onUndismissWorkflow = handler;
  }

  setOpenDetailHandler(handler: (source: DetailSource, containerId: string, sessionId: string) => void): void {
    this.onOpenDetail = handler;
  }

  setOpenWorkspaceHandler(handler: (cwd: string, sessionId?: string) => void): void {
    this.onOpenWorkspace = handler;
  }

  /** Register the footer-slot bridge: a snapshot accessor (so the next
   *  sendUpdate carries the latest payloads) and a click router that resolves
   *  the slot's command and runs it. Both are wired by extension.ts. */
  setFooterSlotBridge(
    getPayloads: () => FooterSlotPayload[],
    onClick: (slotId: string) => void,
  ): void {
    this.getFooterSlotPayloads = getPayloads;
    this.onFooterSlotClick = onClick;
  }

  /** Trigger a redraw — used by the registry's onChange callback so that
   *  registering/updating/disposing a slot re-pushes the update message. */
  refresh(): void {
    this.sendUpdate();
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

    // Push the current settings snapshot before the first data update so the
    // webview can apply visibility gates / CSS custom properties on the very
    // first render and avoid a flash of unhidden sections.
    this.sendSettings();

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
      } else if (message.type === 'dismissWorkflow' && this.onDismissWorkflow) {
        this.onDismissWorkflow(message.runId);
      } else if (message.type === 'undismissWorkflow' && this.onUndismissWorkflow) {
        this.onUndismissWorkflow(message.runId);
      } else if (message.type === 'openDetail' && this.onOpenDetail) {
        this.onOpenDetail(message.source, message.containerId, message.sessionId);
      } else if (message.type === 'openWorkspace' && this.onOpenWorkspace) {
        this.onOpenWorkspace(message.cwd, message.sessionId);
      } else if (message.type === 'footerSlotClick' && this.onFooterSlotClick) {
        this.onFooterSlotClick(message.slotId);
      } else if (message.type === 'requestUpdate') {
        this.sendUpdate();
      }
    });

    // Send initial state
    this.sendUpdate();
  }

  /** Update the panel with new session data */
  updateSessions(sessions: SessionSnapshot[], waitingCount: number, workspacePath: string, usage: UsageSnapshot | null, foreignWorkspaces?: WorkspaceGroup[], compactSettings?: CompactSettings, teams?: TeamSnapshot[], foreignWaiting?: SessionSnapshot[], olderSessionCount?: number, foreignRunning?: SessionSnapshot[], worktrees?: WorktreeRow[], workflows?: WorkflowSnapshot[]): void {
    this.sessions = sessions;
    this.waitingCount = waitingCount;
    this.workspacePath = workspacePath;
    this.usage = usage;
    this.foreignWorkspaces = foreignWorkspaces ?? [];
    this.foreignWaiting = foreignWaiting ?? [];
    this.foreignRunning = foreignRunning ?? [];
    this.teams = teams ?? [];
    this.workflows = workflows ?? [];
    this.compactSettings = compactSettings;
    this.olderSessionCount = olderSessionCount ?? 0;
    this.worktrees = worktrees;

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

  /** Push the current `serac.*` settings snapshot to the webview. Called once
   *  on resolveWebviewView and again whenever onDidChangeConfiguration fires
   *  for the `serac` section. Settings live in a separate message (not bundled
   *  into the 5s update tick) so reactivity is event-driven and the update
   *  payload stays lean. */
  sendSettings(settings?: SeracSettings): void {
    if (!this.view) { return; }
    const payload: WebviewMessage = {
      type: 'settings',
      settings: settings ?? readSettings(),
    };
    this.view.webview.postMessage(payload);
  }

  private sendUpdate(): void {
    if (!this.view) { return; }

    const footerSlots = this.getFooterSlotPayloads ? this.getFooterSlotPayloads() : [];
    const message: WebviewMessage = {
      type: 'update',
      sessions: this.sessions,
      waitingCount: this.waitingCount,
      workspacePath: this.workspacePath,
      home: os.homedir(),
      usage: this.usage,
      foreignWorkspaces: this.foreignWorkspaces.length > 0 ? this.foreignWorkspaces : undefined,
      foreignWaiting: this.foreignWaiting.length > 0 ? this.foreignWaiting : undefined,
      foreignRunning: this.foreignRunning.length > 0 ? this.foreignRunning : undefined,
      teams: this.teams.length > 0 ? this.teams : undefined,
      workflows: this.workflows.length > 0 ? this.workflows : undefined,
      compactSettings: this.compactSettings,
      footerSlots: footerSlots.length > 0 ? footerSlots : undefined,
      olderSessionCount: this.olderSessionCount > 0 ? this.olderSessionCount : undefined,
      worktrees: this.worktrees && this.worktrees.length > 0 ? this.worktrees : undefined,
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
