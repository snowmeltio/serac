/**
 * @vitest-environment jsdom
 *
 * Structural DOM tests for panel.ts.
 * Tests element creation, class toggling, and data binding.
 * Does NOT test: scroll behaviour, FLIP animations, CSS rendering, message round-trips.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Messages captured from vscode.postMessage */
let postedMessages: unknown[] = [];

/** Minimal vscode API mock */
const mockVscodeApi = {
  postMessage: (msg: unknown) => { postedMessages.push(msg); },
  getState: () => undefined as Record<string, unknown> | undefined,
  setState: vi.fn(),
};

// Must be set before panel.ts IIFE runs
(globalThis as any).acquireVsCodeApi = () => mockVscodeApi;

/** Dispatch an update message to the panel */
function sendUpdate(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'update', waitingCount: 0, workspacePath: '/test', ...data },
  }));
}

/** Create a minimal session snapshot for testing */
function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    slug: 'test-slug',
    cwd: '/test',
    workspaceKey: '-test',
    topic: 'Test session',
    status: 'running',
    activity: 'Reading file',
    subagents: [],
    lastActivity: Date.now(),
    firstActivity: Date.now() - 60000,
    dismissed: false,
    contextTokens: 50000,
    searchText: 'test',
    modelLabel: 'Opus',
    title: null,
    customTitle: '',
    aiTitle: '',
    confidence: 'high',
    ...overrides,
  };
}

