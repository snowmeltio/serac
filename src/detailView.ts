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
  /** View row (session-scoped switcher, mockup view 4/4b) collapsed to one line
   *  with only the active + running/waiting chips shown, the rest folded into a
   *  "+N" overflow chip. Tri-state since Phase 2.5 (same pattern as
   *  resultStripCollapsed): null means "no explicit user choice", in which
   *  case the row is expanded on a wide pane and collapsed on a narrow one
   *  (isNarrow) — collapse-by-hand remains an explicit choice that then wins
   *  at every width. A plain boolean persisted by 1.16.0 loads as that
   *  explicit choice, which is exactly what the user meant by it. */
  let viewRowCollapsed: boolean | null = null;
  /** Agent strip collapsed to one line (Phase 2.3), same semantics as the
   *  views row: only the active + running/waiting pills shown, the rest
   *  folded into a "+N" overflow chip. For a phased strip, collapsing folds
   *  ALL phase lines into that single pill row — no phase headers. Tri-state
   *  like viewRowCollapsed above (null → expanded wide, collapsed narrow);
   *  fresh key name so it can't collide with any older persisted shape. */
  let agentStripCollapsed: boolean | null = null;
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
  /** The tkey last painted by renderLogMode; a change means an agent switch,
   *  which resets scroll to the top once the transcript settles. */
  let lastRenderedKey: string | null = null;
  /** Set on agent change; holds "scroll to top" until the transcript for the
   *  new selection finishes loading, so a loading→loaded re-render doesn't
   *  inherit the previous agent's scroll position. */
  let pendingTopOnSettle = false;

  // ── Narrow register (Phase 2.5) ─────────────────────────────────────
  // The webview is its own viewport, so a plain media query drives the CSS
  // side; this is the TS side — the same breakpoint decides the DEFAULT
  // collapse state of the view row and agent strip (collapse is state, not
  // styling, so CSS can't do it). Registered ONCE at module init; jsdom has
  // no matchMedia, so the guard defaults to wide and tests only see the
  // narrow register when they stub it.
  const narrowQuery: MediaQueryList | null =
    typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 720px)') : null;
  function isNarrow(): boolean { return narrowQuery !== null && narrowQuery.matches; }
  if (narrowQuery && typeof narrowQuery.addEventListener === 'function') {
    // Crossing the breakpoint re-renders so null-preference zones snap to
    // the width's default; explicit choices are untouched by design.
    narrowQuery.addEventListener('change', () => render());
  }

  // ── Webview state persistence ──────────────────────────────────────
  // The panel webview is rebuilt whenever its tab is re-opened; vscode.setState
  // survives that (same pattern as the sidebar). Selection is restored only if
  // the next model is the SAME drill-in (owner matches) and the agent still
  // exists — otherwise the normal first-agent default applies.
  interface PersistedState {
    owner?: string;
    groupKey?: string;
    agentId?: string;
    viewRowCollapsed?: boolean | null;
    agentStripCollapsed?: boolean | null;
    resultStripCollapsed?: boolean | null;
    kindFilters?: Partial<Record<'text' | 'tool' | 'error' | 'result', boolean>>;
    timeMode?: 'clock' | 'offset';
  }
  const persisted = (vscode.getState() ?? {}) as PersistedState;
  // A stored boolean (including one written by 1.16.0's two-state model)
  // loads as an EXPLICIT choice; anything else means no choice yet.
  viewRowCollapsed = typeof persisted.viewRowCollapsed === 'boolean' ? persisted.viewRowCollapsed : null;
  agentStripCollapsed = typeof persisted.agentStripCollapsed === 'boolean' ? persisted.agentStripCollapsed : null;
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
      viewRowCollapsed,
      agentStripCollapsed,
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
    const pill = active.closest<HTMLElement>('.wf-agent-pill');
    if (pill) {
      const g = pill.dataset.group ?? '';
      const a = pill.dataset.agent ?? '';
      return () => focusAgentPill(g, a);
    }
    const chip = active.closest<HTMLElement>('.wf-view-chip');
    if (chip) {
      const id = chip.dataset.viewId;
      return () => {
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('.wf-view-chip'))) {
          if (el.dataset.viewId === id) { el.focus(); return; }
        }
      };
    }
    // Up to three zone-collapse controls can coexist (views/agents/result) —
    // restore to the SAME zone's button, not merely the first in the DOM.
    const zc = active.closest<HTMLElement>('.wf-zone-collapse');
    if (zc) {
      const zone = zc.dataset.zone ?? '';
      return () => {
        (root.querySelector('.wf-zone-collapse[data-zone="' + zone + '"]') as HTMLElement | null)?.focus();
      };
    }
    // The scroll container itself (keyboard-scrollable, tabindex 0). Exact
    // match, not closest(): focus on a log ROW inside it must keep falling
    // through to "no restore" rather than teleporting to the container.
    if (active.classList.contains('wf-log-scroll')) {
      return () => { (root.querySelector('.wf-log-scroll') as HTMLElement | null)?.focus(); };
    }
    for (const cls of [
      'wf-openconv', 'wf-facet-time', 'wf-facet-foldall', 'wf-rstrip-head', 'wf-jump-latest',
    ] as const) {
      if (active.closest('.' + cls)) {
        return () => { (root.querySelector('.' + cls) as HTMLElement | null)?.focus(); };
      }
    }
    return null;
  }

  /** Single entry point every message handler and event listener calls. */
  function render(): void {
    renderLogMode();
  }

  // ── Log view ──────────────────────────────────────────────────────
  // Single-pane forensic log. Zone order (Phase 2.2 — pickers stack first):
  // view row → agent strip → header strip → pinned permission row → Result
  // strip → facet bar → the log. DESIGN-DETAIL-PANE-V2.md §4a.

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
   *  has no cross-source switcher — and intentionally does NOT synthesise a
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

  /** The shared zone collapse/expand affordance (Phase 2.3): the views row's
   *  bordered button, generalised — Murray preferred it over the Result
   *  strip's tiny caret, so ONE control (identical glyphs and wording)
   *  serves views, agents, and result. `data-zone` routes the click; sits at
   *  the right end of each zone's first line, outside any clipped wrap
   *  container so a collapsed overflow can never hide it. */
  function zoneCollapse(zone: 'views' | 'agents' | 'result', collapsed: boolean): string {
    return '<span class="wf-zone-collapse" data-zone="' + zone + '" role="button" tabindex="0"'
      + ' title="' + (collapsed ? 'Expand ' : 'Collapse ') + zone + '">'
      + (collapsed ? '⌄ expand' : '⌃ collapse') + '</span>';
  }

  function renderViewRow(): string {
    if (!model || !model.views || model.views.length === 0) { return ''; }
    const views = model.views;
    // Effective state (Phase 2.5): the user's explicit choice, else the
    // width's default — collapsed on a narrow pane, expanded on a wide one.
    const collapsed = viewRowCollapsed ?? isNarrow();
    let shown = views;
    let overflow = 0;
    if (collapsed) {
      shown = views.filter(v => v.active || v.status === 'running' || v.status === 'waiting');
      overflow = views.length - shown.length;
    }
    // Label cell + a separate wrapping chip container: wrapped chip lines
    // then indent to the rail instead of sliding under the label.
    let html = '<div class="wf-view-row' + (collapsed ? ' collapsed' : '') + '" role="tablist" aria-label="Views in this session">'
      + zoneLabel('views')
      + '<div class="wf-view-chipwrap">';
    for (const v of shown) { html += renderViewChip(v); }
    if (collapsed && overflow > 0) {
      html += '<span class="wf-view-chip more" role="button" tabindex="0"'
        + ' title="Show ' + overflow + ' more view' + (overflow === 1 ? '' : 's') + '">+' + overflow + '</span>';
    }
    return html + '</div>' + zoneCollapse('views', collapsed) + '</div>';
  }

  /** Roll-up across every agent in every group (workflow phases included) —
   *  the header strip's live counts and totals are session-view-wide, not
   *  scoped to the selected agent (that's the agent strip's job). */
  function headerAgg(): {
    running: number; waiting: number; done: number; failed: number;
    tokens: number; durationMs: number | null; model: string; modelExtra: number;
    modelTitle: string; pillStatus: string;
  } {
    const agents = allAgents();
    let running = 0, waiting = 0, done = 0, failed = 0, tokens = 0;
    let maxDur: number | null = null;
    const models = new Set<string>();
    let mostRecentModel = '';
    for (const a of agents) {
      if (a.status === 'running') { running++; }
      else if (a.status === 'waiting') { waiting++; }
      else if (a.status === 'failed') { failed++; }
      else { done++; } // done/stale roll up to "done" in the glance count
      tokens += a.tokens;
      if (a.durationMs !== null) { maxDur = maxDur === null ? a.durationMs : Math.max(maxDur, a.durationMs); }
      // allAgents() walks groups/agents in the same oldest-run-first order
      // the strip renders them in (no per-agent timestamp exists to sort by
      // instead — see renderPermRow's note), so the last hit is the most
      // recently spawned agent's model, a reasonable proxy for "current".
      if (a.model) { models.add(a.model); mostRecentModel = a.model; }
    }
    // Naming the most recent model beats the old blank-on-mixed (Murray,
    // 2026-07-15): a mixed run still names ONE real model instead of hiding
    // that any model ran at all. The rest of the set rides a "+N" suffix and
    // the full list in the title tooltip, same pattern as renderAgentPill.
    const modelLabel = mostRecentModel ? formatModelLabel(mostRecentModel) : '';
    const modelExtra = models.size > 1 ? models.size - 1 : 0;
    const modelTitle = models.size > 1 ? [...models].map(formatModelLabel).join(', ') : '';
    // Run-level failed/incomplete outranks the agent roll-up once nothing is
    // in flight: a failed 0-agent run has all-zero counters and previously
    // fell through to a DONE pill ("DONE · 0 done" on a crashed run).
    const runBad = model && (model.runStatus === 'failed' || model.runStatus === 'incomplete')
      ? model.runStatus : null;
    const pillStatus = running > 0 ? 'running' : waiting > 0 ? 'waiting'
      : (runBad ?? (failed > 0 ? 'failed' : 'done'));
    return { running, waiting, done, failed, tokens, durationMs: maxDur, model: modelLabel, modelExtra, modelTitle, pillStatus };
  }

  /** A failed/incomplete pill carries the run's error as its tooltip — the
   *  cheapest always-reachable surface for "why did it fail", even when the
   *  roster is non-empty and the empty-body error line never renders. */
  function pillTitleAttr(pillStatus: string): string {
    if (!model?.runError) { return ''; }
    if (pillStatus !== 'failed' && pillStatus !== 'incomplete') { return ''; }
    return ' title="' + escapeHtml(model.runError.slice(0, 1000)) + '"';
  }

  /** Empty-roster body. A failed run with no agents previously rendered only
   *  "No agents to show" — the sidecar's error is strictly more useful (the
   *  v1.16.21 blank panel: a script that crashed in 5ms surfaced nothing).
   *  First line renders; the full text (capped) rides the title attribute. */
  function renderEmptyBody(): string {
    const err = model?.runError;
    if (err) {
      const word = model?.runStatus === 'incomplete' ? 'incomplete' : 'failed';
      return '<div class="wf-empty wf-empty-error" title="' + escapeHtml(err.slice(0, 1000)) + '">'
        + escapeHtml('Run ' + word + ': ' + err.split('\n')[0].slice(0, 300)) + '</div>';
    }
    return '<div class="wf-empty">No agents to show for this view.</div>';
  }

  /** Header strip (mockup §2): source badge, container name, status pill, live
   *  counts, duration/tokens/model. Phase 2.5: everything after the rail label
   *  sits in a wrapping body (whole units flow to continuation lines that
   *  indent to the rail — the view row's pattern), counts drop their zero
   *  segments, and each meta bit is its own atomic nowrap span. */
  function renderHeaderStrip(): string {
    if (!model) { return ''; }
    const agg = headerAgg();
    const badge = model.source === 'workflow' ? 'workflow' : model.source === 'team' ? 'team' : 'subagent';
    // Zero-drop counts: only what IS. A finished 6-agent run reads "6 done";
    // a live one "3 running · 2 done". Failed finally surfaces here too
    // (headerAgg always counted it; the old string never showed it). All
    // zero — an empty roster — degrades to "0 done".
    const countBits: string[] = [];
    if (agg.running > 0) { countBits.push(agg.running + ' running'); }
    if (agg.waiting > 0) { countBits.push(agg.waiting + ' waiting'); }
    if (agg.failed > 0) { countBits.push(agg.failed + ' failed'); }
    if (agg.done > 0) { countBits.push(agg.done + ' done'); }
    // An empty roster on a failed/incomplete run reads "run failed", not the
    // absurd "0 done" the zero-drop fallback used to produce.
    if (countBits.length === 0) {
      countBits.push(agg.pillStatus === 'failed' || agg.pillStatus === 'incomplete'
        ? 'run ' + agg.pillStatus : '0 done');
    }
    const metaBits: string[] = [];
    const dur = fmtDuration(agg.durationMs);
    if (dur) { metaBits.push(dur); }
    if (agg.tokens > 0) { metaBits.push(fmtTokens(agg.tokens) + ' tokens'); }
    if (agg.model) {
      const label = escapeHtml(agg.model + (agg.modelExtra > 0 ? ' +' + agg.modelExtra : ''));
      metaBits.push(agg.modelTitle ? '<span title="' + escapeHtml(agg.modelTitle) + '">' + label + '</span>' : label);
    }
    // Each meta bit is one unbreakable unit; the separator dot rides INSIDE
    // the non-first spans so a wrapped line keeps the register's dots
    // without ever orphaning one.
    let metaHtml = '';
    for (let i = 0; i < metaBits.length; i++) {
      metaHtml += '<span class="wf-hstrip-meta-item">' + (i > 0 ? '· ' : '') + metaBits[i] + '</span>';
    }
    // The source badge lives in the shared label rail (Phase 2.3) — same
    // gutter cell as views/agents/result/filter, not a bordered one-off box.
    return '<div class="wf-hstrip">'
      + zoneLabel(badge)
      + '<div class="wf-hstrip-body">'
      + '<span class="wf-hstrip-name" title="' + escapeHtml(model.title) + '">' + escapeHtml(model.title) + '</span>'
      + '<span class="wf-hstrip-pill status-' + agg.pillStatus + '"' + pillTitleAttr(agg.pillStatus) + '>' + escapeHtml(agg.pillStatus) + '</span>'
      + '<span class="wf-hstrip-counts">' + countBits.join(' · ') + '</span>'
      + '<span class="wf-hstrip-meta">' + metaHtml + '</span>'
      // The word hides at narrow width (CSS .wf-openconv-text); the glyph
      // plus the title attribute keep the affordance legible icon-only.
      + '<span class="wf-openconv wf-hstrip-openconv" role="button" tabindex="0" title="Open the parent agent session">↗ <span class="wf-openconv-text">session</span></span>'
      + '</div></div>';
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

  /** The "first user entry" (the inception brief — same pick buildLogRows
   *  makes), falling back to the sidecar's promptPreview before the
   *  transcript has loaded — one line, truncated. */
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
    // Phase 2.3: the head leads with the shared rail label (no more one-off
    // caret + label pair) and ends with the shared collapse control. The
    // whole head stays clickable; the button inside it is the visible
    // affordance — the click handler checks .wf-zone-collapse BEFORE
    // .wf-rstrip-head, so the two never double-toggle.
    let html = '<div class="wf-rstrip' + (collapsed ? ' collapsed' : '') + '">';
    html += '<div class="wf-rstrip-head" role="button" tabindex="0" aria-expanded="' + (!collapsed) + '">'
      + zoneLabel('result')
      + (collapsed ? renderResultStripSummary(agent, evidence) + renderInlineMismatch(mismatches) : '')
      + zoneCollapse('result', collapsed)
      + '</div>';
    if (!collapsed) {
      // Body indents to the rail (label width + the 9px rail gap), matching
      // .wf-log-expand's arithmetic — the 14px strip padding is already on
      // the container.
      html += '<div class="wf-rstrip-body">' + renderResultStripBody(agent, evidence, mismatches) + '</div>';
    }
    return html + '</div>';
  }

  function renderAgentPill(groupKey: string, a: DetailAgentView): string {
    const active = groupKey === selectedGroupKey && a.agentId === selectedAgentId;
    const badge = a.teammate ? '<span class="wf-teammate-badge" title="Agent Team member">team</span>' : '';
    // Model rides in the title/aria-label only (Murray, 2026-07-10): a repeated
    // "Sonnet 5" on every pill in a same-model run was pure clutter — the
    // agent detail bar under the strip is now the one place it shows visibly.
    const modelLabel = a.model ? formatModelLabel(a.model) : '';
    const nameWithStatus = a.label + ' · ' + a.status + (modelLabel ? ' · ' + modelLabel : '');
    return '<span class="wf-agent-pill' + (active ? ' active' : '') + '"'
      + ' data-group="' + escapeHtml(groupKey) + '" data-agent="' + escapeHtml(a.agentId) + '"'
      + ' role="button" tabindex="' + (active ? '0' : '-1') + '"'
      + ' title="' + escapeHtml(nameWithStatus) + '" aria-label="' + escapeHtml(nameWithStatus) + '"'
      + (active ? ' aria-current="true"' : '') + '>'
      + statusDot(a.status)
      + '<span class="wf-agent-pill-label">' + escapeHtml(a.label) + '</span>'
      + badge
      + '</span>';
  }

  /** Selected-agent detail bar: sits directly under the agent strip, one line
   *  scoped to whichever pill is active (the header strip above stays the
   *  workflow-wide roll-up). Carries what the per-pill model tag used to show
   *  plus tokens/runtime/tool-calls, as a rail-aligned strip to match the
   *  rest of the pane. Absent when the selected agent has none of these to report
   *  (a fresh agent with no tokens/model/duration yet). */
  function renderAgentDetailBar(agent: DetailAgentView | undefined): string {
    if (!agent) { return ''; }
    const metaBits: string[] = [];
    const modelLabel = agent.model ? formatModelLabel(agent.model) : '';
    if (modelLabel) { metaBits.push(escapeHtml(modelLabel)); }
    const dur = fmtDuration(agent.durationMs);
    if (dur) { metaBits.push(dur); }
    if (agent.tokens > 0) { metaBits.push(fmtTokens(agent.tokens) + ' tokens'); }
    if (agent.toolCalls > 0) { metaBits.push(agent.toolCalls + ' tool' + (agent.toolCalls === 1 ? '' : 's')); }
    if (agent.attempt && agent.attempt > 1) { metaBits.push('attempt ' + agent.attempt); }
    if (metaBits.length === 0) { return ''; }
    let metaHtml = '';
    for (let i = 0; i < metaBits.length; i++) {
      metaHtml += '<span class="wf-astrip-meta-item">' + (i > 0 ? '· ' : '') + metaBits[i] + '</span>';
    }
    return '<div class="wf-astrip">'
      + zoneLabel('')
      + '<div class="wf-astrip-body">'
      + statusDot(agent.status)
      + '<span class="wf-astrip-name">' + escapeHtml(agent.label) + '</span>'
      + metaHtml
      + '</div></div>';
  }

  /** Agent strip: the agent roster. Phase 2.1: a workflow's phases each
   *  get their OWN line — a phase header (title + done/total, failed called
   *  out first-class) with that phase's pills wrapping
   *  beneath it — one phase after another vertically, so a phase reads as a
   *  unit instead of pills and titles interleaving in one flowing row. Flat
   *  sources (subagents/team, no titles) keep the single pill row. Roving
   *  tabindex — ArrowLeft/ArrowRight walk EVERY pill in document order,
   *  crossing phase-line boundaries (one flat list either way; a 2D grid
   *  model would buy nothing
   *  at these row counts and complicate focus restore). */
  function renderAgentStrip(): string {
    if (!model) { return ''; }
    const phased = model.groups.some(g => g.title !== null);
    // Collapsed (Phase 2.3, same semantics as the views row): one line
    // whatever the shape — the active pill plus any running/waiting pills,
    // the rest folded into a "+N" chip. A phased strip folds ALL its phase
    // lines into this single row (no phase headers); phase grouping is an
    // expanded-only affordance.
    // Effective state (Phase 2.5): explicit choice, else the width default.
    const collapsed = agentStripCollapsed ?? isNarrow();
    if (collapsed) {
      const all: Array<{ key: string; a: DetailAgentView }> = [];
      for (const g of model.groups) { for (const a of g.agents) { all.push({ key: g.key, a }); } }
      const shown = all.filter(({ key, a }) =>
        (key === selectedGroupKey && a.agentId === selectedAgentId)
        || a.status === 'running' || a.status === 'waiting');
      const overflow = all.length - shown.length;
      let html = '<div class="wf-agentstrip collapsed" role="tablist" aria-label="Agents">'
        + zoneLabel('agents')
        + '<div class="wf-agentstrip-pillwrap">';
      for (const { key, a } of shown) { html += renderAgentPill(key, a); }
      if (overflow > 0) {
        html += '<span class="wf-agent-pill more" role="button" tabindex="0"'
          + ' title="Show ' + overflow + ' more agent' + (overflow === 1 ? '' : 's') + '">+' + overflow + '</span>';
      }
      return html + '</div>' + zoneCollapse('agents', true) + '</div>';
    }
    if (!phased) {
      let html = '<div class="wf-agentstrip" role="tablist" aria-label="Agents">'
        + zoneLabel('agents')
        + '<div class="wf-agentstrip-pillwrap">';
      for (const g of model.groups) {
        for (const a of g.agents) { html += renderAgentPill(g.key, a); }
      }
      return html + '</div>' + zoneCollapse('agents', false) + '</div>';
    }
    // Phased: the AGENTS label sits on the strip's FIRST line only; every
    // other line (later phase headers, all pill rows) carries an empty
    // gutter cell so the phase content indents to the shared rail. The
    // shared collapse control rides the first line too, whatever kind of
    // line that is.
    let html = '<div class="wf-agentstrip phased" role="tablist" aria-label="Agents">';
    let first = true;
    for (const g of model.groups) {
      html += '<div class="wf-agentstrip-phaserow">';
      if (g.title !== null) {
        const count = g.agents.length;
        const done = g.agents.filter(a => a.status === 'done').length;
        const failed = g.agents.filter(a => a.status === 'failed').length;
        // Failed gets first-class treatment (.wf-nav-count-failed carries the
        // light-theme contrast override): "4/5" alone reads as still-running.
        const failedHtml = failed > 0
          ? ' · <span class="wf-nav-count-failed">' + failed + ' failed</span>'
          : '';
        html += '<div class="wf-agentstrip-phasehead">'
          + zoneLabel(first ? 'agents' : '')
          + '<span class="wf-agentstrip-phasetitle">' + escapeHtml(g.title) + '</span>'
          + '<span class="wf-agentstrip-count">' + done + '/' + count + failedHtml + '</span>'
          + (first ? zoneCollapse('agents', false) : '') + '</div>';
        first = false;
      }
      const leadLine = first; // an untitled leading group still anchors the label
      html += '<div class="wf-agentstrip-pills">'
        + zoneLabel(leadLine ? 'agents' : '')
        + '<div class="wf-agentstrip-pillwrap">';
      first = false;
      for (const a of g.agents) { html += renderAgentPill(g.key, a); }
      html += '</div>' + (leadLine ? zoneCollapse('agents', false) : '') + '</div></div>';
    }
    return html + '</div>';
  }

  /** Focus an agent-strip pill by identity (mirrors focusNavRow). Phase 2.3:
   *  the pill may now be hidden behind the collapsed strip's "+N" fold — fall
   *  back to the active pill so keyboard focus survives instead of dropping
   *  to <body>. */
  function focusAgentPill(groupKey: string, agentId: string): void {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.wf-agent-pill'))) {
      if (el.dataset.group === groupKey && el.dataset.agent === agentId) { el.focus(); return; }
    }
    (root.querySelector('.wf-agent-pill.active') as HTMLElement | null)?.focus();
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
    // The inception brief: the first genuine
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
   *  the time-mode indicator chip, fold-all/expand-all, and the search box.
   *  Rail label reads "display" (Phase 2.4) — the bar governs more than
   *  filtering now. Absent when no agent is selected — nothing to display. */
  function renderFacets(agent: DetailAgentView): string {
    const rows = buildLogRows(agent);
    const counts = { text: 0, tool: 0, error: 0, result: 0 };
    for (const r of rows) { counts[facetBucket(r.entry)]++; }
    const kindToggle = (k: 'text' | 'tool' | 'error' | 'result', label: string): string =>
      '<span class="wf-facet-kind' + (kindFilters[k] ? ' on' : ' off') + '" data-kind="' + k + '"'
      + ' role="checkbox" aria-checked="' + kindFilters[k] + '" tabindex="0">'
      + (kindFilters[k] ? '☑' : '☐') + ' ' + label
      + ' <span class="wf-facet-count">' + counts[k] + '</span></span>';
    // Time-mode indicator (Phase 2.4): the gutter's wall-clock/offset choice
    // finally gets a visible label — in Murray's terms, absolute vs session.
    // Clicking it is the SAME toggle as clicking the timestamp column (both
    // routes share one handler effect). ◷ is a text glyph, not an emoji —
    // emoji render in colour and ignore the theme.
    const timeChip = '<span class="wf-facet-time" role="button" tabindex="0"'
      + ' data-mode="' + timeMode + '"'
      + ' title="' + (timeMode === 'clock'
        ? 'Timestamps are absolute wall-clock — click for session-relative offsets'
        : 'Timestamps are session-relative offsets — click for absolute wall-clock') + '">'
      + '◷ ' + (timeMode === 'clock' ? 'absolute' : 'session') + '</span>';
    const anyExpanded = expandedRows.size > 0;
    return '<div class="wf-facets">'
      + zoneLabel('display')
      // Controls live in their own wrapping body (Phase 2.5): at narrow
      // widths whole toggles flow to continuation lines that indent to the
      // rail, instead of a ☑ splitting from its label.
      + '<div class="wf-facets-body">'
      + kindToggle('text', 'Text') + kindToggle('tool', 'Tool') + kindToggle('error', 'Error') + kindToggle('result', 'Result')
      + timeChip
      + '<span class="wf-facet-foldall" role="button" tabindex="0" title="' + (anyExpanded ? 'Fold all expanded rows' : 'Expand all rows') + '">'
      + (anyExpanded ? 'fold ▸' : 'expand ▾') + '</span>'
      + '<span class="wf-facet-search">⌕ <input type="text" class="wf-facet-search-input" placeholder="search…" value="' + escapeHtml(logSearch) + '" /></span>'
      + '</div></div>';
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
    // Tool-flavoured rows (facetBucket's own 'tool' predicate, so the class
    // can never drift from the filter) get a hook for the grey-text
    // treatment (Phase 2.4/2.4b): tool chatter reads as secondary to the
    // prose in EVERY state — expanded included — and a step lighter than
    // errors. Errors take their grey via .err; result/brief rows are
    // excluded in the CSS — they are core content.
    if (facetBucket(e) === 'tool') { classes.push('tool'); }
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

  /** Show the jump-to-latest pill only while the log is scrolled away from
   *  the bottom — the same STICK threshold the auto-follow uses, so the pill
   *  and the follow behaviour agree on what "at the bottom" means. Called on
   *  every render and (via the capture-phase listener below) every scroll. */
  function updateJumpPill(): void {
    const pill = root.querySelector('.wf-jump-latest') as HTMLElement | null;
    const scroll = root.querySelector('.wf-log-scroll') as HTMLElement | null;
    if (!pill || !scroll) { return; }
    const show = !isNearBottom(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight, STICK_THRESHOLD_PX);
    pill.classList.toggle('visible', show);
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
      root.innerHTML = renderViewRow() + renderHeaderStrip() + renderEmptyBody();
      lastRenderedKey = null;
      refocus?.();
      updateComposer();
      return;
    }

    const agent = findAgent(selectedGroupKey, selectedAgentId);
    // Zone order (Murray, 2026-07-10): view row first (what am I in), then its
    // summary (header strip — the workflow-wide roll-up), THEN the agent
    // strip (pick which agent) with its own detail bar directly beneath it,
    // then the banners (permission, Result), then the log's own controls.
    root.innerHTML = renderViewRow()
      + renderHeaderStrip()
      + renderAgentStrip()
      + renderAgentDetailBar(agent)
      + renderPermRow()
      + (agent ? renderResultStrip(agent) : '')
      + (agent ? renderFacets(agent) : '')
      + '<div class="wf-log-scroll" tabindex="0">'
      + (agent ? renderLogRows(agent) : '<div class="wf-log-empty">Select an agent to view its transcript.</div>')
      + '</div>'
      + '<div class="wf-jump-latest" role="button" tabindex="0" title="Jump to the latest entry">↓ latest</div>';

    const newScroll = root.querySelector('.wf-log-scroll') as HTMLElement | null;
    if (newScroll) {
      newScroll.scrollTop = chooseReaderScrollTop({ isAgentChange, wasAtBottom, prevTop, scrollHeight: newScroll.scrollHeight });
    }
    updateJumpPill();
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

  // Scroll events don't bubble, so the jump-pill visibility check listens in
  // the CAPTURE phase on the persistent root — it survives every innerHTML
  // rebuild without per-render re-attachment.
  root.addEventListener('scroll', () => { updateJumpPill(); }, true);

  root.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.wf-jump-latest')) {
      const scroll = root.querySelector('.wf-log-scroll') as HTMLElement | null;
      if (scroll) { scroll.scrollTop = scroll.scrollHeight; }
      updateJumpPill();
      return;
    }
    if (target.closest('.wf-openconv')) {
      if (model) { vscode.postMessage({ type: 'openConversation', sessionId: model.sessionId }); }
      return;
    }
    // Shared zone collapse control (Phase 2.3). Checked BEFORE the
    // .wf-rstrip-head branch below: the result zone's button sits INSIDE the
    // clickable head, so this branch returning first is what prevents a
    // double toggle.
    const zc = target.closest<HTMLElement>('.wf-zone-collapse');
    if (zc) {
      const zone = zc.dataset.zone;
      // All three zones toggle FROM the effective state (explicit choice ??
      // width/zone default) and WRITE an explicit boolean — so the first
      // click always does what it visually looks like it will do, and the
      // choice then holds at every width.
      if (zone === 'views') {
        viewRowCollapsed = !(viewRowCollapsed ?? isNarrow());
      } else if (zone === 'agents') {
        agentStripCollapsed = !(agentStripCollapsed ?? isNarrow());
      } else {
        resultStripCollapsed = !(resultStripCollapsed ?? true);
      }
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
    // Order matters, same as the view chips: the agents overflow chip carries
    // BOTH .wf-agent-pill and .more (no data attrs), so it must be checked
    // before the generic select-agent branch.
    if (target.closest('.wf-agent-pill.more')) {
      agentStripCollapsed = false;
      saveState();
      render();
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
    // Time-mode chip (Phase 2.4): the same toggle as the timestamp-column
    // click below — two routes, one effect.
    if (target.closest('.wf-facet-time')) {
      timeMode = timeMode === 'clock' ? 'offset' : 'clock';
      saveState();
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
    // Agent strip: ArrowLeft/ArrowRight walks the horizontal strip, matching
    // VS Code's native list idiom (selection follows focus).
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
      '.wf-openconv, .wf-view-chip, .wf-zone-collapse, .wf-agent-pill, '
      + '.wf-facet-kind, .wf-facet-time, .wf-facet-foldall, .wf-log-row, .wf-rstrip-head, '
      + '.wf-log-action, .wf-rstrip-chip.clickable, .wf-jump-latest',
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
      existing.entries.push(...delta);
      existing.suffix = suffix.slice();
      existing.evidence = evidence;
      existing.mismatches = mismatches.slice();
      // Log rows (timestamps, facet counts, the terminal RESULT row) are cheap
      // enough to fully rebuild — no append fast-path needed.
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
})();
