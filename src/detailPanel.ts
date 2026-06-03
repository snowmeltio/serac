import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type {
  DetailAgentView, DetailGroupView, DetailModel, DetailRunChoice, DetailSource,
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
  /** List a session's subagent transcripts on disk (`subagents/agent-*.jsonl`).
   *  Fallback for the subagents source when live tracking never resolved an
   *  agentId (e.g. Agent-tool subagents that don't relay `agent_progress`). */
  listSubagents: (sessionId: string) => { agentId: string; agentType: string | null; description: string | null }[];
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
  /** Which workflow run the panel is showing when a session owns several. Reset
   *  on every show() so a fresh drill-in defaults to the most recent run; the
   *  header run switcher updates it. Ignored by the team/subagents sources. */
  private selectedRunId: string | null = null;
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
    this.selectedRunId = null; // fresh drill-in → default to the most recent run

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
      // Reveal in the panel's CURRENT column, not Beside. `Beside` recomputes
      // relative to the active editor, so if the user is focused on the
      // conversation (left), revealing Beside spawns/relocates a new pane
      // instead of surfacing the existing one. Passing the live viewColumn
      // keeps the panel where it already is.
      this.panel.reveal(this.panel.viewColumn);
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
    // Most-recent-first so a fresh drill-in defaults to the run the user just
    // kicked off, and the switcher reads newest → oldest.
    const runs = this.deps.getWorkflows()
      .filter(w => w.sessionId === sessionId)
      .sort((a, b) => b.startTime - a.startTime);
    const multi = runs.length > 1;
    // Show ONE run at a time: the selected one, else the most recent. Earlier
    // runs are reachable through the header switcher. (Concatenating every run's
    // phases buried the current run under earlier-run noise and made phase
    // headers ambiguous.)
    const selected = runs.find(r => r.runId === this.selectedRunId) ?? runs[0];
    const groups: DetailGroupView[] = [];
    if (selected) {
      const seen = new Set<string>();
      for (const ph of selected.phases) {
        const inPhase = selected.agents.filter(a => a.phaseIndex === ph.index);
        inPhase.forEach(a => seen.add(a.agentId));
        groups.push({
          key: selected.runId,
          title: 'Phase ' + ph.index + ' · ' + ph.title,
          status: selected.status,
          agents: inPhase.map(a => this.workflowAgentView(a)),
        });
      }
      const ungrouped = selected.agents.filter(a => !seen.has(a.agentId));
      if (ungrouped.length > 0) {
        const title = selected.phases.length > 0 ? 'Other' : null;
        groups.push({ key: selected.runId, title, status: selected.status, agents: ungrouped.map(a => this.workflowAgentView(a)) });
      }
    }
    const metricsBits = selected
      ? [selected.agentCount + ' agents', fmtTokens(selected.totalTokens) + ' tokens', selected.totalToolCalls + ' tools']
      : [];
    if (selected?.durationMs) { const d = fmtDuration(selected.durationMs); if (d) { metricsBits.push(d); } }
    return {
      source: 'workflow',
      containerId: sessionId,
      sessionId: invokingSessionId,
      title: selected?.name ?? 'Workflow',
      chips: selected ? [selected.source === 'live' ? 'live' : 'workflow', selected.status] : ['workflow'],
      metrics: metricsBits.join(' · '),
      groups,
      runs: multi ? this.buildRunChoices(runs, selected) : undefined,
    };
  }

  /** Build the header run-switcher entries. Runs are already most-recent-first.
   *  When several share a workflow name they get a recency ordinal (#1 = newest)
   *  so the chips stay distinguishable. */
  private buildRunChoices(runs: WorkflowSnapshot[], selected: WorkflowSnapshot | undefined): DetailRunChoice[] {
    const nameTotals = new Map<string, number>();
    for (const r of runs) { nameTotals.set(r.name, (nameTotals.get(r.name) ?? 0) + 1); }
    const nameSeen = new Map<string, number>();
    return runs.map(r => {
      const n = (nameSeen.get(r.name) ?? 0) + 1;
      nameSeen.set(r.name, n);
      const label = (nameTotals.get(r.name) ?? 0) > 1 ? r.name + ' #' + n : r.name;
      return { runId: r.runId, label, status: r.status, active: r.runId === selected?.runId };
    });
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
    // Live-tracked subagents carry rich progress (running state, tool counts,
    // result preview) but only once tracking resolved an agentId. Agent-tool
    // subagents that never relay `agent_progress` stay agentId-less, so the
    // tracked list alone can be empty even when transcripts exist on disk.
    const tracked = (session?.subagents ?? []).filter(s => s.agentId);
    const agents: DetailAgentView[] = tracked.map(s => ({
      agentId: s.agentId as string,
      label: s.description || (s.agentId as string).slice(0, 10),
      status: s.running ? 'running' : 'done',
      tokens: 0,
      toolCalls: s.toolsCompleted,
      durationMs: null,
      model: '',
      resultPreview: s.resultPreview,
    } satisfies DetailAgentView));
    // Union in any on-disk transcript the tracker missed, so no subagent is
    // silently dropped (the cause of the empty panel). These are treated as
    // completed — a disk-only agent with no live tracking has nothing running.
    const trackedIds = new Set(tracked.map(s => s.agentId));
    for (const d of this.deps.listSubagents(sessionId)) {
      if (trackedIds.has(d.agentId)) { continue; }
      agents.push({
        agentId: d.agentId,
        label: d.description || d.agentType || d.agentId.slice(0, 10),
        status: 'done',
        tokens: 0,
        toolCalls: 0,
        durationMs: null,
        model: '',
      } satisfies DetailAgentView);
    }
    const running = tracked.filter(s => s.running).length;
    const metricsBits = [agents.length + ' subagent' + (agents.length === 1 ? '' : 's')];
    if (running > 0) { metricsBits.push(running + ' running'); }
    return {
      source: 'subagents',
      containerId: sessionId,
      sessionId: invokingSessionId,
      title: 'Subagents',
      chips: ['subagents'],
      metrics: metricsBits.join(' · '),
      groups: [{ key: '', title: null, status: null, agents }],
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
    } else if (msg.type === 'selectWorkflowRun' && typeof msg.runId === 'string') {
      // Header run switcher: re-render the workflow model for the chosen run.
      // Force, since the run change always alters the visible groups.
      this.selectedRunId = msg.runId;
      this.postRender(true);
    } else if (msg.type === 'openConversation' && isValidSessionId(msg.sessionId)) {
      this.deps.openConversation(msg.sessionId);
    }
  }

  private async sendAgentTranscript(source: DetailSource, containerId: string, groupKey: string, agentId: string): Promise<void> {
    // Capture the panel up front and re-check identity after the await: the
    // transcript parse is async, and the panel can be disposed (or reused for a
    // different drill-in) before it resolves. Posting to a disposed webview
    // throws; posting to a reused one bleeds a stale transcript into the new view.
    const panel = this.panel;
    if (!panel) { return; }
    const key = groupKey + '|' + agentId;
    const file = this.deps.resolveAgentFile(source, containerId, groupKey, agentId);
    if (!file) {
      void panel.webview.postMessage({ type: 'agentTranscriptError', key, message: 'Transcript not available yet.' });
      return;
    }
    try {
      const entries = await parseTranscript(file);
      if (this.panel !== panel) { return; } // disposed or replaced mid-parse
      void panel.webview.postMessage({ type: 'agentTranscript', key, entries });
    } catch (err) {
      if (this.panel !== panel) { return; }
      void panel.webview.postMessage({ type: 'agentTranscriptError', key, message: String(err) });
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
