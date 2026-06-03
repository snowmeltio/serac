// Webview frontend for the detail panel (createWebviewPanel, opened beside the
// conversation). Source-keyed: renders a normalised DetailModel for workflow
// runs, agent teams, or a session's subagents. Two panes: left = groups →
// agents; right = the selected agent's transcript. Vanilla, no framework
// (bundled to media/detailView.js). Cannot import extension-side modules, so the
// data shapes are redeclared here to mirror types.ts.

interface DetailAgentView {
  agentId: string;
  label: string;
  status: string;
  tokens: number;
  toolCalls: number;
  durationMs: number | null;
  model: string;
  phaseTitle?: string | null;
  attempt?: number;
  promptPreview?: string;
  resultPreview?: string | null;
}

interface DetailGroupView {
  key: string;
  title: string | null;
  status: string | null;
  agents: DetailAgentView[];
}

interface DetailModel {
  source: string;
  containerId: string;
  sessionId: string;
  title: string;
  chips: string[];
  metrics: string;
  groups: DetailGroupView[];
}

interface TranscriptEntry { timestamp: string; role: string; content: string }

type TranscriptState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; entries: TranscriptEntry[] };

interface VsCodeApi { postMessage(msg: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;

(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('wf-root')!;

  let model: DetailModel | null = null;
  let selectedGroupKey: string | null = null;
  let selectedAgentId: string | null = null;
  /** Identity of the drill-in the cache below belongs to. The cache key is only
   *  groupKey|agentId, which collides across containers (subagents/team groups
   *  use an empty groupKey, so '|defender' means different things in two teams).
   *  When the panel is reused for a different drill-in we drop the cache so a
   *  stale transcript can't bleed through. */
  let cacheOwner: string | null = null;
  const transcripts = new Map<string, TranscriptState>(); // key: groupKey|agentId

  function tkey(groupKey: string, agentId: string): string { return groupKey + '|' + agentId; }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
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

  function findAgent(groupKey: string | null, agentId: string | null): DetailAgentView | undefined {
    if (!model || groupKey === null || agentId === null) { return undefined; }
    const g = model.groups.find(gr => gr.key === groupKey);
    return g?.agents.find(a => a.agentId === agentId);
  }

  function firstAgent(): { groupKey: string; agentId: string } | null {
    if (!model) { return null; }
    for (const g of model.groups) {
      if (g.agents.length > 0) { return { groupKey: g.key, agentId: g.agents[0].agentId }; }
    }
    return null;
  }

  function selectAgent(groupKey: string, agentId: string): void {
    selectedGroupKey = groupKey;
    selectedAgentId = agentId;
    const k = tkey(groupKey, agentId);
    if (!transcripts.has(k) && model) {
      transcripts.set(k, { state: 'loading' });
      vscode.postMessage({ type: 'viewAgent', source: model.source, containerId: model.containerId, groupKey, agentId });
    }
    render();
  }

  // ── Rendering ──────────────────────────────────────────────────────

  function statusDot(status: string): string {
    return '<span class="wf-dot ' + escapeHtml(status) + '"></span>';
  }

  function renderNav(): string {
    if (!model) { return ''; }
    let html = '';
    for (const g of model.groups) {
      if (g.title !== null) {
        const count = g.agents.length;
        const done = g.agents.filter(a => a.status === 'done').length;
        html += '<div class="wf-nav-phase"><span>' + escapeHtml(g.title) + '</span>'
          + '<span class="wf-nav-count">' + done + '/' + count + '</span></div>';
      }
      for (const a of g.agents) { html += renderNavRow(g.key, a); }
    }
    return html;
  }

  function renderNavRow(groupKey: string, a: DetailAgentView): string {
    const active = groupKey === selectedGroupKey && a.agentId === selectedAgentId;
    return '<div class="wf-nav-row' + (active ? ' active' : '') + '" data-group="' + escapeHtml(groupKey)
      + '" data-agent="' + escapeHtml(a.agentId) + '" role="button" tabindex="0">'
      + statusDot(a.status)
      + '<span class="wf-nav-label">' + escapeHtml(a.label) + '</span>'
      + (a.tokens > 0 ? '<span class="wf-nav-tokens">' + fmtTokens(a.tokens) + '</span>' : '')
      + '</div>';
  }

  function renderReader(): string {
    const agent = findAgent(selectedGroupKey, selectedAgentId);
    if (!agent) {
      return '<div class="wf-reader-empty">Select an agent to view its transcript.</div>';
    }
    const metaBits: string[] = [];
    if (agent.phaseTitle) { metaBits.push(escapeHtml(agent.phaseTitle)); }
    if (agent.model) { metaBits.push(escapeHtml(agent.model)); }
    if (agent.tokens > 0) { metaBits.push(fmtTokens(agent.tokens) + ' tokens'); }
    metaBits.push(agent.toolCalls + ' tools');
    const dur = fmtDuration(agent.durationMs);
    if (dur) { metaBits.push(dur); }
    if (agent.attempt && agent.attempt > 1) { metaBits.push('attempt ' + agent.attempt); }

    const head = '<div class="wf-reader-head">'
      + '<div class="wf-reader-title">' + statusDot(agent.status) + escapeHtml(agent.label) + '</div>'
      + '<div class="wf-reader-meta">' + metaBits.join(' · ') + '</div></div>';

    let body = '<div class="wf-reader-body">';
    const st = transcripts.get(tkey(selectedGroupKey!, agent.agentId));
    if (st && st.state === 'ready' && st.entries.length > 0) {
      for (const e of st.entries) { body += renderTurn(e); }
    } else {
      if (agent.promptPreview) { body += renderTurnRaw('prompt', agent.promptPreview); }
      if (agent.resultPreview) { body += renderTurnRaw('result', agent.resultPreview); }
      if (st && st.state === 'loading') {
        body += '<div class="wf-note">Loading transcript…</div>';
      } else if (st && st.state === 'error') {
        body += '<div class="wf-note">' + escapeHtml(st.message) + '</div>';
      } else if (st && st.state === 'ready') {
        body += '<div class="wf-note">No transcript turns recorded.</div>';
      }
    }
    body += '</div>';
    return head + body;
  }

  function renderTurn(e: TranscriptEntry): string {
    const who = e.role === 'user' ? 'prompt' : e.role === 'assistant' ? 'assistant' : 'system';
    return renderTurnRaw(who, e.content);
  }

  function renderTurnRaw(who: string, content: string): string {
    const lines = content.split('\n');
    let inner = '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (line.trim() === '') { continue; }
      if (line.startsWith('> ')) {
        inner += '<div class="wf-tool">' + formatInline(line.slice(2)) + '</div>';
      } else {
        inner += '<div class="wf-line">' + formatInline(line) + '</div>';
      }
    }
    return '<div class="wf-turn ' + escapeHtml(who) + '">'
      + '<div class="wf-who">' + escapeHtml(who) + '</div>'
      + '<div class="wf-bubble">' + inner + '</div></div>';
  }

  /** Minimal inline markdown: **bold** and `code`. Everything escaped first. */
  function formatInline(text: string): string {
    let s = escapeHtml(text);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }

  function renderHeader(): string {
    if (!model) { return ''; }
    const chips = model.chips.map(c => '<span class="wf-chip">' + escapeHtml(c) + '</span>').join('');
    const metrics = model.metrics
      ? '<div class="wf-head-metrics">' + escapeHtml(model.metrics) + '</div>' : '';
    return '<div class="wf-head">'
      + '<div class="wf-head-title">' + escapeHtml(model.title) + ' ' + chips + '</div>'
      + '<div class="wf-head-meta">' + escapeHtml(model.sessionId.slice(0, 8)) + '</div>'
      + metrics
      + '<div class="wf-openconv" role="button" tabindex="0">↗ open conversation</div>'
      + '</div>';
  }

  function render(): void {
    if (!model || model.groups.every(g => g.agents.length === 0)) {
      root.innerHTML = '<div class="wf-empty">No agents to show for this view.</div>';
      return;
    }
    root.innerHTML = renderHeader()
      + '<div class="wf-2pane">'
      + '<div class="wf-nav">' + renderNav() + '</div>'
      + '<div class="wf-reader">' + renderReader() + '</div>'
      + '</div>';
  }

  // ── Events ─────────────────────────────────────────────────────────

  root.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const navRow = target.closest<HTMLElement>('.wf-nav-row');
    if (navRow) {
      selectAgent(navRow.dataset.group!, navRow.dataset.agent!);
      return;
    }
    if (target.closest('.wf-openconv')) {
      if (model) { vscode.postMessage({ type: 'openConversation', sessionId: model.sessionId }); }
      return;
    }
  });

  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    const target = e.target as HTMLElement;
    if (target.closest('.wf-nav-row') || target.closest('.wf-openconv')) {
      e.preventDefault();
      (target.closest('.wf-nav-row, .wf-openconv') as HTMLElement).click();
    }
  });

  // ── Inbound messages ───────────────────────────────────────────────

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.type === 'render') {
      model = msg.model as DetailModel;
      // A different drill-in (source or container) invalidates the cache and
      // any carried-over selection — the empty-groupKey cache keys would
      // otherwise collide across containers.
      const owner = model.source + ' ' + model.containerId;
      if (owner !== cacheOwner) {
        cacheOwner = owner;
        transcripts.clear();
        selectedGroupKey = null;
        selectedAgentId = null;
      }
      // Keep selection if still valid; else default to the first agent.
      if (!findAgent(selectedGroupKey, selectedAgentId)) {
        const first = firstAgent();
        if (first) { selectAgent(first.groupKey, first.agentId); return; }
        selectedGroupKey = null;
        selectedAgentId = null;
      }
      render();
    } else if (msg.type === 'agentTranscript') {
      transcripts.set(String(msg.key), { state: 'ready', entries: (msg.entries as TranscriptEntry[]) || [] });
      if (String(msg.key) === tkey(selectedGroupKey ?? '', selectedAgentId ?? '')) { render(); }
    } else if (msg.type === 'agentTranscriptError') {
      transcripts.set(String(msg.key), { state: 'error', message: String(msg.message || 'Failed to load transcript.') });
      if (String(msg.key) === tkey(selectedGroupKey ?? '', selectedAgentId ?? '')) { render(); }
    }
  });
})();
