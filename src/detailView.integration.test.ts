/**
 * @vitest-environment jsdom
 *
 * Structural DOM tests for the detail-panel webview frontend (detailView.ts →
 * media/detailView.js). Covers the agent-list collapse behaviour and the
 * source-grouped switcher. Does NOT test CSS layout/animation (jsdom has no
 * layout engine) — only the DOM structure and class toggling the CSS keys off.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let postedMessages: unknown[] = [];
/** Webview state store backing getState/setState — survives vi.resetModules()
 *  within a test, mirroring how VS Code persists state across webview rebuilds. */
let webviewState: unknown = undefined;
const mockVscodeApi = {
  postMessage: (msg: unknown) => { postedMessages.push(msg); },
  getState: () => webviewState,
  setState: (s: unknown) => { webviewState = s; },
};
(globalThis as any).acquireVsCodeApi = () => mockVscodeApi;

interface Agent { agentId: string; label: string; status: string; tokens?: number; toolCalls?: number; durationMs?: number | null; model?: string; phaseTitle?: string | null; }
function agent(a: Partial<Agent> & { agentId: string; label: string }): Agent {
  return { status: 'done', tokens: 0, toolCalls: 0, durationMs: null, model: '', ...a };
}

function sendRender(model: Record<string, unknown>, select?: { groupKey: string; agentId: string }): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', model, select } }));
}

/** Phase 1's additive TranscriptEntry fields (kind/toolName/rawInput/
 *  rawOutput/isError) are optional so every pre-existing call site (plain
 *  {timestamp,role,content}) keeps compiling unchanged; the log-view tests
 *  below opt into them. */
interface RawEntry {
  timestamp: string; role: string; content: string;
  kind?: string; toolName?: string; rawInput?: string; rawOutput?: string; isError?: boolean;
}

/** Phase 3's host-computed Result-strip payload (detailShared.ts's Evidence/
 *  Mismatch wire shapes). Optional on both send helpers so every pre-existing
 *  call site (which never set these) keeps compiling and rendering exactly
 *  as before — the strip is absent whenever evidence is omitted, matching
 *  detailPanel.ts's own default of `null`/`[]` for a message with none. */
interface RawFileTouch { path: string; kind: 'edit' | 'write' | 'notebook'; approxAdded: number | null; approxRemoved: number | null }
interface RawCommandRun { command: string; exitOk: boolean | null }
interface RawEvidence { filesTouched: RawFileTouch[]; commandsRun: RawCommandRun[]; testsRun: boolean; finalMessage: string | null }
interface RawMismatch { kind: string; message: string }

function sendTranscript(
  key: string, entries: RawEntry[], suffix: RawEntry[] = [],
  evidence?: RawEvidence, mismatches?: RawMismatch[],
): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'agentTranscript', key, entries, suffix, evidence, mismatches } }));
}

function sendTranscriptAppend(
  key: string, entries: RawEntry[], suffix: RawEntry[] = [],
  evidence?: RawEvidence, mismatches?: RawMismatch[],
): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'agentTranscriptAppend', key, entries, suffix, evidence, mismatches } }));
}

/** An empty Evidence — the fixture for "no tool activity yet" tests. */
function emptyEvidence(overrides: Partial<RawEvidence> = {}): RawEvidence {
  return { filesTouched: [], commandsRun: [], testsRun: false, finalMessage: null, ...overrides };
}

const root = () => document.getElementById('wf-root')!;
const q = (sel: string) => root().querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(root().querySelectorAll(sel)) as HTMLElement[];

/** A two-source workflow drill-in: one Audit phase with two agents, plus a
 *  Subagents view — so the switcher has both a `workflow` and `subagents` kind. */
function twoSourceModel() {
  return {
    source: 'workflow',
    containerId: 'wf_run1',
    sessionId: 'sess1',
    title: 'audit-run',
    metrics: '4 agents',
    groups: [
      {
        key: 'wf_run1',
        title: 'Audit',
        status: 'running',
        agents: [
          agent({ agentId: 'agent001', label: 'audit:privacy', phaseTitle: 'Audit' }),
          agent({ agentId: 'agent002', label: 'audit:security', status: 'running', phaseTitle: 'Audit' }),
        ],
      },
    ],
    views: [
      { id: 'wf_run1', kind: 'workflow', label: 'audit-run', status: 'running', active: true },
      { id: 'subs', kind: 'subagents', label: 'Subagents', status: 'done', active: false },
    ],
  };
}

