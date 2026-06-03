import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type {
  DetailAgentView, DetailGroupView, DetailModel, DetailSource,
  SessionSnapshot, TeamSnapshot, WorkflowSnapshot,
} from './types.js';
import { parseTranscript } from './transcriptRenderer.js';
import { isValidSessionId } from './validation.js';

/**
 * The detail view: a single editor-area webview (ViewColumn.Beside) laid out as
 * a two-pane navigator — left = groups → agents, right = the selected agent's
 * transcript. One instance is reused (revealed) so opening another drill-in
 * swaps its contents rather than spawning tabs.
 *
 * Source-keyed: the same panel serves workflow runs, agent teams, and a
 * session's Task subagents. Only the model-builder (and the host-side transcript
 * resolver) differ per source; the webview renders the normalised DetailModel
 * generically. This is the only createWebviewPanel in the extension; its HTML
 * wiring mirrors AgentPanelProvider.getHtml (asWebviewUri + CSP nonce).
 */
export interface DetailPanelDeps {
  /** Current workflow snapshots (live, from discovery). */
  getWorkflows: () => WorkflowSnapshot[];
  /** Current team snapshots (live, from discovery). */
  getTeams: () => TeamSnapshot[];
  /** Resolve a session snapshot by id (for the subagents source). */
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  /** Resolve an agent's transcript JSONL for a source, or null. */
  resolveAgentFile: (source: DetailSource, containerId: string, groupKey: string, agentId: string) => string | null;
  /** Open the invoking conversation for a session (companion editor). */
  openConversation: (sessionId: string) => void;
}

