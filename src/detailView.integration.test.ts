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

function sendTranscript(key: string, entries: { timestamp: string; role: string; content: string }[]): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'agentTranscript', key, entries } }));
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
    chips: [],
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
    webviewState = undefined;
    document.body.innerHTML = '<div id="wf-root"></div>';
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
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
      chips: [],
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
});

describe('detailView.ts — live transcript refresh', () => {
  beforeEach(async () => {
    postedMessages = [];
    webviewState = undefined;
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

  /** A subagents drill-in with one running in-process teammate. */
  function teammateModel(over: Partial<{ status: string; teammate: boolean }> = {}) {
    return {
      source: 'subagents', containerId: 'lead-001', sessionId: 'sess1',
      title: 'Teammates', chips: ['team'], metrics: '1 teammate', team: 'my-team',
      groups: [{ key: '', title: null, status: null, agents: [
        { agentId: 'deadbeef', label: 'defender', status: over.status ?? 'running',
          tokens: 0, toolCalls: 0, durationMs: null, model: '', teammate: over.teammate ?? true },
      ] }],
      views: [{ id: 'subagents', kind: 'subagents', label: 'Teammates', status: 'running', active: true }],
    };
  }

  beforeEach(async () => {
    postedMessages = [];
    webviewState = undefined;
    document.body.innerHTML = '<div id="wf-root"></div>' + COMPOSER_HTML;
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./detailView.js');
  });

  it('stays hidden while the flag is off', () => {
    sendRender(teammateModel());
    expect(composer().hidden).toBe(true);
  });

  it('shows for a running teammate once the flag is on, and marks body.composer-open', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel());
    expect(composer().hidden).toBe(false);
    expect(document.body.classList.contains('composer-open')).toBe(true);
  });

  it('stays hidden for a non-running teammate even with the flag on', () => {
    sendSettings({ teammateMessaging: true, operatorName: 'murray' });
    sendRender(teammateModel({ status: 'done' }));
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
      tokens: 0, toolCalls: 0, durationMs: null, model: '', teammate: true,
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
      tokens: 0, toolCalls: 0, durationMs: null, model: '', teammate: true,
    });
    sendRender(m, { groupKey: '', agentId: 'deadbeef' });
    cInput().value = 'for defender';
    cSend().click();
    sendRender(m, { groupKey: '', agentId: 'cafef00d' }); // switch mid-flight
    sendReply(false, 'send failed');
    expect(cInput().value).toBe(''); // defender's draft must not land in skeptic's box
    expect(cSend().disabled).toBe(false); // button still released
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
    webviewState = undefined;
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