describe('detailView.ts — collapse + grouped switcher', () => {
  beforeEach(async () => {
    postedMessages = [];
    // Existing assertions below target the CLASSIC DOM; the log view (Phase
    // 2, DESIGN-DETAIL-PANE-V2.md) is the new default, so seed persisted state
    // to keep every pre-existing test exercising the classic renderer.
    webviewState = { mode: 'classic' };
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
  });

  it('nav rows carry status in title/aria-label, aria-current on the active row (UX-2)', () => {
    sendRender(twoSourceModel());
    const active = q('.wf-nav-row.active')!;
    expect(active.getAttribute('title')).toBe('audit:privacy · done');
    expect(active.getAttribute('aria-label')).toBe('audit:privacy · done');
    expect(active.getAttribute('aria-current')).toBe('true');
    const other = qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!;
    expect(other.getAttribute('title')).toBe('audit:security · running');
    expect(other.hasAttribute('aria-current')).toBe(false);
  });

  it('phase header surfaces a failed count (UX-4)', () => {
    const model = twoSourceModel() as any;
    model.groups[0].agents.push(agent({ agentId: 'agent003', label: 'audit:perf', status: 'failed', phaseTitle: 'Audit' }));
    sendRender(model);
    const count = q('.wf-nav-count')!;
    expect(count.textContent).toContain('1/3');
    expect(q('.wf-nav-count-failed')!.textContent).toBe('1 failed');
  });

  it('reader meta omits "0 tools" for untracked agents, keeps a real count (UX-5)', () => {
    const model = twoSourceModel() as any;
    model.groups[0].agents[1] = agent({ agentId: 'agent002', label: 'audit:security', status: 'running', phaseTitle: 'Audit', toolCalls: 7 });
    sendRender(model);
    // agent001 (toolCalls 0) auto-selected: no fabricated zero.
    expect(q('.wf-reader-meta')!.textContent).not.toContain('tools');
    qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!.click();
    expect(q('.wf-reader-meta')!.textContent).toContain('7 tools');
  });

  it('shows the model in the nav row and reader meta, formatted from the raw id', () => {
    const model = twoSourceModel() as any;
    model.groups[0].agents[0] = agent({ agentId: 'agent001', label: 'audit:privacy', phaseTitle: 'Audit', model: 'claude-sonnet-5' });
    model.groups[0].agents[1] = agent({ agentId: 'agent002', label: 'audit:security', status: 'running', phaseTitle: 'Audit', model: 'claude-opus-4-8[1m]' });
    sendRender(model);
    const row1 = qa('.wf-nav-row').find(r => r.dataset.agent === 'agent001')!;
    expect(row1.querySelector('.wf-nav-model')!.textContent).toBe('Sonnet 5');
    // The model rides in title/aria-label like status (survives truncation).
    expect(row1.getAttribute('title')).toBe('audit:privacy · done · Sonnet 5');
    // agent001 auto-selected: the reader meta carries the formatted label too.
    expect(q('.wf-reader-meta')!.textContent).toContain('Sonnet 5');
    // The [1m] context-window suffix is stripped, not shown raw.
    const row2 = qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!;
    expect(row2.querySelector('.wf-nav-model')!.textContent).toBe('Opus 4.8');
  });

  it('omits the nav model span when the model is unknown', () => {
    sendRender(twoSourceModel()); // fixture default: model ''
    expect(q('.wf-nav-model')).toBeNull();
    expect(q('.wf-reader-meta')!.textContent).not.toContain('Opus');
  });

  it('reader head shows the live tool line for a running agent only (UX-1)', () => {
    const model = twoSourceModel() as any;
    model.groups[0].agents[1] = {
      ...agent({ agentId: 'agent002', label: 'audit:security', status: 'running', phaseTitle: 'Audit' }),
      lastToolName: 'Grep', lastToolSummary: 'pattern="eval(" path=src/',
    };
    sendRender(model);
    // Done agent selected: no live line.
    expect(q('.wf-reader-live')).toBeNull();
    qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!.click();
    const live = q('.wf-reader-live')!;
    expect(live.textContent).toContain('Grep');
    expect(live.textContent).toContain('pattern="eval(" path=src/');
  });

  it('toggle carries the aggregate rail dot classed by the worst-case roll-up (UX-6)', () => {
    sendRender(twoSourceModel());
    // One running agent → aggregate is running.
    const dot = q('.wf-nav-toggle .wf-rail-dot')!;
    expect(dot.classList.contains('running')).toBe(true);

    // Collapse is purely a class flip; the dot element survives untouched.
    q('.wf-nav-toggle')!.click();
    expect(root().classList.contains('nav-collapsed')).toBe(true);
    expect(q('.wf-nav-toggle .wf-rail-dot')).toBe(dot);

    // All-done model → dot rolls up to done on the next render.
    const model = twoSourceModel() as any;
    model.groups[0].agents = model.groups[0].agents.map((a: any) => ({ ...a, status: 'done' }));
    sendRender(model);
    expect(q('.wf-nav-toggle .wf-rail-dot')!.classList.contains('done')).toBe(true);
  });

  it('roster uses a roving tabindex: active row 0, the rest -1 (UX-3)', () => {
    sendRender(twoSourceModel());
    const rows = qa('.wf-nav-row');
    expect(rows.find(r => r.classList.contains('active'))!.getAttribute('tabindex')).toBe('0');
    expect(rows.filter(r => !r.classList.contains('active')).every(r => r.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('ArrowDown/ArrowUp move selection and focus through the roster (UX-3)', () => {
    sendRender(twoSourceModel());
    const first = qa('.wf-nav-row').find(r => r.dataset.agent === 'agent001')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(q('.wf-nav-row.active')!.dataset.agent).toBe('agent002');
    expect((document.activeElement as HTMLElement).dataset.agent).toBe('agent002');

    // Down past the last row is a no-op…
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(q('.wf-nav-row.active')!.dataset.agent).toBe('agent002');

    // …and Up walks back.
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(q('.wf-nav-row.active')!.dataset.agent).toBe('agent001');
    expect((document.activeElement as HTMLElement).dataset.agent).toBe('agent001');
  });

  it('keyboard focus survives a model-push re-render (UX-3)', () => {
    sendRender(twoSourceModel());
    const row = qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!;
    row.focus();
    expect(document.activeElement).toBe(row);

    // A model push rebuilds #wf-root — focus must land on the NEW row element.
    sendRender(twoSourceModel());
    const after = document.activeElement as HTMLElement;
    expect(after).not.toBe(row);
    expect(after.classList.contains('wf-nav-row')).toBe(true);
    expect(after.dataset.agent).toBe('agent002');
  });

  it('focus on the nav toggle survives a re-render too (UX-3)', () => {
    sendRender(twoSourceModel());
    (q('.wf-nav-toggle') as HTMLElement).focus();
    sendRender(twoSourceModel());
    expect((document.activeElement as HTMLElement).classList.contains('wf-nav-toggle')).toBe(true);
  });

  it('agentTranscriptAppend appends turn nodes without rebuilding the reader (PR 6b)', () => {
    sendRender(twoSourceModel());
    const KEY = 'workflow:wf_run1|wf_run1|agent001';
    sendTranscript(KEY, [
      { timestamp: 't1', role: 'user', content: 'the brief' },
      { timestamp: 't2', role: 'assistant', content: 'first reply' },
    ]);
    const firstTurn = q('.wf-turn.assistant')!;
    const body = q('.wf-reader-body')!;

    sendTranscriptAppend(KEY, [{ timestamp: 't3', role: 'assistant', content: 'second reply' }]);

    // Same DOM nodes — no innerHTML rebuild — with the new turn appended after.
    expect(q('.wf-reader-body')).toBe(body);
    expect(q('.wf-turn.assistant')).toBe(firstTurn);
    const turns = qa('.wf-turn.assistant');
    expect(turns).toHaveLength(2);
    expect(turns[1].textContent).toContain('second reply');
  });

  it('append replaces the inbox suffix wholesale (it can shrink)', () => {
    sendRender(twoSourceModel());
    const KEY = 'workflow:wf_run1|wf_run1|agent001';
    sendTranscript(KEY, [
      { timestamp: 't1', role: 'user', content: 'the brief' },
      { timestamp: 't2', role: 'assistant', content: 'reply' },
    ], [{ timestamp: 'q1', role: 'system', content: 'Queued for delivery (from murray): hello' }]);
    expect(q('.wf-suffix')!.textContent).toContain('hello');

    // Teammate drained its inbox: empty suffix, no new entries.
    sendTranscriptAppend(KEY, [], []);
    expect(q('.wf-suffix')).toBeNull();
    // The real turns survive untouched.
    expect(qa('.wf-turn.assistant')).toHaveLength(1);
  });

  it('falls back to a full render when the first user entry arrives in a delta (brief pin-out)', () => {
    sendRender(twoSourceModel());
    const KEY = 'workflow:wf_run1|wf_run1|agent001';
    // No user entry yet — the brief is the promptPreview fallback (none here).
    sendTranscript(KEY, [{ timestamp: 't1', role: 'assistant', content: 'working' }]);
    expect(q('.wf-brief')).toBeNull();

    sendTranscriptAppend(KEY, [{ timestamp: 't2', role: 'user', content: 'late brief' }]);
    // Structure changed: the user entry is pinned out as the brief.
    expect(q('.wf-brief')!.textContent).toContain('Inception brief');
    expect(q('.wf-brief-body')!.textContent).toContain('late brief');
  });

  it('re-requests a full snapshot when an append arrives with no cached anchor', () => {
    sendRender(twoSourceModel());
    postedMessages.length = 0;
    // Selected key (agent001 auto-selected) but the cache holds only 'loading'.
    sendTranscriptAppend('workflow:wf_run1|wf_run1|agent001', [{ timestamp: 't', role: 'assistant', content: 'x' }]);
    const req = postedMessages.find(m => (m as { type?: string }).type === 'viewAgent') as { full?: boolean } | undefined;
    expect(req).toBeTruthy();
    expect(req!.full).toBe(true);
  });

  it('does NOT collapse the agent list when selecting an agent (click-through stays open)', () => {
    sendRender(twoSourceModel());
    // First agent auto-selected; list is expanded.
    expect(root().classList.contains('nav-collapsed')).toBe(false);
    expect(q('.wf-nav-row.active')!.dataset.agent).toBe('agent001');

    // Click the second row — selection moves, but the list must stay expanded.
    qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!.click();
    expect(root().classList.contains('nav-collapsed')).toBe(false);
    expect(q('.wf-nav-row.active')!.dataset.agent).toBe('agent002');
  });

  it('collapses/expands via the toggle by mutating the persistent root (no element rebuild)', () => {
    sendRender(twoSourceModel());
    const navBefore = q('.wf-nav');
    expect(root().classList.contains('nav-collapsed')).toBe(false);

    q('.wf-nav-toggle')!.click();
    expect(root().classList.contains('nav-collapsed')).toBe(true);
    // Same .wf-nav node — the toggle animates it, it is not re-rendered.
    expect(q('.wf-nav')).toBe(navBefore);
    // The roster is still in the DOM (CSS clips/fades it), so a width
    // transition has content to slide over.
    expect(qa('.wf-nav-row').length).toBe(2);

    q('.wf-nav-toggle')!.click();
    expect(root().classList.contains('nav-collapsed')).toBe(false);
    expect(q('.wf-nav')).toBe(navBefore);
  });

  it('groups the switcher by source when more than one kind is present', () => {
    sendRender(twoSourceModel());
    const sw = q('.wf-switch')!;
    expect(sw.classList.contains('grouped')).toBe(true);
    const labels = qa('.wf-switch-group-label').map(e => e.textContent);
    expect(labels).toEqual(['Workflow', 'Subagents']);
    // Chips live inside their group's chip row, not intermixed.
    const groups = qa('.wf-switch-group');
    expect(groups[0].querySelectorAll('.wf-switch-chip').length).toBe(1);
    expect(groups[1].querySelectorAll('.wf-switch-chip').length).toBe(1);
  });

  it('renders a flat (ungrouped) switcher for a single-source view', () => {
    const m = twoSourceModel();
    (m as any).views = [{ id: 'wf_run1', kind: 'workflow', label: 'audit-run', status: 'running', active: true }];
    sendRender(m);
    const sw = q('.wf-switch')!;
    expect(sw.classList.contains('grouped')).toBe(false);
    expect(qa('.wf-switch-group').length).toBe(0);
    expect(qa('.wf-switch-chip').length).toBe(1);
  });

  it('pluralises the workflow group label when several runs are switchable', () => {
    const m = twoSourceModel();
    (m as any).views = [
      { id: 'wf_run1', kind: 'workflow', label: 'run one', status: 'running', active: true },
      { id: 'wf_run2', kind: 'workflow', label: 'run two', status: 'done', active: false },
      { id: 'subs', kind: 'subagents', label: 'Subagents', status: 'done', active: false },
    ];
    sendRender(m);
    expect(qa('.wf-switch-group-label').map(e => e.textContent)).toEqual(['Workflows', 'Subagents']);
  });

  it('synthesises a single flat team chip for the team source', () => {
    sendRender({
      source: 'team',
      containerId: 'at:squad',
      sessionId: 'sess1',
      title: 'squad',
      metrics: '',
      team: 'squad',
      groups: [{ key: '', title: null, status: null, agents: [agent({ agentId: 'memberxx', label: 'defender' })] }],
    });
    const sw = q('.wf-switch')!;
    expect(sw.classList.contains('grouped')).toBe(false);
    expect(qa('.wf-switch-chip').length).toBe(1);
    expect(q('.wf-switch-chip-label')!.textContent).toBe('squad');
  });

  describe('transcript timestamps', () => {
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

    it('labels turns relative when recent and absolute when old, with the full time on hover', () => {
      sendRender(twoSourceModel()); // auto-selects agent001 (group wf_run1)
      sendTranscript('workflow:wf_run1|wf_run1|agent001', [
        { timestamp: iso(5 * 60 * 1000), role: 'user', content: 'the inception brief' },        // → brief head
        { timestamp: iso(3 * 60 * 1000), role: 'assistant', content: 'a recent reply' },          // → "3m ago"
        { timestamp: iso(3 * 24 * 60 * 60 * 1000), role: 'assistant', content: 'an old reply' },  // → a date
      ]);
      const turnTimes = qa('.wf-turn .wf-turn-time');
      expect(turnTimes.length).toBe(2);
      const texts = turnTimes.map(e => e.textContent || '');
      expect(texts.some(t => /ago|just now/.test(t))).toBe(true);   // the recent turn
      expect(texts.some(t => !/ago|just now/.test(t) && t.length > 0)).toBe(true); // the old turn → a date
      // Every time label carries the full absolute time on hover.
      for (const e of qa('.wf-turn-time')) { expect((e.getAttribute('title') || '').length).toBeGreaterThan(0); }
      // The inception brief head is stamped too.
      expect(q('.wf-brief-head .wf-turn-time')).not.toBeNull();
    });

    it('omits the time label when a record has no (parseable) timestamp', () => {
      sendRender(twoSourceModel());
      sendTranscript('workflow:wf_run1|wf_run1|agent001', [
        { timestamp: '', role: 'assistant', content: 'no timestamp here' },
        { timestamp: 'not-a-date', role: 'assistant', content: 'bad timestamp here' },
      ]);
      expect(qa('.wf-turn .wf-turn-time').length).toBe(0);
    });
  });

  describe('transcript turn labels', () => {
    it('labels a tool-role entry "tool result", never "prompt"', () => {
      sendRender(twoSourceModel());
      sendTranscript('workflow:wf_run1|wf_run1|agent001', [
        { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the inception brief' },
        { timestamp: '2026-06-10T10:00:05Z', role: 'tool', content: '> **Tool result** (toolu_abc...): grep output' },
      ]);
      const turn = q('.wf-turn.tool');
      expect(turn).not.toBeNull();
      expect(turn!.querySelector('.wf-who')!.textContent).toContain('tool result');
      // The tool turn must not pick up the prompt accent class.
      expect(turn!.classList.contains('prompt')).toBe(false);
    });

    it('does not pin a tool-role entry as the inception brief', () => {
      sendRender(twoSourceModel());
      sendTranscript('workflow:wf_run1|wf_run1|agent001', [
        { timestamp: '2026-06-10T10:00:00Z', role: 'tool', content: '> **Tool result** (toolu_abc...): early result' },
        { timestamp: '2026-06-10T10:00:05Z', role: 'user', content: 'the real brief' },
      ]);
      expect(q('.wf-brief-body')!.textContent).toContain('the real brief');
    });
  });
});

describe('detailView.ts — live transcript refresh', () => {
  beforeEach(async () => {
    postedMessages = [];
    // Existing assertions below target the CLASSIC DOM; the log view (Phase
    // 2, DESIGN-DETAIL-PANE-V2.md) is the new default, so seed persisted state
    // to keep every pre-existing test exercising the classic renderer.
    webviewState = { mode: 'classic' };
    vi.useFakeTimers();              // fake before the IIFE import so its setInterval is faked
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
  });
  afterEach(() => { vi.useRealTimers(); });

  const viewAgentMsgs = (id: string) =>
    (postedMessages as any[]).filter(m => m.type === 'viewAgent' && m.agentId === id);

  it('re-requests a running agent’s transcript on the steady interval', () => {
    sendRender(twoSourceModel()); // agent001 done (auto-selected), agent002 running
    qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!.click(); // select the running one
    postedMessages.length = 0;     // drop the select's own viewAgent
    vi.advanceTimersByTime(2600);  // > STEADY_REFRESH_MS
    expect(viewAgentMsgs('agent002').length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT refresh a terminal (done) agent', () => {
    sendRender(twoSourceModel()); // auto-selects agent001 (done)
    postedMessages.length = 0;
    vi.advanceTimersByTime(5200);  // two ticks
    expect((postedMessages as any[]).filter(m => m.type === 'viewAgent').length).toBe(0);
  });

  it('DOES refresh an alive idle teammate (it can wake on an inbox message any moment)', () => {
    sendRender({
      source: 'subagents', containerId: 'lead-001', sessionId: 'sess1',
      title: 'Teammates', metrics: '', team: 'my-team',
      groups: [{ key: '', title: null, status: null, agents: [
        { agentId: 'deadbeef', label: 'lyrebird', status: 'done',
          tokens: 0, toolCalls: 0, durationMs: null, model: '', teammate: true, alive: true },
      ] }],
    });
    postedMessages.length = 0;
    vi.advanceTimersByTime(2600);
    expect(viewAgentMsgs('deadbeef').length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT refresh a teammate that has left the team (alive false)', () => {
    sendRender({
      source: 'subagents', containerId: 'lead-001', sessionId: 'sess1',
      title: 'Teammates', metrics: '', team: 'my-team',
      groups: [{ key: '', title: null, status: null, agents: [
        { agentId: 'deadbeef', label: 'lyrebird', status: 'done',
          tokens: 0, toolCalls: 0, durationMs: null, model: '', teammate: true, alive: false },
      ] }],
    });
    postedMessages.length = 0;
    vi.advanceTimersByTime(5200);
    expect(viewAgentMsgs('deadbeef').length).toBe(0);
  });

  it('pauses refreshing while the panel is hidden', () => {
    sendRender(twoSourceModel());
    qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!.click();
    postedMessages.length = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    vi.advanceTimersByTime(5200);
    expect(viewAgentMsgs('agent002').length).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
});

describe('detailView.ts — teammate composer (experimental)', () => {
  // getHtml ships the composer as a sibling OUTSIDE #wf-root; mirror that here so
  // the webview's getElementById('wf-composer') resolves.
  const COMPOSER_HTML =
    '<div id="wf-composer" hidden>'
    + '<div class="wf-composer-disclosure"></div>'
    + '<div class="wf-composer-row">'
    + '<textarea id="wf-composer-input" maxlength="8000"></textarea>'
    + '<button id="wf-composer-send" type="button">Send</button></div>'
    + '<div class="wf-composer-foot"><span id="wf-composer-status"></span><span id="wf-composer-count"></span></div>'
    + '</div>';

  function sendSettings(exp: { teammateMessaging?: boolean; operatorName?: string }): void {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'settings', experimental: exp } }));
  }
  function sendReply(ok: boolean, error?: string): void {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'teammateMessageSent', ok, error } }));
  }
  const composer = () => document.getElementById('wf-composer') as HTMLElement;
  const cInput = () => document.getElementById('wf-composer-input') as HTMLTextAreaElement;
  const cSend = () => document.getElementById('wf-composer-send') as HTMLButtonElement;
  const cStatus = () => document.getElementById('wf-composer-status') as HTMLElement;

  /** A subagents drill-in with one live in-process teammate. */
  function teammateModel(over: Partial<{ status: string; teammate: boolean; alive: boolean }> = {}) {
    return {
      source: 'subagents', containerId: 'lead-001', sessionId: 'sess1',
      title: 'Teammates', metrics: '1 teammate', team: 'my-team',
      groups: [{ key: '', title: null, status: null, agents: [
        { agentId: 'deadbeef', label: 'defender', status: over.status ?? 'running',
          tokens: 0, toolCalls: 0, durationMs: null, model: '',
          teammate: over.teammate ?? true, alive: over.alive ?? true },
      ] }],
      views: [{ id: 'subagents', kind: 'subagents', label: 'Teammates', status: 'running', active: true }],
    };
  }

  beforeEach(async () => {
    postedMessages = [];
    // Existing assertions below target the CLASSIC DOM; the log view (Phase
    // 2, DESIGN-DETAIL-PANE-V2.md) is the new default, so seed persisted state
    // to keep every pre-existing test exercising the classic renderer.
    webviewState = { mode: 'classic' };
    document.body.innerHTML = '<div id="wf-root"></div>' + COMPOSER_HTML;
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
  });

  it('stays hidden while the flag is off', () => {
    sendRender(teammateModel());
    expect(composer().hidden).toBe(true);
  });

  it('shows for a live teammate once the flag is on, and marks body.composer-open', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    expect(composer().hidden).toBe(false);
    expect(document.body.classList.contains('composer-open')).toBe(true);
  });

  it('shows for an IDLE teammate (status done) that is still alive — liveness, not status, gates', () => {
    // An in-process teammate idling between messages reads done to Task
    // tracking but is alive and listening on its inbox (the aviary case).
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel({ status: 'done' }));
    expect(composer().hidden).toBe(false);
  });

  it('stays hidden for a teammate that has left the team (alive false) even with the flag on', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel({ alive: false }));
    expect(composer().hidden).toBe(true);
  });

  it('stays hidden when the host omits alive (fail closed)', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    const m = teammateModel();
    delete (m.groups[0].agents[0] as Record<string, unknown>).alive;
    sendRender(m);
    expect(composer().hidden).toBe(true);
  });

  it('stays hidden for a plain (non-teammate) subagent', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel({ teammate: false }));
    expect(composer().hidden).toBe(true);
  });

  it('sends the message (no webview-supplied `from`) and optimistically clears the draft', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    cInput().value = 'please re-run the failing test';
    cSend().click();
    const sent = (postedMessages as any[]).find(m => m.type === 'sendTeammateMessage');
    expect(sent).toMatchObject({ source: 'subagents', containerId: 'lead-001', agentId: 'deadbeef', text: 'please re-run the failing test' });
    expect(sent).not.toHaveProperty('from');     // host synthesizes the sender
    expect(cInput().value).toBe('');             // optimistic clear
    expect(cStatus().textContent || '').toMatch(/sending/i);
  });

  it('strips invisible/bidi characters from the draft on input', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    cInput().value = 'safe​‮text';     // zero-width space + RLO
    cInput().dispatchEvent(new Event('input'));
    expect(cInput().value).toBe('safetext');
  });

  it('clears the draft when the selection moves to a different teammate', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    const m = teammateModel();
    (m.groups[0].agents as any[]).push({
      agentId: 'cafef00d', label: 'skeptic', status: 'running',
      tokens: 0, toolCalls: 0, durationMs: null, model: '', teammate: true, alive: true,
    });
    sendRender(m, { groupKey: '', agentId: 'deadbeef' });
    cInput().value = 'meant for defender only';
    sendRender(m, { groupKey: '', agentId: 'cafef00d' }); // switch teammates
    expect(cInput().value).toBe(''); // draft must not follow the selection
  });

  it('does not restore a failed send into a DIFFERENT teammate\'s composer', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    const m = teammateModel();
    (m.groups[0].agents as any[]).push({
      agentId: 'cafef00d', label: 'skeptic', status: 'running',
      tokens: 0, toolCalls: 0, durationMs: null, model: '', teammate: true, alive: true,
    });
    sendRender(m, { groupKey: '', agentId: 'deadbeef' });
    cInput().value = 'for defender';
    cSend().click();
    sendRender(m, { groupKey: '', agentId: 'cafef00d' }); // switch mid-flight
    sendReply(false, 'send failed');
    expect(cInput().value).toBe(''); // defender's draft must not land in skeptic's box
    expect(cSend().disabled).toBe(false); // button still released
  });

  it('sends on a bare Enter (chat-style)', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    cInput().value = 'quick ping';
    cInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const sent = (postedMessages as any[]).find(m => m.type === 'sendTeammateMessage');
    expect(sent).toMatchObject({ text: 'quick ping' });
  });

  it('Shift+Enter does NOT send (newline stays a newline)', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    cInput().value = 'line one';
    cInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect((postedMessages as any[]).filter(m => m.type === 'sendTeammateMessage')).toHaveLength(0);
    expect(cInput().value).toBe('line one'); // draft untouched
  });

  it('Enter mid-IME-composition does NOT send', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    cInput().value = 'にほんご';
    cInput().dispatchEvent(new CompositionEvent('compositionstart'));
    cInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect((postedMessages as any[]).filter(m => m.type === 'sendTeammateMessage')).toHaveLength(0);
  });

  it('ignores Cmd+Enter while a send is already in flight', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    cInput().value = 'first';
    cSend().click();
    cInput().value = 'second attempt mid-flight';
    cInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    const sends = (postedMessages as any[]).filter(m => m.type === 'sendTeammateMessage');
    expect(sends).toHaveLength(1); // the keyboard path honours the in-flight guard
    expect(cInput().value).toBe('second attempt mid-flight'); // draft untouched
  });

  it('restores the cleared draft and surfaces the error when the host rejects the send', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    cInput().value = 'draft to keep';
    cSend().click();
    expect(cInput().value).toBe('');
    sendReply(false, 'inbox file is a symlink');
    expect(cInput().value).toBe('draft to keep'); // not lost
    expect(cStatus().textContent).toContain('inbox file is a symlink');
    expect(cStatus().classList.contains('error')).toBe(true);
    expect(cSend().disabled).toBe(false);
  });
});

