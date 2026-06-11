// Webview frontend for the detail panel (createWebviewPanel, opened beside the
// conversation). Source-keyed: renders a normalised DetailModel for workflow
// runs, agent teams, or a session's subagents. Two panes: left = groups →
// agents; right = the selected agent's transcript. Vanilla, no framework
// (bundled to media/detailView.js). The data shapes and shared formatters come
// from detailShared.ts — the same module the host's builders compile against,
// so the contract is compiler-enforced rather than comment-mirrored.

import { isNearBottom, chooseReaderScrollTop, STICK_THRESHOLD_PX } from './detailViewScroll.js';
import { escapeHtml } from './panelUtils.js';
import { fmtTokens, fmtDuration, transcriptKey } from './detailShared.js';
import type {
  DetailAgentView, DetailGroupView, DetailViewChoice, DetailModel, TranscriptEntry,
} from './detailShared.js';

type TranscriptState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; entries: TranscriptEntry[] };

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('wf-root')!;

  let model: DetailModel | null = null;
  let selectedGroupKey: string | null = null;
  let selectedAgentId: string | null = null;
  /** Left-nav collapsed to a thin rail to free horizontal space for the reader.
   *  Reflected as a `nav-collapsed` class on the persistent #wf-root (not baked
   *  into the nav markup) so toggling it animates the existing .wf-nav width via
   *  CSS — a full innerHTML re-render would destroy the element and kill the
   *  transition. Manual only: selecting an agent no longer auto-collapses. */
  let navCollapsed = false;
  /** Inception-brief block collapsed in the reader. Default expanded (shown). */
  let briefCollapsed = false;

  // ── Webview state persistence ──────────────────────────────────────
  // The panel webview is rebuilt whenever its tab is re-opened; vscode.setState
  // survives that (same pattern as the sidebar). Selection is restored only if
  // the next model is the SAME drill-in (owner matches) and the agent still
  // exists — otherwise the normal first-agent default applies.
  interface PersistedState {
    owner?: string;
    groupKey?: string;
    agentId?: string;
    navCollapsed?: boolean;
    briefCollapsed?: boolean;
  }
  const persisted = (vscode.getState() ?? {}) as PersistedState;
  navCollapsed = persisted.navCollapsed === true;
  briefCollapsed = persisted.briefCollapsed === true;
  /** One-shot selection restore, consumed by the first matching render. */
  let pendingRestore: { owner: string; groupKey: string; agentId: string } | null =
    (typeof persisted.owner === 'string' && typeof persisted.groupKey === 'string'
      && typeof persisted.agentId === 'string')
      ? { owner: persisted.owner, groupKey: persisted.groupKey, agentId: persisted.agentId }
      : null;

  function saveState(): void {
    vscode.setState({
      owner: cacheOwner ?? undefined,
      groupKey: selectedGroupKey ?? undefined,
      agentId: selectedAgentId ?? undefined,
      navCollapsed,
      briefCollapsed,
    } satisfies PersistedState);
  }
  /** Identity of the drill-in the cache below belongs to. The cache key is only
   *  groupKey|agentId, which collides across containers (subagents/team groups
   *  use an empty groupKey, so '|defender' means different things in two teams).
   *  When the panel is reused for a different drill-in we drop the cache so a
   *  stale transcript can't bleed through. */
  let cacheOwner: string | null = null;
  const transcripts = new Map<string, TranscriptState>(); // key: groupKey|agentId

  /** Experimental settings pushed from the host (composer gate + disclosure
   *  label). The flag here is DISPLAY-ONLY — every send is re-checked server-side
   *  regardless, so a tampered webview value cannot enable the write path. */
  const experimental = { teammateMessaging: false, operatorName: 'operator' };

  /** Cache key for one agent's transcript — the shared transcriptKey() the
   *  host also uses, so the two sides cannot drift. Model-less early calls
   *  fall back to an owner-less key (matched only within this webview). */
  function tkey(groupKey: string, agentId: string): string {
    return model
      ? transcriptKey(model.source, model.containerId, groupKey, agentId)
      : '|' + groupKey + '|' + agentId;
  }

  /** A per-record time label: relative while recent ("just now", "5m ago",
   *  "2h ago"), crossing over to an absolute date once ≥ ~24h old (the
   *  GitHub/Slack timeago pattern). `t`/`now` are epoch ms; the webview is a
   *  browser context so Date is unrestricted here. */
  function formatRelativeTime(t: number, now: number): string {
    const diff = now - t;
    if (diff < 60000) { return 'just now'; }            // < 1 min (also covers small clock skew)
    if (diff < 3600000) { return Math.floor(diff / 60000) + 'm ago'; }
    if (diff < 86400000) { return Math.floor(diff / 3600000) + 'h ago'; }
    const d = new Date(t);
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date(now).getFullYear()) { opts.year = 'numeric'; }
    return d.toLocaleDateString(undefined, opts);
  }

  /** A quiet timestamp span for a transcript turn: relative-then-absolute text,
   *  with the full local date-time always on hover. Empty when the record has no
   *  (parseable) timestamp. */
  function renderTime(iso?: string): string {
    if (!iso) { return ''; }
    const t = Date.parse(iso);
    if (isNaN(t)) { return ''; }
    const rel = formatRelativeTime(t, Date.now());
    const abs = new Date(t).toLocaleString();
    return '<span class="wf-turn-time" data-t="' + t + '" title="' + escapeHtml(abs) + '">' + escapeHtml(rel) + '</span>';
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

  /** Append-only transcript identity: same length and identical last entry.
   *  (A streamed turn that grows in place changes the last entry's content.) */
  function sameTranscript(a: TranscriptEntry[], b: TranscriptEntry[]): boolean {
    if (a.length !== b.length) { return false; }
    if (a.length === 0) { return true; }
    const la = a[a.length - 1];
    const lb = b[b.length - 1];
    return la.role === lb.role && la.timestamp === lb.timestamp && la.content === lb.content;
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
    saveState();
    const k = tkey(groupKey, agentId);
    if (!transcripts.has(k) && model) {
      transcripts.set(k, { state: 'loading' });
      vscode.postMessage({ type: 'viewAgent', source: model.source, containerId: model.containerId, groupKey, agentId });
    }
    render();
  }

  // ── Live refresh ────────────────────────────────────────────────────
  // A running agent's transcript must stream. The host re-reads + re-posts the
  // transcript on each `viewAgent`, so we re-request the SELECTED agent on a
  // steady interval *only while it is running*. We do NOT touch the transcript
  // cache here, so the reader keeps showing the current turns until the refreshed
  // ones arrive — no loading flash. Paused while the panel is hidden.
  const STEADY_REFRESH_MS = 2500;
  // After a teammate send, briefly poll faster to catch the member's reply (it
  // drains its inbox on a ~5-6s cycle), then fall back to the steady cadence.
  const BURST_REFRESH_MS = 1000;
  const BURST_DURATION_MS = 15000;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let burstUntil = 0;

  function startRefreshLoop(intervalMs: number): void {
    if (refreshTimer !== null) { clearInterval(refreshTimer); }
    refreshTimer = setInterval(refreshTick, intervalMs);
  }

  /** Switch the refresh loop to the fast cadence for a short window. */
  function burstRefresh(): void {
    burstUntil = Date.now() + BURST_DURATION_MS;
    startRefreshLoop(BURST_REFRESH_MS);
  }

  function refreshTick(): void {
    // Expired burst → revert to the steady cadence (then still tick this cycle).
    if (burstUntil && Date.now() > burstUntil) { burstUntil = 0; startRefreshLoop(STEADY_REFRESH_MS); }
    if (typeof document !== 'undefined' && document.hidden) { return; } // don't poll a hidden panel
    if (!model || selectedGroupKey === null || selectedAgentId === null) { return; }
    const agent = findAgent(selectedGroupKey, selectedAgentId);
    // Live agents stream; so do ALIVE teammates — an idle teammate reads done
    // to Task tracking but can wake on an inbox message at any moment, and its
    // transcript must follow in real time.
    const live = agent && (agent.status === 'running' || (agent.teammate === true && agent.alive === true));
    if (!live) { return; }
    vscode.postMessage({
      type: 'viewAgent', source: model.source, containerId: model.containerId,
      groupKey: selectedGroupKey, agentId: selectedAgentId,
    });
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
        const failed = g.agents.filter(a => a.status === 'failed').length;
        // Failures surface in the header itself: at 50-agent scale the phase
        // headers are the triage layer, and "4/5" alone reads as still-running.
        const failedHtml = failed > 0
          ? ' · <span class="wf-nav-count-failed">' + failed + ' failed</span>'
          : '';
        html += '<div class="wf-nav-phase"><span>' + escapeHtml(g.title) + '</span>'
          + '<span class="wf-nav-count">' + done + '/' + count + failedHtml + '</span></div>';
      }
      for (const a of g.agents) { html += renderNavRow(g.key, a); }
    }
    return html;
  }

  function renderNavRow(groupKey: string, a: DetailAgentView): string {
    const active = groupKey === selectedGroupKey && a.agentId === selectedAgentId;
    const badge = a.teammate ? '<span class="wf-teammate-badge" title="Agent Team member">team</span>' : '';
    // Status rides in the title/aria-label so it survives ellipsis truncation
    // and is announced — the dot alone is colour-only signalling (WCAG 1.4.1).
    const nameWithStatus = a.label + ' · ' + a.status;
    return '<div class="wf-nav-row' + (active ? ' active' : '') + (a.teammate ? ' teammate' : '') + '" data-group="' + escapeHtml(groupKey)
      + '" data-agent="' + escapeHtml(a.agentId) + '" role="button" tabindex="0"'
      + ' title="' + escapeHtml(nameWithStatus) + '" aria-label="' + escapeHtml(nameWithStatus) + '"'
      + (active ? ' aria-current="true"' : '') + '>'
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
    // Gated like tokens: team rows and disk-only subagents carry toolCalls: 0
    // because the data is genuinely untracked — "0 tools" would read as "did
    // nothing" rather than "not measured".
    if (agent.toolCalls > 0) { metaBits.push(agent.toolCalls + ' tools'); }
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
    const briefTs = briefIdx !== -1 ? entries[briefIdx].timestamp : '';
    if (briefText) { body += renderBrief(briefText, briefTs); }

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
  function renderBrief(text: string, timestamp?: string): string {
    const caret = briefCollapsed ? '▸' : '▾';
    const head = '<div class="wf-brief-head" role="button" tabindex="0" aria-expanded="'
      + (briefCollapsed ? 'false' : 'true') + '">'
      + '<span class="wf-brief-caret">' + caret + '</span>'
      + '<span class="wf-brief-label">Inception brief</span>'
      + renderTime(timestamp) + '</div>';
    const inner = briefCollapsed ? '' : '<div class="wf-brief-body">' + renderLines(text) + '</div>';
    return '<div class="wf-brief' + (briefCollapsed ? ' collapsed' : '') + '">' + head + inner + '</div>';
  }

  function renderTurn(e: TranscriptEntry): string {
    // 'tool' = tool_result blocks riding back to the assistant in a user-role
    // record — responses TO the assistant, so never labelled "prompt".
    const who = e.role === 'user' ? 'prompt'
      : e.role === 'assistant' ? 'assistant'
        : e.role === 'tool' ? 'tool' : 'system';
    return renderTurnRaw(who, e.content, e.timestamp);
  }

  /** `who` is the CSS class; the visible label differs only for 'tool'. */
  function renderTurnRaw(who: string, content: string, timestamp?: string): string {
    const label = who === 'tool' ? 'tool result' : who;
    return '<div class="wf-turn ' + escapeHtml(who) + '">'
      + '<div class="wf-who">' + escapeHtml(label) + renderTime(timestamp) + '</div>'
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

  // Caps for the markdown echo path. A teammate's REPLY renders here too — i.e.
  // arbitrary, possibly-hostile agent output — so bound the work a single
  // construct can force (wide tables, very long lines) defensively.
  const MAX_TABLE_COLS = 24;
  const MAX_TABLE_ROWS = 200;
  const MAX_INLINE_LEN = 50000;

  function renderTable(rows: string[][]): string {
    if (rows.length === 0) { return ''; }
    const cols = Math.min(rows[0].length, MAX_TABLE_COLS);
    const bodyRows = rows.slice(1, MAX_TABLE_ROWS);
    let h = '<table class="wf-md-table"><thead><tr>';
    for (let c = 0; c < cols; c++) { h += '<th>' + formatInline(rows[0][c] || '') + '</th>'; }
    h += '</tr></thead><tbody>';
    for (const r of bodyRows) {
      h += '<tr>';
      for (let c = 0; c < cols; c++) { h += '<td>' + formatInline(r[c] || '') + '</td>'; }
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  /** Minimal inline markdown: **bold**, *italic*, `code`, and [text](url) (the
   *  url is dropped — the reader is read-only). Everything escaped first; bold is
   *  consumed before italic so `**x**` doesn't get mangled by the single-`*` rule.
   *  The italic span is length-bounded and a pathologically long line skips inline
   *  passes entirely — both guard against regex backtracking on hostile output. */
  function formatInline(text: string): string {
    const s0 = escapeHtml(text);
    if (s0.length > MAX_INLINE_LEN) { return s0; } // too long to risk inline regex passes
    let s = s0;
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]{0,200}?)\*(?!\*)/g, '$1<i>$2</i>');
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

  function renderChip(v: DetailViewChoice): string {
    const dot = dotClass(v.status);
    return '<span class="wf-switch-chip' + (v.active ? ' active' : '') + (dot ? ' status-' + dot : '') + '"'
      + ' data-view-id="' + escapeHtml(v.id) + '" data-view-kind="' + escapeHtml(v.kind) + '"'
      + ' role="button" tabindex="0"'
      + ' title="' + escapeHtml(v.label) + ' · ' + escapeHtml(v.status)
      + (v.summary ? '\n' + escapeHtml(v.summary) : '') + '">'
      + '<span class="wf-dot ' + dot + '"></span>'
      + '<span class="wf-switch-chip-label">' + escapeHtml(v.label) + '</span></span>';
  }

  /** The label for a source group in the switcher. */
  function groupLabel(kind: string, count: number): string {
    if (kind === 'workflow') { return count > 1 ? 'Workflows' : 'Workflow'; }
    if (kind === 'subagents') { return 'Subagents'; }
    if (kind === 'team') { return 'Agent team'; }
    return 'Agents';
  }

  /** Render the switcher chips, separately grouped by source (workflows /
   *  subagents / agent teams) so each kind is visually delineated rather than
   *  intermixed. A single-source view renders a flat chip row (no sub-labels —
   *  the heading already names it); two or more sources render labelled groups. */
  function renderSwitcher(chips: DetailViewChoice[]): string {
    if (chips.length === 0) { return ''; }
    const order = ['workflow', 'subagents', 'team'];
    const kinds = order.filter(k => chips.some(c => c.kind === k));
    for (const c of chips) { if (!kinds.includes(c.kind)) { kinds.push(c.kind); } }
    const grouped = kinds.length > 1;
    let html = '<div class="wf-switch' + (grouped ? ' grouped' : '') + '">';
    for (const kind of kinds) {
      const inKind = chips.filter(c => c.kind === kind);
      if (inKind.length === 0) { continue; }
      if (grouped) {
        html += '<div class="wf-switch-group">'
          + '<div class="wf-switch-group-label">' + escapeHtml(groupLabel(kind, inKind.length)) + '</div>'
          + '<div class="wf-switch-chips">';
      }
      for (const v of inKind) { html += renderChip(v); }
      if (grouped) { html += '</div></div>'; }
    }
    return html + '</div>';
  }

  /** The pane header: a heading + the switcher chips (the selectable groupings,
   *  grouped by source and the selected one tinted to its status), the selected
   *  view's metrics, and a jump back to the parent session. The parent session id
   *  is intentionally omitted — it's identical across every chip, so it added
   *  noise, not information. */
  function renderHeader(): string {
    if (!model) { return ''; }
    const metrics = model.metrics
      ? '<div class="wf-head-metrics">' + escapeHtml(model.metrics) + '</div>' : '';
    return '<div class="wf-head">'
      + '<div class="wf-head-top">'
      + '<div class="wf-head-heading">' + escapeHtml(switcherHeading()) + '</div>'
      + '<div class="wf-openconv" role="button" tabindex="0" title="Open the parent agent session">↗ open parent session</div>'
      + '</div>'
      + renderSwitcher(viewChips())
      + metrics
      + '</div>';
  }

  /** Re-render fully replaces the tree via innerHTML, resetting both panes'
   *  scroll. The reader is restored with intent (see below); the nav just keeps
   *  its offset. Reader scroll model — log/terminal style:
   *   • switching agents      → start at the TOP (read the brief/first turns);
   *   • same agent, was at the bottom → stick to the BOTTOM (live tail follows
   *     new turns as a running agent streams);
   *   • same agent, scrolled up → preserve the offset, so appended content stays
   *     below the fold and what you're reading never jumps. */
  let lastRenderedKey: string | null = null;
  /** A top-reset is OWED to the reader after a selection change, but must not
   *  be consumed by the interim loading-placeholder render: that render's tiny
   *  scrollHeight reads as "at bottom", so the follow-up ready render would
   *  stick to the BOTTOM of the freshly loaded transcript instead of the top.
   *  The flag stays set until a settled (ready/error) render applies it. */
  let pendingTopOnSettle = false;

  function render(): void {
    const prevReader = root.querySelector('.wf-reader') as HTMLElement | null;
    const prevNav = root.querySelector('.wf-nav') as HTMLElement | null;
    const prevTop = prevReader ? prevReader.scrollTop : 0;
    const wasAtBottom = prevReader
      ? isNearBottom(prevReader.scrollTop, prevReader.clientHeight, prevReader.scrollHeight, STICK_THRESHOLD_PX)
      : false;
    const navTop = prevNav ? prevNav.scrollTop : 0;
    // Selection identity is the full transcript key (owner + group + agent), so
    // same-named agents across containers still register as a change.
    const selKey = (selectedGroupKey !== null && selectedAgentId !== null)
      ? tkey(selectedGroupKey, selectedAgentId) : null;
    if (selKey !== lastRenderedKey) { pendingTopOnSettle = true; }
    const isAgentChange = pendingTopOnSettle;
    // Collapse lives as a class on the persistent #wf-root, not in the nav
    // markup — so the toggle can animate the existing .wf-nav width (see the
    // toggle handler). The full roster is always rendered; CSS clips it when
    // collapsed, so a width transition has real content to slide over.
    root.classList.toggle('nav-collapsed', navCollapsed);
    if (!model || model.groups.every(g => g.agents.length === 0)) {
      // The header carries the switcher, so it stays visible even when the
      // selected view has no agents — the user can switch to one that does.
      root.innerHTML = renderHeader()
        + '<div class="wf-empty">No agents to show for this view.</div>';
      lastRenderedKey = null;
      updateComposer();
      return;
    }
    const navInner = '<div class="wf-nav-head"><button class="wf-nav-toggle"'
      + ' title="Toggle agent list" aria-label="Toggle agent list">'
      + '<span class="wf-nav-toggle-icon" aria-hidden="true"></span>'
      + '<span class="wf-nav-toggle-text">Agents</span></button></div>' + renderNav();
    root.innerHTML = renderHeader()
      + '<div class="wf-2pane">'
      + '<div class="wf-nav">' + navInner + '</div>'
      + '<div class="wf-reader">' + renderReader() + '</div>'
      + '</div>';
    const newReader = root.querySelector('.wf-reader') as HTMLElement | null;
    const newNav = root.querySelector('.wf-nav') as HTMLElement | null;
    if (newReader) {
      newReader.scrollTop = chooseReaderScrollTop({
        isAgentChange, wasAtBottom, prevTop, scrollHeight: newReader.scrollHeight,
      });
    }
    if (newNav && navTop) { newNav.scrollTop = navTop; }
    // The owed top-reset is consumed only once the selected transcript has
    // settled (ready or error); a loading placeholder keeps it pending.
    const st = selKey ? transcripts.get(selKey) : undefined;
    if (!st || st.state !== 'loading') { pendingTopOnSettle = false; }
    lastRenderedKey = selKey;
    updateComposer();
  }

  // ── Teammate composer (experimental) ────────────────────────────────
  // Lives OUTSIDE #wf-root (a persistent sibling) so render()'s innerHTML swap
  // never wipes a draft. We only toggle [hidden] / .value here; listeners are
  // attached once. Shown only when the flag is on AND the selected agent is a
  // RUNNING teammate. The host re-checks the flag on every send regardless.
  const composerEl = document.getElementById('wf-composer');
  const composerInput = document.getElementById('wf-composer-input') as HTMLTextAreaElement | null;
  const composerSend = document.getElementById('wf-composer-send') as HTMLButtonElement | null;
  const composerStatus = document.getElementById('wf-composer-status');
  const composerCount = document.getElementById('wf-composer-count');
  const COMPOSER_MAX = 8000;
  // C0 controls (except \t \n \r), DEL, zero-width, and bidi overrides — the
  // same set the host rejects. Stripped client-side so the user sees what will
  // actually be sent (the host is still the authority and re-checks).
  const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
  let composing = false;          // IME composition in progress — don't mangle mid-compose
  let pendingSendText: string | null = null; // stashed during an in-flight send (restored on error)
  let pendingSendKey: string | null = null;  // selection key the in-flight send belongs to
  let composerForKey: string | null = null;  // selection key the current draft belongs to

  function setComposerStatus(text: string, kind?: 'ok' | 'error'): void {
    if (!composerStatus) { return; }
    composerStatus.textContent = text;
    composerStatus.className = 'wf-composer-status' + (kind ? ' ' + kind : '');
  }

  function updateComposerCount(): void {
    if (!composerInput || !composerCount) { return; }
    const n = composerInput.value.length;
    composerCount.textContent = n >= COMPOSER_MAX - 200 ? n + ' / ' + COMPOSER_MAX : '';
  }

  /** Strip invisible/bidi chars from the draft (skipped mid-IME-composition),
   *  flagging when something was removed so it isn't silent. */
  function sanitiseComposerInput(): void {
    if (composing || !composerInput) { return; }
    const cleaned = composerInput.value.replace(UNSAFE_CHARS, '');
    if (cleaned !== composerInput.value) {
      const pos = composerInput.selectionStart;
      composerInput.value = cleaned;
      if (typeof pos === 'number') {
        const p = Math.min(pos, cleaned.length);
        composerInput.selectionStart = composerInput.selectionEnd = p;
      }
      setComposerStatus('Removed invisible characters.');
    }
    updateComposerCount();
  }

  /** Decide composer visibility from the (display-only) flag + selection.
   *  Gated on `alive` (still on the team roster + lead process not confirmed
   *  dead), NOT on subagent status: an idle teammate between messages reads
   *  done to Task-tracking but is alive and listening on its inbox. */
  function updateComposer(): void {
    if (!composerEl) { return; }
    const agent = findAgent(selectedGroupKey, selectedAgentId);
    const show = experimental.teammateMessaging === true
      && !!model && model.source === 'subagents'
      && !!agent && agent.teammate === true && agent.alive === true;
    composerEl.hidden = !show;
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('composer-open', show);
    }
    if (show && composerInput && agent) {
      // A draft belongs to ONE teammate: switching selection clears it (and any
      // failed-send restore) so text composed for A can never be sent to B.
      // Same-agent re-renders and brief hide/show flickers keep the draft.
      const ckey = tkey(selectedGroupKey!, selectedAgentId!);
      if (ckey !== composerForKey) {
        composerForKey = ckey;
        composerInput.value = '';
        pendingSendText = null;
        setComposerStatus('');
        updateComposerCount();
      }
      composerInput.placeholder = 'Message ' + agent.label + ' as ' + experimental.operatorName + ' — direct, bypasses the lead…';
    } else if (!show) {
      setComposerStatus('');
    }
  }

  function sendComposer(): void {
    if (!model || !composerInput || !composerSend) { return; }
    if (composerSend.disabled) { return; } // in-flight guard — Cmd/Ctrl+Enter must honour it too
    if (!experimental.teammateMessaging) { return; }
    const agent = findAgent(selectedGroupKey, selectedAgentId);
    if (!agent || agent.teammate !== true || agent.alive !== true) {
      setComposerStatus('This teammate has left the team.', 'error');
      return;
    }
    const text = composerInput.value.replace(UNSAFE_CHARS, '').trim();
    if (!text) { setComposerStatus('Type a message first.', 'error'); return; }
    if (text.length > COMPOSER_MAX) { setComposerStatus('Too long (max ' + COMPOSER_MAX + ').', 'error'); return; }
    pendingSendText = text;
    pendingSendKey = composerForKey;
    composerInput.value = '';        // optimistic clear; restored if the send fails
    updateComposerCount();
    composerSend.disabled = true;
    setComposerStatus('Sending…');
    vscode.postMessage({
      type: 'sendTeammateMessage', source: model.source,
      containerId: model.containerId, agentId: selectedAgentId, text,
    });
  }

  if (composerInput) {
    composerInput.addEventListener('input', sanitiseComposerInput);
    composerInput.addEventListener('compositionstart', () => { composing = true; });
    composerInput.addEventListener('compositionend', () => { composing = false; sanitiseComposerInput(); });
    composerInput.addEventListener('keydown', (e: KeyboardEvent) => {
      // Enter sends (chat-style, Murray 2026-06-11); Shift+Enter inserts a
      // newline (textarea default). Cmd/Ctrl+Enter still sends for muscle
      // memory. Never send mid-IME-composition — Enter there confirms the
      // composed text, not the message.
      if (e.key !== 'Enter' || e.shiftKey) { return; }
      if (composing || e.isComposing) { return; }
      e.preventDefault();
      sendComposer();
    });
  }
  if (composerSend) { composerSend.addEventListener('click', sendComposer); }

  // ── Events ─────────────────────────────────────────────────────────

  root.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.wf-nav-toggle')) {
      // Toggle collapse by flipping the class on the persistent root, NOT a
      // re-render — so the existing .wf-nav width transitions smoothly (and the
      // reader, flex:1, widens in lockstep). A render() here would rebuild the
      // element and the animation would never fire.
      navCollapsed = !navCollapsed;
      root.classList.toggle('nav-collapsed', navCollapsed);
      saveState();
      return;
    }
    if (target.closest('.wf-brief-head')) {
      briefCollapsed = !briefCollapsed;
      saveState();
      render();
      return;
    }
    const navRow = target.closest<HTMLElement>('.wf-nav-row');
    if (navRow) {
      // Selecting an agent keeps the list expanded so you can click straight
      // through the roster without re-expanding each time — collapse is manual,
      // via the toggle (which then hands the freed width to the reader).
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
      const owner = model.source + ' ' + model.containerId;
      if (owner !== cacheOwner) {
        cacheOwner = owner;
        transcripts.clear();
        selectedGroupKey = null;
        selectedAgentId = null;
      }
      // Deep-link from an inline card agent row: select that agent if it exists.
      const sel = msg.select as { groupKey: string; agentId: string } | undefined;
      if (sel && findAgent(sel.groupKey, sel.agentId)) {
        pendingRestore = null;
        selectAgent(sel.groupKey, sel.agentId);
        return;
      }
      // Restore the persisted selection across a webview rebuild — one shot,
      // same drill-in only, and only if the agent still exists in the model.
      if (pendingRestore) {
        const r = pendingRestore;
        pendingRestore = null;
        if (r.owner === owner && findAgent(r.groupKey, r.agentId)) {
          selectAgent(r.groupKey, r.agentId);
          return;
        }
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
      const key = String(msg.key);
      const incoming = (msg.entries as TranscriptEntry[]) || [];
      const existing = transcripts.get(key);
      // Steady-tick dedup: an unchanged transcript must NOT re-render — the
      // innerHTML swap would destroy any text selection the user is holding
      // mid-copy. Transcripts are append-only, so length + last-entry equality
      // is a sufficient (and cheap) identity check.
      if (existing && existing.state === 'ready' && sameTranscript(existing.entries, incoming)) {
        return;
      }
      // An agent transcript only grows; a response that lost the race against a
      // newer one would step the reader backwards — drop it (the steady tick
      // re-converges, and an owner change clears the cache outright).
      if (!(existing && existing.state === 'ready' && incoming.length < existing.entries.length)) {
        transcripts.set(key, { state: 'ready', entries: incoming });
      }
      if (key === tkey(selectedGroupKey ?? '', selectedAgentId ?? '')) { render(); }
    } else if (msg.type === 'agentTranscriptError') {
      transcripts.set(String(msg.key), { state: 'error', message: String(msg.message || 'Failed to load transcript.') });
      if (String(msg.key) === tkey(selectedGroupKey ?? '', selectedAgentId ?? '')) { render(); }
    } else if (msg.type === 'settings') {
      const ex = (msg.experimental || {}) as { teammateMessaging?: unknown; operatorName?: unknown };
      experimental.teammateMessaging = ex.teammateMessaging === true;
      experimental.operatorName = typeof ex.operatorName === 'string' ? ex.operatorName : 'operator';
      updateComposer();
    } else if (msg.type === 'teammateMessageSent') {
      if (composerSend) { composerSend.disabled = false; }
      if (msg.ok) {
        pendingSendText = null;
        pendingSendKey = null;
        setComposerStatus('Sent.', 'ok');
        burstRefresh(); // catch the teammate's reply (~5-6s) on a fast poll
      } else {
        // Restore the optimistically-cleared draft so the user doesn't lose it
        // — but only into the SAME teammate's composer it was typed for; if the
        // selection moved while the send was in flight, drop it instead.
        if (composerInput && pendingSendText !== null && composerInput.value === ''
          && pendingSendKey !== null && pendingSendKey === composerForKey) {
          composerInput.value = pendingSendText;
          updateComposerCount();
          setComposerStatus(String(msg.error || 'Send failed.'), 'error');
        } else if (pendingSendKey !== null && pendingSendKey === composerForKey) {
          setComposerStatus(String(msg.error || 'Send failed.'), 'error');
        }
        pendingSendText = null;
        pendingSendKey = null;
      }
    }
  });

  // Stream the selected running agent's transcript (no-op for terminal agents).
  startRefreshLoop(STEADY_REFRESH_MS);

  // Relative-time slow tick: terminal agents never re-render, so "5m ago"
  // would otherwise freeze. Updates the time spans in place (textContent
  // only — no innerHTML swap, so scroll and text selection are untouched).
  const TIME_TICK_MS = 60_000;
  setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) { return; }
    const now = Date.now();
    root.querySelectorAll('.wf-turn-time[data-t]').forEach(el => {
      const t = Number(el.getAttribute('data-t'));
      if (t > 0) { el.textContent = formatRelativeTime(t, now); }
    });
  }, TIME_TICK_MS);
})();
