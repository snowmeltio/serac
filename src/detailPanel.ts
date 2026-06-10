import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type {
  DetailAgentView, DetailGroupView, DetailModel, DetailViewChoice, DetailSource,
  SessionSnapshot, TeamSnapshot, WorkflowSnapshot,
} from './types.js';
import { parseTranscript } from './transcriptRenderer.js';
import { isValidSessionId, parseTeammateMessageCommand } from './validation.js';

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

  // ── Teammate messaging (experimental; all optional) ──────────────────
  // The detail panel is the ONLY place Serac writes into ~/.claude/. These deps
  // are wired only when the feature is built into the host; absent (e.g. in
  // unit tests) the composer is reported disabled and no write path is reachable.

  /** Re-read the teammate-messaging settings. Called server-side on EVERY send
   *  (and to gate the composer) — a webview-cached flag is never trusted. */
  getMessagingSettings?: () => { enabled: boolean; operatorName: string };
  /** Map (orchestrator session, in-process subagent hash) → inbox target, or
   *  null to refuse. Resolves the member by roster server-side; the webview
   *  never names a file. */
  resolveInboxTarget?: (orchestratorSessionId: string, agentId: string) => { teamDir: string; member: string } | null;
  /** Append a message to the resolved teammate's inbox (atomic, queued, confined,
   *  schema-guarded). Rejects on any refusal; the reason is safe to surface
   *  (carries no message content). */
  appendTeammateMessage?: (teamDir: string, member: string, from: string, text: string) => Promise<void>;
  /** Structured log sink for write-path metadata. NEVER receives message content
   *  (the OutputChannel persists to disk; a message could carry a pasted secret). */
  logMessaging?: (line: string) => void;
  /** Read-only peek at a teammate's pending inbox (sanitised, fail-silent []).
   *  Feeds the queued-message thread under a teammate's transcript. */
  peekTeammateInbox?: (teamDir: string, member: string) => Array<{ from: string; text: string; timestamp: string }>;
}