describe('detailView.ts — UX batch (dedup, persistence, time tick, chip summary)', () => {
  beforeEach(async () => {
    postedMessages = [];
    // Existing assertions below target the CLASSIC DOM; the log view (Phase
    // 2, DESIGN-DETAIL-PANE-V2.md) is the new default, so seed persisted state
    // to keep every pre-existing test exercising the classic renderer.
    webviewState = { mode: 'classic' };
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
  });

  const KEY = 'workflow:wf_run1|wf_run1|agent001';
  const T1 = [
    { timestamp: '2026-06-10T01:00:00Z', role: 'user', content: 'brief' },
    { timestamp: '2026-06-10T01:00:05Z', role: 'assistant', content: 'first reply' },
  ];

  it('an identical steady-tick transcript does NOT re-render (text selection survives)', () => {
    sendRender(twoSourceModel());
    sendTranscript(KEY, T1);
    const readerBefore = q('.wf-reader');
    expect(readerBefore).not.toBeNull();
    sendTranscript(KEY, [...T1.map(e => ({ ...e }))]); // same content, fresh objects
    expect(q('.wf-reader')).toBe(readerBefore); // same node — no innerHTML swap
  });

  it('a grown transcript still re-renders with the new turn', () => {
    sendRender(twoSourceModel());
    sendTranscript(KEY, T1);
    const readerBefore = q('.wf-reader');
    sendTranscript(KEY, [...T1, { timestamp: '2026-06-10T01:00:10Z', role: 'assistant', content: 'second reply' }]);
    expect(q('.wf-reader')).not.toBe(readerBefore);
    expect(root().textContent).toContain('second reply');
  });

  it('an in-place grown last turn (streaming) also re-renders', () => {
    sendRender(twoSourceModel());
    sendTranscript(KEY, T1);
    sendTranscript(KEY, [T1[0], { ...T1[1], content: 'first reply — now longer' }]);
    expect(root().textContent).toContain('now longer');
  });

  it('persists selection and restores it across a webview rebuild (same drill-in)', async () => {
    sendRender(twoSourceModel());
    qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!.click();
    expect((webviewState as { agentId?: string }).agentId).toBe('agent002');

    // Rebuild: fresh module + DOM, but the SAME persisted state (VS Code keeps it).
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    await import('./detailView.js');
    sendRender(twoSourceModel());
    expect(q('.wf-nav-row.active')!.dataset.agent).toBe('agent002');
  });

  it('does NOT restore selection into a different drill-in (falls back to first agent)', async () => {
    sendRender(twoSourceModel());
    qa('.wf-nav-row').find(r => r.dataset.agent === 'agent002')!.click();

    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    await import('./detailView.js');
    const other = { ...twoSourceModel(), containerId: 'wf_run2' };
    other.groups = [{ ...other.groups[0], key: 'wf_run2' }];
    sendRender(other);
    expect(q('.wf-nav-row.active')!.dataset.agent).toBe('agent001');
  });

  it('persists and restores navCollapsed across a rebuild', async () => {
    sendRender(twoSourceModel());
    q('.wf-nav-toggle')!.click();
    expect(root().classList.contains('nav-collapsed')).toBe(true);

    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    await import('./detailView.js');
    sendRender(twoSourceModel());
    expect(root().classList.contains('nav-collapsed')).toBe(true);
  });

  it('time spans carry data-t so the slow tick can refresh them in place', () => {
    sendRender(twoSourceModel());
    sendTranscript(KEY, T1);
    const span = q('.wf-turn-time[data-t]');
    expect(span).not.toBeNull();
    expect(Number(span!.getAttribute('data-t'))).toBe(Date.parse(T1[0].timestamp));
  });

  it('chip tooltip includes the host-computed roll-up summary', () => {
    const model = twoSourceModel();
    (model.views[0] as Record<string, unknown>).summary = '2 agents · 1 running · 1 done';
    sendRender(model);
    const chip = qa('.wf-switch-chip').find(c => c.dataset.viewId === 'wf_run1')!;
    expect(chip.getAttribute('title')).toContain('2 agents · 1 running · 1 done');
  });
});

