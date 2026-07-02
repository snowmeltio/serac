// Webview frontend for the detail panel (createWebviewPanel, opened beside the
// conversation). Source-keyed: renders a normalised DetailModel for workflow
// runs, agent teams, or a session's subagents. Two panes: left = groups →
// agents; right = the selected agent's transcript. Vanilla, no framework
// (bundled to media/detailView.js). The data shapes and shared formatters come
// from detailShared.ts — the same module the host's builders compile against,
// so the contract is compiler-enforced rather than comment-mirrored.

import { isNearBottom, chooseReaderScrollTop, STICK_THRESHOLD_PX } from './detailViewScroll.js';
import { escapeHtml } from './panelUtils.js';
import { fmtTokens, fmtDuration, formatModelLabel, transcriptKey, parseEditInput } from './detailShared.js';
import type {
  DetailAgentView, DetailGroupView, DetailViewChoice, DetailModel, TranscriptEntry,
  Evidence, Mismatch, FileTouch, CommandRun,
} from './detailShared.js';

type TranscriptState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  /** `entries` is the append-only JSONL prefix; `suffix` is the teammate
   *  inbox tail, replaced wholesale on every host post (it shrinks when the
   *  member drains its inbox, so it can never be folded into entries).
   *  `evidence`/`mismatches` (Phase 3, DESIGN-DETAIL-PANE-V2.md) are the
   *  host-computed Result-strip inputs — display-only here, the webview
   *  never derives or recomputes them. `evidence` is null only when the host
   *  hasn't posted it yet (shouldn't happen once 'ready', kept optional for
   *  defensiveness against an older/partial message shape). */
  | { state: 'ready'; entries: TranscriptEntry[]; suffix: TranscriptEntry[]; evidence: Evidence | null; mismatches: Mismatch[] };

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

  // ── Phase 2: log view (default) vs classic (temporary fallback) ─────
  // DESIGN-DETAIL-PANE-V2.md forensic-log skeleton: a single-pane log replaces
  // the two-pane navigator. Classic stays reachable for one release via the
  // header-strip toggle while confidence builds; both render functions read the
  // SAME selection/transcript-cache state below, so switching modes mid-session
  // keeps the current agent selected.
  let mode: 'log' | 'classic' = 'log';
  /** View row (session-scoped switcher, mockup view 4/4b) collapsed to one line
   *  with only the active + running/waiting chips shown, the rest folded into a
   *  "+N" overflow chip. Expanded (false) by default — collapse is an explicit
   *  space-saving choice, not the resting state. */
  let viewRowCollapsed = false;
  /** Result strip (Phase 3, DESIGN-DETAIL-PANE-V2.md) collapse preference.
   *  Tri-state, unlike viewRowCollapsed/briefCollapsed's plain booleans: null
   *  means "no explicit user choice yet", in which case the strip is
   *  COLLAPSED to its one-line summary for every agent, running or done
   *  (Phase 2.2, Murray 2026-07-02: results are so lengthy that the open
   *  strip isn't helpful — the mismatch flag is the part that must never
   *  hide, and it renders inline even collapsed). An explicit true/false
   *  from the user's own toggle click overrides the default for every agent
   *  thereafter, persisted like the other collapse flags. */
  let resultStripCollapsed: boolean | null = null;
  /** Log-mode kind filters (facet bar). Default: Text + Error + Result on,
   *  Tool OFF (Phase 2.1, Murray 2026-07-02) — for design/research agents the
   *  prose IS the primary read, and tool chatter is on-demand. Errors are
   *  their own bucket, so hiding Tool never hides a failure. Persisted as a
   *  set (webview state, global not per-agent) so an enabled Tool chip
   *  survives re-renders and reopens. */
  const kindFilters: { text: boolean; tool: boolean; error: boolean; result: boolean } = {
    text: true, tool: false, error: true, result: true,
  };
  let logSearch = '';
  /** Time gutter representation (Phase 2.2). Wall clock by default — the
   *  mm:ss.s offset "anchors to the epoch of inception" and reads oddly on a
   *  long session (Murray, 2026-07-02). Clicking any timestamp toggles the
   *  WHOLE column; persisted globally like kindFilters. Each cell's tooltip
   *  carries the other representation. */
  let timeMode: 'clock' | 'offset' = 'clock';
  /** Row indices (within the selected agent's combined entries+suffix list)
   *  expanded in place. Keyed by index, not identity, so it must be cleared on
   *  every agent change (see renderLogMode) — index 3 means nothing once the
   *  selection moves to a different agent's entry list. */
  const expandedRows = new Set<number>();

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
    mode?: 'log' | 'classic';
    viewRowCollapsed?: boolean;
    resultStripCollapsed?: boolean | null;
    kindFilters?: Partial<Record<'text' | 'tool' | 'error' | 'result', boolean>>;
    timeMode?: 'clock' | 'offset';
  }
  const persisted = (vscode.getState() ?? {}) as PersistedState;
  navCollapsed = persisted.navCollapsed === true;
  briefCollapsed = persisted.briefCollapsed === true;
  mode = persisted.mode === 'classic' ? 'classic' : 'log';
  viewRowCollapsed = persisted.viewRowCollapsed === true;
  resultStripCollapsed = typeof persisted.resultStripCollapsed === 'boolean' ? persisted.resultStripCollapsed : null;
  timeMode = persisted.timeMode === 'offset' ? 'offset' : 'clock';
  // Per-key restore over the defaults, so adding a future kind can't be
  // silently forced off by an older persisted state that never knew it.
  if (persisted.kindFilters && typeof persisted.kindFilters === 'object') {
    for (const k of ['text', 'tool', 'error', 'result'] as const) {
      const v = persisted.kindFilters[k];
      if (typeof v === 'boolean') { kindFilters[k] = v; }
    }
  }
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
      mode,
      viewRowCollapsed,
      resultStripCollapsed,
      kindFilters: { ...kindFilters },
      timeMode,
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

  /** Focus a roster row by identity (dataset match — ids can hold characters
   *  a selector would need escaping for). */
  function focusNavRow(groupKey: string, agentId: string): void {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.wf-nav-row'))) {
      if (el.dataset.group === groupKey && el.dataset.agent === agentId) { el.focus(); return; }
    }
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
      // full: the webview holds nothing for this key, so an append delta
      // would be unanchored — the host must answer with a whole snapshot.
      vscode.postMessage({ type: 'viewAgent', source: model.source, containerId: model.containerId, groupKey, agentId, full: true });
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
    const modelLabel = a.model ? formatModelLabel(a.model) : '';
    // Status rides in the title/aria-label so it survives ellipsis truncation
    // and is announced — the dot alone is colour-only signalling (WCAG 1.4.1).
    const nameWithStatus = a.label + ' · ' + a.status + (modelLabel ? ' · ' + modelLabel : '');
    // Roving tabindex (UX-3): one Tab stop for the whole roster (the active
    // row); ArrowUp/ArrowDown walk the rest. 50 agents are otherwise 50 stops.
    return '<div class="wf-nav-row' + (active ? ' active' : '') + (a.teammate ? ' teammate' : '') + '" data-group="' + escapeHtml(groupKey)
      + '" data-agent="' + escapeHtml(a.agentId) + '" role="button" tabindex="' + (active ? '0' : '-1') + '"'
      + ' title="' + escapeHtml(nameWithStatus) + '" aria-label="' + escapeHtml(nameWithStatus) + '"'
      + (active ? ' aria-current="true"' : '') + '>'
      + statusDot(a.status)
      + '<span class="wf-nav-label">' + escapeHtml(a.label) + '</span>'
      + badge
      + (modelLabel ? '<span class="wf-nav-model">' + escapeHtml(modelLabel) + '</span>' : '')
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
    const readerModel = agent.model ? formatModelLabel(agent.model) : '';
    if (readerModel) { metaBits.push(escapeHtml(readerModel)); }
    if (agent.tokens > 0) { metaBits.push(fmtTokens(agent.tokens) + ' tokens'); }
    // Gated like tokens: team rows and disk-only subagents carry toolCalls: 0
    // because the data is genuinely untracked — "0 tools" would read as "did
    // nothing" rather than "not measured".
    if (agent.toolCalls > 0) { metaBits.push(agent.toolCalls + ' tools'); }
    const dur = fmtDuration(agent.durationMs);
    if (dur) { metaBits.push(dur); }
    if (agent.attempt && agent.attempt > 1) { metaBits.push('attempt ' + agent.attempt); }

    // Live signal (UX-1): for a running agent, a recessed tool line answers
    // "what is it doing right now?" — the meta duration above answers "for how
    // long" (the host sends elapsed-so-far while durationMs is unsettled).
    const liveTool = agent.status === 'running' && agent.lastToolName
      ? '<div class="wf-reader-live wf-tool"><b>' + escapeHtml(agent.lastToolName) + '</b>'
        + (agent.lastToolSummary ? ' ' + escapeHtml(agent.lastToolSummary) : '') + '</div>'
      : '';
    const head = '<div class="wf-reader-head">'
      + '<div class="wf-reader-title">' + statusDot(agent.status) + escapeHtml(agent.label) + '</div>'
      + '<div class="wf-reader-meta">' + metaBits.join(' · ') + '</div>'
      + liveTool + '</div>';

    let body = '<div class="wf-reader-body">';
    const st = transcripts.get(tkey(selectedGroupKey!, agent.agentId));
    const entries = (st && st.state === 'ready') ? st.entries : [];
    const suffix = (st && st.state === 'ready') ? st.suffix : [];

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
    body += renderSuffix(suffix);
    body += '</div>';
    return head + body;
  }

  /** The teammate-inbox tail, in ONE replaceable container — the append fast
   *  path swaps this node wholesale while only ever appending turn nodes. */
  function renderSuffix(suffix: TranscriptEntry[]): string {
    if (suffix.length === 0) { return ''; }
    let html = '<div class="wf-suffix">';
    for (const e of suffix) { html += renderTurn(e); }
    return html + '</div>';
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
      + '<div class="wf-head-top-actions">'
      + '<span class="wf-mode-toggle" role="button" tabindex="0" title="Switch to the log view">log view</span>'
      + '<div class="wf-openconv" role="button" tabindex="0" title="Open the parent agent session">↗ open parent session</div>'
      + '</div>'
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

  /** What to re-focus after the innerHTML swap. Captured from
   *  document.activeElement before render() destroys it (UX-3): scroll gets
   *  carefully restored, keyboard focus deserves the same care — a model push
   *  mid-roster-walk otherwise drops focus to <body> silently. */
  function captureFocus(): (() => void) | null {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !root.contains(active)) { return null; }
    // The search box IS the focused element (not a wrapper) — restore both
    // focus and caret position, or every keystroke's re-render would bounce
    // the cursor to the end of the field.
    if (active.classList.contains('wf-facet-search-input')) {
      const pos = (active as HTMLInputElement).selectionStart;
      return () => {
        const el = root.querySelector('.wf-facet-search-input') as HTMLInputElement | null;
        if (!el) { return; }
        el.focus();
        if (pos !== null) { el.setSelectionRange(pos, pos); }
      };
    }
    const row = active.closest<HTMLElement>('.wf-nav-row');
    if (row) {
      const g = row.dataset.group ?? '';
      const a = row.dataset.agent ?? '';
      return () => focusNavRow(g, a);
    }
    const pill = active.closest<HTMLElement>('.wf-agent-pill');
    if (pill) {
      const g = pill.dataset.group ?? '';
      const a = pill.dataset.agent ?? '';
      return () => focusAgentPill(g, a);
    }
    const chip = active.closest<HTMLElement>('.wf-switch-chip, .wf-view-chip');
    if (chip) {
      const id = chip.dataset.viewId;
      const cls = chip.classList.contains('wf-view-chip') ? 'wf-view-chip' : 'wf-switch-chip';
      return () => {
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('.' + cls))) {
          if (el.dataset.viewId === id) { el.focus(); return; }
        }
      };
    }
    for (const cls of [
      'wf-nav-toggle', 'wf-brief-head', 'wf-openconv', 'wf-mode-toggle',
      'wf-view-collapse', 'wf-facet-foldall', 'wf-rstrip-head',
    ] as const) {
      if (active.closest('.' + cls)) {
        return () => { (root.querySelector('.' + cls) as HTMLElement | null)?.focus(); };
      }
    }
    return null;
  }

  /** Mode dispatcher — the single entry point every message handler and event
   *  listener calls. Both modes share selection state, the transcript cache,
   *  and the refresh loop; only the markup and scroll-container differ. */
  function render(): void {
    if (mode === 'classic') { renderClassicMode(); } else { renderLogMode(); }
  }

  function renderClassicMode(): void {
    const refocus = captureFocus();
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
      refocus?.();
      updateComposer();
      return;
    }
    // Rail dot (UX-6): when collapsed, the rail's only content is the toggle —
    // this keeps the run's worst-case roll-up visible there. Always in the
    // markup, shown purely by the .nav-collapsed CSS, so the no-re-render
    // toggle animation is preserved; the steady refresh keeps it current.
    const railStatus = aggStatus(allAgents());
    const railDot = railStatus
      ? '<span class="wf-dot wf-rail-dot ' + escapeHtml(railStatus === 'completed' ? 'done' : railStatus) + '" aria-hidden="true"></span>'
      : '';
    const navInner = '<div class="wf-nav-head"><button class="wf-nav-toggle"'
      + ' title="Toggle agent list" aria-label="Toggle agent list">'
      + '<span class="wf-nav-toggle-icon" aria-hidden="true"></span>'
      + railDot
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
    refocus?.();
    updateComposer();
  }

  // ── Log view (Phase 2, default mode) ─────────────────────────────────
  // Single-pane forensic log. Zone order (Phase 2.2 — pickers stack first):
  // view row → agent strip → header strip → pinned permission row → Result
  // strip → facet bar → the log. DESIGN-DETAIL-PANE-V2.md §4a. Shares
  // selection, the transcript cache, and the refresh loop with classic mode
  // (above) — only the markup and the scroll container differ.

  /** Leading integer off a host-computed roll-up summary ("12 agents · 9
   *  done · 1 failed", `rollupSummary()` in detailPanel.ts) — the view row's
   *  agent-count badge. Blank when the view carries no summary (e.g. a
   *  same-session synthesised chip). */
  function viewCount(summary?: string): string {
    if (!summary) { return ''; }
    const m = /^(\d+)/.exec(summary);
    return m ? m[1] : '';
  }

  function renderViewChip(v: DetailViewChoice): string {
    const dot = dotClass(v.status);
    const tag = v.kind === 'workflow' ? 'wf' : v.kind === 'team' ? 'team' : 'sub';
    const count = viewCount(v.summary);
    return '<span class="wf-view-chip' + (v.active ? ' active' : '') + '"'
      + ' data-view-id="' + escapeHtml(v.id) + '" data-view-kind="' + escapeHtml(v.kind) + '"'
      + ' role="button" tabindex="0"'
      + ' title="' + escapeHtml(v.label) + ' · ' + escapeHtml(v.status)
      + (v.summary ? '\n' + escapeHtml(v.summary) : '') + '">'
      + '<span class="wf-view-tag ' + tag + '">' + tag + '</span>'
      + '<span class="wf-dot ' + dot + '"></span>'
      + '<span class="wf-view-label">' + escapeHtml(v.label) + '</span>'
      + (count ? '<span class="wf-view-count">' + escapeHtml(count) + '</span>' : '')
      + '</span>';
  }

  /** The view row (mockup 4/4b): every view this session owns — workflow runs,
   *  the subagents view, the team roster — as one row of chips, ABOVE the
   *  header strip (Murray, 2026-07-02: "1. what am I in, 2. its summary, 3.
   *  everything else"). Collapsed keeps the active chip plus anything
   *  running/waiting, folding the rest behind a "+N" overflow chip. Renders
   *  nothing when the model carries no `views` (a plain team drill-in, which
   *  has no cross-source switcher — same gate the classic switcher uses via
   *  viewChips(), but the log view intentionally does NOT synthesise a
   *  single-chip fallback for team: with only one thing to show, a one-chip
   *  row is pure chrome the header strip already covers). */
  /** The shared left label cell (Phase 2.2): every top zone row leads with a
   *  --wf-gutter-wide, right-aligned cell so the zone labels and the log's
   *  timestamps read as ONE column — the pane aligns on a single vertical
   *  rail. Text is lowercase here; CSS uppercases (same pattern as the other
   *  small-caps labels). Empty for continuation lines (phased strip). */
  function zoneLabel(text: string): string {
    return '<span class="wf-zone-label">' + escapeHtml(text) + '</span>';
  }

  function renderViewRow(): string {
    if (!model || !model.views || model.views.length === 0) { return ''; }
    const views = model.views;
    let shown = views;
    let overflow = 0;
    if (viewRowCollapsed) {
      shown = views.filter(v => v.active || v.status === 'running' || v.status === 'waiting');
      overflow = views.length - shown.length;
    }
    // Label cell + a separate wrapping chip container: wrapped chip lines
    // then indent to the rail instead of sliding under the label.
    let html = '<div class="wf-view-row' + (viewRowCollapsed ? ' collapsed' : '') + '" role="tablist" aria-label="Views in this session">'
      + zoneLabel('views')
      + '<div class="wf-view-chipwrap">';
    for (const v of shown) { html += renderViewChip(v); }
    if (viewRowCollapsed && overflow > 0) {
      html += '<span class="wf-view-chip more" role="button" tabindex="0"'
        + ' title="Show ' + overflow + ' more view' + (overflow === 1 ? '' : 's') + '">+' + overflow + '</span>';
    }
    html += '<span class="wf-view-collapse" role="button" tabindex="0"'
      + ' title="' + (viewRowCollapsed ? 'Expand view row' : 'Collapse view row') + '">'
      + (viewRowCollapsed ? '⌄ expand' : '⌃ collapse') + '</span>';
    return html + '</div></div>';
  }

  /** Roll-up across every agent in every group (workflow phases included) —
   *  the header strip's live counts and totals are session-view-wide, not
   *  scoped to the selected agent (that's the agent strip's job). */
  function headerAgg(): {
    running: number; waiting: number; done: number; failed: number;
    tokens: number; durationMs: number | null; model: string; pillStatus: string;
  } {
    const agents = allAgents();
    let running = 0, waiting = 0, done = 0, failed = 0, tokens = 0;
    let maxDur: number | null = null;
    const models = new Set<string>();
    for (const a of agents) {
      if (a.status === 'running') { running++; }
      else if (a.status === 'waiting') { waiting++; }
      else if (a.status === 'failed') { failed++; }
      else { done++; } // done/stale roll up to "done" in the glance count
      tokens += a.tokens;
      if (a.durationMs !== null) { maxDur = maxDur === null ? a.durationMs : Math.max(maxDur, a.durationMs); }
      if (a.model) { models.add(a.model); }
    }
    // A shared model across every agent is worth naming; a mixed run isn't
    // attributable to one label, so it's omitted rather than picking one.
    const modelLabel = models.size === 1 ? formatModelLabel([...models][0]) : '';
    const pillStatus = running > 0 ? 'running' : waiting > 0 ? 'waiting' : failed > 0 ? 'failed' : 'done';
    return { running, waiting, done, failed, tokens, durationMs: maxDur, model: modelLabel, pillStatus };
  }

  /** Header strip (mockup §2): source badge, container name, status pill, live
   *  counts, duration/tokens/model. Replaces the classic `.wf-head` heading +
   *  metrics block in log mode. */
  function renderHeaderStrip(): string {
    if (!model) { return ''; }
    const agg = headerAgg();
    const badge = model.source === 'workflow' ? 'workflow' : model.source === 'team' ? 'team' : 'subagent';
    const metaBits: string[] = [];
    const dur = fmtDuration(agg.durationMs);
    if (dur) { metaBits.push(dur); }
    if (agg.tokens > 0) { metaBits.push(fmtTokens(agg.tokens) + ' tokens'); }
    if (agg.model) { metaBits.push(escapeHtml(agg.model)); }
    return '<div class="wf-hstrip">'
      + '<span class="wf-hstrip-badge">' + escapeHtml(badge) + '</span>'
      + '<span class="wf-hstrip-name">' + escapeHtml(model.title) + '</span>'
      + '<span class="wf-hstrip-pill status-' + agg.pillStatus + '">' + escapeHtml(agg.pillStatus) + '</span>'
      + '<span class="wf-hstrip-counts">' + agg.running + ' running · ' + agg.waiting + ' waiting · ' + agg.done + ' done</span>'
      + '<span class="wf-hstrip-meta">' + metaBits.join(' · ') + '</span>'
      + '<span class="wf-openconv wf-hstrip-openconv" role="button" tabindex="0" title="Open the parent agent session">↗ session</span>'
      + '<span class="wf-mode-toggle" role="button" tabindex="0" title="Switch to the classic view">classic view</span>'
      + '</div>';
  }

  /** Pinned permission row (mockup §1/§2): shown whenever ANY agent, in ANY
   *  group, is `waiting` — independent of the selected agent, and never
   *  affected by the facet-bar filters or the log's scroll position (it isn't
   *  part of the scrolling `.wf-log-scroll` region at all). Multiple waiting
   *  agents show the first encountered (groups render oldest-run-first) with
   *  a "+n more" suffix — there is no waiting-since timestamp on
   *  DetailAgentView to sort by or age against, so elapsed-since is omitted
   *  rather than fabricated (deviation from the mockup's "18s ago", noted in
   *  the Phase 2 report). */
  function renderPermRow(): string {
    const waiting = allAgents().filter(a => a.status === 'waiting');
    if (waiting.length === 0) { return ''; }
    const first = waiting[0];
    const extra = waiting.length - 1;
    const toolBit = first.lastToolName
      ? escapeHtml(first.lastToolName) + (first.lastToolSummary ? ' ' + escapeHtml(first.lastToolSummary) : '')
      : 'a tool';
    return '<div class="wf-permrow" role="status">'
      + '<span class="wf-permrow-icon" aria-hidden="true">⚠</span>'
      + '<span class="wf-permrow-who">' + escapeHtml(first.label) + '</span>'
      + '<span>waiting on permission:</span>'
      + '<span class="wf-permrow-cmd">' + toolBit + '</span>'
      + (extra > 0 ? '<span class="wf-permrow-extra">+' + extra + ' more</span>' : '')
      + '</div>';
  }

  // ── Result strip (Phase 3, mockup §2, DESIGN-DETAIL-PANE-V2.md) ────────
  // The verification anchor for the SELECTED agent, sitting between the
  // header/permission rows and the agent strip in log mode only. Every field
  // here is HOST-computed (evidenceExtractor.ts/mismatch.ts via
  // detailPanel.ts) and carried on the transcript cache entry — this module
  // only formats it; it never derives evidence or a mismatch itself.

  const RESULT_BRIEF_MAX_CHARS = 140;
  const RESULT_FINAL_MAX_CHARS = 400;
  const RESULT_COMMAND_LABEL_MAX_CHARS = 40;
  const RESULT_MAX_FILE_CHIPS = 6;
  const RESULT_MAX_COMMAND_CHIPS = 4;
  const MISMATCH_DISCLAIMER = "Computed from tool calls, not the agent's prose.";

  /** The same "first user entry" the classic reader's inception brief uses
   *  (see renderReader), falling back to the sidecar's promptPreview before
   *  the transcript has loaded — one line, truncated. */
  function resultBriefText(agent: DetailAgentView): string {
    const st = transcripts.get(tkey(selectedGroupKey!, agent.agentId));
    const entries = (st && st.state === 'ready') ? st.entries : [];
    const briefEntry = entries.find(e => e.role === 'user');
    const raw = briefEntry ? briefEntry.content : (agent.promptPreview || '');
    return raw.replace(/\r?\n+/g, ' ').trim();
  }

  function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function basename(filePath: string): string {
    const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return idx >= 0 ? filePath.slice(idx + 1) : filePath;
  }

  /** File chips: basename + approx +added/−removed when non-null, capped at
   *  RESULT_MAX_FILE_CHIPS with a "+n" overflow chip (mockup §2). An `edit`
   *  chip is also a native escape hatch (Phase 4, DESIGN-DETAIL-PANE-V2.md):
   *  clicking it posts `showFileChanges` with the file's PATH (not an
   *  entryIndex — the strip has no single row to point at), and the host
   *  resolves that to the file's FIRST Edit in the transcript. `write`/
   *  `notebook` chips have no equivalent before/after to diff (Write's tool
   *  input carries no prior content — see evidenceExtractor.ts), so they
   *  stay inert. */
  function renderFileChips(files: FileTouch[]): string {
    if (files.length === 0) { return ''; }
    const shown = files.slice(0, RESULT_MAX_FILE_CHIPS);
    const overflow = files.length - shown.length;
    let html = '<span class="wf-rstrip-cat">Files (' + files.length + ')</span>';
    for (const f of shown) {
      const deltaBits: string[] = [];
      if (f.approxAdded !== null) { deltaBits.push('<span class="wf-rstrip-add">+' + f.approxAdded + '</span>'); }
      if (f.approxRemoved !== null) { deltaBits.push('<span class="wf-rstrip-del">−' + f.approxRemoved + '</span>'); }
      const clickable = f.kind === 'edit';
      const attrs = clickable
        ? ' class="wf-rstrip-chip clickable" data-file-path="' + escapeHtml(f.path) + '"'
          + ' role="button" tabindex="0" title="' + escapeHtml(f.path) + ' — view as edited by this agent"'
        : ' class="wf-rstrip-chip" title="' + escapeHtml(f.path) + '"';
      html += '<span' + attrs + '>'
        + escapeHtml(basename(f.path))
        + (deltaBits.length > 0 ? ' ' + deltaBits.join(' ') : '')
        + '</span>';
    }
    if (overflow > 0) { html += '<span class="wf-rstrip-chip wf-rstrip-more">+' + overflow + '</span>'; }
    return html;
  }

  /** Command chips: first ~40 chars + ✓/✗/no-mark for exitOk true/false/null,
   *  capped at RESULT_MAX_COMMAND_CHIPS with a "+n" overflow chip. */
  function renderCommandChips(commands: CommandRun[]): string {
    if (commands.length === 0) { return ''; }
    const shown = commands.slice(0, RESULT_MAX_COMMAND_CHIPS);
    const overflow = commands.length - shown.length;
    let html = '<span class="wf-rstrip-cat">Commands (' + commands.length + ')</span>';
    for (const c of shown) {
      const mark = c.exitOk === true ? '<span class="wf-rstrip-ok">✓</span>'
        : c.exitOk === false ? '<span class="wf-rstrip-bad">✗</span>' : '';
      html += '<span class="wf-rstrip-chip" title="' + escapeHtml(c.command) + '">'
        + escapeHtml(truncate(c.command, RESULT_COMMAND_LABEL_MAX_CHARS))
        + (mark ? ' ' + mark : '')
        + '</span>';
    }
    if (overflow > 0) { html += '<span class="wf-rstrip-chip wf-rstrip-more">+' + overflow + '</span>'; }
    return html;
  }

  /** The bordered salmon mismatch box (mockup §2): "⚠ MISMATCH" + the
   *  heuristic-specific message + the fixed disclaimer suffix. One box per
   *  Mismatch — mismatch.ts can return more than one at once. */
  function renderMismatches(mismatches: Mismatch[]): string {
    let html = '';
    for (const m of mismatches) {
      html += '<div class="wf-rstrip-mismatch" data-kind="' + escapeHtml(m.kind) + '">'
        + '<span class="wf-rstrip-mismatch-flag">⚠ MISMATCH</span>'
        + '<span class="wf-rstrip-mismatch-msg">' + escapeHtml(m.message)
        + ' <span class="wf-rstrip-mismatch-why">' + escapeHtml(MISMATCH_DISCLAIMER) + '</span></span>'
        + '</div>';
    }
    return html;
  }

  /** The strip's one-line collapsed summary (Phase 2.2): the first ~100
   *  chars of the final message when there is one — the actual answer, not
   *  a count roll-up — else the status line + evidence roll-up it always
   *  showed. Mismatches are NOT summarised here: they render inline on the
   *  collapsed head via renderInlineMismatch, never reduced to a count. */
  const RESULT_SUMMARY_MAX_CHARS = 100;
  function renderResultStripSummary(agent: DetailAgentView, evidence: Evidence): string {
    if (evidence.finalMessage) {
      const oneLine = evidence.finalMessage.replace(/\s+/g, ' ').trim();
      return '<span class="wf-rstrip-summary">' + escapeHtml(truncate(oneLine, RESULT_SUMMARY_MAX_CHARS)) + '</span>';
    }
    const bits: string[] = [];
    bits.push(agent.status === 'running' ? 'running' : 'result');
    if (evidence.filesTouched.length > 0) { bits.push(evidence.filesTouched.length + ' file' + (evidence.filesTouched.length === 1 ? '' : 's')); }
    if (evidence.commandsRun.length > 0) { bits.push(evidence.commandsRun.length + ' command' + (evidence.commandsRun.length === 1 ? '' : 's')); }
    return '<span class="wf-rstrip-summary">' + escapeHtml(bits.join(' · ')) + '</span>';
  }

  /** Compact mismatch form for the COLLAPSED head line (Phase 2.2,
   *  non-negotiable: the flag renders visibly even when everything else is
   *  folded away — it is the anti-fabrication signal the strip exists for).
   *  First mismatch's message, truncated; a "+n" marks any further ones.
   *  The full bordered box (with the methodology disclaimer) is the
   *  expanded form. */
  const INLINE_MISMATCH_MAX_CHARS = 90;
  function renderInlineMismatch(mismatches: Mismatch[]): string {
    if (mismatches.length === 0) { return ''; }
    const extra = mismatches.length - 1;
    return '<span class="wf-rstrip-mismatch-inline">⚠ MISMATCH '
      + escapeHtml(truncate(mismatches[0].message, INLINE_MISMATCH_MAX_CHARS))
      + (extra > 0 ? ' +' + extra : '') + '</span>';
  }

  function renderResultStripBody(agent: DetailAgentView, evidence: Evidence, mismatches: Mismatch[]): string {
    let html = '';
    const brief = resultBriefText(agent);
    if (brief) {
      html += '<div class="wf-rstrip-brief"><b>Brief:</b> “' + escapeHtml(truncate(brief, RESULT_BRIEF_MAX_CHARS)) + '”</div>';
    }
    if (evidence.finalMessage) {
      html += '<div class="wf-rstrip-final">' + escapeHtml(truncate(evidence.finalMessage.trim(), RESULT_FINAL_MAX_CHARS)) + '</div>';
    }
    const chips = renderFileChips(evidence.filesTouched) + renderCommandChips(evidence.commandsRun);
    if (chips) { html += '<div class="wf-rstrip-chiprow">' + chips + '</div>'; }
    html += renderMismatches(mismatches);
    if (!brief && !evidence.finalMessage && !chips && mismatches.length === 0) {
      html += '<div class="wf-rstrip-empty">No tool activity recorded yet.</div>';
    }
    return html;
  }

  /** Result strip entry point. Absent entirely when the selected agent's
   *  transcript hasn't loaded yet (nothing to verify against); collapsed to
   *  the one-line summary by default for EVERY agent (Phase 2.2 — see
   *  resultStripCollapsed's doc comment), overridden by the user's own
   *  toggle. A mismatch always shows: compact inline form on the collapsed
   *  head, full box when expanded. */
  function renderResultStrip(agent: DetailAgentView): string {
    const st = transcripts.get(tkey(selectedGroupKey!, agent.agentId));
    if (!st || st.state !== 'ready' || !st.evidence) { return ''; }
    const evidence = st.evidence;
    const mismatches = st.mismatches;
    const collapsed = resultStripCollapsed ?? true;
    let html = '<div class="wf-rstrip' + (collapsed ? ' collapsed' : '') + '">';
    html += '<div class="wf-rstrip-head" role="button" tabindex="0" aria-expanded="' + (!collapsed) + '">'
      + '<span class="wf-rstrip-caret">' + (collapsed ? '▸' : '▾') + '</span>'
      + '<span class="wf-rstrip-label">Result</span>'
      + (collapsed ? renderResultStripSummary(agent, evidence) + renderInlineMismatch(mismatches) : '')
      + '</div>';
    if (!collapsed) { html += renderResultStripBody(agent, evidence, mismatches); }
    return html + '</div>';
  }

  function renderAgentPill(groupKey: string, a: DetailAgentView): string {
    const active = groupKey === selectedGroupKey && a.agentId === selectedAgentId;
    const badge = a.teammate ? '<span class="wf-teammate-badge" title="Agent Team member">team</span>' : '';
    const nameWithStatus = a.label + ' · ' + a.status;
    return '<span class="wf-agent-pill' + (active ? ' active' : '') + '"'
      + ' data-group="' + escapeHtml(groupKey) + '" data-agent="' + escapeHtml(a.agentId) + '"'
      + ' role="button" tabindex="' + (active ? '0' : '-1') + '"'
      + ' title="' + escapeHtml(nameWithStatus) + '" aria-label="' + escapeHtml(nameWithStatus) + '"'
      + (active ? ' aria-current="true"' : '') + '>'
      + statusDot(a.status)
      + '<span class="wf-agent-pill-label">' + escapeHtml(a.label) + '</span>'
      + badge + '</span>';
  }

  /** Agent strip: the old left-nav's job. Phase 2.1: a workflow's phases each
   *  get their OWN line — a phase header (title + done/total, failed called
   *  out like the classic nav's phase header) with that phase's pills wrapping
   *  beneath it — one phase after another vertically, so a phase reads as a
   *  unit instead of pills and titles interleaving in one flowing row. Flat
   *  sources (subagents/team, no titles) keep the single pill row. Roving
   *  tabindex — ArrowLeft/ArrowRight walk EVERY pill in document order,
   *  crossing phase lines like the classic nav's Up/Down crossed group
   *  boundaries (one flat list either way; a 2D grid model would buy nothing
   *  at these row counts and complicate focus restore). */
  function renderAgentStrip(): string {
    if (!model) { return ''; }
    const phased = model.groups.some(g => g.title !== null);
    if (!phased) {
      let html = '<div class="wf-agentstrip" role="tablist" aria-label="Agents">'
        + zoneLabel('agents')
        + '<div class="wf-agentstrip-pillwrap">';
      for (const g of model.groups) {
        for (const a of g.agents) { html += renderAgentPill(g.key, a); }
      }
      return html + '</div></div>';
    }
    // Phased: the AGENTS label sits on the strip's FIRST line only; every
    // other line (later phase headers, all pill rows) carries an empty
    // gutter cell so the phase content indents to the shared rail.
    let html = '<div class="wf-agentstrip phased" role="tablist" aria-label="Agents">';
    let first = true;
    for (const g of model.groups) {
      html += '<div class="wf-agentstrip-phaserow">';
      if (g.title !== null) {
        const count = g.agents.length;
        const done = g.agents.filter(a => a.status === 'done').length;
        const failed = g.agents.filter(a => a.status === 'failed').length;
        // Same failed-first-class treatment as the classic nav header (and the
        // same .wf-nav-count-failed class, so the light-theme contrast override
        // applies here too): "4/5" alone reads as still-running.
        const failedHtml = failed > 0
          ? ' · <span class="wf-nav-count-failed">' + failed + ' failed</span>'
          : '';
        html += '<div class="wf-agentstrip-phasehead">'
          + zoneLabel(first ? 'agents' : '')
          + '<span class="wf-agentstrip-phasetitle">' + escapeHtml(g.title) + '</span>'
          + '<span class="wf-agentstrip-count">' + done + '/' + count + failedHtml + '</span></div>';
        first = false;
      }
      html += '<div class="wf-agentstrip-pills">'
        + zoneLabel(first ? 'agents' : '') // an untitled leading group still anchors the label
        + '<div class="wf-agentstrip-pillwrap">';
      first = false;
      for (const a of g.agents) { html += renderAgentPill(g.key, a); }
      html += '</div></div></div>';
    }
    return html + '</div>';
  }

  /** Focus an agent-strip pill by identity (mirrors focusNavRow). */
  function focusAgentPill(groupKey: string, agentId: string): void {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.wf-agent-pill'))) {
      if (el.dataset.group === groupKey && el.dataset.agent === agentId) { el.focus(); return; }
    }
  }

  interface LogRow { entry: TranscriptEntry; idx: number; isBrief: boolean; isResult: boolean }

  /** The selected agent's entries + inbox suffix as flat, index-stable rows,
   *  with the inception brief and the terminal result flagged for distinct
   *  styling (mockup §2's brief/RESULT treatment) — NOT filtered yet; facet
   *  filtering happens in renderLogRows so the counts in the facet bar can be
   *  computed over the same set. `idx` is the position in the combined
   *  entries+suffix array — stable across a streaming append (which only ever
   *  grows the array), which is what makes expandedRows (keyed by idx) safe to
   *  keep across a live re-render. */
  function buildLogRows(agent: DetailAgentView): LogRow[] {
    const st = transcripts.get(tkey(selectedGroupKey!, agent.agentId));
    const entries = (st && st.state === 'ready') ? st.entries : [];
    const suffix = (st && st.state === 'ready') ? st.suffix : [];
    const all = [...entries, ...suffix];
    // Same rule as the classic reader's inception brief: the first genuine
    // prompt turn (tool_result plumbing rides in as role 'tool', never 'user').
    const briefIdx = all.findIndex(e => e.role === 'user');
    const rows: LogRow[] = all.map((e, i) => ({ entry: e, idx: i, isBrief: i === briefIdx, isResult: false }));
    // Terminal result treatment (mockup §2's ✔ RESULT row): the last entry of
    // a finished agent, or a synthesised row from the sidecar's resultPreview
    // when the transcript hasn't produced one (no JSONL record type maps to
    // TranscriptEntry.kind 'result' today — see detailShared.ts).
    const terminal = agent.status === 'done' || agent.status === 'failed' || agent.status === 'stale';
    if (terminal && rows.length > 0) {
      const last = rows[rows.length - 1];
      if (!last.isBrief) { last.isResult = true; }
    } else if (terminal && rows.length === 0 && agent.resultPreview) {
      rows.push({ entry: { timestamp: '', role: 'assistant', content: agent.resultPreview, kind: 'result' }, idx: -1, isBrief: false, isResult: true });
    }
    return rows;
  }

  /** Which facet-bar bucket a row counts under. Mutually exclusive so the
   *  bar's per-bucket counts sum to the row total: an error pre-empts its
   *  underlying tool/text kind (the mockup's Error(1) is a SUBSET call-out,
   *  but the checkbox model here is a partition, not an overlay — simpler to
   *  reason about and to keep counts additive). */
  function facetBucket(e: TranscriptEntry): 'text' | 'tool' | 'error' | 'result' {
    if (e.isError) { return 'error'; }
    if (e.kind === 'result') { return 'result'; }
    if (e.kind === 'tool_use' || e.kind === 'tool_result' || e.kind === 'task') { return 'tool'; }
    if (e.kind === 'text') { return 'text'; }
    return e.role === 'tool' ? 'tool' : 'text'; // fallback for kind-less legacy entries
  }

  function rowVisible(e: TranscriptEntry): boolean {
    if (!kindFilters[facetBucket(e)]) { return false; }
    const q = logSearch.trim().toLowerCase();
    if (!q) { return true; }
    return (e.content + ' ' + (e.toolName || '')).toLowerCase().includes(q);
  }

  /** Facet bar: kind filters (with live counts over the unfiltered row set),
   *  fold-all/expand-all, and the search box. Absent when no agent is
   *  selected — there is nothing to filter. */
  function renderFacets(agent: DetailAgentView): string {
    const rows = buildLogRows(agent);
    const counts = { text: 0, tool: 0, error: 0, result: 0 };
    for (const r of rows) { counts[facetBucket(r.entry)]++; }
    const kindToggle = (k: 'text' | 'tool' | 'error' | 'result', label: string): string =>
      '<span class="wf-facet-kind' + (kindFilters[k] ? ' on' : ' off') + '" data-kind="' + k + '"'
      + ' role="checkbox" aria-checked="' + kindFilters[k] + '" tabindex="0">'
      + (kindFilters[k] ? '☑' : '☐') + ' ' + label
      + ' <span class="wf-facet-count">' + counts[k] + '</span></span>';
    const anyExpanded = expandedRows.size > 0;
    return '<div class="wf-facets">'
      + zoneLabel('filter')
      + kindToggle('text', 'Text') + kindToggle('tool', 'Tool') + kindToggle('error', 'Error') + kindToggle('result', 'Result')
      + '<span class="wf-facet-foldall" role="button" tabindex="0" title="' + (anyExpanded ? 'Fold all expanded rows' : 'Expand all rows') + '">'
      + (anyExpanded ? 'fold ▸' : 'expand ▾') + '</span>'
      + '<span class="wf-facet-search">⌕ <input type="text" class="wf-facet-search-input" placeholder="search…" value="' + escapeHtml(logSearch) + '" /></span>'
      + '</div>';
  }

  const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
  /** Wrap every case-insensitive match of `q` in `text` with a `.wf-hl` span.
   *  Escapes both the display text and the search needle for HTML first, then
   *  matches on the already-escaped strings — so a needle containing `&`/`<`
   *  can neither break the match nor inject markup. */
  function highlightSearch(text: string, q: string): string {
    const esc = escapeHtml(text);
    const query = q.trim();
    if (!query) { return esc; }
    const needle = escapeHtml(query).replace(RE_SPECIAL, '\\$&');
    return esc.replace(new RegExp(needle, 'gi'), m => '<span class="wf-hl">' + m + '</span>');
  }

  /** Local wall-clock HH:MM:SS (Phase 2.2's default gutter). Manual padding,
   *  not toLocaleTimeString — the gutter must be a FIXED 8 chars in every
   *  locale or the label rail wobbles. */
  function fmtClock(t: number): string {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** mm:ss.s offset from `baseMs` (mockup's relative-timestamp column). Empty
   *  string when either side is unparseable — the row just shows no time
   *  rather than a misleading 00:00.0. */
  function fmtOffset(ms: number): string {
    if (!isFinite(ms) || ms < 0) { ms = 0; }
    const tenths = Math.round(ms / 100);
    const m = Math.floor(tenths / 600);
    const rem = tenths - m * 600;
    const s = Math.floor(rem / 10);
    const t = rem % 10;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + t;
  }

  /** Row glyph + its kind class — the primary channel (mockup §4a), colour is
   *  reinforcement only: an error and a tool call are different SYMBOLS
   *  (✗ vs ⚙), not just different colours (WCAG 1.4.1). */
  function logGlyph(e: TranscriptEntry, isResult: boolean): { glyph: string; cls: string } {
    if (e.isError) { return { glyph: '✗', cls: 'k-err' }; }
    if (isResult || e.kind === 'result') { return { glyph: '✔', cls: 'k-res' }; }
    if (e.kind === 'task') { return { glyph: '▶', cls: 'k-task' }; }
    if (e.kind === 'tool_use' || e.kind === 'tool_result' || e.role === 'tool') { return { glyph: '⚙', cls: 'k-tool' }; }
    return { glyph: '💬', cls: 'k-text' };
  }

  // ── Prose rows (Phase 2.1) ───────────────────────────────────────────
  // For design/research agents the assistant's prose IS the primary content;
  // one truncated monospace line per paragraph made the log unreadable
  // (Murray, 2026-07-02, live click-test). Text entries keep the gutter
  // (time + glyph — the scannable log spine) but the body becomes a flowing,
  // UI-font, pre-wrap block at the Phase 0 reading measure. Very long texts
  // clamp with a "show all" expander riding the same expandedRows mechanism
  // tool rows use; the inception brief defaults to a ~3-line clamp (its
  // one-liner already lives in the Result strip — a fully open brief here
  // was pure duplication).

  const PROSE_CLAMP_LINES = 28;
  const BRIEF_CLAMP_LINES = 3;
  /** Nominal reading measure (chars per rendered line) for the clamp
   *  heuristic. jsdom-free string-concat rendering can't measure real layout,
   *  so "rendered lines" are estimated: each source line contributes
   *  ceil(len/measure), minimum 1. The CSS -webkit-line-clamp is applied only
   *  when this estimate exceeds the limit, so the clamp and its "show all"
   *  affordance always agree (a clamp with no expander would trap content). */
  const PROSE_NOMINAL_MEASURE_CH = 80;

  /** A prose entry per the Phase 2.1 rule: kind text, or kind unset with a
   *  conversational role (legacy hosts that predate the kind field). */
  function isProseEntry(e: TranscriptEntry): boolean {
    return e.kind === 'text' || (!e.kind && (e.role === 'user' || e.role === 'assistant'));
  }

  function proseLineEstimate(content: string): number {
    let n = 0;
    for (const line of content.split('\n')) {
      n += Math.max(1, Math.ceil(line.length / PROSE_NOMINAL_MEASURE_CH));
    }
    return n;
  }

  /** Can this row expand in place? Tool rows: raw input/output to reveal.
   *  Prose rows: a clamp to release (brief clamps at 3 estimated lines,
   *  other prose at 28). Drives the click/fold-all handlers and the
   *  `expandable` class the click handler gates on. */
  function rowExpandable(r: LogRow): boolean {
    const e = r.entry;
    if (e.rawInput || e.rawOutput) { return true; }
    if (isProseEntry(e)) {
      return proseLineEstimate(e.content) > (r.isBrief ? BRIEF_CLAMP_LINES : PROSE_CLAMP_LINES);
    }
    return false;
  }

  /** `content` already carries the transcript renderer's "> **Name** summary"
   *  / "> **Tool result** (id): summary" convention (transcriptRenderer.ts) —
   *  the row's own glyph + bold toolName already say WHAT this is, so strip
   *  that marker rather than showing it twice. Collapsed to one line: the log
   *  row is a single line, ellipsis-truncated by CSS. */
  function logRowLabel(e: TranscriptEntry): string {
    const oneLine = e.content.replace(/\r?\n+/g, ' ').trim();
    let label = oneLine.replace(/^>\s*\*\*[^*]+\*\*\s*/, '').replace(/^>\s*/, '');
    // A CORRELATED tool_result names its tool (bold, like tool_use rows) —
    // the leading "(toolu_…):" id parenthetical is then pure noise, so strip
    // it from the display label only (the raw-JSON escape hatch keeps the
    // full record). An uncorrelated result keeps today's rendering intact.
    if (e.kind === 'tool_result' && e.toolName) {
      label = label.replace(/^\(toolu_[^)]*\)\s*:?\s*/, '');
    }
    return label;
  }

  /** Phase 4 native escape hatches (DESIGN-DETAIL-PANE-V2.md): small action
   *  buttons on an expanded row. Every button only POSTS a message — the host
   *  (detailPanel.ts + nativeDocs.ts) resolves the transcript file and builds
   *  every URI; nothing here ever constructs one, and no file content round-
   *  trips through this untrusted context. "Show file changes" appears only
   *  when this row's rawInput parses as a two-sided Edit — `parseEditInput`
   *  is the SAME function nativeDocs.ts re-parses with host-side before
   *  actually opening the diff, so the two sides can't disagree on what
   *  counts as a valid Edit (this webview check is purely a display decision,
   *  never trusted for the write). */
  function renderNativeDocActions(e: TranscriptEntry, idx: number): string {
    let html = '<div class="wf-log-actions">'
      + '<span class="wf-log-action" data-action="raw-json" data-idx="' + idx + '" role="button" tabindex="0">View raw JSON</span>'
      + '<span class="wf-log-action" data-action="open-transcript" role="button" tabindex="0">Open transcript in editor</span>';
    if (e.toolName === 'Edit' && e.rawInput && parseEditInput(e.rawInput)) {
      html += '<span class="wf-log-action" data-action="file-changes" data-idx="' + idx + '" role="button" tabindex="0">Show file changes</span>';
    }
    return html + '</div>';
  }

  function renderExpandedBlock(e: TranscriptEntry, idx: number): string {
    let html = '<div class="wf-log-expand">';
    if (e.rawInput) { html += '<div class="wf-log-expand-h">input</div><pre class="wf-log-expand-pre">' + escapeHtml(e.rawInput) + '</pre>'; }
    if (e.rawOutput) {
      html += '<div class="wf-log-expand-h">' + (e.isError ? 'tool_result (error)' : 'tool_result') + '</div>'
        + '<pre class="wf-log-expand-pre">' + escapeHtml(e.rawOutput) + '</pre>';
    }
    html += renderNativeDocActions(e, idx);
    return html + '</div>';
  }

  function renderLogRow(r: LogRow, baseTs: number): string {
    const e = r.entry;
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    // Two representations (Phase 2.2): wall clock (default) needs only this
    // entry's timestamp; the run offset also needs a parseable first entry.
    // The active mode fills the cell, the other rides the tooltip; a row
    // with no parseable timestamp stays an empty cell in both modes.
    const clock = !isNaN(t) ? fmtClock(t) : '';
    const offset = (!isNaN(t) && !isNaN(baseTs)) ? fmtOffset(t - baseTs) : '';
    const timeLabel = timeMode === 'clock' ? clock : offset;
    const timeAlt = timeMode === 'clock' ? offset : clock;
    const timeTitle = timeAlt ? ' title="' + escapeHtml(timeAlt) + '"' : '';
    const glyph = logGlyph(e, r.isResult);
    const prose = isProseEntry(e);
    const hasExpand = rowExpandable(r);
    const expanded = hasExpand && expandedRows.has(r.idx);
    const classes = ['wf-log-row'];
    if (prose) { classes.push('prose'); }
    if (e.isError) { classes.push('err'); }
    if (r.isBrief) { classes.push('brief'); }
    if (r.isResult) { classes.push('result'); }
    if (expanded) { classes.push('expanded'); }
    if (hasExpand) { classes.push('expandable'); }
    const tags = (r.isBrief ? '<span class="wf-log-tag">BRIEF</span> ' : '')
      + (r.isResult ? '<span class="wf-log-tag">RESULT</span> ' : '');
    let body: string;
    if (prose) {
      // Flowing block: full text, newlines preserved (pre-wrap), UI font,
      // Phase 0 reading measure — see the .wf-log-prose CSS. A clamped body
      // (estimate over the limit, not expanded) gets the line-clamp class and
      // a "show all" affordance; the click handler treats the whole row as
      // the toggle, so the span is decorative (aria-expanded rides the row).
      const clampedNow = hasExpand && !expanded;
      body = '<div class="wf-log-prosewrap">'
        + '<div class="wf-log-prose' + (clampedNow ? (r.isBrief ? ' clamp-brief' : ' clamp-prose') : '') + '">'
        + tags + highlightSearch(e.content, logSearch) + '</div>'
        + (hasExpand ? '<span class="wf-log-showall" aria-hidden="true">' + (expanded ? 'show less ▴' : 'show all ▾') + '</span>' : '')
        + '</div>';
    } else {
      const toolBit = e.toolName ? '<b>' + escapeHtml(e.toolName) + '</b> ' : '';
      const label = highlightSearch(logRowLabel(e), logSearch);
      body = '<span class="wf-log-body">' + tags + toolBit + label + '</span>';
    }
    let html = '<div class="' + classes.join(' ') + '" data-idx="' + r.idx + '"'
      + ' role="button" tabindex="0" aria-expanded="' + (hasExpand ? String(expanded) : 'false') + '">'
      + '<span class="wf-log-t"' + timeTitle + '>' + escapeHtml(timeLabel) + '</span>'
      + '<span class="wf-log-glyph ' + glyph.cls + '">' + glyph.glyph + '</span>'
      + body + '</div>';
    // The expand-below block is for raw tool payloads only — an expanded
    // prose row simply un-clamps in place (its content is already the body).
    if (expanded && (e.rawInput || e.rawOutput)) { html += renderExpandedBlock(e, r.idx); }
    return html;
  }

  /** The log itself (mockup §4a's rest-of-pane): one row per entry, the brief
   *  always shown (it isn't one of the four filterable kinds), everything
   *  else subject to the facet bar's kind filters + search. */
  function renderLogRows(agent: DetailAgentView): string {
    const rows = buildLogRows(agent);
    const baseTs = rows.length > 0 ? Date.parse(rows[0].entry.timestamp || '') : NaN;
    let html = '<div class="wf-log">';
    let shown = 0;
    for (const r of rows) {
      if (!r.isBrief && !rowVisible(r.entry)) { continue; }
      shown++;
      html += renderLogRow(r, baseTs);
    }
    if (shown === 0) { html += '<div class="wf-log-empty">No matching entries.</div>'; }
    return html + '</div>';
  }

  function renderLogMode(): void {
    const refocus = captureFocus();
    const prevScroll = root.querySelector('.wf-log-scroll') as HTMLElement | null;
    const prevTop = prevScroll ? prevScroll.scrollTop : 0;
    const wasAtBottom = prevScroll
      ? isNearBottom(prevScroll.scrollTop, prevScroll.clientHeight, prevScroll.scrollHeight, STICK_THRESHOLD_PX)
      : false;
    const selKey = (selectedGroupKey !== null && selectedAgentId !== null) ? tkey(selectedGroupKey, selectedAgentId) : null;
    if (selKey !== lastRenderedKey) {
      pendingTopOnSettle = true;
      // Row indices are only stable WITHIN one agent's entry list (see
      // buildLogRows) — carrying them across a selection change would expand
      // the wrong rows (or none) once the new agent renders.
      expandedRows.clear();
    }
    const isAgentChange = pendingTopOnSettle;

    if (!model || model.groups.every(g => g.agents.length === 0)) {
      root.innerHTML = renderViewRow() + renderHeaderStrip()
        + '<div class="wf-empty">No agents to show for this view.</div>';
      lastRenderedKey = null;
      refocus?.();
      updateComposer();
      return;
    }

    const agent = findAgent(selectedGroupKey, selectedAgentId);
    // Zone order (Phase 2.2): pickers stack at the top — pick what you're
    // looking at (view, then agent) BEFORE its summary (header strip), then
    // the banners (permission, Result), then the log's own controls.
    root.innerHTML = renderViewRow()
      + renderAgentStrip()
      + renderHeaderStrip()
      + renderPermRow()
      + (agent ? renderResultStrip(agent) : '')
      + (agent ? renderFacets(agent) : '')
      + '<div class="wf-log-scroll">'
      + (agent ? renderLogRows(agent) : '<div class="wf-log-empty">Select an agent to view its transcript.</div>')
      + '</div>';

    const newScroll = root.querySelector('.wf-log-scroll') as HTMLElement | null;
    if (newScroll) {
      newScroll.scrollTop = chooseReaderScrollTop({ isAgentChange, wasAtBottom, prevTop, scrollHeight: newScroll.scrollHeight });
    }
    const st = selKey ? transcripts.get(selKey) : undefined;
    if (!st || st.state !== 'loading') { pendingTopOnSettle = false; }
    lastRenderedKey = selKey;
    refocus?.();
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
    // ── Log view (Phase 2) ──────────────────────────────────────────
    if (target.closest('.wf-mode-toggle')) {
      mode = mode === 'log' ? 'classic' : 'log';
      saveState();
      render();
      return;
    }
    if (target.closest('.wf-view-collapse')) {
      viewRowCollapsed = !viewRowCollapsed;
      saveState();
      render();
      return;
    }
    // Result-strip file chip (Phase 4): kind==='edit' chips only (see
    // renderFileChips) — clicking posts the file's PATH, not an entryIndex,
    // so the host resolves the file's FIRST Edit in the transcript.
    const fileChip = target.closest<HTMLElement>('.wf-rstrip-chip.clickable');
    if (fileChip) {
      const agent = findAgent(selectedGroupKey, selectedAgentId);
      if (model && agent && selectedGroupKey !== null && fileChip.dataset.filePath) {
        vscode.postMessage({
          type: 'showFileChanges', source: model.source, containerId: model.containerId,
          groupKey: selectedGroupKey, agentId: agent.agentId, label: agent.label,
          filePath: fileChip.dataset.filePath,
        });
      }
      return;
    }
    if (target.closest('.wf-rstrip-head')) {
      // Toggle FROM the currently effective state (collapsed default when
      // the user hasn't chosen yet — see resultStripCollapsed's doc
      // comment), not from a raw negation of the persisted flag, so the
      // first click always does what it visually looks like it will do.
      const effective = resultStripCollapsed ?? true;
      resultStripCollapsed = !effective;
      saveState();
      render();
      return;
    }
    // Order matters: the overflow chip carries BOTH .wf-view-chip and .more —
    // it must be checked before the generic .wf-view-chip switch-view branch.
    if (target.closest('.wf-view-chip.more')) {
      viewRowCollapsed = false;
      saveState();
      render();
      return;
    }
    const viewChip2 = target.closest<HTMLElement>('.wf-view-chip');
    if (viewChip2) {
      if (!viewChip2.classList.contains('active')) {
        vscode.postMessage({ type: 'selectDetailView', id: viewChip2.dataset.viewId!, kind: viewChip2.dataset.viewKind! });
      }
      return;
    }
    const agentPill = target.closest<HTMLElement>('.wf-agent-pill');
    if (agentPill) {
      selectAgent(agentPill.dataset.group!, agentPill.dataset.agent!);
      return;
    }
    const facetKind = target.closest<HTMLElement>('.wf-facet-kind');
    if (facetKind) {
      const k = facetKind.dataset.kind as keyof typeof kindFilters;
      kindFilters[k] = !kindFilters[k];
      saveState(); // the enabled-kind set persists (Phase 2.1, global)
      render();
      return;
    }
    if (target.closest('.wf-facet-foldall')) {
      const agent = findAgent(selectedGroupKey, selectedAgentId);
      if (agent) {
        if (expandedRows.size > 0) {
          expandedRows.clear();
        } else {
          // Everything expandable: raw tool payloads AND clamped prose/brief.
          for (const r of buildLogRows(agent)) { if (rowExpandable(r)) { expandedRows.add(r.idx); } }
        }
      }
      render();
      return;
    }
    // Native escape hatches (Phase 4): the expanded block (and these buttons)
    // is a flow SIBLING of .wf-log-row, not nested inside it (see the CSS
    // comment on .wf-log-expand — deliberate, so a click here never bubbles
    // into the row's own expand/collapse toggle below).
    const nativeAction = target.closest<HTMLElement>('.wf-log-action');
    if (nativeAction) {
      const agent = findAgent(selectedGroupKey, selectedAgentId);
      if (model && agent && selectedGroupKey !== null) {
        const action = nativeAction.dataset.action;
        const base = { source: model.source, containerId: model.containerId, groupKey: selectedGroupKey, agentId: agent.agentId, label: agent.label };
        if (action === 'raw-json' || action === 'file-changes') {
          const idx = Number(nativeAction.dataset.idx);
          if (!Number.isNaN(idx)) {
            const type = action === 'raw-json' ? 'showRawRecord' : 'showFileChanges';
            vscode.postMessage({ type, ...base, entryIndex: idx });
          }
        } else if (action === 'open-transcript') {
          vscode.postMessage({ type: 'openTranscriptDoc', ...base });
        }
      }
      return;
    }
    // A click anywhere in the time column flips the WHOLE gutter between
    // wall clock and run offset (Phase 2.2) — checked before the row branch
    // so it never doubles as a row expand/collapse.
    if (target.closest('.wf-log-t')) {
      timeMode = timeMode === 'clock' ? 'offset' : 'clock';
      saveState();
      render();
      return;
    }
    const logRow = target.closest<HTMLElement>('.wf-log-row');
    if (logRow) {
      // Only expandable rows toggle (a short prose row has nothing to
      // reveal, and the re-render would pointlessly destroy a text
      // selection); a click that ENDS a text selection is a copy gesture,
      // not a toggle — prose rows exist to be read and copied from.
      if (!logRow.classList.contains('expandable')) { return; }
      const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (sel && sel.toString().length > 0) { return; }
      const idx = Number(logRow.dataset.idx);
      if (!Number.isNaN(idx)) {
        if (expandedRows.has(idx)) { expandedRows.delete(idx); } else { expandedRows.add(idx); }
        render();
      }
      return;
    }
  });

  // The search box re-renders on every keystroke (filtering is cheap at the
  // sizes this view targets — Phase 5 in DESIGN-DETAIL-PANE-V2.md defers
  // virtualisation until a real transcript demonstrates the need); caret
  // position is restored by captureFocus/refocus in renderLogMode.
  root.addEventListener('input', (e: Event) => {
    const target = e.target as HTMLElement;
    if (target.classList && target.classList.contains('wf-facet-search-input')) {
      logSearch = (target as HTMLInputElement).value;
      render();
    }
  });

  root.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Arrow navigation (UX-3): Up/Down on a roster row moves selection AND
    // focus to the adjacent agent, across group boundaries, matching VS
    // Code's native list idiom (selection follows focus).
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const row = target.closest<HTMLElement>('.wf-nav-row');
      if (row && model) {
        e.preventDefault();
        const flat: Array<{ groupKey: string; agentId: string }> = [];
        for (const g of model.groups) { for (const a of g.agents) { flat.push({ groupKey: g.key, agentId: a.agentId }); } }
        const idx = flat.findIndex(x => x.groupKey === row.dataset.group && x.agentId === row.dataset.agent);
        const next = idx === -1 ? undefined : flat[idx + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          selectAgent(next.groupKey, next.agentId); // re-renders with the new active row
          focusNavRow(next.groupKey, next.agentId);
        }
      }
      return;
    }
    // Agent strip (log view): ArrowLeft/ArrowRight, same idiom as the classic
    // nav's Up/Down — a horizontal strip walks horizontally.
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const pill = target.closest<HTMLElement>('.wf-agent-pill');
      if (pill && model) {
        e.preventDefault();
        const flat: Array<{ groupKey: string; agentId: string }> = [];
        for (const g of model.groups) { for (const a of g.agents) { flat.push({ groupKey: g.key, agentId: a.agentId }); } }
        const idx = flat.findIndex(x => x.groupKey === pill.dataset.group && x.agentId === pill.dataset.agent);
        const next = idx === -1 ? undefined : flat[idx + (e.key === 'ArrowRight' ? 1 : -1)];
        if (next) {
          selectAgent(next.groupKey, next.agentId);
          focusAgentPill(next.groupKey, next.agentId);
        }
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    const activatable = target.closest(
      '.wf-nav-row, .wf-openconv, .wf-switch-chip, .wf-nav-toggle, .wf-brief-head, '
      + '.wf-view-chip, .wf-view-collapse, .wf-mode-toggle, .wf-agent-pill, '
      + '.wf-facet-kind, .wf-facet-foldall, .wf-log-row, .wf-rstrip-head, '
      + '.wf-log-action, .wf-rstrip-chip.clickable',
    );
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
      // Full snapshot: first load for this key, or a host-side reset
      // (truncation, file swap). Authoritative — requests are serialised on
      // the host, so a shrink here is a real truncation, not a stale race.
      const key = String(msg.key);
      const incoming = (msg.entries as TranscriptEntry[]) || [];
      const suffix = (msg.suffix as TranscriptEntry[]) || [];
      const evidence = (msg.evidence as Evidence | undefined) ?? null;
      const mismatches = (msg.mismatches as Mismatch[] | undefined) ?? [];
      const existing = transcripts.get(key);
      // Dedup: an unchanged transcript must NOT re-render — the innerHTML
      // swap would destroy any text selection the user is holding mid-copy.
      if (existing && existing.state === 'ready'
          && sameTranscript(existing.entries, incoming) && sameTranscript(existing.suffix, suffix)) {
        return;
      }
      // Copy at the message boundary: the cache arrays are mutated by the
      // append path, and message data must never be aliased into owned state.
      transcripts.set(key, { state: 'ready', entries: incoming.slice(), suffix: suffix.slice(), evidence, mismatches: mismatches.slice() });
      if (key === tkey(selectedGroupKey ?? '', selectedAgentId ?? '')) { render(); }
    } else if (msg.type === 'agentTranscriptAppend') {
      // Delta post (audit perf-render-4): new JSONL entries since the last
      // post, plus the full replacement inbox suffix. Appends DOM turn nodes
      // in place when it can — rebuilding #wf-root re-runs the markdown
      // pipeline over every prior turn and destroys any text selection.
      const key = String(msg.key);
      const delta = (msg.entries as TranscriptEntry[]) || [];
      const suffix = (msg.suffix as TranscriptEntry[]) || [];
      const evidence = (msg.evidence as Evidence | undefined) ?? null;
      const mismatches = (msg.mismatches as Mismatch[] | undefined) ?? [];
      const existing = transcripts.get(key);
      if (!existing || existing.state !== 'ready') {
        // No anchor to append to (webview reloaded mid-stream, or an error
        // state). Only the selected agent is ever steady-polled, so if this
        // is the selected key, re-request a full snapshot; otherwise drop.
        if (model && selectedGroupKey !== null && selectedAgentId !== null
            && key === tkey(selectedGroupKey, selectedAgentId)) {
          transcripts.set(key, { state: 'loading' });
          vscode.postMessage({ type: 'viewAgent', source: model.source, containerId: model.containerId, groupKey: selectedGroupKey, agentId: selectedAgentId, full: true });
        }
        return;
      }
      // The brief is the FIRST user entry: appending can only change the
      // structure when no user entry existed yet (promptPreview fallback) and
      // one arrives now — pin-out then needs a full render.
      const briefStable = existing.entries.some(e => e.role === 'user') || !delta.some(e => e.role === 'user');
      // Classic-only optimisation: the log view's rows (timestamps, facet
      // counts, the terminal RESULT row) are cheap enough to fully rebuild —
      // see the `render()` call below, which dispatches to renderLogMode() —
      // and .wf-reader-body only ever exists in classic mode anyway.
      const canFastAppend = mode === 'classic'
        && key === tkey(selectedGroupKey ?? '', selectedAgentId ?? '')
        && existing.entries.length > 0
        && briefStable
        && root.querySelector('.wf-reader-body') !== null;
      existing.entries.push(...delta);
      existing.suffix = suffix.slice();
      existing.evidence = evidence;
      existing.mismatches = mismatches.slice();
      if (!canFastAppend) {
        if (key === tkey(selectedGroupKey ?? '', selectedAgentId ?? '')) { render(); }
        return;
      }
      const reader = root.querySelector('.wf-reader') as HTMLElement;
      const body = root.querySelector('.wf-reader-body') as HTMLElement;
      const stick = isNearBottom(reader.scrollTop, reader.clientHeight, reader.scrollHeight, STICK_THRESHOLD_PX);
      body.querySelector('.wf-suffix')?.remove();
      let html = '';
      for (const e of delta) { html += renderTurn(e); }
      body.insertAdjacentHTML('beforeend', html + renderSuffix(suffix));
      if (stick) { reader.scrollTop = reader.scrollHeight; }
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
