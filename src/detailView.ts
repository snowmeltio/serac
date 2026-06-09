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
  teammate?: boolean;
}

interface DetailGroupView {
  key: string;
  title: string | null;
  status: string | null;
  agents: DetailAgentView[];
}

interface DetailViewChoice {
  id: string;
  kind: string;
  label: string;
  status: string;
  active: boolean;
}

interface DetailModel {
  source: string;
  containerId: string;
  sessionId: string;
  title: string;
  chips: string[];
  metrics: string;
  groups: DetailGroupView[];
  views?: DetailViewChoice[];
  team?: string;
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
  /** Left-nav collapsed to a thin rail to free horizontal space for the reader. */
  let navCollapsed = false;
  /** Inception-brief block collapsed in the reader. Default expanded (shown). */
  let briefCollapsed = false;
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
    // A workflow's phase groups all share one key (the runId), so several groups
    // can match `groupKey`. Search every matching group — not just the first —
    // or agents in phases after the first become unselectable (the reader stays
    // on the empty "select an agent" state). agentId is unique within a run.
    for (const g of model.groups) {
      if (g.key !== groupKey) { continue; }
      const a = g.agents.find(ag => ag.agentId === agentId);
      if (a) { return a; }
    }
    return undefined;
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
    const badge = a.teammate ? '<span class="wf-teammate-badge" title="Agent Team member">team</span>' : '';
    return '<div class="wf-nav-row' + (active ? ' active' : '') + (a.teammate ? ' teammate' : '') + '" data-group="' + escapeHtml(groupKey)
      + '" data-agent="' + escapeHtml(a.agentId) + '" role="button" tabindex="0">'
      + statusDot(a.status)
      + '<span class="wf-nav-label">' + escapeHtml(a.label) + '</span>'
      + badge
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
    const entries = (st && st.state === 'ready') ? st.entries : [];

    // The agent's first prompt turn is its inception brief — the task it was
    // spawned with. Pull it out of the flow and pin it, distinct, at the top so
    // the reader leads with "what was asked" rather than the response. Fall back
    // to the sidecar promptPreview before the transcript loads.
    const briefIdx = entries.findIndex(e => e.role === 'user');
    const briefText = briefIdx !== -1 ? entries[briefIdx].content : (agent.promptPreview || '');
    if (briefText) { body += renderBrief(briefText); }