describe('detailView.ts — log view (Phase 2, default mode)', () => {
  // No mode override here (unlike the classic-DOM blocks above): log is the
  // DEFAULT, so these tests exercise it with a fresh, unpersisted webview.
  beforeEach(async () => {
    postedMessages = [];
    webviewState = undefined;
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
  });

  /** A workflow drill-in with three switchable views (for the view-row
   *  collapse test) and two phase agents (for the agent strip). */
  function logModel() {
    return {
      source: 'workflow',
      containerId: 'wf_run1',
      sessionId: 'sess1',
      title: 'audit-run',
      metrics: '2 agents',
      groups: [
        {
          key: 'wf_run1',
          title: 'Audit',
          agents: [
            agent({ agentId: 'agent001', label: 'audit:privacy', phaseTitle: 'Audit' }),
            agent({ agentId: 'agent002', label: 'audit:security', status: 'running', phaseTitle: 'Audit' }),
          ],
        },
      ],
      views: [
        { id: 'wf_run1', kind: 'workflow', label: 'audit-run', status: 'running', active: true, summary: '2 agents · 1 running · 1 done' },
        { id: 'subs', kind: 'subagents', label: 'Subagents', status: 'done', active: false, summary: '3 subagents' },
        { id: 'wf_run2', kind: 'workflow', label: 'earlier-run', status: 'waiting', active: false, summary: '1 agent · 1 waiting' },
      ],
    };
  }

  /** One agent, status 'waiting', carrying the live-tool fields the pinned
   *  permission row reads. Built as a raw literal (not via the `agent()`
   *  helper, whose local `Agent` type omits lastToolName/lastToolSummary —
   *  same pattern the composer describe block above uses). */
  function waitingModel() {
    return {
      source: 'workflow', containerId: 'wf_run1', sessionId: 'sess1', title: 'audit-run', metrics: '',
      groups: [{
        key: 'wf_run1', title: null,
        agents: [{
          agentId: 'agent001', label: 'research-agent', status: 'waiting',
          tokens: 0, toolCalls: 0, durationMs: null, model: '',
          lastToolName: 'Bash', lastToolSummary: 'rm -rf build/',
        }],
      }],
    };
  }

  const KEY1 = 'workflow:wf_run1|wf_run1|agent001';

  it('view row renders chips with counts and collapse/overflow behaviour', () => {
    sendRender(logModel());
    const chips = qa('.wf-view-chip');
    expect(chips.length).toBe(3); // expanded by default — nothing folded yet
    const active = chips.find(c => c.classList.contains('active'))!;
    expect(active.querySelector('.wf-view-count')!.textContent).toBe('2');

    // Collapse: the active chip and the WAITING one are kept; the DONE,
    // non-active one folds into a "+1" overflow chip.
    q('.wf-view-collapse')!.click();
    const collapsedIds = qa('.wf-view-chip').map(c => c.dataset.viewId);
    expect(collapsedIds).toContain('wf_run1');
    expect(collapsedIds).toContain('wf_run2');
    expect(collapsedIds).not.toContain('subs');
    const more = q('.wf-view-chip.more')!;
    expect(more.textContent).toContain('+1');

    // The overflow chip re-expands the row.
    more.click();
    expect(qa('.wf-view-chip').length).toBe(3);
  });

  it('permission row appears for a waiting agent, survives kind filters, and is absent otherwise', () => {
    sendRender(waitingModel());
    const perm = q('.wf-permrow')!;
    expect(perm).not.toBeNull();
    expect(perm.textContent).toContain('research-agent');
    expect(perm.textContent).toContain('Bash');

    // Toggling a facet kind filter off must not touch the pinned row — it
    // isn't part of the filtered .wf-log region at all.
    q('.wf-facet-kind[data-kind="text"]')!.click();
    expect(q('.wf-permrow')).not.toBeNull();

    // No waiting agent anywhere in the model → no row.
    sendRender(logModel());
    expect(q('.wf-permrow')).toBeNull();
  });

  it('agent strip selection posts viewAgent and renders the selected agent\'s entries', () => {
    sendRender(logModel()); // agent001 auto-selected
    postedMessages.length = 0;
    qa('.wf-agent-pill').find(p => p.dataset.agent === 'agent002')!.click();
    const req = (postedMessages as any[]).find(m => m.type === 'viewAgent' && m.agentId === 'agent002');
    expect(req).toBeTruthy();
    expect(q('.wf-agent-pill.active')!.dataset.agent).toBe('agent002');

    sendTranscript('workflow:wf_run1|wf_run1|agent002', [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:05Z', role: 'assistant', content: 'reply text here', kind: 'text' },
    ]);
    expect(q('.wf-log')!.textContent).toContain('reply text here');
  });

  it('kind filters hide/show rows', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: 'some prose here', kind: 'text' },
      { timestamp: '2026-06-10T10:00:02Z', role: 'assistant', content: '> **Bash** rm -rf build/', kind: 'tool_use', toolName: 'Bash' },
    ]);
    expect(q('.wf-log')!.textContent).toContain('some prose here');
    expect(q('.wf-log')!.textContent).toContain('Bash');

    q('.wf-facet-kind[data-kind="text"]')!.click();
    expect(q('.wf-log')!.textContent).not.toContain('some prose here');
    expect(q('.wf-log')!.textContent).toContain('Bash'); // the tool row is a different bucket
  });

  it('search filters rows and highlights matches', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: 'alpha content line', kind: 'text' },
      { timestamp: '2026-06-10T10:00:02Z', role: 'assistant', content: 'beta content line', kind: 'text' },
    ]);
    const input = q('.wf-facet-search-input') as HTMLInputElement;
    input.value = 'alpha';
    // Delegated on #wf-root (like the click/keydown listeners) — a REAL
    // browser 'input' event bubbles by default; jsdom's Event constructor
    // does not unless told to.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(q('.wf-log')!.textContent).toContain('alpha');
    expect(q('.wf-log')!.textContent).not.toContain('beta content line');
    const hl = q('.wf-hl');
    expect(hl).not.toBeNull();
    expect(hl!.textContent!.toLowerCase()).toBe('alpha');
  });

  it('row expansion reveals rawInput/rawOutput in place and sets aria-expanded', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Edit** detailView.css',
        kind: 'tool_use', toolName: 'Edit', rawInput: '{"old_string":"a"}', rawOutput: 'Error: not unique',
      },
    ]);
    const row = qa('.wf-log-row').find(r => r.textContent!.includes('Edit'))!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(q('.wf-log-expand')).toBeNull();

    row.click();
    // The click rebuilds the DOM (render() → innerHTML) — re-query, don't
    // reuse the (now detached) `row` reference.
    const rowAfter = qa('.wf-log-row').find(r => r.textContent!.includes('Edit'))!;
    expect(rowAfter.getAttribute('aria-expanded')).toBe('true');
    const expand = q('.wf-log-expand')!;
    expect(expand.textContent).toContain('old_string');
    expect(expand.textContent).toContain('not unique');
  });

  it('error rows get the err class', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'tool', content: '> **Tool result**: boom', kind: 'tool_result', isError: true },
    ]);
    expect(qa('.wf-log-row.err')).toHaveLength(1);
  });

  it('renders mm:ss.s offsets relative to the first entry', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00.000Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:41.200Z', role: 'assistant', content: 'later', kind: 'text' },
    ]);
    const times = qa('.wf-log-t').map(t => t.textContent);
    expect(times).toContain('00:00.0');
    expect(times).toContain('00:41.2');
  });

  it('the classic-view toggle switches back to the old two-pane DOM (and back again)', () => {
    sendRender(logModel());
    expect(q('.wf-log-scroll')).not.toBeNull();
    expect(q('.wf-2pane')).toBeNull();

    q('.wf-mode-toggle')!.click();
    expect(q('.wf-2pane')).not.toBeNull();
    expect(q('.wf-nav-row')).not.toBeNull();
    expect(q('.wf-log-scroll')).toBeNull();

    q('.wf-mode-toggle')!.click();
    expect(q('.wf-log-scroll')).not.toBeNull();
    expect(q('.wf-2pane')).toBeNull();
  });

  // ── Result strip (Phase 3, DESIGN-DETAIL-PANE-V2.md) ──────────────────

  function sampleEvidence(): RawEvidence {
    return {
      filesTouched: [
        { path: 'src/detailView.css', kind: 'edit', approxAdded: 142, approxRemoved: 38 },
        { path: 'proto/v2.html', kind: 'write', approxAdded: 210, approxRemoved: null },
      ],
      commandsRun: [
        { command: 'npm run typecheck', exitOk: true },
        { command: 'npm run build', exitOk: true },
      ],
      testsRun: false,
      finalMessage: 'Proposes a 3-zone stack replacing chat bubbles. All checks green, ready for review.',
    };
  }

  it('is absent entirely when the selected agent has no transcript loaded yet', () => {
    sendRender(logModel());
    expect(q('.wf-rstrip')).toBeNull();
  });

  it('renders the brief, final message, and file/command chips for a finished agent, open by default', () => {
    sendRender(logModel()); // agent001 (done) auto-selected
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'Design a v2 layout treating each agent as a unit of work' },
    ], [], sampleEvidence(), []);
    const strip = q('.wf-rstrip')!;
    expect(strip).not.toBeNull();
    expect(strip.classList.contains('collapsed')).toBe(false); // finished agent → open by default
    expect(q('.wf-rstrip-brief')!.textContent).toContain('Design a v2 layout');
    expect(q('.wf-rstrip-final')!.textContent).toContain('ready for review');
    const chips = qa('.wf-rstrip-chip');
    expect(chips.some(c => c.textContent!.includes('detailView.css'))).toBe(true);
    expect(chips.some(c => c.textContent!.includes('npm run typecheck'))).toBe(true);
  });

  it('collapses to a one-line status summary for a running agent by default', () => {
    sendRender(logModel());
    qa('.wf-agent-pill').find(p => p.dataset.agent === 'agent002')!.click(); // agent002 is running
    sendTranscript('workflow:wf_run1|wf_run1|agent002', [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], sampleEvidence(), []);
    const strip = q('.wf-rstrip')!;
    expect(strip).not.toBeNull();
    expect(strip.classList.contains('collapsed')).toBe(true);
    expect(q('.wf-rstrip-summary')!.textContent).toContain('running');
    expect(q('.wf-rstrip-final')).toBeNull(); // body hidden while collapsed
    expect(q('.wf-rstrip-brief')).toBeNull();
  });

  it('mismatch box appears for a fabricated-claim fixture and is absent for an honest one', () => {
    sendRender(logModel());
    const fabricated: RawEvidence = { ...sampleEvidence(), finalMessage: 'All tests pass, ready for review.' };
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], fabricated, [{ kind: 'tests-claimed-not-run', message: 'Final message claims the tests pass; typecheck and build ran, no test command found.' }]);
    const mismatch = q('.wf-rstrip-mismatch')!;
    expect(mismatch).not.toBeNull();
    expect(mismatch.textContent).toContain('MISMATCH');
    expect(mismatch.textContent).toContain('typecheck and build ran');
    expect(mismatch.textContent).toContain("Computed from tool calls, not the agent's prose.");

    // Honest evidence (a real test command ran) → host sends no mismatches.
    // A second, distinct entry keeps this send from being deduped as an
    // unchanged transcript (sameTranscript compares length + last entry).
    const honest: RawEvidence = {
      ...sampleEvidence(),
      commandsRun: [...sampleEvidence().commandsRun, { command: 'npm test', exitOk: true }],
      testsRun: true,
      finalMessage: 'All tests pass, ready for review.',
    };
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
      { timestamp: '2026-06-10T10:00:05Z', role: 'assistant', content: 'tests confirmed green', kind: 'text' },
    ], [], honest, []);
    expect(q('.wf-rstrip-mismatch')).toBeNull();
  });

  it('caps file chips at 6 and command chips at 4, each with a "+n" overflow chip', () => {
    sendRender(logModel());
    const manyFiles: RawFileTouch[] = Array.from({ length: 8 }, (_, i) => ({ path: `src/file${i}.ts`, kind: 'edit', approxAdded: 1, approxRemoved: 1 }));
    const manyCommands: RawCommandRun[] = Array.from({ length: 6 }, (_, i) => ({ command: `echo ${i}`, exitOk: true }));
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], { filesTouched: manyFiles, commandsRun: manyCommands, testsRun: false, finalMessage: null }, []);
    const overflow = qa('.wf-rstrip-chip.wf-rstrip-more');
    expect(overflow).toHaveLength(2); // one for files, one for commands
    expect(overflow[0].textContent).toContain('+2'); // 8 files - 6 shown
    expect(overflow[1].textContent).toContain('+2'); // 6 commands - 4 shown
  });

  it('collapse toggle persists across re-renders (tri-state, like viewRowCollapsed)', () => {
    sendRender(logModel()); // agent001 (done) auto-selected → open by default
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], sampleEvidence(), []);
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(false);

    q('.wf-rstrip-head')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(true);
    expect((webviewState as { resultStripCollapsed?: boolean | null }).resultStripCollapsed).toBe(true);

    // Explicit false overrides the status-based default too.
    q('.wf-rstrip-head')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(false);
    expect((webviewState as { resultStripCollapsed?: boolean | null }).resultStripCollapsed).toBe(false);
  });
});