describe('panel.ts integration', () => {
  beforeEach(async () => {
    postedMessages = [];
    mockVscodeApi.setState.mockClear();

    // Reset DOM to match panelProvider.ts template
    document.body.innerHTML = `
      <div id="root">
        <div class="empty-state">
          <div class="icon">\u2298</div>
          <div>Loading...</div>
        </div>
      </div>
    `;

    // Re-import to re-execute the IIFE against fresh DOM
    // vitest module cache must be invalidated
    vi.resetModules();
    (globalThis as any).acquireVsCodeApi = () => mockVscodeApi;
    await import('./panel.js');
  });

  it('renders empty state when no sessions', () => {
    sendUpdate({ sessions: [] });
    const empty = document.querySelector('.empty-state');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('No Claude Code sessions');
  });

  it('creates top bar with status summary', () => {
    sendUpdate({ sessions: [makeSession({ status: 'running' })] });
    const topBar = document.querySelector('.top-bar');
    expect(topBar).toBeTruthy();
    const summary = topBar!.querySelector('.status-summary');
    expect(summary!.textContent).toContain('1 running');
  });

  it('creates card with correct data-status class', () => {
    const sess = makeSession({ status: 'waiting' });
    sendUpdate({ sessions: [sess] });
    const card = document.querySelector('.card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.classList.contains('waiting')).toBe(true);
    expect(card.dataset.sessionId).toBe(sess.sessionId);
  });

  it('sets data-confidence attribute on cards', () => {
    sendUpdate({ sessions: [makeSession({ confidence: 'low' })] });
    const card = document.querySelector('.card') as HTMLElement;
    expect(card.dataset.confidence).toBe('low');
  });

  it('renders multiple sessions with correct count', () => {
    sendUpdate({
      sessions: [
        makeSession({ status: 'running' }),
        makeSession({ status: 'waiting' }),
        makeSession({ status: 'done' }),
      ],
    });
    const cards = document.querySelectorAll('.card');
    expect(cards.length).toBe(3);
    const summary = document.querySelector('.status-summary')!;
    expect(summary.textContent).toContain('1 running');
    expect(summary.textContent).toContain('1 waiting');
    expect(summary.textContent).toContain('1 done');
  });

  it('renders dismissed sessions in archive section', () => {
    sendUpdate({
      sessions: [
        makeSession({ status: 'done', dismissed: true, topic: 'Archived' }),
        makeSession({ status: 'running', topic: 'Active' }),
      ],
    });
    // Active card should exist
    const cards = document.querySelectorAll('.card:not(.card-leave)');
    expect(cards.length).toBe(1);
    // Archive section should have a compact row
    const archiveRows = document.querySelectorAll('.compact-row');
    expect(archiveRows.length).toBeGreaterThanOrEqual(1);
  });

  it('renders time-range bar with range buttons', () => {
    sendUpdate({
      sessions: [makeSession({ status: 'done', dismissed: true })],
    });
    const rangeBtns = document.querySelectorAll('[data-range]');
    expect(rangeBtns.length).toBeGreaterThan(0);
    const ranges = Array.from(rangeBtns).map(b => (b as HTMLElement).dataset.range);
    expect(ranges).toContain('1d');
    expect(ranges).toContain('7d');
    expect(ranges).toContain('all');
  });

  it('renders subagents on cards', () => {
    sendUpdate({
      sessions: [makeSession({
        subagents: [
          { parentToolUseId: 't1', description: 'Explore code', running: true, waitingOnPermission: false, startedAt: Date.now(), resultPreview: null, toolsCompleted: 3, blocking: true },
          { parentToolUseId: 't2', description: 'Run tests', running: false, waitingOnPermission: false, startedAt: Date.now() - 5000, resultPreview: 'All passed', toolsCompleted: 1, blocking: false },
        ],
      })],
    });
    const card = document.querySelector('.card')!;
    // Should have subagent elements
    const subagentEls = card.querySelectorAll('.subagent, .subagent-row, [class*="subagent"]');
    expect(subagentEls.length).toBeGreaterThan(0);
  });

  it('posts focusSession on card click', () => {
    const sess = makeSession();
    sendUpdate({ sessions: [sess] });
    const card = document.querySelector('.card') as HTMLElement;
    card.click();
    const focusMsg = postedMessages.find((m: any) => m.type === 'focusSession');
    expect(focusMsg).toBeTruthy();
    expect((focusMsg as any).sessionId).toBe(sess.sessionId);
  });

  it('renders foreign workspaces section', () => {
    sendUpdate({
      sessions: [makeSession()],
      foreignWorkspaces: [
        { workspaceKey: '-other-ws', displayName: 'Other Project', cwd: '/other/project', counts: { running: 2, waiting: 1, done: 3 }, confidence: 'medium' },
      ],
    });
    const foreignRows = document.querySelector('.ws-foreign-rows');
    expect(foreignRows).toBeTruthy();
    expect(foreignRows!.textContent).toContain('Other Project');
    expect(foreignRows!.textContent).toContain('1W');
    expect(foreignRows!.textContent).toContain('2R');
    expect(foreignRows!.textContent).toContain('3D');
  });

  it('groups sibling foreign workspaces under parent path header', () => {
    sendUpdate({
      sessions: [makeSession()],
      foreignWorkspaces: [
        { workspaceKey: '-ws-a', displayName: 'alpha', cwd: '/repos/snowmeltio/alpha', counts: { running: 1 }, confidence: 'medium' },
        { workspaceKey: '-ws-b', displayName: 'beta', cwd: '/repos/snowmeltio/beta', counts: { done: 2 }, confidence: 'low' },
        { workspaceKey: '-ws-c', displayName: 'solo', cwd: '/other/solo', counts: { done: 1 }, confidence: 'low' },
      ],
    });
    const foreignRows = document.querySelector('.ws-foreign-rows');
    expect(foreignRows).toBeTruthy();
    // Should have a group header for /repos/snowmeltio/
    const groupHeaders = foreignRows!.querySelectorAll('.ws-group-header');
    expect(groupHeaders.length).toBe(1);
    expect(groupHeaders[0].textContent).toContain('/repos/snowmeltio/');
    // Siblings should be sorted alphabetically within the group
    const rows = foreignRows!.querySelectorAll('.ws-row');
    const names = Array.from(rows).map(r => r.querySelector('.ws-name')?.textContent);
    expect(names).toEqual(['alpha', 'beta', 'solo']);
  });

  it('does not group singletons under a parent header', () => {
    sendUpdate({
      sessions: [makeSession()],
      foreignWorkspaces: [
        { workspaceKey: '-ws-a', displayName: 'alpha', cwd: '/path-a/alpha', counts: { done: 1 }, confidence: 'low' },
        { workspaceKey: '-ws-b', displayName: 'beta', cwd: '/path-b/beta', counts: { done: 1 }, confidence: 'low' },
      ],
    });
    const foreignRows = document.querySelector('.ws-foreign-rows');
    const groupHeaders = foreignRows!.querySelectorAll('.ws-group-header');
    expect(groupHeaders.length).toBe(0);
  });

  it('sorts active groups before inactive groups', () => {
    sendUpdate({
      sessions: [makeSession()],
      foreignWorkspaces: [
        { workspaceKey: '-ws-a', displayName: 'a-idle', cwd: '/idle-parent/a-idle', counts: { done: 1 }, confidence: 'low' },
        { workspaceKey: '-ws-b', displayName: 'b-idle', cwd: '/idle-parent/b-idle', counts: { done: 1 }, confidence: 'low' },
        { workspaceKey: '-ws-c', displayName: 'c-active', cwd: '/active-parent/c-active', counts: { running: 1 }, confidence: 'medium' },
        { workspaceKey: '-ws-d', displayName: 'd-active', cwd: '/active-parent/d-active', counts: { done: 2 }, confidence: 'low' },
      ],
    });
    const foreignRows = document.querySelector('.ws-foreign-rows');
    const groupHeaders = foreignRows!.querySelectorAll('.ws-group-header');
    expect(groupHeaders.length).toBe(2);
    // Active group should come first
    expect(groupHeaders[0].textContent).toContain('/active-parent/');
    expect(groupHeaders[1].textContent).toContain('/idle-parent/');
  });

  it('renders status summary without action buttons (actions live in title bar)', () => {
    sendUpdate({ sessions: [makeSession()] });
    expect(document.querySelector('.top-bar .status-summary')).toBeTruthy();
    expect(document.getElementById('newChatBtn')).toBeNull();
    expect(document.getElementById('cleanupBtn')).toBeNull();
  });
});
