/**
 * @vitest-environment jsdom
 *
 * Structural DOM tests for the detail-panel webview frontend (detailView.ts →
 * media/detailView.js). Covers the agent-list collapse behaviour and the
 * source-grouped switcher. Does NOT test CSS layout/animation (jsdom has no
 * layout engine) — only the DOM structure and class toggling the CSS keys off.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
    q('.wf-zone-collapse[data-zone="views"]')!.click();
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

  it('agent pill carries the formatted model in its title only, not a visible tag', () => {
    const model = logModel() as any;
    model.groups[0].agents[0] = agent({ agentId: 'agent001', label: 'audit:privacy', phaseTitle: 'Audit', model: 'claude-sonnet-5' });
    sendRender(model);
    const pill1 = qa('.wf-agent-pill').find(p => p.dataset.agent === 'agent001')!;
    expect(pill1.querySelector('.wf-agent-pill-model')).toBeNull();
    expect(pill1.getAttribute('title')).toBe('audit:privacy · done · Sonnet 5');
  });

  it('agent detail bar surfaces the selected agent\'s model/tokens/runtime/tool-calls under the agent strip', () => {
    const model = logModel() as any;
    model.groups[0].agents[0] = agent({
      agentId: 'agent001', label: 'audit:privacy', phaseTitle: 'Audit',
      model: 'claude-sonnet-5', tokens: 1500, toolCalls: 4, durationMs: 65000,
    });
    sendRender(model);
    const bar = q('.wf-astrip')!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.wf-astrip-name')!.textContent).toBe('audit:privacy');
    expect(qa('.wf-astrip-meta-item').map(i => i.textContent)).toEqual([
      'Sonnet 5', '· 1m 5s', '· 1.5k tokens', '· 4 tools',
    ]);
  });

  it('agent detail bar is absent when the selected agent has no model/tokens/runtime to show', () => {
    sendRender(logModel()); // fixture default: model '', tokens 0, toolCalls 0, durationMs null
    expect(q('.wf-astrip')).toBeNull();
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

  // Phase 2.1 (E): tool rows are opt-in — the default filter set is Text +
  // Error + Result on, Tool OFF. This test asserted the old all-on default
  // (tool rows visible on first open); it now asserts the inverse, plus that
  // toggling Tool on works and persists in the webview state.
  it('tool rows are hidden by default; toggling Tool on shows them and persists', async () => {
    sendRender(logModel());
    const ENTRIES = [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: 'some prose here', kind: 'text' },
      { timestamp: '2026-06-10T10:00:02Z', role: 'assistant', content: '> **Bash** rm -rf build/', kind: 'tool_use', toolName: 'Bash' },
    ];
    sendTranscript(KEY1, ENTRIES);
    // Default: prose is the primary read; tool chatter is hidden.
    expect(q('.wf-log')!.textContent).toContain('some prose here');
    expect(q('.wf-log')!.textContent).not.toContain('Bash');
    // The chip visibly reads as off on first open (existing off styling).
    const toolChip = q('.wf-facet-kind[data-kind="tool"]')!;
    expect(toolChip.classList.contains('off')).toBe(true);
    expect(toolChip.getAttribute('aria-checked')).toBe('false');

    // Toggle Tool on: the row appears and the choice is persisted.
    toolChip.click();
    expect(q('.wf-log')!.textContent).toContain('Bash');
    expect((webviewState as { kindFilters?: { tool?: boolean } }).kindFilters!.tool).toBe(true);

    // Text off still hides prose while the tool row stays (separate buckets).
    q('.wf-facet-kind[data-kind="text"]')!.click();
    expect(q('.wf-log')!.textContent).not.toContain('some prose here');
    expect(q('.wf-log')!.textContent).toContain('Bash');

    // Rebuild (fresh module + DOM, same persisted state, like a reopen): the
    // enabled-kind set survives — global, not per-agent.
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    await import('./detailView.js');
    sendRender(logModel());
    sendTranscript(KEY1, ENTRIES);
    expect(q('.wf-log')!.textContent).toContain('Bash');
    expect(q('.wf-log')!.textContent).not.toContain('some prose here');
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
    // Phase 2.1 (E): tool rows are opt-in by default — enable them first.
    q('.wf-facet-kind[data-kind="tool"]')!.click();
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

  // Phase 2.2 (D): wall clock is now the DEFAULT gutter; the mm:ss.s offset
  // became the click-to-toggle alternate. The old test here asserted offsets
  // as the default — replaced by the block below (default + toggle/persist).
  /** Local HH:MM:SS as fmtClock renders it (fixtures are UTC ISO strings;
   *  the gutter is local time, so compute the expectation the same way
   *  rather than hard-coding a timezone). */
  const clockOf = (iso: string): string => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  it('renders wall-clock HH:MM:SS by default, with the offset in the tooltip', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00.000Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:41.200Z', role: 'assistant', content: 'later', kind: 'text' },
    ]);
    const cells = qa('.wf-log-t');
    expect(cells.map(t => t.textContent)).toContain(clockOf('2026-06-10T10:00:41.200Z'));
    for (const c of cells) { expect(c.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/); }
    // The alternate representation rides the tooltip.
    expect(cells.some(c => c.getAttribute('title') === '00:41.2')).toBe(true);
  });

  it('clicking a timestamp toggles the whole column to offsets and persists the mode', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00.000Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:41.200Z', role: 'assistant', content: 'later', kind: 'text' },
    ]);
    qa('.wf-log-t')[0].click();
    const times = qa('.wf-log-t').map(t => t.textContent);
    expect(times).toContain('00:00.0');
    expect(times).toContain('00:41.2');
    // Tooltip now carries the wall clock; the choice is persisted globally.
    expect(qa('.wf-log-t')[1].getAttribute('title')).toBe(clockOf('2026-06-10T10:00:41.200Z'));
    expect((webviewState as { timeMode?: string }).timeMode).toBe('offset');
    // Clicking again returns to wall clock.
    qa('.wf-log-t')[0].click();
    expect(qa('.wf-log-t')[0].textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect((webviewState as { timeMode?: string }).timeMode).toBe('clock');
  });

  it('a time-cell click never expands/collapses the row it sits in', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Edit** x.css',
        kind: 'tool_use', toolName: 'Edit', rawInput: '{"a":1}',
      },
    ]);
    q('.wf-facet-kind[data-kind="tool"]')!.click(); // tool rows are opt-in (E)
    const row = qa('.wf-log-row').find(r => r.textContent!.includes('Edit'))!;
    (row.querySelector('.wf-log-t') as HTMLElement).click();
    const after = qa('.wf-log-row').find(r => r.textContent!.includes('Edit'))!;
    expect(after.getAttribute('aria-expanded')).toBe('false'); // toggled time, not the row
  });

  it('rows with unparseable timestamps render an empty cell in both modes', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '', role: 'assistant', content: 'no stamp', kind: 'text' },
    ]);
    const cellOf = () => qa('.wf-log-row.prose').find(r => r.textContent!.includes('no stamp'))!.querySelector('.wf-log-t')!;
    expect(cellOf().textContent).toBe('');
    qa('.wf-log-t')[0].click(); // → offset mode
    expect(cellOf().textContent).toBe('');
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

  // Phase 2.2 (C): the strip is collapsed to ONE line by default for every
  // agent, running or done — Murray: results are so lengthy that the open
  // strip wasn't helpful; the mismatch flag is the part that must never
  // hide. The four tests below replaced their open-by-default originals.
  it('collapses to a one-line finalMessage summary by default; expanding reveals brief, final, and chips', () => {
    sendRender(logModel()); // agent001 (done) auto-selected
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'Design a v2 layout treating each agent as a unit of work' },
    ], [], sampleEvidence(), []);
    const strip = q('.wf-rstrip')!;
    expect(strip).not.toBeNull();
    expect(strip.classList.contains('collapsed')).toBe(true); // collapsed for ALL agents now
    // Collapsed line = first ~100 chars of the final message, not a count roll-up.
    expect(q('.wf-rstrip-summary')!.textContent).toContain('Proposes a 3-zone stack');
    expect(q('.wf-rstrip-summary')!.textContent!.length).toBeLessThanOrEqual(101); // 100 + ellipsis
    // Everything else lives behind the expand.
    expect(q('.wf-rstrip-brief')).toBeNull();
    expect(q('.wf-rstrip-final')).toBeNull();
    expect(q('.wf-rstrip-chip')).toBeNull();

    q('.wf-rstrip-head')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(false);
    expect(q('.wf-rstrip-brief')!.textContent).toContain('Design a v2 layout');
    expect(q('.wf-rstrip-final')!.textContent).toContain('ready for review');
    const chips = qa('.wf-rstrip-chip');
    expect(chips.some(c => c.textContent!.includes('detailView.css'))).toBe(true);
    expect(chips.some(c => c.textContent!.includes('npm run typecheck'))).toBe(true);
  });

  it('falls back to the running status line when there is no final message', () => {
    sendRender(logModel());
    qa('.wf-agent-pill').find(p => p.dataset.agent === 'agent002')!.click(); // agent002 is running
    sendTranscript('workflow:wf_run1|wf_run1|agent002', [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], { ...sampleEvidence(), finalMessage: null }, []);
    const strip = q('.wf-rstrip')!;
    expect(strip.classList.contains('collapsed')).toBe(true);
    expect(q('.wf-rstrip-summary')!.textContent).toContain('running');
    expect(q('.wf-rstrip-final')).toBeNull(); // body hidden while collapsed
    expect(q('.wf-rstrip-brief')).toBeNull();
  });

  it('a mismatch stays VISIBLE on the collapsed line (inline), full box when expanded, absent when honest', () => {
    sendRender(logModel());
    const fabricated: RawEvidence = { ...sampleEvidence(), finalMessage: 'All tests pass, ready for review.' };
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], fabricated, [{ kind: 'tests-claimed-not-run', message: 'Final message claims the tests pass; typecheck and build ran, no test command found.' }]);
    // Collapsed by default — the flag must render regardless (non-negotiable).
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(true);
    const inline = q('.wf-rstrip-mismatch-inline')!;
    expect(inline).not.toBeNull();
    expect(inline.textContent).toContain('MISMATCH');
    expect(q('.wf-rstrip-mismatch')).toBeNull(); // full box only when expanded

    q('.wf-rstrip-head')!.click();
    const mismatch = q('.wf-rstrip-mismatch')!;
    expect(mismatch).not.toBeNull();
    expect(mismatch.textContent).toContain('typecheck and build ran');
    expect(mismatch.textContent).toContain("Computed from tool calls, not the agent's prose.");

    // Honest evidence (a real test command ran) → host sends no mismatches:
    // neither form renders. Collapse back first (the toggle persisted open).
    q('.wf-rstrip-head')!.click();
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
    expect(q('.wf-rstrip-mismatch-inline')).toBeNull();
    expect(q('.wf-rstrip-mismatch')).toBeNull();
  });

  it('caps file chips at 6 and command chips at 4, each with a "+n" overflow chip', () => {
    sendRender(logModel());
    const manyFiles: RawFileTouch[] = Array.from({ length: 8 }, (_, i) => ({ path: `src/file${i}.ts`, kind: 'edit', approxAdded: 1, approxRemoved: 1 }));
    const manyCommands: RawCommandRun[] = Array.from({ length: 6 }, (_, i) => ({ command: `echo ${i}`, exitOk: true }));
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], { filesTouched: manyFiles, commandsRun: manyCommands, testsRun: false, finalMessage: null }, []);
    q('.wf-rstrip-head')!.click(); // chips live behind the expand now (C)
    const overflow = qa('.wf-rstrip-chip.wf-rstrip-more');
    expect(overflow).toHaveLength(2); // one for files, one for commands
    expect(overflow[0].textContent).toContain('+2'); // 8 files - 6 shown
    expect(overflow[1].textContent).toContain('+2'); // 6 commands - 4 shown
  });

  it('collapse toggle persists across re-renders (tri-state, like viewRowCollapsed)', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], sampleEvidence(), []);
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(true); // C: collapsed default

    // First click expands and persists the explicit choice.
    q('.wf-rstrip-head')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(false);
    expect((webviewState as { resultStripCollapsed?: boolean | null }).resultStripCollapsed).toBe(false);

    // Second click collapses again — explicit true, not just the default.
    q('.wf-rstrip-head')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(true);
    expect((webviewState as { resultStripCollapsed?: boolean | null }).resultStripCollapsed).toBe(true);
  });

  // ── Prose rows (Phase 2.1) — hybrid register ─────────────────────────

  it('a text entry renders as a flowing prose block (UI-font class), full text, gutter intact', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: 'para one\n\npara two of the reasoning', kind: 'text' },
    ]);
    const row = qa('.wf-log-row.prose').find(r => r.textContent!.includes('para one'))!;
    expect(row).toBeTruthy();
    // The body is the prose class (the CSS keys --vscode-font-family, 13px,
    // 1.5 line-height, pre-wrap off it — jsdom has no layout, so the class
    // IS the assertion), with newlines preserved, not collapsed to one line.
    const body = row.querySelector('.wf-log-prose')!;
    expect(body.textContent).toContain('para one\n\npara two of the reasoning');
    // Gutter intact: relative time + kind glyph keep the log spine scannable.
    expect(row.querySelector('.wf-log-t')).not.toBeNull();
    expect(row.querySelector('.wf-log-glyph')).not.toBeNull();
    // Short prose has nothing to expand: no clamp, no affordance, no toggle.
    expect(row.classList.contains('expandable')).toBe(false);
    expect(row.querySelector('.wf-log-showall')).toBeNull();
  });

  it('the brief row defaults to a ~3-line clamp and expands in place (aria-expanded)', () => {
    sendRender(logModel());
    const longBrief = Array.from({ length: 10 }, (_, i) => 'brief line ' + i).join('\n');
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: longBrief },
      { timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: 'working on it', kind: 'text' },
    ]);
    const brief = q('.wf-log-row.brief')!;
    expect(brief.classList.contains('expandable')).toBe(true);
    expect(brief.getAttribute('aria-expanded')).toBe('false');
    expect(brief.querySelector('.wf-log-prose')!.classList.contains('clamp-brief')).toBe(true);
    expect(brief.querySelector('.wf-log-showall')!.textContent).toContain('show all');

    brief.click();
    const after = q('.wf-log-row.brief')!; // click re-renders; re-query
    expect(after.getAttribute('aria-expanded')).toBe('true');
    expect(after.querySelector('.wf-log-prose')!.classList.contains('clamp-brief')).toBe(false);
    expect(after.querySelector('.wf-log-showall')!.textContent).toContain('show less');
  });

  it('long prose clamps with a "show all" expander; expanding releases the clamp', () => {
    sendRender(logModel());
    const long = Array.from({ length: 40 }, (_, i) => 'reasoning line ' + i).join('\n');
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: long, kind: 'text' },
    ]);
    const row = qa('.wf-log-row.prose').find(r => r.textContent!.includes('reasoning line 39'))!;
    expect(row.classList.contains('expandable')).toBe(true);
    expect(row.querySelector('.wf-log-prose')!.classList.contains('clamp-prose')).toBe(true);
    expect(row.querySelector('.wf-log-showall')!.textContent).toContain('show all');

    row.click();
    const after = qa('.wf-log-row.prose').find(r => r.textContent!.includes('reasoning line 39'))!;
    expect(after.getAttribute('aria-expanded')).toBe('true');
    expect(after.querySelector('.wf-log-prose')!.classList.contains('clamp-prose')).toBe(false);
  });

  it('search highlights matches inside prose bodies', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: 'first line\nthe needle sits mid-paragraph\nlast line', kind: 'text' },
    ]);
    const input = q('.wf-facet-search-input') as HTMLInputElement;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const hl = q('.wf-log-row.prose .wf-log-prose .wf-hl');
    expect(hl).not.toBeNull();
    expect(hl!.textContent).toBe('needle');
  });

  it('a correlated tool_result row shows the tool name bold and drops the toolu_ id parenthetical', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:01Z', role: 'tool', content: '> **Tool result** (toolu_012nYa...): 878 src/detailPanel.ts', kind: 'tool_result', toolName: 'Grep' },
      { timestamp: '2026-06-10T10:00:02Z', role: 'tool', content: '> **Tool result** (toolu_099xxB...): uncorrelated output', kind: 'tool_result' },
    ]);
    q('.wf-facet-kind[data-kind="tool"]')!.click(); // tool rows are opt-in (E)
    const rows = qa('.wf-log-row');
    const named = rows.find(r => r.textContent!.includes('878'))!;
    expect(named.querySelector('.wf-log-body b')!.textContent).toBe('Grep');
    expect(named.textContent).not.toContain('toolu_'); // display-only strip
    // Correlation miss → today's rendering, minus nothing: id kept, no bold.
    const fallback = rows.find(r => r.textContent!.includes('uncorrelated'))!;
    expect(fallback.textContent).toContain('(toolu_099xxB...)');
    expect(fallback.querySelector('.wf-log-body b')).toBeNull();
  });

  // ── Phased agent strip (Phase 2.1, F) ────────────────────────────────

  it('workflow phases each get their own line: header with done/total + failed, pills beneath', () => {
    const m = logModel() as any;
    m.groups = [
      {
        key: 'wf_run1', title: 'Phase 1 · Research',
        agents: [
          agent({ agentId: 'r1', label: 'research-a', status: 'done' }),
          agent({ agentId: 'r2', label: 'research-b', status: 'failed' }),
        ],
      },
      {
        key: 'wf_run1', title: 'Phase 2 · Draft',
        agents: [agent({ agentId: 'd1', label: 'draft-a', status: 'running' })],
      },
    ];
    sendRender(m);
    expect(q('.wf-agentstrip')!.classList.contains('phased')).toBe(true);
    const heads = qa('.wf-agentstrip-phasehead');
    expect(heads).toHaveLength(2);
    expect(heads[0].textContent).toContain('Phase 1 · Research');
    expect(heads[0].textContent).toContain('1/2');
    expect(heads[0].querySelector('.wf-nav-count-failed')!.textContent).toBe('1 failed');
    expect(heads[1].textContent).toContain('Phase 2 · Draft');
    expect(heads[1].textContent).toContain('0/1');
    // Pills live in their phase's own row, not interleaved with the headers.
    const pillRows = qa('.wf-agentstrip-pills');
    expect(pillRows).toHaveLength(2);
    expect(pillRows[0].querySelectorAll('.wf-agent-pill')).toHaveLength(2);
    expect(pillRows[1].querySelectorAll('.wf-agent-pill')).toHaveLength(1);
  });

  it('a flat source (no phase titles) keeps the single pill row', () => {
    sendRender({
      source: 'subagents', containerId: 'sess1', sessionId: 'sess1', title: 'Subagents', metrics: '',
      groups: [{ key: '', title: null, agents: [agent({ agentId: 's1', label: 'explore' }), agent({ agentId: 's2', label: 'review' })] }],
    });
    expect(q('.wf-agentstrip')!.classList.contains('phased')).toBe(false);
    expect(qa('.wf-agentstrip-phasehead')).toHaveLength(0);
    expect(qa('.wf-agent-pill')).toHaveLength(2);
  });

  it('ArrowRight walks pills across phase lines in document order', () => {
    const m = logModel() as any;
    m.groups = [
      { key: 'wf_run1', title: 'Phase 1', agents: [agent({ agentId: 'p1', label: 'one' })] },
      { key: 'wf_run1', title: 'Phase 2', agents: [agent({ agentId: 'p2', label: 'two' })] },
    ];
    sendRender(m);
    const first = qa('.wf-agent-pill').find(p => p.dataset.agent === 'p1')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // Selection AND focus crossed the phase-line boundary.
    expect(q('.wf-agent-pill.active')!.dataset.agent).toBe('p2');
    expect((document.activeElement as HTMLElement).dataset.agent).toBe('p2');
  });

  // ── Zone order + label rail (Phase 2.2, A/B) ─────────────────────────

  it('zones stack view row, then header strip (summary), then agent strip, then the rest', () => {
    const m = logModel() as any;
    m.groups[0].agents[1].status = 'waiting'; // → permission row present too
    sendRender(m);
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], emptyEvidence(), []);
    const classes = Array.from(root().children).map(c => (c as HTMLElement).className.split(' ')[0]);
    // Fixture agent001 has no model/tokens/duration, so the agent detail bar
    // doesn't render here — see the dedicated agent-detail-bar tests above.
    const order = ['wf-view-row', 'wf-hstrip', 'wf-agentstrip', 'wf-permrow', 'wf-rstrip', 'wf-facets', 'wf-log-scroll'];
    expect(classes).toEqual(order);
  });

  it('view row, agent strip, and facet bar each lead with a rail label cell', () => {
    sendRender(logModel());
    expect(q('.wf-view-row .wf-zone-label')!.textContent).toBe('views');
    // logModel's groups are phased — the label sits on the strip's FIRST
    // line only; every other line reserves an EMPTY gutter cell.
    const stripLabels = qa('.wf-agentstrip .wf-zone-label');
    expect(stripLabels[0].textContent).toBe('agents');
    expect(stripLabels.length).toBeGreaterThan(1);
    for (const l of stripLabels.slice(1)) { expect(l.textContent).toBe(''); }
    // Phase 2.4: "display" — the bar holds kind filters + time mode +
    // fold-all + search, so "filter" undersold it.
    expect(q('.wf-facets .wf-zone-label')!.textContent).toBe('display');
  });

  it('a flat agent strip carries the label on its single line', () => {
    sendRender({
      source: 'subagents', containerId: 'sess1', sessionId: 'sess1', title: 'Subagents', metrics: '',
      groups: [{ key: '', title: null, agents: [agent({ agentId: 's1', label: 'explore' })] }],
    });
    const labels = qa('.wf-agentstrip .wf-zone-label');
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe('agents');
  });

  it('the rail width is one shared CSS var: --wf-gutter sizes both timestamps and zone labels', () => {
    // jsdom does not apply the stylesheet, so assert the contract at its
    // source: the CSS file must size .wf-log-t and .wf-zone-label off the
    // SAME variable (this is what keeps the rail aligned; a hardcoded width
    // in either place would silently drift).
    // (import.meta.url is an http: URL under the jsdom environment, so
    // resolve from the repo root — vitest's cwd — instead.)
    const css = fs.readFileSync(path.join(process.cwd(), 'media', 'detailView.css'), 'utf-8');
    expect(css).toMatch(/--wf-gutter:\s*\d+px/);
    expect(css).toMatch(/\.wf-log-t\s*{[^}]*width:\s*var\(--wf-gutter\)/);
    expect(css).toMatch(/\.wf-zone-label\s*{[^}]*width:\s*var\(--wf-gutter\)/);
  });

  // ── Rail labels + shared collapse control (Phase 2.3) ────────────────

  it('header strip and result strip head lead with the shared rail label cell (badge box gone)', () => {
    sendRender(logModel());
    // The bordered one-off source badge is retired: the source name now sits
    // in the same gutter cell as views/agents/filter.
    expect(q('.wf-hstrip-badge')).toBeNull();
    expect(q('.wf-hstrip .wf-zone-label')!.textContent).toBe('workflow');
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], sampleEvidence(), []);
    expect(q('.wf-rstrip-head .wf-zone-label')!.textContent).toBe('result');
    expect(q('.wf-rstrip-caret')).toBeNull(); // old tiny caret retired too
    // ONE control, identical wording, on all three collapsible zones.
    const buttons = qa('.wf-zone-collapse');
    expect(buttons.map(b => b.dataset.zone).sort()).toEqual(['agents', 'result', 'views']);
    for (const b of buttons.filter(x => x.dataset.zone !== 'result')) {
      expect(b.textContent).toBe('⌃ collapse'); // views/agents expanded by default
    }
    expect(buttons.find(b => b.dataset.zone === 'result')!.textContent).toBe('⌄ expand'); // result collapsed by default
  });

  it('the shared collapse control folds a phased agent strip into one line: active + running/waiting + "+N"', () => {
    const m = logModel() as any;
    m.groups = [
      {
        key: 'wf_run1', title: 'Phase 1', agents: [
          agent({ agentId: 'a1', label: 'one', status: 'done' }), // auto-selected → active, so kept
          agent({ agentId: 'a2', label: 'two', status: 'done' }), // folds
          agent({ agentId: 'a3', label: 'three', status: 'failed' }), // folds
        ],
      },
      {
        key: 'wf_run1', title: 'Phase 2', agents: [
          agent({ agentId: 'a4', label: 'four', status: 'running' }), // kept
          agent({ agentId: 'a5', label: 'five', status: 'waiting' }), // kept
        ],
      },
    ];
    sendRender(m);
    expect(q('.wf-agentstrip')!.classList.contains('phased')).toBe(true);

    q('.wf-zone-collapse[data-zone="agents"]')!.click();
    const strip = q('.wf-agentstrip')!;
    expect(strip.classList.contains('collapsed')).toBe(true);
    // ALL phase lines fold into one row: no phase headers, one leading label.
    expect(strip.classList.contains('phased')).toBe(false);
    expect(qa('.wf-agentstrip-phasehead')).toHaveLength(0);
    const labels = qa('.wf-agentstrip .wf-zone-label');
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe('agents');
    // Active + running + waiting across all groups, document order; the rest
    // behind a "+N" chip.
    const ids = qa('.wf-agent-pill').filter(p => !p.classList.contains('more')).map(p => p.dataset.agent);
    expect(ids).toEqual(['a1', 'a4', 'a5']);
    expect(q('.wf-agent-pill.more')!.textContent).toContain('+2');
    expect((webviewState as { agentStripCollapsed?: boolean }).agentStripCollapsed).toBe(true);

    // The "+N" chip expands the strip back to its phased form.
    q('.wf-agent-pill.more')!.click();
    expect(q('.wf-agentstrip')!.classList.contains('phased')).toBe(true);
    expect(qa('.wf-agent-pill')).toHaveLength(5);
    expect((webviewState as { agentStripCollapsed?: boolean }).agentStripCollapsed).toBe(false);
  });

  it('agentStripCollapsed persists across a webview rebuild', async () => {
    sendRender(logModel());
    q('.wf-zone-collapse[data-zone="agents"]')!.click();
    expect(q('.wf-agentstrip')!.classList.contains('collapsed')).toBe(true);

    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    await import('./detailView.js');
    sendRender(logModel());
    expect(q('.wf-agentstrip')!.classList.contains('collapsed')).toBe(true);
    q('.wf-zone-collapse[data-zone="agents"]')!.click();
    expect(q('.wf-agentstrip')!.classList.contains('collapsed')).toBe(false);
  });

  it('result strip: the collapse button inside the head and the head itself both toggle, never double-fire', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'brief' },
    ], [], sampleEvidence(), []);
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(true);

    // The button sits INSIDE the clickable head — its click bubbles through
    // the head, so a double-toggle would leave the strip visibly unchanged.
    // Exactly one toggle per click is what these flips prove.
    q('.wf-rstrip-head .wf-zone-collapse')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(false);
    expect((webviewState as { resultStripCollapsed?: boolean | null }).resultStripCollapsed).toBe(false);
    q('.wf-rstrip-head .wf-zone-collapse')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(true);
    expect((webviewState as { resultStripCollapsed?: boolean | null }).resultStripCollapsed).toBe(true);

    // The whole head stays clickable, same as before.
    q('.wf-rstrip-head')!.click();
    expect(q('.wf-rstrip')!.classList.contains('collapsed')).toBe(false);
  });

  // ── Time-mode chip + compact grey (Phase 2.4) ────────────────────────

  it('facet bar shows a time-mode chip: absolute by default, session after a click, both toggle routes stay in sync', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00.000Z', role: 'user', content: 'the brief' },
      { timestamp: '2026-06-10T10:00:41.200Z', role: 'assistant', content: 'later', kind: 'text' },
    ]);
    const chip = () => q('.wf-facet-time')!;
    expect(chip().textContent).toBe('◷ absolute');
    expect(chip().dataset.mode).toBe('clock');
    expect(qa('.wf-log-t')[0].textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/); // wall clock

    // Chip click → session offsets, persisted, column actually switches.
    chip().click();
    expect(chip().textContent).toBe('◷ session');
    expect(chip().dataset.mode).toBe('offset');
    expect(qa('.wf-log-t').map(t => t.textContent)).toContain('00:41.2');
    expect((webviewState as { timeMode?: string }).timeMode).toBe('offset');

    // The timestamp-column route (Phase 2.2) still toggles, and the chip
    // label follows — two routes, one state.
    qa('.wf-log-t')[0].click();
    expect(chip().textContent).toBe('◷ absolute');
    expect(qa('.wf-log-t')[0].textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect((webviewState as { timeMode?: string }).timeMode).toBe('clock');
  });

  it('tool rows carry the grey hook class in every state, result/brief rows never do, tool text a step lighter than err', () => {
    sendRender(logModel());
    sendTranscript(KEY1, [
      { timestamp: '2026-06-10T10:00:00Z', role: 'user', content: 'the brief' },
      {
        timestamp: '2026-06-10T10:00:01Z', role: 'assistant', content: '> **Edit** x.css',
        kind: 'tool_use', toolName: 'Edit', rawInput: '{"a":1}',
      },
      { timestamp: '2026-06-10T10:00:02Z', role: 'assistant', content: 'done, all green', kind: 'result' },
    ]);
    q('.wf-facet-kind[data-kind="tool"]')!.click(); // tool rows are opt-in (E)
    const toolRow = () => qa('.wf-log-row').find(r => r.textContent!.includes('Edit'))!;
    expect(toolRow().classList.contains('tool')).toBe(true);
    expect(toolRow().classList.contains('expanded')).toBe(false);
    // Result and brief rows are core content — never tool-greyed.
    expect(qa('.wf-log-row').find(r => r.classList.contains('result'))!.classList.contains('tool')).toBe(false);
    expect(qa('.wf-log-row').find(r => r.classList.contains('brief'))!.classList.contains('tool')).toBe(false);
    // Expanding keeps the grey (2.4b): the row carries BOTH classes and the
    // grey selectors no longer key off :not(.expanded).
    toolRow().click();
    expect(toolRow().classList.contains('expanded')).toBe(true);
    expect(toolRow().classList.contains('tool')).toBe(true);

    // jsdom cannot compute the cascade — assert the greying contract at its
    // source, same pattern as the rail-width CSS test above. Phase 2.4b:
    // grey in ALL states (no :not(.expanded) in the grey rules — its absence
    // is asserted to lock the regression out), tool text a step lighter than
    // err (opacity on the tool rule only), and the expanded band scoped to
    // prose rows.
    const css = fs.readFileSync(path.join(process.cwd(), 'media', 'detailView.css'), 'utf-8');
    const toolRule = css.match(/\.wf-log-row\.tool:not\(\.result\):not\(\.brief\)\s+\.wf-log-body\s*{[^}]*}/);
    const errRule = css.match(/\.wf-log-row\.err:not\(\.result\):not\(\.brief\)\s+\.wf-log-body\s*{[^}]*}/);
    expect(toolRule).not.toBeNull();
    expect(errRule).not.toBeNull();
    expect(toolRule![0]).toContain('opacity: 0.7');
    expect(errRule![0]).not.toContain('opacity');
    expect(css).not.toMatch(/\.tool:not\(\.expanded\)|\.err:not\(\.expanded\)/);
    // The expanded background band is a prose-only affordance now.
    expect(css).toMatch(/\.wf-log-row\.prose\.expanded\s*{/);
    expect(css).not.toMatch(/\.wf-log-row\.expanded\s*{/);
  });

  // ── Narrow-width hardening (Phase 2.5) ───────────────────────────────

  it('header counts drop zero segments: a finished run reads "N done", a live run only what IS, failed surfaces', () => {
    // Finished: 6 done, nothing else — no "0 running · 0 waiting" noise.
    const m = logModel() as any;
    m.groups = [{
      key: 'wf_run1', title: null,
      agents: Array.from({ length: 6 }, (_, i) => agent({ agentId: 'a' + i, label: 'agent-' + i, status: 'done' })),
    }];
    sendRender(m);
    expect(q('.wf-hstrip-counts')!.textContent).toBe('6 done');

    // Live: running + done only.
    const m2 = logModel() as any;
    m2.groups = [{
      key: 'wf_run1', title: null,
      agents: [
        agent({ agentId: 'r1', label: 'one', status: 'running' }),
        agent({ agentId: 'r2', label: 'two', status: 'running' }),
        agent({ agentId: 'r3', label: 'three', status: 'running' }),
        agent({ agentId: 'd1', label: 'four', status: 'done' }),
        agent({ agentId: 'd2', label: 'five', status: 'done' }),
      ],
    }];
    sendRender(m2);
    expect(q('.wf-hstrip-counts')!.textContent).toBe('3 running · 2 done');

    // Failed finally shows in the counts (headerAgg always tracked it).
    const m3 = logModel() as any;
    m3.groups = [{
      key: 'wf_run1', title: null,
      agents: [
        agent({ agentId: 'f1', label: 'boom', status: 'failed' }),
        agent({ agentId: 'd1', label: 'fine', status: 'done' }),
      ],
    }];
    sendRender(m3);
    expect(q('.wf-hstrip-counts')!.textContent).toBe('1 failed · 1 done');

    // Degenerate all-zero roster reads "0 done", never an empty span.
    const m4 = logModel() as any;
    m4.groups = [{ key: 'wf_run1', title: null, agents: [] }];
    sendRender(m4);
    expect(q('.wf-hstrip-counts')!.textContent).toBe('0 done');
  });

  it('header strip is atomic: body wrapper, ellipsis title with tooltip, meta bits as separate nowrap spans', () => {
    const m = logModel() as any;
    m.groups[0].agents = [
      agent({ agentId: 'agent001', label: 'audit:privacy', tokens: 1500, durationMs: 65000, model: 'claude-opus-4-5' }),
      agent({ agentId: 'agent002', label: 'audit:security', status: 'running', tokens: 1500, durationMs: 5000, model: 'claude-opus-4-5' }),
    ];
    sendRender(m);
    // Everything after the rail label sits in the wrapping body — that is
    // what keeps continuation lines indented to the rail at narrow widths.
    const name = q('.wf-hstrip-name')!;
    expect(name.parentElement!.classList.contains('wf-hstrip-body')).toBe(true);
    expect(name.getAttribute('title')).toBe('audit-run'); // full name rides the tooltip
    expect(q('.wf-hstrip-body .wf-mode-toggle')).not.toBeNull();
    // Meta: duration + tokens + shared model = three atomic items; the
    // separator dot rides INSIDE each non-first span, never orphaned.
    const items = qa('.wf-hstrip-meta-item');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toBe('1m 5s');
    expect(items[1].textContent).toBe('· 3.0k tokens');
    for (const item of items.slice(1)) { expect(item.textContent).toMatch(/^· /); }
    // The session button's word is hideable at narrow width; glyph + title remain.
    const openconv = q('.wf-hstrip-openconv')!;
    expect(openconv.querySelector('.wf-openconv-text')!.textContent).toBe('session');
    // CSS contract: the title is the one unit that gives way (ellipsis).
    const css = fs.readFileSync(path.join(process.cwd(), 'media', 'detailView.css'), 'utf-8');
    expect(css).toMatch(/\.wf-hstrip-name\s*{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.wf-hstrip-meta-item\s*{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.wf-hstrip-body\s*{[^}]*flex-wrap:\s*wrap/);
  });

  it('header model on a mixed run names the most recent agent\'s model with a "+N" count and the full set in the tooltip', () => {
    const m = logModel() as any;
    m.groups[0].agents = [
      agent({ agentId: 'agent001', label: 'audit:privacy', model: 'claude-sonnet-5' }),
      agent({ agentId: 'agent002', label: 'audit:security', model: 'claude-opus-4-8' }),
      agent({ agentId: 'agent003', label: 'audit:perf', status: 'running', model: 'claude-fable-5' }),
    ];
    sendRender(m);
    const items = qa('.wf-hstrip-meta-item');
    const modelItem = items[items.length - 1];
    // Most recently listed agent's model wins the visible label, not the
    // first — the old behaviour hid the model entirely on any mismatch.
    expect(modelItem.textContent).toContain('Fable 5 +2');
    const tooltip = modelItem.querySelector('span[title]')!;
    expect(tooltip.getAttribute('title')).toBe('Sonnet 5, Opus 4.8, Fable 5');
  });

  it('display-bar controls sit in their own wrapping body after the rail label', () => {
    sendRender(logModel());
    expect(q('.wf-facets > .wf-zone-label')).not.toBeNull(); // label outside the wrapper
    const body = q('.wf-facets > .wf-facets-body')!;
    expect(body).not.toBeNull();
    expect(body.querySelectorAll('.wf-facet-kind')).toHaveLength(4);
    expect(body.querySelector('.wf-facet-time')).not.toBeNull();
    expect(body.querySelector('.wf-facet-foldall')).not.toBeNull();
    expect(body.querySelector('.wf-facet-search')).not.toBeNull();
    const css = fs.readFileSync(path.join(process.cwd(), 'media', 'detailView.css'), 'utf-8');
    expect(css).toMatch(/\.wf-facets-body\s*{[^}]*flex-wrap:\s*wrap/);
  });

  it('narrow register: view row + agent strip collapse by default, explicit choices win, toggle writes explicit', async () => {
    // Re-import with matchMedia stubbed NARROW (jsdom has none; the module
    // guard treats its absence as wide, which is why every other test in
    // this file exercises the wide register untouched).
    const stubMatchMedia = (matches: boolean) => {
      (window as any).matchMedia = (query: string) => ({
        matches, media: query,
        addEventListener: () => {}, removeEventListener: () => {},
      });
    };
    try {
      document.body.innerHTML = '<div id="wf-root"></div>';
      vi.resetModules();
      stubMatchMedia(true);
      await import('./detailView.js');
      sendRender(logModel());
      // No explicit choice stored → the narrow default is collapsed.
      expect(q('.wf-view-row')!.classList.contains('collapsed')).toBe(true);
      expect(q('.wf-agentstrip')!.classList.contains('collapsed')).toBe(true);

      // The collapse control toggles FROM the effective (collapsed) state
      // and writes the explicit value.
      q('.wf-zone-collapse[data-zone="views"]')!.click();
      expect(q('.wf-view-row')!.classList.contains('collapsed')).toBe(false);
      expect((webviewState as { viewRowCollapsed?: boolean | null }).viewRowCollapsed).toBe(false);
      q('.wf-zone-collapse[data-zone="agents"]')!.click();
      expect(q('.wf-agentstrip')!.classList.contains('collapsed')).toBe(false);
      expect((webviewState as { agentStripCollapsed?: boolean | null }).agentStripCollapsed).toBe(false);

      // A 1.16.0 user's persisted explicit false stays expanded at narrow —
      // the stored boolean loads as an explicit choice.
      document.body.innerHTML = '<div id="wf-root"></div>';
      vi.resetModules();
      webviewState = { viewRowCollapsed: false, agentStripCollapsed: false };
      await import('./detailView.js');
      sendRender(logModel());
      expect(q('.wf-view-row')!.classList.contains('collapsed')).toBe(false);
      expect(q('.wf-agentstrip')!.classList.contains('collapsed')).toBe(false);
    } finally {
      delete (window as any).matchMedia; // never leak narrow into later imports
    }
  });

  it('CSS contract: the 720px narrow register exists — slimmer gutter, icon-only session, relaxed search', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'media', 'detailView.css'), 'utf-8');
    const media = css.match(/@media\s*\(max-width:\s*720px\)\s*{([\s\S]*?)\n}/);
    expect(media).not.toBeNull();
    expect(media![1]).toMatch(/--wf-gutter:\s*56px/);
    expect(media![1]).toMatch(/\.wf-openconv-text\s*{\s*display:\s*none/);
    expect(media![1]).toMatch(/\.wf-facet-search-input\s*{\s*min-width:\s*90px/);
  });
});

describe('detailView.ts — native escape hatches (Phase 4, DESIGN-DETAIL-PANE-V2.md)', () => {
  beforeEach(async () => {
    postedMessages = [];
    // Phase 2.1 (E) hid Tool rows by default; every test here expands a tool
    // row, so seed the persisted filter set with Tool enabled (the same
    // mechanism a user's own toggle persists through).
    webviewState = { kindFilters: { tool: true } };
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
  // Phase 2.2 (C): the strip collapses to one line by default, so each of
  // these expands it first — the chips live behind the expand now.

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
    q('.wf-rstrip-head')!.click();
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
    q('.wf-rstrip-head')!.click();
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
    q('.wf-rstrip-head')!.click();
    postedMessages.length = 0;
    const chip = q('.wf-rstrip-chip.clickable')!;
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect((postedMessages as any[]).some(m => m.type === 'showFileChanges')).toBe(true);
  });
});