describe('detailView.ts — native escape hatches (Phase 4, DESIGN-DETAIL-PANE-V2.md)', () => {
  beforeEach(async () => {
    postedMessages = [];
    webviewState = undefined;
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
  });

  function logModel() {
    return {
      source: 'workflow',
      containerId: 'wf_run1',
      sessionId: 'sess1',
      title: 'audit-run',
      metrics: '2 agents',
      groups: [
        {
          key: 'wf_run1',
          title: 'Audit',
          agents: [
            agent({ agentId: 'agent001', label: 'audit:privacy', phaseTitle: 'Audit' }),
          ],
        },
      ],
    };
  }

  const KEY1 = 'workflow:wf_run1|wf_run1|agent001';
  const EDIT_INPUT = JSON.stringify({ file_path: '/repo/src/foo.ts', old_string: 'before', new_string: 'after' });

  /** Click the (non-brief) row whose text contains `textMatch` to expand it,
   *  then re-query it (the click re-renders the whole tree via innerHTML —
   *  see the existing "row expansion reveals rawInput/rawOutput" test for
   *  the same re-query pattern). */
  function expandRow(textMatch: string): HTMLElement {
    const before = qa('.wf-log-row').find(r => r.textContent!.includes(textMatch))!;
    before.click();
    return qa('.wf-log-row').find(r => r.textContent!.includes(textMatch))!;
  }

  it('the two base actions (raw JSON, open transcript) appear on any expanded row', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Bash** ls',
        kind: 'tool_use', toolName: 'Bash', rawInput: JSON.stringify({ command: 'ls' }),
      },
    ]);
    expect(q('.wf-log-actions')).toBeNull(); // nothing expanded yet
    expandRow('Bash');
    const actions = qa('.wf-log-action');
    expect(actions.map(a => a.dataset.action)).toEqual(['raw-json', 'open-transcript']);
  });

  it('"Show file changes" is a THIRD action only when rawInput parses as a two-sided Edit', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Edit** foo.ts',
        kind: 'tool_use', toolName: 'Edit', rawInput: EDIT_INPUT,
      },
    ]);
    expandRow('Edit');
    const actions = qa('.wf-log-action').map(a => a.dataset.action);
    expect(actions).toEqual(['raw-json', 'open-transcript', 'file-changes']);
  });

  it('does NOT show "Show file changes" for a Write call (no old_string/new_string)', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Write** foo.ts',
        kind: 'tool_use', toolName: 'Write', rawInput: JSON.stringify({ file_path: '/a.ts', content: 'x' }),
      },
    ]);
    expandRow('Write');
    expect(qa('.wf-log-action').map(a => a.dataset.action)).toEqual(['raw-json', 'open-transcript']);
  });

  it('does NOT show "Show file changes" for an Edit whose rawInput is malformed JSON', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Edit** foo.ts',
        kind: 'tool_use', toolName: 'Edit', rawInput: '{not json',
      },
    ]);
    expandRow('Edit');
    expect(qa('.wf-log-action').map(a => a.dataset.action)).toEqual(['raw-json', 'open-transcript']);
  });

  it('clicking "View raw JSON" posts showRawRecord with the row\'s entry index', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Bash** ls',
        kind: 'tool_use', toolName: 'Bash', rawInput: JSON.stringify({ command: 'ls' }),
      },
    ]);
    const row = expandRow('Bash');
    postedMessages.length = 0;
    qa('.wf-log-action').find(a => a.dataset.action === 'raw-json')!.click();
    const msg = (postedMessages as any[]).find(m => m.type === 'showRawRecord');
    expect(msg).toEqual({
      type: 'showRawRecord', source: 'workflow', containerId: 'wf_run1',
      groupKey: 'wf_run1', agentId: 'agent001', label: 'audit:privacy',
      entryIndex: Number(row.dataset.idx),
    });
  });

  it('clicking "Open transcript in editor" posts openTranscriptDoc with no entryIndex', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Bash** ls',
        kind: 'tool_use', toolName: 'Bash', rawInput: JSON.stringify({ command: 'ls' }),
      },
    ]);
    expandRow('Bash');
    postedMessages.length = 0;
    qa('.wf-log-action').find(a => a.dataset.action === 'open-transcript')!.click();
    const msg = (postedMessages as any[]).find(m => m.type === 'openTranscriptDoc');
    expect(msg).toEqual({
      type: 'openTranscriptDoc', source: 'workflow', containerId: 'wf_run1',
      groupKey: 'wf_run1', agentId: 'agent001', label: 'audit:privacy',
    });
    expect('entryIndex' in msg).toBe(false);
  });

  it('clicking "Show file changes" on a row posts showFileChanges with an entryIndex', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Edit** foo.ts',
        kind: 'tool_use', toolName: 'Edit', rawInput: EDIT_INPUT,
      },
    ]);
    const row = expandRow('Edit');
    postedMessages.length = 0;
    qa('.wf-log-action').find(a => a.dataset.action === 'file-changes')!.click();
    const msg = (postedMessages as any[]).find(m => m.type === 'showFileChanges');
    expect(msg).toEqual({
      type: 'showFileChanges', source: 'workflow', containerId: 'wf_run1',
      groupKey: 'wf_run1', agentId: 'agent001', label: 'audit:privacy',
      entryIndex: Number(row.dataset.idx),
    });
  });

  it('a click inside the expanded block never re-toggles (re-collapses) the row', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Bash** ls',
        kind: 'tool_use', toolName: 'Bash', rawInput: JSON.stringify({ command: 'ls' }),
      },
    ]);
    expandRow('Bash');
    qa('.wf-log-action').find(a => a.dataset.action === 'raw-json')!.click();
    // Still expanded — the click posted a message but did not toggle expandedRows.
    const row = qa('.wf-log-row').find(r => r.textContent!.includes('Bash'))!;
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(q('.wf-log-expand')).not.toBeNull();
  });

  it('keyboard Enter on a native action activates it', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Bash** ls',
        kind: 'tool_use', toolName: 'Bash', rawInput: JSON.stringify({ command: 'ls' }),
      },
    ]);
    expandRow('Bash');
    postedMessages.length = 0;
    const btn = qa('.wf-log-action').find(a => a.dataset.action === 'raw-json')!;
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect((postedMessages as any[]).some(m => m.type === 'showRawRecord')).toBe(true);
  });

  // ── Result-strip file chip (Phase 4's third wiring point) ─────────────

  it('only an "edit"-kind file chip is clickable; write/notebook chips stay inert', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], {
      filesTouched: [
        { path: 'src/foo.ts', kind: 'edit', approxAdded: 1, approxRemoved: 1 },
        { path: 'src/new.ts', kind: 'write', approxAdded: 5, approxRemoved: null },
      ],
      commandsRun: [], testsRun: false, finalMessage: null,
    } as any, []);
    const chips = qa('.wf-rstrip-chip').filter(c => !c.classList.contains('wf-rstrip-more') && !c.classList.contains('wf-rstrip-cat'));
    const editChip = chips.find(c => c.textContent!.includes('foo.ts'))!;
    const writeChip = chips.find(c => c.textContent!.includes('new.ts'))!;
    expect(editChip.classList.contains('clickable')).toBe(true);
    expect(writeChip.classList.contains('clickable')).toBe(false);
  });

  it('clicking an edit file chip posts showFileChanges with the file PATH, not an entryIndex', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], {
      filesTouched: [{ path: 'src/foo.ts', kind: 'edit', approxAdded: 1, approxRemoved: 1 }],
      commandsRun: [], testsRun: false, finalMessage: null,
    } as any, []);
    postedMessages.length = 0;
    q('.wf-rstrip-chip.clickable')!.click();
    const msg = (postedMessages as any[]).find(m => m.type === 'showFileChanges');
    expect(msg).toEqual({
      type: 'showFileChanges', source: 'workflow', containerId: 'wf_run1',
      groupKey: 'wf_run1', agentId: 'agent001', label: 'audit:privacy',
      filePath: 'src/foo.ts',
    });
    expect('entryIndex' in msg).toBe(false);
  });

  it('keyboard Enter on a clickable file chip activates it', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], {
      filesTouched: [{ path: 'src/foo.ts', kind: 'edit', approxAdded: 1, approxRemoved: 1 }],
      commandsRun: [], testsRun: false, finalMessage: null,
    } as any, []);
    postedMessages.length = 0;
    const chip = q('.wf-rstrip-chip.clickable')!;
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect((postedMessages as any[]).some(m => m.type === 'showFileChanges')).toBe(true);
  });
});