    const rest = briefIdx !== -1 ? entries.filter((_, i) => i !== briefIdx) : entries;
    if (rest.length > 0) {
      for (const e of rest) { body += renderTurn(e); }
    } else if (entries.length === 0) {
      // No transcript turns yet — show the result preview (if any) plus status.
      if (agent.resultPreview) { body += renderTurnRaw('result', agent.resultPreview); }
      if (st && st.state === 'loading') {
        body += '<div class="wf-note">Loading transcript…</div>';
      } else if (st && st.state === 'error') {
        body += '<div class="wf-note">' + escapeHtml(st.message) + '</div>';
      } else if (st && st.state === 'ready') {
        body += '<div class="wf-note">No further turns recorded.</div>';
      }
    }
    body += '</div>';
    return head + body;
  }

  /** The inception brief — the agent's spawning prompt — pinned at the top of
   *  the reader. Collapsible (briefs can run to tens of KB); height-capped with
   *  internal scroll when expanded so it never buries the response. */
  function renderBrief(text: string): string {
    const caret = briefCollapsed ? '▸' : '▾';
    const head = '<div class="wf-brief-head" role="button" tabindex="0" aria-expanded="'
      + (briefCollapsed ? 'false' : 'true') + '">'
      + '<span class="wf-brief-caret">' + caret + '</span>'
      + '<span class="wf-brief-label">Inception brief</span></div>';
    const inner = briefCollapsed ? '' : '<div class="wf-brief-body">' + renderLines(text) + '</div>';
    return '<div class="wf-brief' + (briefCollapsed ? ' collapsed' : '') + '">' + head + inner + '</div>';
  }

  function renderTurn(e: TranscriptEntry): string {
    const who = e.role === 'user' ? 'prompt' : e.role === 'assistant' ? 'assistant' : 'system';
    return renderTurnRaw(who, e.content);
  }

  function renderTurnRaw(who: string, content: string): string {
    return '<div class="wf-turn ' + escapeHtml(who) + '">'
      + '<div class="wf-who">' + escapeHtml(who) + '</div>'
      + '<div class="wf-bubble">' + renderLines(content) + '</div></div>';
  }

  /** Render multiline content (shared by turns and the brief block) as light
   *  markdown — agents speak markdown, so headings, lists, and tables should read
   *  as such rather than as raw `#`/`|` noise. A run of plain prose lines becomes
   *  ONE pre-wrap block so its vertical rhythm is pure line-height (no per-line
   *  margin stacking). Block constructs (headings, `-`/`1.` lists, `|` tables,
   *  `---` rules) break the prose flow. A `> `-prefixed line stays a tool call.
   *  Single blank lines survive as paragraph breaks; runs of blanks collapse.
   *  Deliberately small: no nesting, no block quotes, no fenced code — enough to
   *  de-noise typical agent output without a markdown dependency in the webview. */
  function renderLines(content: string): string {
    const lines = content.split('\n').map(l => l.replace(/\r$/, ''));
    let inner = '';
    let prose: string[] = [];
    const flush = () => {
      while (prose.length && prose[prose.length - 1] === '') { prose.pop(); }
      if (prose.length) { inner += '<div class="wf-prose">' + prose.join('\n') + '</div>'; }
      prose = [];
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Tool call — the transcript renderer's `> ` convention.
      if (line.startsWith('> ')) { flush(); inner += '<div class="wf-tool">' + formatInline(line.slice(2)) + '</div>'; i++; continue; }

      // A line that is wholly a pseudo-XML/HTML wrapper tag — the framing agents
      // wrap briefs in (`<teammate-message …>`, `<system-reminder>`, closing
      // tags). Keep it (it's context) but recess it so the brief leads with the
      // actual instruction, not the envelope.
      if (/^\s*<\/?[a-zA-Z][\w:-]*(\s[^<>]*)?>\s*$/.test(line)) {
        flush();
        inner += '<div class="wf-md-tag">' + formatInline(line.trim()) + '</div>';
        i++; continue;
      }

      // Heading (#..####).
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { flush(); inner += '<div class="wf-md-h' + h[1].length + '">' + formatInline(h[2]) + '</div>'; i++; continue; }

      // Horizontal rule.
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); inner += '<hr class="wf-md-hr">'; i++; continue; }

      // Table — a `|`-row immediately followed by a `|---|` separator row.
      if (line.trim().startsWith('|') && i + 1 < lines.length
          && /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        flush();
        const rows = [splitRow(line)];
        i += 2; // header consumed, separator skipped
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
        inner += renderTable(rows);
        continue;
      }

      // Unordered list.
      if (/^\s*[-*]\s+/.test(line)) {
        flush();
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
        inner += '<ul class="wf-md-list">' + items.map(it => '<li>' + formatInline(it) + '</li>').join('') + '</ul>';
        continue;
      }

      // Ordered list.
      if (/^\s*\d+\.\s+/.test(line)) {
        flush();
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
        inner += '<ol class="wf-md-list">' + items.map(it => '<li>' + formatInline(it) + '</li>').join('') + '</ol>';
        continue;
      }

      // Blank — one paragraph break; collapse leading/consecutive blanks.
      if (line.trim() === '') { if (prose.length && prose[prose.length - 1] !== '') { prose.push(''); } i++; continue; }

      // Plain prose.
      prose.push(formatInline(line));
      i++;
    }
    flush();
    return inner;
  }

  /** Split a markdown table row into trimmed cells (drop the outer pipes). */
  function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith('|')) { s = s.slice(1); }
    if (s.endsWith('|')) { s = s.slice(0, -1); }
    return s.split('|').map(c => c.trim());
  }

  function renderTable(rows: string[][]): string {
    if (rows.length === 0) { return ''; }
    const cols = rows[0].length;
    let h = '<table class="wf-md-table"><thead><tr>';
    for (const c of rows[0]) { h += '<th>' + formatInline(c) + '</th>'; }
    h += '</tr></thead><tbody>';
    for (const r of rows.slice(1)) {
      h += '<tr>';
      for (let c = 0; c < cols; c++) { h += '<td>' + formatInline(r[c] || '') + '</td>'; }
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  /** Minimal inline markdown: **bold**, *italic*, `code`, and [text](url) (the
   *  url is dropped — the reader is read-only). Everything escaped first; bold is
   *  consumed before italic so `**x**` doesn't get mangled by the single-`*` rule. */
  function formatInline(text: string): string {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>');
    s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');
    return s;
  }

  /** Map a view/agent status to a status-dot class so a chip's dot — and its
   *  selected tint — match the status bubble palette used elsewhere. */
  function dotClass(status: string): string {
    return status === 'completed' || status === 'done' ? 'done'
      : status === 'running' ? 'running'
      : status === 'waiting' ? 'waiting'
      : status === 'failed' ? 'failed'
      : status === 'incomplete' ? 'incomplete' : '';
  }

  function allAgents(): DetailAgentView[] {
    if (!model) { return []; }
    const out: DetailAgentView[] = [];
    for (const g of model.groups) { for (const a of g.agents) { out.push(a); } }
    return out;
  }

  /** Aggregate status across a group of agents (for the synthesised team chip). */
  function aggStatus(agents: DetailAgentView[]): string {
    if (agents.some(a => a.status === 'running')) { return 'running'; }
    if (agents.some(a => a.status === 'waiting')) { return 'waiting'; }
    if (agents.some(a => a.status === 'failed')) { return 'failed'; }
    if (agents.length > 0 && agents.every(a => a.status === 'done')) { return 'completed'; }
    return '';
  }

  /** The selectable groupings shown at the top of the pane. Workflow/subagents
   *  sources carry `model.views`; the team source has none (separate surface),
   *  so synthesise a single chip from the team itself — every drill-in then
   *  reads the same: one row of chips you pick from. */
  function viewChips(): DetailViewChoice[] {
    if (!model) { return []; }
    if (model.views && model.views.length > 0) { return model.views; }
    if (model.source === 'team') {
      return [{ id: model.containerId, kind: 'team', label: model.title, status: aggStatus(allAgents()), active: true }];
    }
    return [];
  }

  /** A heading over the switcher so it's obvious what the chips are. */
  function switcherHeading(): string {
    if (!model) { return ''; }
    if (model.source === 'team') { return 'Agent team'; }
    const views = model.views || [];
    const hasWf = views.some(v => v.kind === 'workflow');
    const hasSub = views.some(v => v.kind === 'subagents');
    // A team orchestrator: its subagents are teammates — name the team.
    if (model.team) {
      if (hasWf && hasSub) { return 'Workflows & teammates · ' + model.team; }
      if (hasWf) { return 'Workflows · team ' + model.team; }
      return 'Team · ' + model.team;
    }
    if (hasWf && hasSub) { return 'Workflows & subagents in this session'; }
    if (hasWf) { return (views.filter(v => v.kind === 'workflow').length > 1 ? 'Workflows' : 'Workflow') + ' in this session'; }
    if (hasSub) { return 'Subagents in this session'; }
    return 'Agents in this session';
  }

  /** The pane header: a heading + the switcher chips (the selectable groupings,
   *  selected one tinted to its status), the selected view's metrics, and a jump
   *  back to the parent session. The parent session id is intentionally omitted
   *  — it's identical across every chip, so it added noise, not information. */
  function renderHeader(): string {
    if (!model) { return ''; }
    const metrics = model.metrics
      ? '<div class="wf-head-metrics">' + escapeHtml(model.metrics) + '</div>' : '';
    const chips = viewChips();
    let switcher = '';
    if (chips.length > 0) {
      switcher = '<div class="wf-switch">';
      for (const v of chips) {
        const dot = dotClass(v.status);
        switcher += '<span class="wf-switch-chip' + (v.active ? ' active' : '') + (dot ? ' status-' + dot : '') + '"'
          + ' data-view-id="' + escapeHtml(v.id) + '" data-view-kind="' + escapeHtml(v.kind) + '"'
          + ' role="button" tabindex="0"'
          + ' title="' + escapeHtml(v.label) + ' · ' + escapeHtml(v.status) + '">'
          + '<span class="wf-dot ' + dot + '"></span>'
          + '<span class="wf-switch-chip-label">' + escapeHtml(v.label) + '</span></span>';
      }
      switcher += '</div>';
    }
    return '<div class="wf-head">'
      + '<div class="wf-head-top">'
      + '<div class="wf-head-heading">' + escapeHtml(switcherHeading()) + '</div>'
      + '<div class="wf-openconv" role="button" tabindex="0" title="Open the parent agent session">↗ open parent session</div>'
      + '</div>'
      + switcher
      + metrics
      + '</div>';
  }

  function render(): void {
    // Re-render replaces the whole tree via innerHTML, which resets the scroll
    // of the two independently-scrollable panes. On a live run the host re-posts
    // the model whenever an agent's status flips, so without this a user reading
    // a transcript gets snapped back to the top each tick. Capture and restore.
    const prevReader = root.querySelector('.wf-reader') as HTMLElement | null;
    const prevNav = root.querySelector('.wf-nav') as HTMLElement | null;
    const readerTop = prevReader ? prevReader.scrollTop : 0;
    const navTop = prevNav ? prevNav.scrollTop : 0;
    if (!model || model.groups.every(g => g.agents.length === 0)) {
      // The header carries the switcher, so it stays visible even when the
      // selected view has no agents — the user can switch to one that does.
      root.innerHTML = renderHeader()
        + '<div class="wf-empty">No agents to show for this view.</div>';
      return;
    }
    const navInner = navCollapsed
      ? '<button class="wf-nav-toggle" title="Show agents" aria-label="Show agents">☰</button>'
      : '<div class="wf-nav-head"><button class="wf-nav-toggle" title="Hide agent list"'
        + ' aria-label="Hide agent list">‹ <span>Agents</span></button></div>' + renderNav();
    root.innerHTML = renderHeader()
      + '<div class="wf-2pane">'
      + '<div class="wf-nav' + (navCollapsed ? ' collapsed' : '') + '">' + navInner + '</div>'
      + '<div class="wf-reader">' + renderReader() + '</div>'
      + '</div>';
    const newReader = root.querySelector('.wf-reader') as HTMLElement | null;
    const newNav = root.querySelector('.wf-nav') as HTMLElement | null;
    if (newReader && readerTop) { newReader.scrollTop = readerTop; }
    if (newNav && navTop) { newNav.scrollTop = navTop; }
  }

  // ── Events ─────────────────────────────────────────────────────────

  root.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.wf-nav-toggle')) {
      navCollapsed = !navCollapsed;
      render();
      return;
    }
    if (target.closest('.wf-brief-head')) {
      briefCollapsed = !briefCollapsed;
      render();
      return;
    }
    const navRow = target.closest<HTMLElement>('.wf-nav-row');
    if (navRow) {
      // Picking an agent collapses the list to a thin rail, handing the freed
      // width to the reader. The list stays expanded on first open (the initial
      // auto-select goes straight through selectAgent, not this click path), so
      // you see the roster before you commit to one; re-expand via the rail.
      navCollapsed = true;
      selectAgent(navRow.dataset.group!, navRow.dataset.agent!);
      return;
    }
    const viewChip = target.closest<HTMLElement>('.wf-switch-chip');
    if (viewChip) {
      if (!viewChip.classList.contains('active')) {
        vscode.postMessage({ type: 'selectDetailView', id: viewChip.dataset.viewId!, kind: viewChip.dataset.viewKind! });
      }
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
    const activatable = target.closest('.wf-nav-row, .wf-openconv, .wf-switch-chip, .wf-nav-toggle, .wf-brief-head');
    if (activatable) {
      e.preventDefault();
      (activatable as HTMLElement).click();
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
      // Deep-link from an inline card agent row: select that agent if it exists.
      const sel = msg.select as { groupKey: string; agentId: string } | undefined;
      if (sel && findAgent(sel.groupKey, sel.agentId)) {
        selectAgent(sel.groupKey, sel.agentId);
        return;
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