export class DetailPanel {
  private panel: vscode.WebviewPanel | undefined;
  private source: DetailSource = 'workflow';
  private containerId: string | null = null;
  private sessionId: string | null = null;
  /** Which workflow run the panel is showing when a session owns several. Reset
   *  on every show() so a fresh drill-in defaults to the most recent run; the
   *  header view switcher updates it. Ignored by the team/subagents sources. */
  private selectedRunId: string | null = null;
  /** Container to restore when switching away from a roster view entered via
   *  the switcher (team containerId differs from the orchestrator session). */
  private preTeamContainerId: string | null = null;
  /** JSON of the last render payload pushed; lets the periodic refresh() tick
   *  skip re-posting when nothing changed (a full re-render resets reader scroll
   *  + focus, jarring on an idle panel). */
  private lastPushed: string | null = null;
  /** One-shot deep-link target from an inline card agent row: the webview selects
   *  this agent on the next render, then it's cleared so refresh ticks don't yank
   *  the selection back. */
  private pendingSelect: { groupKey: string; agentId: string } | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: DetailPanelDeps,
  ) {}

  /** Open (or reveal) the panel for a drill-in and push its model. `target`
   *  deep-links to a specific agent (from an inline card row): the right run is
   *  selected for a workflow, and the webview selects the agent on first render. */
  show(source: DetailSource, containerId: string, sessionId: string, target?: { groupKey: string; agentId: string }): void {
    this.source = source;
    this.containerId = containerId;
    this.sessionId = sessionId;
    // For a workflow deep-link the groupKey IS the runId — show that run, not the
    // most recent. Otherwise a fresh drill-in defaults to the most recent run.
    this.selectedRunId = (source === 'workflow' && target?.groupKey) ? target.groupKey : null;
    this.pendingSelect = target ?? null;

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
    // Push the current messaging settings so the webview can gate the composer
    // (also re-pushed on settings change via the public sendSettings()).
    this.sendSettings();
    // Opening/revealing must always render (the user just asked for it).
    this.postRender(true);
  }

  /** Push the current teammate-messaging settings to the webview (composer gate
   *  + disclosure label). Safe no-op when the panel is closed or the feature
   *  deps aren't wired. Call on panel open and whenever `serac.experimental.*`
   *  changes — the webview's flag is display-only; every send is re-checked
   *  server-side regardless. */
  sendSettings(): void {
    if (!this.panel) { return; }
    const s = this.deps.getMessagingSettings?.() ?? { enabled: false, operatorName: 'operator' };
    void this.panel.webview.postMessage({
      type: 'settings',
      experimental: { teammateMessaging: s.enabled, operatorName: s.operatorName },
    });
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
    const message: { type: 'render'; model: DetailModel; select?: { groupKey: string; agentId: string } } = { type: 'render', model };
    // Deep-link selection rides the first render after show(), then clears so
    // periodic refresh ticks don't drag the user back to it.
    if (this.pendingSelect) { message.select = this.pendingSelect; this.pendingSelect = null; }
    void this.panel.webview.postMessage(message);
  }

  // ── Model builders (source → normalised DetailModel) ────────────────

  private buildModel(source: DetailSource, containerId: string, sessionId: string): DetailModel {
    if (source === 'team') { return this.buildTeamModel(containerId, sessionId); }
    if (source === 'subagents') { return this.buildSubagentsModel(containerId, sessionId); }
    return this.buildWorkflowModel(containerId, sessionId);
  }

  /** The Agent Team this session orchestrates, if any. In-process teammates are
   *  skipped by the team parser and surface instead through the subagents source,
   *  so a team orchestrator's "subagents" are really its teammates — this lets the
   *  models frame them as such (label + per-agent badge) rather than as plain
   *  Task subagents. */
  private teamFor(sessionId: string): TeamSnapshot | undefined {
    return this.deps.getTeams().find(t => t.orchestrator.sessionId === sessionId);
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
      // Failed-first within each phase: when triaging a failed run, the
      // broken agent is what the user came to find — it must not hide among
      // a dozen done siblings in source order.
      const failedFirst = (agents: typeof selected.agents) =>
        [...agents].sort((a, b) => (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1));
      const seen = new Set<string>();
      for (const ph of selected.phases) {
        const inPhase = selected.agents.filter(a => a.phaseIndex === ph.index);
        inPhase.forEach(a => seen.add(a.agentId));
        groups.push({
          key: selected.runId,
          title: 'Phase ' + ph.index + ' · ' + ph.title,
          status: selected.status,
          agents: failedFirst(inPhase).map(a => this.workflowAgentView(a)),
        });
      }
      const ungrouped = selected.agents.filter(a => !seen.has(a.agentId));
      if (ungrouped.length > 0) {
        const title = selected.phases.length > 0 ? 'Other' : null;
        groups.push({ key: selected.runId, title, status: selected.status, agents: failedFirst(ungrouped).map(a => this.workflowAgentView(a)) });
      }
    }
    const metricsBits = selected
      ? [selected.agentCount + ' agents', fmtTokens(selected.totalTokens) + ' tokens', selected.totalToolCalls + ' tools']
      : [];
    // Failure roll-up: surface WHICH portion of the run failed in the header,
    // so a 'failed' chip is immediately quantified without scanning the nav.
    if (selected) {
      const failed = selected.agents.filter(a => a.status === 'failed').length;
      if (failed > 0) { metricsBits.push(failed + ' failed'); }
    }
    if (selected?.durationMs) { const d = fmtDuration(selected.durationMs); if (d) { metricsBits.push(d); } }
    const team = this.teamFor(sessionId);
    return {
      source: 'workflow',
      containerId: sessionId,
      sessionId: invokingSessionId,
      title: selected?.name ?? 'Workflow',
      chips: selected ? [selected.source === 'live' ? 'live' : 'workflow', selected.status] : ['workflow'],
      metrics: metricsBits.join(' · '),
      groups,
      views: this.buildViewChoices(runs, selected?.runId ?? null, 'workflow', this.collectSubagents(sessionId), team),
      team: team?.name,
    };
  }

  /** Build the header view-switcher entries for a session card's drill-in: one
   *  per workflow run the session owns (most-recent-first, with a recency
   *  ordinal when names collide), plus a 'Subagents' view when the session also
   *  spawned plain Task subagents. Returned even for a single view — the switcher
   *  doubles as a labelled heading of what's under this session, so showing the
   *  lone grouping (under its heading) is clearer than hiding it. Undefined only
   *  when there are no groupings at all. `activeSource`/`activeRunId` mark which
   *  chip is current; `subs` is the session's plain subagents (already collected
   *  by the caller, so the dir-scan happens once per model build). */
  private buildViewChoices(
    runs: WorkflowSnapshot[],
    activeRunId: string | null,
    activeSource: DetailSource,
    subs: { agents: DetailAgentView[]; running: number },
    team?: TeamSnapshot,
  ): DetailViewChoice[] | undefined {
    const views: DetailViewChoice[] = [];
    const nameTotals = new Map<string, number>();
    for (const r of runs) { nameTotals.set(r.name, (nameTotals.get(r.name) ?? 0) + 1); }
    const nameSeen = new Map<string, number>();
    for (const r of runs) {
      const n = (nameSeen.get(r.name) ?? 0) + 1;
      nameSeen.set(r.name, n);
      const label = (nameTotals.get(r.name) ?? 0) > 1 ? r.name + ' #' + n : r.name;
      views.push({
        id: r.runId, kind: 'workflow', label, status: r.status,
        active: activeSource === 'workflow' && r.runId === activeRunId,
        summary: rollupSummary(r.agents.map(a => a.status), 'agent'),
      });
    }
    if (subs.agents.length > 0) {
      views.push({
        id: 'subagents',
        kind: 'subagents',
        label: team ? 'Teammates' : 'Subagents',
        status: subs.running > 0 ? 'running' : 'completed',
        active: activeSource === 'subagents',
        summary: rollupSummary(subs.agents.map(a => a.status), team ? 'teammate' : 'subagent'),
      });
    }
    // Team roster view — restores the drill-in that became unreachable when
    // v1.11 folded the team section into the orchestrator's card. Rides the
    // same switcher as every other view (implicit interactivity, no new chrome).
    if (team) {
      views.push({
        id: team.teamId,
        kind: 'team',
        label: 'Roster · ' + team.name,
        status: team.agents.some(a => a.status === 'running') ? 'running' : 'completed',
        active: activeSource === 'team',
        summary: rollupSummary(team.agents.map(a => a.status), 'member'),
      });
    }
    return views.length > 0 ? views : undefined;
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

  /** Collect a session's plain Task subagents — live-tracked (rich progress)
   *  unioned with on-disk transcripts the tracker missed, so none is dropped.
   *  Shared by the subagents model and the view switcher's count. */
  private collectSubagents(sessionId: string): { agents: DetailAgentView[]; running: number } {
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
    return { agents, running: tracked.filter(s => s.running).length };
  }

  private buildSubagentsModel(sessionId: string, invokingSessionId: string): DetailModel {
    const subs = this.collectSubagents(sessionId);
    const { running } = subs;
    // When this session orchestrates a team, its (in-process) subagents ARE the
    // teammates — frame them as such: a teammate badge per agent, a "Teammates"
    // label, and the team name on the model for the header.
    const team = this.teamFor(sessionId);
    // Only roster-matched subagents are teammates: a team lead can also spawn
    // ordinary Task subagents (Explore, general-purpose, …) whose inbox sends
    // could never resolve — those must not get a composer or a team badge.
    // Membership is keyed the same way resolveInboxTarget resolves it: the
    // on-disk meta's agentType equals the member name.
    const roster = new Set((team?.agents ?? []).map(a => a.name));
    const typeById = new Map(this.deps.listSubagents(sessionId).map(d => [d.agentId, d.agentType]));
    const agents = team
      ? subs.agents.map(a => ({ ...a, teammate: roster.has(typeById.get(a.agentId) ?? '') }))
      : subs.agents;
    const noun = team ? 'teammate' : 'subagent';
    const metricsBits = [agents.length + ' ' + noun + (agents.length === 1 ? '' : 's')];
    if (running > 0) { metricsBits.push(running + ' running'); }
    // Most-recent-first so the switcher matches the workflow view's ordering.
    const runs = this.deps.getWorkflows()
      .filter(w => w.sessionId === sessionId)
      .sort((a, b) => b.startTime - a.startTime);
    return {
      source: 'subagents',
      containerId: sessionId,
      sessionId: invokingSessionId,
      title: team ? 'Teammates' : 'Subagents',
      chips: team ? ['team'] : ['subagents'],
      metrics: metricsBits.join(' · '),
      groups: [{ key: '', title: null, status: null, agents }],
      views: this.buildViewChoices(runs, null, 'subagents', { agents, running }, team),
      team: team?.name,
    };
  }

  private buildTeamModel(teamId: string, invokingSessionId: string): DetailModel {
    const team = this.deps.getTeams().find(t => t.teamId === teamId);
    const agents = team?.agents ?? [];
    const done = agents.filter(a => a.status === 'done').length;
    const metricsBits = [agents.length + ' member' + (agents.length === 1 ? '' : 's')];
    if (agents.length > 0) { metricsBits.push(done + '/' + agents.length + ' done'); }
    // The switcher must offer the way back: the orchestrator's workflow runs
    // and teammates views, built against the orchestrator session.
    const orchestratorId = team?.orchestrator.sessionId;
    const runs = orchestratorId
      ? this.deps.getWorkflows().filter(w => w.sessionId === orchestratorId).sort((a, b) => b.startTime - a.startTime)
      : [];
    const views = orchestratorId
      ? this.buildViewChoices(runs, null, 'team', this.collectSubagents(orchestratorId), team)
      : undefined;
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
      views,
      team: team?.name,
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
    } else if (msg.type === 'selectDetailView'
        && (msg.kind === 'workflow' || msg.kind === 'subagents' || msg.kind === 'team')
        && typeof msg.id === 'string') {
      // Header view switcher: flip the active source (and, for a workflow view,
      // the run). Force, since the view change always alters the visible groups.
      if (msg.kind === 'team') {
        // The webview is untrusted: only switch to a team that exists AND is
        // orchestrated by the session this drill-in is anchored to.
        const team = this.deps.getTeams().find(t => t.teamId === msg.id);
        if (!team || team.orchestrator.sessionId !== this.containerId && team.teamId !== this.containerId) { return; }
        if (this.containerId !== team.teamId) { this.preTeamContainerId = this.containerId; }
        this.containerId = team.teamId;
      } else if (this.source === 'team' && this.preTeamContainerId) {
        // Switching away from the roster: restore the orchestrator container.
        this.containerId = this.preTeamContainerId;
        this.preTeamContainerId = null;
      }
      this.source = msg.kind;
      this.selectedRunId = msg.kind === 'workflow' ? msg.id : null;
      this.postRender(true);
    } else if (msg.type === 'openConversation' && isValidSessionId(msg.sessionId)) {
      this.deps.openConversation(msg.sessionId);
    } else if (msg.type === 'sendTeammateMessage') {
      await this.handleSendTeammateMessage(raw);
    }
  }

  /**
   * Handle the composer's `sendTeammateMessage`. This is the single entry to
   * Serac's only write into `~/.claude/`, so it fails closed at every step and
   * surfaces errors IN-WEBVIEW ONLY (never a toast — that would steal focus).
   * Order is deliberate: re-check the flag BEFORE any parsing or I/O.
   */
  private async handleSendTeammateMessage(raw: unknown): Promise<void> {
    const panel = this.panel;
    if (!panel) { return; }
    const log = this.deps.logMessaging ?? (() => { /* no sink wired */ });
    const reply = (ok: boolean, error?: string): void => {
      if (this.panel !== panel) { return; } // disposed/replaced mid-flight
      void panel.webview.postMessage({ type: 'teammateMessageSent', ok, error });
    };

    // 1. Re-check the master flag server-side, first, before touching anything.
    const settings = this.deps.getMessagingSettings?.();
    if (!settings || !settings.enabled || !this.deps.resolveInboxTarget || !this.deps.appendTeammateMessage) {
      log('[messaging] refused: feature disabled');
      reply(false, 'Teammate messaging is disabled.');
      return;
    }

    // 2. Strict central validation. Pins source==='subagents', path-safe + capped
    //    ids, bounded text — and NEVER reads a webview-supplied `from`.
    const cmd = parseTeammateMessageCommand(raw);
    if (!cmd) {
      log('[messaging] refused: invalid command');
      reply(false, 'Message rejected (invalid request).');
      return;
    }

    // 3. Synthesize the sender label server-side and validate it.
    const from = settings.operatorName;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(from)) {
      log('[messaging] refused: invalid operatorName (len=' + (typeof from === 'string' ? from.length : -1) + ')');
      reply(false, 'Operator name is invalid — check serac.experimental.operatorName (letters, digits, - or _).');
      return;
    }

    // 4. Resolve the inbox target by roster, server-side. The webview names a
    //    subagent hash; the host maps it to a current roster member or refuses.
    const target = this.deps.resolveInboxTarget(cmd.containerId, cmd.agentId);
    if (!target) {
      log('[messaging] refused: unresolved target (container=' + cmd.containerId.slice(0, 8) + ' agent=' + cmd.agentId.slice(0, 8) + ')');
      reply(false, 'Could not resolve this teammate (it may have finished).');
      return;
    }

    // 5. Write. Metadata-only logging — never the message text.
    try {
      await this.deps.appendTeammateMessage(target.teamDir, target.member, from, cmd.text);
      log('[messaging] sent: team=' + target.teamDir + ' member=' + target.member + ' from=' + from + ' chars=' + cmd.text.length);
      reply(true);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'write failed';
      log('[messaging] failed: team=' + target.teamDir + ' member=' + target.member + ' chars=' + cmd.text.length + ' reason=' + reason);
      reply(false, reason);
    }
  }

  private async sendAgentTranscript(source: DetailSource, containerId: string, groupKey: string, agentId: string): Promise<void> {
    // Capture the panel up front and re-check identity after the await: the
    // transcript parse is async, and the panel can be disposed (or reused for a
    // different drill-in) before it resolves. Posting to a disposed webview
    // throws; posting to a reused one bleeds a stale transcript into the new view.
    const panel = this.panel;
    if (!panel) { return; }
    // Owner-prefixed so a response in flight across a drill-in switch can never
    // collide with the new container's keys. Mirrors detailView's tkey().
    const key = source + ':' + containerId + '|' + groupKey + '|' + agentId;
    const file = this.deps.resolveAgentFile(source, containerId, groupKey, agentId);
    if (!file) {
      void panel.webview.postMessage({ type: 'agentTranscriptError', key, message: 'Transcript not available yet.' });
      return;
    }
    try {
      const entries = await parseTranscript(file);
      if (this.panel !== panel) { return; } // disposed or replaced mid-parse
      // Inbox read-side: messages sent to this teammate that it has not yet
      // drained appear as queued turns at the tail — so "did my message land?"
      // is answerable from the thread itself. Gated on the same server-side
      // settings as the composer; fail-silent (display affordance only).
      if (source === 'subagents' && this.deps.peekTeammateInbox && this.deps.resolveInboxTarget
          && this.deps.getMessagingSettings?.().enabled) {
        try {
          const target = this.deps.resolveInboxTarget(containerId, agentId);
          if (target) {
            for (const m of this.deps.peekTeammateInbox(target.teamDir, target.member)) {
              entries.push({
                timestamp: m.timestamp,
                role: 'system',
                content: 'Queued for delivery (from ' + m.from + '): ' + m.text,
              });
            }
          }
        } catch { /* never block the transcript on inbox state */ }
      }
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
  <!-- The composer lives OUTSIDE #wf-root: render() replaces #wf-root's innerHTML
       every tick, which would wipe a textarea mid-typing. As a sibling it
       persists; the webview only toggles its [hidden] + .value. -->
  <div id="wf-composer" hidden>
    <div class="wf-composer-disclosure">Direct message — bypasses the lead. No delivery guarantee; resend if unconfirmed.</div>
    <div class="wf-composer-row">
      <textarea id="wf-composer-input" rows="2" maxlength="8000"
        placeholder="Message this teammate directly…" aria-label="Message this teammate"></textarea>
      <button id="wf-composer-send" type="button">Send</button>
    </div>
    <div class="wf-composer-foot">
      <span id="wf-composer-status" class="wf-composer-status" role="status" aria-live="polite"></span>
      <span id="wf-composer-count" class="wf-composer-count"></span>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Chip-tooltip roll-up: "12 agents · 9 done · 2 running · 1 failed". Status
 *  buckets in triage order (failed first); zero-count buckets are omitted; any
 *  status outside the known set is counted under its own name (fail-visible). */
export function rollupSummary(statuses: string[], noun: string): string | undefined {
  if (statuses.length === 0) { return undefined; }
  const counts = new Map<string, number>();
  for (const st of statuses) { counts.set(st, (counts.get(st) ?? 0) + 1); }
  const order = ['failed', 'error', 'running', 'waiting', 'done', 'completed', 'incomplete'];
  const keys = [...order.filter(k => counts.has(k)), ...[...counts.keys()].filter(k => !order.includes(k))];
  const bits = [statuses.length + ' ' + noun + (statuses.length === 1 ? '' : 's')];
  // A single uniform bucket adds nothing over the chip's own status dot.
  if (counts.size > 1 || (keys[0] !== 'done' && keys[0] !== 'completed')) {
    for (const k of keys) { bits.push(counts.get(k) + ' ' + k); }
  }
  return bits.join(' \u00b7 ');
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
