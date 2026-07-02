import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { fmtTokens, fmtDuration, transcriptKey } from './detailShared.js';
import type {
  DetailAgentView, DetailGroupView, DetailModel, DetailViewChoice, DetailSource,
  SessionSnapshot, TeamSnapshot, WorkflowSnapshot, JsonlRecord,
} from './types.js';
import { entryFromRecord } from './transcriptRenderer.js';
import type { TranscriptEntry } from './detailShared.js';
import { JsonlTailer } from './jsonlTailer.js';
import { isValidSessionId, parseTeammateMessageCommand } from './validation.js';
import { extractEvidence, type Evidence } from './evidenceExtractor.js';
import { detectMismatches, type Mismatch } from './mismatch.js';

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
  listSubagents: (sessionId: string) => { agentId: string; agentType: string | null; description: string | null; model: string | null }[];
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

  /** Drop every cached native-doc snapshot (Phase 4, DESIGN-DETAIL-PANE-V2.md
   *  — the three escape-hatch commands in nativeDocs.ts) when this panel's
   *  drill-in closes. The token map's OTHER eviction path (an N=32 cap) bounds
   *  steady-state growth on its own; this is the second, panel-lifecycle-driven
   *  path the module docstring documents. Optional: absent in unit tests, and
   *  wherever the native-docs feature isn't wired at all (cutting it is then
   *  just "don't wire this + don't register the three commands" in
   *  extension.ts — no DetailPanel code change needed). */
  clearNativeDocsCache?: () => void;
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

  /** Incremental live-transcript cache (audit perf-io-4): ONE slot, keyed by
   *  the transcript key the steady tick re-requests — the selected agent.
   *  Holds a byte-offset tailer plus the entries parsed so far, so a refresh
   *  tick costs a stat (+ appended bytes) instead of a whole-file re-parse.
   *  `inboxSig` fingerprints the teammate inbox suffix, which is NOT
   *  append-only (drained on delivery) and therefore ships separately from
   *  the JSONL entries on every post. Selecting another agent replaces the
   *  slot; truncation or a file swap resets it.
   *
   *  `records` (Phase 3, DESIGN-DETAIL-PANE-V2.md) mirrors `entries` one for
   *  one — the same raw JsonlRecord stream entryFromRecord already consumes
   *  per record, kept around unparsed so extractEvidence can run its own
   *  cross-record correlation (Bash tool_use ↔ tool_result pairing) over the
   *  whole transcript. It grows and resets in lockstep with `entries` (same
   *  reset-on-truncation, same absence of any extra cap): entryFromRecord is
   *  already called once per record read here, so this is one more array
   *  push alongside an existing loop, not a second file read. */
  private liveTranscript: {
    key: string;
    filePath: string;
    tailer: JsonlTailer;
    entries: TranscriptEntry[];
    records: JsonlRecord[];
    /** tool_use id → name correlation for entryFromRecord (Phase 2.1): a
     *  tool_result names its originating tool in the log view. Lives on the
     *  slot because a call and its result can straddle an append boundary —
     *  the map must persist across tailer reads. Reset with entries/records
     *  on truncation, same discipline. */
    toolNames: Map<string, string>;
    inboxSig: string;
  } | null = null;
  /** Transcript requests run strictly one at a time — interleaved tailer
   *  reads on the shared slot would double-append. Steady ticks are dropped
   *  while one is queued (the next tick re-converges); full requests always
   *  run (the webview shows "loading" until they answer). */
  private transcriptQueue: Promise<void> = Promise.resolve();
  private transcriptQueueDepth = 0;
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
        this.liveTranscript = null;
        this.deps.clearNativeDocsCache?.();
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
    this.liveTranscript = null;
    this.deps.clearNativeDocsCache?.();
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

  // Per-build memo for the two expensive deps. buildViewChoices documents that
  // the subagents dir-scan "happens once per model build"; that invariant broke
  // as team support grew — the team path reached deps.listSubagents (sync
  // readdir + per-agent reads) and deps.getSession (full snapshot rebuild) up
  // to four times per build, at refresh cadence. Cleared at buildModel entry so
  // one build sees one consistent scan.
  private readonly memoSession = new Map<string, SessionSnapshot | undefined>();
  private readonly memoDisk = new Map<string, ReturnType<DetailPanelDeps['listSubagents']>>();

  private sessionOnce(sessionId: string): SessionSnapshot | undefined {
    if (!this.memoSession.has(sessionId)) { this.memoSession.set(sessionId, this.deps.getSession(sessionId)); }
    return this.memoSession.get(sessionId);
  }

  private subagentFilesOnce(sessionId: string): ReturnType<DetailPanelDeps['listSubagents']> {
    if (!this.memoDisk.has(sessionId)) { this.memoDisk.set(sessionId, this.deps.listSubagents(sessionId)); }
    return this.memoDisk.get(sessionId)!;
  }

  private buildModel(source: DetailSource, containerId: string, sessionId: string): DetailModel {
    this.memoSession.clear();
    this.memoDisk.clear();
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
          agents: failedFirst(inPhase).map(a => this.workflowAgentView(a)),
        });
      }
      const ungrouped = selected.agents.filter(a => !seen.has(a.agentId));
      if (ungrouped.length > 0) {
        const title = selected.phases.length > 0 ? 'Other' : null;
        groups.push({ key: selected.runId, title, agents: failedFirst(ungrouped).map(a => this.workflowAgentView(a)) });
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
      metrics: metricsBits.join(' · '),
      groups,
      views: this.buildViewChoices(runs, selected?.runId ?? null, 'workflow', this.subsForViewChoices(sessionId, team), team),
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
    // Offered only when the team has tmux members — for an all-in-process team
    // the (deduped) Teammates view is a superset WITH the composer, so a roster
    // chip is pure redundancy (Murray, 2026-06-10). Kept while active so the
    // switcher always reflects the visible view; the view itself still renders
    // in-process members for mixed teams and the keep-while-active case.
    if (team && (team.agents.length > 0 || activeSource === 'team')) {
      const rosterStatuses = [
        ...team.agents.map(a => a.status),
        ...this.inProcessRosterRows(team).map(r => r.status),
      ];
      views.push({
        id: team.teamId,
        kind: 'team',
        label: 'Roster · ' + team.name,
        status: rosterStatuses.some(s => s === 'running') ? 'running' : 'completed',
        active: activeSource === 'team',
        summary: rollupSummary(rosterStatuses, 'member'),
      });
    }
    return views.length > 0 ? views : undefined;
  }

  private workflowAgentView(a: WorkflowSnapshot['agents'][number]): DetailAgentView {
    // A running agent has no final duration yet — show elapsed-so-far instead
    // (UX-1). The webview's steady refresh keeps it current; no new timers.
    const durationMs = a.durationMs ?? (a.status === 'running' && a.startedAt > 0
      ? Date.now() - a.startedAt
      : null);
    return {
      agentId: a.agentId,
      label: a.label || a.agentId.slice(0, 10),
      status: a.status,
      tokens: a.tokens,
      toolCalls: a.toolCalls,
      durationMs,
      model: a.model,
      phaseTitle: a.phaseTitle,
      attempt: a.attempt,
      promptPreview: a.promptPreview,
      resultPreview: a.resultPreview,
      lastToolName: a.status === 'running' ? a.lastToolName : null,
      lastToolSummary: a.status === 'running' ? a.lastToolSummary : null,
    };
  }

  /** Collect a session's plain Task subagents — live-tracked (rich progress)
   *  unioned with on-disk transcripts the tracker missed, so none is dropped.
   *  Shared by the subagents model and the view switcher's count. */
  private collectSubagents(sessionId: string): { agents: DetailAgentView[]; running: number } {
    const session = this.sessionOnce(sessionId);
    // Live-tracked subagents carry rich progress (running state, tool counts,
    // result preview) but only once tracking resolved an agentId. Agent-tool
    // subagents that never relay `agent_progress` stay agentId-less, so the
    // tracked list alone can be empty even when transcripts exist on disk.
    const tracked = (session?.subagents ?? []).filter(s => s.agentId);
    // Model comes from the on-disk transcript head (meta.json never carries
    // it), so tracked rows borrow it from the same disk scan the union uses.
    const modelById = new Map(this.subagentFilesOnce(sessionId).map(d => [d.agentId, d.model]));
    const agents: DetailAgentView[] = tracked.map(s => ({
      agentId: s.agentId as string,
      label: s.description || (s.agentId as string).slice(0, 10),
      // 'waiting' (not just running/done): the Phase 2 log view's pinned
      // permission row (DESIGN-DETAIL-PANE-V2.md) is driven purely off
      // DetailAgentView.status, so a plain subagent blocked on a permission
      // prompt must surface it — same mapping panelRender.ts already uses
      // for the sidebar's subagent rows.
      status: s.running ? (s.waitingOnPermission ? 'waiting' : 'running') : 'done',
      tokens: 0,
      toolCalls: s.toolsCompleted,
      durationMs: null,
      model: modelById.get(s.agentId as string) ?? '',
      resultPreview: s.resultPreview,
    } satisfies DetailAgentView));
    // Union in any on-disk transcript the tracker missed, so no subagent is
    // silently dropped (the cause of the empty panel). These are treated as
    // completed — a disk-only agent with no live tracking has nothing running.
    const trackedIds = new Set(tracked.map(s => s.agentId));
    for (const d of this.subagentFilesOnce(sessionId)) {
      if (trackedIds.has(d.agentId)) { continue; }
      agents.push({
        agentId: d.agentId,
        label: d.description || d.agentType || d.agentId.slice(0, 10),
        status: 'done',
        tokens: 0,
        toolCalls: 0,
        durationMs: null,
        model: d.model ?? '',
      } satisfies DetailAgentView);
    }
    return { agents, running: tracked.filter(s => s.running).length };
  }

  /** A team lead's subagent rows framed for display. Only roster-matched rows
   *  are teammates (a lead can also spawn ordinary Task subagents — Explore,
   *  general-purpose, … — whose inbox sends could never resolve; those must not
   *  get a composer or a team badge). Membership is keyed the same way
   *  resolveInboxTarget resolves it: the on-disk meta's agentType equals the
   *  member name, with tmux entries unioned with the in-process names.
   *
   *  Teammates are deduped to ONE row per CURRENT member: re-spawn rounds leave
   *  stale duplicates, and the inbox keys by name, so extras only mislead. Rows
   *  arrive tracked-then-disk, each in spawn order, so on a name collision the
   *  LAST row is the newest; a running row always beats a finished one. The kept
   *  row is labelled with the member name and ordered by the roster.
   *
   *  Teammate liveness ≠ subagent status: an idle teammate is alive (listening
   *  on its inbox) while its Task-tracking reads done. Alive = still on the
   *  CURRENT roster (members are removed from the config on shutdown) and the
   *  lead process not registry-confirmed dead (in-process teammates live in it). */
  private teamSubagentRows(sessionId: string, team: TeamSnapshot | undefined): { teammates: DetailAgentView[]; plain: DetailAgentView[]; running: number } {
    const subs = this.collectSubagents(sessionId);
    if (!team) { return { teammates: [], plain: subs.agents, running: subs.running }; }
    const roster = new Set([...team.agents.map(a => a.name), ...team.inProcessMembers]);
    const typeById = new Map(this.subagentFilesOnce(sessionId).map(d => [d.agentId, d.agentType]));
    const leadGone = this.sessionOnce(sessionId)?.processLive === false;
    const byName = new Map<string, DetailAgentView>();
    const plain: DetailAgentView[] = [];
    for (const a of subs.agents) {
      const name = typeById.get(a.agentId) ?? '';
      if (!roster.has(name)) { plain.push(a); continue; }
      const row = { ...a, label: name, teammate: true, alive: !leadGone };
      const prev = byName.get(name);
      if (!prev || row.status === 'running' || prev.status !== 'running') { byName.set(name, row); }
    }
    // Roster order (tmux then in-process) so the list mirrors the team config.
    const order = [...team.agents.map(a => a.name), ...team.inProcessMembers];
    const teammates = order.filter(n => byName.has(n)).map(n => byName.get(n) as DetailAgentView);
    const running = [...teammates, ...plain].filter(a => a.status === 'running').length;
    return { teammates, plain, running };
  }

  /** Flat row set for the view switcher's roll-up counts — deduped the same way
   *  the subagents view renders, so the chip tooltip matches what opening it shows. */
  private subsForViewChoices(sessionId: string, team: TeamSnapshot | undefined): { agents: DetailAgentView[]; running: number } {
    const { teammates, plain, running } = this.teamSubagentRows(sessionId, team);
    return { agents: [...teammates, ...plain], running };
  }

  private buildSubagentsModel(sessionId: string, invokingSessionId: string): DetailModel {
    // When this session orchestrates a team, its (in-process) subagents ARE the
    // teammates — frame them as such: a teammate badge per agent, a "Teammates"
    // label, and the team name on the model for the header.
    const team = this.teamFor(sessionId);
    const { teammates, plain, running } = this.teamSubagentRows(sessionId, team);
    // Two groups only when both kinds exist — a pure team (or a plain session)
    // stays a flat list with no headers. Both groups share the '' key (findAgent
    // searches all matching groups), so card deep-links keep resolving.
    const groups: DetailGroupView[] = team && teammates.length > 0 && plain.length > 0
      ? [
        { key: '', title: 'Teammates', agents: teammates },
        { key: '', title: 'Other subagents', agents: plain },
      ]
      : [{ key: '', title: null, agents: [...teammates, ...plain] }];
    const metricsBits: string[] = [];
    if (team) {
      metricsBits.push(teammates.length + ' teammate' + (teammates.length === 1 ? '' : 's'));
      if (plain.length > 0) { metricsBits.push(plain.length + ' other subagent' + (plain.length === 1 ? '' : 's')); }
    } else {
      metricsBits.push(plain.length + ' subagent' + (plain.length === 1 ? '' : 's'));
    }
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
      metrics: metricsBits.join(' · '),
      groups,
      views: this.buildViewChoices(runs, null, 'subagents', { agents: [...teammates, ...plain], running }, team),
      team: team?.name,
    };
  }

  private buildTeamModel(teamId: string, invokingSessionId: string): DetailModel {
    const team = this.deps.getTeams().find(t => t.teamId === teamId);
    const agents = team?.agents ?? [];
    // The switcher must offer the way back: the orchestrator's workflow runs
    // and teammates views, built against the orchestrator session.
    const orchestratorId = team?.orchestrator.sessionId;
    // In-process members get roster rows too (the orchestrator card's `agent
    // team` chip lands here — an all-in-process team must not read "0 members").
    const inProcessRows = team ? this.inProcessRosterRows(team) : [];
    const memberCount = agents.length + inProcessRows.length;
    const done = agents.filter(a => a.status === 'done').length;
    const metricsBits = [memberCount + ' member' + (memberCount === 1 ? '' : 's')];
    if (agents.length > 0) { metricsBits.push(done + '/' + agents.length + ' done'); }
    const runs = orchestratorId
      ? this.deps.getWorkflows().filter(w => w.sessionId === orchestratorId).sort((a, b) => b.startTime - a.startTime)
      : [];
    const views = orchestratorId
      ? this.buildViewChoices(runs, null, 'team', this.subsForViewChoices(orchestratorId, team), team)
      : undefined;
    return {
      source: 'team',
      containerId: teamId,
      sessionId: invokingSessionId,
      title: team?.name ?? 'Agent team',
      metrics: metricsBits.join(' · '),
      groups: [{
        key: '',
        title: null,
        // Resolution key is the member name (matched against agent-*.meta.json
        // agentType for in-process members, or its sessionId when present).
        agents: [
          ...agents.map(a => ({
            agentId: a.name,
            label: a.name,
            status: a.status,
            tokens: a.contextTokens,
            toolCalls: 0,
            durationMs: null,
            model: '',
          } satisfies DetailAgentView)),
          ...inProcessRows,
        ],
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
      this.enqueueTranscript(msg.source, msg.containerId, msg.groupKey, msg.agentId, msg.full === true);
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
    } else if (msg.type === 'showRawRecord') {
      await this.handleShowRawRecord(msg);
    } else if (msg.type === 'openTranscriptDoc') {
      await this.handleOpenTranscriptDoc(msg);
    } else if (msg.type === 'showFileChanges') {
      await this.handleShowFileChanges(msg);
    }
  }

  // ── Native escape hatches (Phase 4, DESIGN-DETAIL-PANE-V2.md) ────────
  // Each webview message here names a row/chip in the panel's CURRENTLY
  // DISPLAYED drill-in — validated against `this.source`/`this.containerId`,
  // not just structurally, the same defensive posture resolveInboxTarget
  // uses for roster resolution (a stale or forged message naming a different
  // drill-in is refused, not just a malformed one). The actual work (file
  // I/O, opening a native doc/diff) lives entirely in nativeDocs.ts, invoked
  // here via `vscode.commands.executeCommand` — real, independently
  // registered commands (see extension.ts), so cutting one is just "don't
  // register it": the rejected promise from a missing command is swallowed
  // below, not surfaced as an error (a cut feature is a silent no-op, not a
  // broken button).

  /** Common shape + identity validation shared by all three handlers below.
   *  `label` is a display-only courtesy string (tab title / diff title
   *  suffix) — it never drives file resolution, so a generous cap is enough;
   *  nativeDocs.ts sanitises it further before using it in a URI. */
  private validNativeDocBase(msg: Record<string, unknown>): { source: DetailSource; containerId: string; groupKey: string; agentId: string; label: string } | null {
    if (msg.source !== 'workflow' && msg.source !== 'team' && msg.source !== 'subagents') { return null; }
    // The transcript key must match the panel's CURRENT container — refuses a
    // message naming a drill-in this panel isn't (or is no longer) showing.
    if (msg.source !== this.source || msg.containerId !== this.containerId) { return null; }
    if (typeof msg.groupKey !== 'string' || (msg.groupKey !== '' && !isValidSessionId(msg.groupKey))) { return null; }
    if (!isValidSessionId(msg.agentId)) { return null; }
    const label = typeof msg.label === 'string' ? msg.label.slice(0, 200) : msg.agentId;
    return { source: msg.source, containerId: msg.containerId as string, groupKey: msg.groupKey, agentId: msg.agentId, label };
  }

  private resolveNativeDocFile(base: { source: DetailSource; containerId: string; groupKey: string; agentId: string }): string | null {
    return this.deps.resolveAgentFile(base.source, base.containerId, base.groupKey, base.agentId);
  }

  /** Run a registered native-doc command, swallowing a rejection silently —
   *  the ONLY way `executeCommand` rejects here is "no command with this id"
   *  (extension.ts didn't register it, i.e. the feature was cut). A
   *  business-logic failure (oversized transcript, record not found, not an
   *  Edit) resolves normally; the command itself surfaces that with a toast
   *  (see nativeDocs.ts's `make*Command` factories) — DetailPanel never
   *  inspects the result. */
  private async runNativeDocCommand(command: string, args: Record<string, unknown>): Promise<void> {
    try {
      await vscode.commands.executeCommand(command, args);
    } catch {
      // Not registered — the feature was cut. No-op.
    }
  }

  private async handleShowRawRecord(msg: Record<string, unknown>): Promise<void> {
    const base = this.validNativeDocBase(msg);
    if (!base) { return; }
    if (typeof msg.entryIndex !== 'number' || !Number.isInteger(msg.entryIndex) || msg.entryIndex < 0) { return; }
    const filePath = this.resolveNativeDocFile(base);
    if (!filePath) { void vscode.window.showWarningMessage('Transcript not available yet.'); return; }
    await this.runNativeDocCommand('serac.detail.showRawRecord', { filePath, entryIndex: msg.entryIndex, label: base.label });
  }

  private async handleOpenTranscriptDoc(msg: Record<string, unknown>): Promise<void> {
    const base = this.validNativeDocBase(msg);
    if (!base) { return; }
    const filePath = this.resolveNativeDocFile(base);
    if (!filePath) { void vscode.window.showWarningMessage('Transcript not available yet.'); return; }
    await this.runNativeDocCommand('serac.detail.openTranscriptDoc', { filePath, agentId: base.agentId, label: base.label });
  }

  private async handleShowFileChanges(msg: Record<string, unknown>): Promise<void> {
    const base = this.validNativeDocBase(msg);
    if (!base) { return; }
    const hasIndex = typeof msg.entryIndex === 'number' && Number.isInteger(msg.entryIndex) && msg.entryIndex >= 0;
    const hasPath = typeof msg.filePath === 'string' && msg.filePath.length > 0 && msg.filePath.length <= 4096;
    if (!hasIndex && !hasPath) { return; }
    const filePath = this.resolveNativeDocFile(base);
    if (!filePath) { void vscode.window.showWarningMessage('Transcript not available yet.'); return; }
    const target = hasIndex ? { entryIndex: msg.entryIndex as number } : { targetPath: msg.filePath as string };
    await this.runNativeDocCommand('serac.detail.showFileChanges', { filePath, target, label: base.label });
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

  /** Roster rows for a team's IN-PROCESS members. They are excluded from
   *  `TeamSnapshot.agents` (they surface as the lead's subagents) but the
   *  roster view renders them so an all-in-process team is never a "0 members"
   *  dead end. Resolution key is the member name; transcripts resolve via the
   *  lead's agent-*.meta.json scan. Status borrows the lead's live subagent
   *  tracking when a matching agent is tracked, else the idle default 'done' —
   *  `alive` (presence in the config + lead process alive) carries liveness. */
  private inProcessRosterRows(team: TeamSnapshot): DetailAgentView[] {
    if (team.inProcessMembers.length === 0) { return []; }
    const orchestratorId = team.orchestrator.sessionId;
    const orchSession = this.sessionOnce(orchestratorId);
    const files = this.subagentFilesOnce(orchestratorId);
    const typeById = new Map(files.map(d => [d.agentId, d.agentType]));
    // Newest spawn wins on a name collision (files arrive spawn-ordered), same
    // rule teamSubagentRows uses to dedupe re-spawn rounds.
    const modelByType = new Map<string, string>();
    for (const d of files) { if (d.agentType && d.model) { modelByType.set(d.agentType, d.model); } }
    const tracked = orchSession?.subagents ?? [];
    const leadAlive = orchSession?.processLive !== false;
    return team.inProcessMembers.map(name => ({
      agentId: name,
      label: name,
      status: tracked.some(s => s.agentId && s.running && typeById.get(s.agentId) === name) ? 'running' : 'done',
      tokens: 0,
      toolCalls: 0,
      durationMs: null,
      model: modelByType.get(name) ?? '',
      teammate: true,
      alive: leadAlive,
    } satisfies DetailAgentView));
  }

  /** Inbox target for a TEAM-ROSTER row, where the agentId IS the member name.
   *  Read-side only (the composer/write path stays pinned to the subagents
   *  source). The name must be on the CURRENT roster — tmux or in-process —
   *  of a team this panel knows; anything else refuses. */
  private inboxTargetForRosterMember(teamId: string, memberName: string): { teamDir: string; member: string } | null {
    if (!teamId.startsWith('at:')) { return null; }
    const team = this.deps.getTeams().find(t => t.teamId === teamId);
    if (!team) { return null; }
    const onRoster = team.agents.some(a => a.name === memberName) || team.inProcessMembers.includes(memberName);
    return onRoster ? { teamDir: teamId.slice(3), member: memberName } : null;
  }

  /** Serialise transcript requests (see transcriptQueue). */
  private enqueueTranscript(source: DetailSource, containerId: string, groupKey: string, agentId: string, wantFull: boolean): void {
    if (!wantFull && this.transcriptQueueDepth > 0) { return; }
    this.transcriptQueueDepth++;
    this.transcriptQueue = this.transcriptQueue
      .then(() => this.sendAgentTranscript(source, containerId, groupKey, agentId, wantFull))
      .catch(() => { /* errors are posted in-band; never break the chain */ })
      .finally(() => { this.transcriptQueueDepth--; });
  }

  /** Hard cap on the initial window read of a huge transcript: start the tail
   *  at size − cap rather than byte 0 (matches the old parseTranscript cap). */
  private static readonly TRANSCRIPT_WINDOW_BYTES = 50 * 1024 * 1024;

  private async sendAgentTranscript(source: DetailSource, containerId: string, groupKey: string, agentId: string, wantFull: boolean): Promise<void> {
    // Capture the panel up front and re-check identity after the await: the
    // transcript read is async, and the panel can be disposed (or reused for a
    // different drill-in) before it resolves. Posting to a disposed webview
    // throws; posting to a reused one bleeds a stale transcript into the new view.
    const panel = this.panel;
    if (!panel) { return; }
    // Owner-prefixed so a response in flight across a drill-in switch can never
    // collide with the new container's keys — the same shared transcriptKey()
    // the webview uses, so the two sides cannot drift.
    const key = transcriptKey(source, containerId, groupKey, agentId);
    const file = this.deps.resolveAgentFile(source, containerId, groupKey, agentId);
    if (!file) {
      void panel.webview.postMessage({ type: 'agentTranscriptError', key, message: 'Transcript not available yet.' });
      return;
    }

    // Reuse the slot when it matches this key+file; otherwise start fresh.
    let slot = this.liveTranscript;
    let reset = false;
    if (!slot || slot.key !== key || slot.filePath !== file) {
      let initialOffset = 0;
      try {
        const stat = await fs.promises.stat(file);
        if (stat.size > DetailPanel.TRANSCRIPT_WINDOW_BYTES) {
          initialOffset = stat.size - DetailPanel.TRANSCRIPT_WINDOW_BYTES;
        }
      } catch { /* missing file reads as empty below, like the old parser */ }
      slot = { key, filePath: file, tailer: new JsonlTailer(file, initialOffset), entries: [], records: [], toolNames: new Map(), inboxSig: '' };
      reset = true;
    }

    // Drain appended bytes. The tailer reads ≤16MB per call, so loop until the
    // offset stops advancing; truncation resets the slot's entries (the tailer
    // has already restarted from byte 0 within the same call). `records`
    // accumulates in lockstep with `entries` — same records, additionally
    // kept raw for extractEvidence's cross-record correlation below.
    const appended: TranscriptEntry[] = [];
    const appendedRecords: JsonlRecord[] = [];
    try {
      for (;;) {
        const before = slot.tailer.getOffset();
        const records = await slot.tailer.readNewRecords();
        if (slot.tailer.truncated) {
          slot.entries = [];
          slot.records = [];
          slot.toolNames.clear();
          appended.length = 0;
          appendedRecords.length = 0;
          reset = true;
        }
        for (const r of records) {
          appendedRecords.push(r);
          const entry = entryFromRecord(r, slot.toolNames);
          if (entry) { appended.push(entry); }
        }
        if (slot.tailer.getOffset() <= before) { break; }
      }
    } catch (err) {
      if (this.panel !== panel) { return; }
      void panel.webview.postMessage({ type: 'agentTranscriptError', key, message: String(err) });
      return;
    }
    slot.entries.push(...appended);
    slot.records.push(...appendedRecords);
    if (this.panel !== panel) { return; } // disposed or replaced mid-read

    // Inbox read-side: messages sent to this teammate that it has not yet
    // drained appear as queued turns at the tail — so "did my message land?"
    // is answerable from the thread itself. Gated on the same server-side
    // settings as the composer; fail-silent (display affordance only).
    // Covers both teammate surfaces: the subagents view (agentId = subagent
    // hash, roster-resolved) and the team roster view (agentId = member name).
    // Shipped as a SEPARATE suffix on every post (never folded into entries):
    // the inbox drains on delivery, so the suffix can shrink while the JSONL
    // prefix only grows — the webview replaces it wholesale each time.
    const suffix: TranscriptEntry[] = [];
    if ((source === 'subagents' || source === 'team') && this.deps.peekTeammateInbox
        && this.deps.getMessagingSettings?.().enabled) {
      try {
        const target = source === 'subagents'
          ? (this.deps.resolveInboxTarget ? this.deps.resolveInboxTarget(containerId, agentId) : null)
          : this.inboxTargetForRosterMember(containerId, agentId);
        if (target) {
          for (const m of this.deps.peekTeammateInbox(target.teamDir, target.member)) {
            suffix.push({
              timestamp: m.timestamp,
              role: 'system',
              content: 'Queued for delivery (from ' + m.from + '): ' + m.text,
            });
          }
        }
      } catch { /* never block the transcript on inbox state */ }
    }
    const inboxSig = JSON.stringify(suffix);
    const inboxChanged = inboxSig !== slot.inboxSig;
    slot.inboxSig = inboxSig;
    this.liveTranscript = slot;

    // Evidence + mismatches (Phase 3, DESIGN-DETAIL-PANE-V2.md): recomputed
    // from the WHOLE accumulated record set on every post, not incrementally.
    // Chosen deliberately over incremental Bash tool_use/tool_result pairing:
    // a bash call and its result can straddle an append boundary (the
    // tool_use arrives on one tick, the tool_result on the next), so a truly
    // incremental extractor would need to carry half-paired state across
    // calls — real complexity for a cost that stays small in practice
    // (slot.records is bounded the same way slot.entries already is: no
    // extra cap beyond the existing tail-window/truncation-reset discipline,
    // and a refresh tick only re-extracts while the SELECTED agent is live,
    // never for idle agents). The webview never computes this itself — see
    // mismatch.ts's docstring on why that would defeat the anti-fabrication
    // point.
    const evidence: Evidence = extractEvidence(slot.records);
    const mismatches: Mismatch[] = detectMismatches(evidence);

    if (wantFull || reset) {
      // Full snapshot: first load for a webview that holds nothing, or a
      // truncation/file-swap reset. Authoritative — may legitimately shrink.
      void panel.webview.postMessage({ type: 'agentTranscript', key, entries: slot.entries, suffix, evidence, mismatches });
    } else if (appended.length > 0 || inboxChanged) {
      void panel.webview.postMessage({ type: 'agentTranscriptAppend', key, entries: appended, suffix, evidence, mismatches });
    }
    // else: nothing changed — post nothing; the webview keeps its cache.
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