export class DetailPanel {
  private panel: vscode.WebviewPanel | undefined;
  private source: DetailSource = 'workflow';
  private containerId: string | null = null;
  private sessionId: string | null = null;
  /** JSON of the last render payload pushed; lets the periodic refresh() tick
   *  skip re-posting when nothing changed (a full re-render resets reader scroll
   *  + focus, jarring on an idle panel). */
  private lastPushed: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: DetailPanelDeps,
  ) {}

  /** Open (or reveal) the panel for a drill-in and push its model. */
  show(source: DetailSource, containerId: string, sessionId: string): void {
    this.source = source;
    this.containerId = containerId;
    this.sessionId = sessionId;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'seracDetail',
        'Agents',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        },
      );
      this.panel.webview.html = this.getHtml(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.onMessage(raw); });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.containerId = null;
        this.sessionId = null;
        this.lastPushed = null;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    // Opening/revealing must always render (the user just asked for it).
    this.postRender(true);
  }

  /** Re-push if open (from the host's update tick). Deduped: an unchanged model
   *  is not re-posted, so an idle panel keeps its scroll/focus. */
  refresh(): void {
    if (this.panel && this.containerId) { this.postRender(false); }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.containerId = null;
    this.sessionId = null;
    this.lastPushed = null;
  }

  private postRender(force: boolean): void {
    if (!this.panel || this.containerId === null || this.sessionId === null) { return; }
    const model = this.buildModel(this.source, this.containerId, this.sessionId);
    this.panel.title = model.title;
    const json = JSON.stringify(model);
    if (!force && json === this.lastPushed) { return; }
    this.lastPushed = json;
    void this.panel.webview.postMessage({ type: 'render', model });
  }

  // ── Model builders (source → normalised DetailModel) ────────────────

  private buildModel(source: DetailSource, containerId: string, sessionId: string): DetailModel {
    if (source === 'team') { return this.buildTeamModel(containerId, sessionId); }
    if (source === 'subagents') { return this.buildSubagentsModel(containerId, sessionId); }
    return this.buildWorkflowModel(containerId, sessionId);
  }

  private buildWorkflowModel(sessionId: string, invokingSessionId: string): DetailModel {
    const runs = this.deps.getWorkflows().filter(w => w.sessionId === sessionId);
    const lead = runs[0];
    const multi = runs.length > 1;
    const groups: DetailGroupView[] = [];
    for (const run of runs) {
      const seen = new Set<string>();
      const prefix = multi ? run.name + ' · ' : '';
      for (const ph of run.phases) {
        const inPhase = run.agents.filter(a => a.phaseIndex === ph.index);
        inPhase.forEach(a => seen.add(a.agentId));
        groups.push({
          key: run.runId,
          title: prefix + 'Phase ' + ph.index + ' · ' + ph.title,
          status: run.status,
          agents: inPhase.map(a => this.workflowAgentView(a)),
        });
      }
      const ungrouped = run.agents.filter(a => !seen.has(a.agentId));
      if (ungrouped.length > 0) {
        // With phases present, ungrouped agents get an "Other" header; with no
        // phases at all it's a flat list (null title) unless we need the run name.
        const title = run.phases.length > 0 ? prefix + 'Other' : (multi ? prefix + 'Agents' : null);
        groups.push({ key: run.runId, title, status: run.status, agents: ungrouped.map(a => this.workflowAgentView(a)) });
      }
    }
    const metricsBits = lead
      ? [lead.agentCount + ' agents', fmtTokens(lead.totalTokens) + ' tokens', lead.totalToolCalls + ' tools']
      : [];
    if (lead?.durationMs) { const d = fmtDuration(lead.durationMs); if (d) { metricsBits.push(d); } }
    if (multi) { metricsBits.push('+' + (runs.length - 1) + ' earlier'); }
    return {
      source: 'workflow',
      containerId: sessionId,
      sessionId: invokingSessionId,
      title: lead?.name ?? 'Workflow',
      chips: lead ? [lead.source === 'live' ? 'live' : 'workflow', lead.status] : ['workflow'],
      metrics: metricsBits.join(' · '),
      groups,
    };
  }

  private workflowAgentView(a: WorkflowSnapshot['agents'][number]): DetailAgentView {
    return {
      agentId: a.agentId,
      label: a.label || a.agentId.slice(0, 10),
      status: a.status,
      tokens: a.tokens,
      toolCalls: a.toolCalls,
      durationMs: a.durationMs,
      model: a.model,
      phaseTitle: a.phaseTitle,
      attempt: a.attempt,
      promptPreview: a.promptPreview,
      resultPreview: a.resultPreview,
    };
  }

  private buildSubagentsModel(sessionId: string, invokingSessionId: string): DetailModel {
    const session = this.deps.getSession(sessionId);
    const subs = (session?.subagents ?? []).filter(s => s.agentId);
    const running = subs.filter(s => s.running).length;
    const metricsBits = [subs.length + ' subagent' + (subs.length === 1 ? '' : 's')];
    if (running > 0) { metricsBits.push(running + ' running'); }
    return {
      source: 'subagents',
      containerId: sessionId,
      sessionId: invokingSessionId,
      title: 'Subagents',
      chips: ['subagents'],
      metrics: metricsBits.join(' · '),
      groups: [{
        key: '',
        title: null,
        status: null,
        agents: subs.map(s => ({
          agentId: s.agentId as string,
          label: s.description || (s.agentId as string).slice(0, 10),
          status: s.running ? 'running' : 'done',
          tokens: 0,
          toolCalls: s.toolsCompleted,
          durationMs: null,
          model: '',
          resultPreview: s.resultPreview,
        } satisfies DetailAgentView)),
      }],
    };
  }

  private buildTeamModel(teamId: string, invokingSessionId: string): DetailModel {
    const team = this.deps.getTeams().find(t => t.teamId === teamId);
    const agents = team?.agents ?? [];
    const done = agents.filter(a => a.status === 'done').length;
    const metricsBits = [agents.length + ' member' + (agents.length === 1 ? '' : 's')];
    if (agents.length > 0) { metricsBits.push(done + '/' + agents.length + ' done'); }
    return {
      source: 'team',
      containerId: teamId,
      sessionId: invokingSessionId,
      title: team?.name ?? 'Agent team',
      chips: ['team'],
      metrics: metricsBits.join(' · '),
      groups: [{
        key: '',
        title: null,
        status: null,
        // Resolution key is the member name (matched against agent-*.meta.json
        // agentType for in-process members, or its sessionId when present).
        agents: agents.map(a => ({
          agentId: a.name,
          label: a.name,
          status: a.status,
          tokens: a.contextTokens,
          toolCalls: 0,
          durationMs: null,
          model: '',
        } satisfies DetailAgentView)),
      }],
    };
  }

  // ── Inbound messages ────────────────────────────────────────────────

  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') { return; }
    const msg = raw as Record<string, unknown>;
    if (msg.type === 'viewAgent'
        && (msg.source === 'workflow' || msg.source === 'team' || msg.source === 'subagents')
        && typeof msg.containerId === 'string'
        && typeof msg.groupKey === 'string'
        && typeof msg.agentId === 'string') {
      await this.sendAgentTranscript(msg.source, msg.containerId, msg.groupKey, msg.agentId);
    } else if (msg.type === 'openConversation' && isValidSessionId(msg.sessionId)) {
      this.deps.openConversation(msg.sessionId);
    }
  }

  private async sendAgentTranscript(source: DetailSource, containerId: string, groupKey: string, agentId: string): Promise<void> {
    if (!this.panel) { return; }
    const key = groupKey + '|' + agentId;
    const file = this.deps.resolveAgentFile(source, containerId, groupKey, agentId);
    if (!file) {
      void this.panel.webview.postMessage({ type: 'agentTranscriptError', key, message: 'Transcript not available yet.' });
      return;
    }
    try {
      const entries = await parseTranscript(file);
      void this.panel.webview.postMessage({ type: 'agentTranscript', key, entries });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'agentTranscriptError', key, message: String(err) });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'detailView.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'detailView.css'),
    );
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="wf-root">
    <div class="wf-empty">Loading…</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function fmtTokens(n: number): string {
  if (n >= 1000) { return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'; }
  return String(n);
}

function fmtDuration(ms: number | null): string {
  if (!ms || ms <= 0) { return ''; }
  const secs = Math.round(ms / 1000);
  if (secs < 60) { return secs + 's'; }
  const m = Math.floor(secs / 60);
  const r = secs % 60;
  return r > 0 ? m + 'm ' + r + 's' : m + 'm';
}
