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

/** Dispatch a settings message to the panel. Pass a partial settings shape;
 *  unspecified sections fall back to the defaults. */
function sendSettings(overrides: any = {}): void {
  const defaults = {
    show: { foreignWorkspaces: true, worktrees: true, usage: true, subagents: false, workflows: true },
    archive: { defaultRange: '1d', maxDoneShown: 20 },
    refresh: { intervalSeconds: 5 },
    discovery: { ageGateDays: 7 },
    foreignWorkspaces: { maxHeightPx: 280 },
    worktrees: { maxHeightPx: 280, autoCollapseAfterSeconds: 20 },
    usage: { showWeekly: true, warnAtPercent: 85, criticalAtPercent: 100 },
    animations: { enabled: true },
    cleanup: { confirmRequired: true },
  };
  // Shallow-merge each top-level section so callers can override one field.
  const merged: any = { ...defaults };
  for (const key of Object.keys(overrides)) {
    merged[key] = { ...(defaults as any)[key], ...overrides[key] };
  }
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'settings', settings: merged },
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

  it('moves a card between sections on status change without duplicating it', () => {
    const sess = makeSession({ status: 'running' });
    sendUpdate({ sessions: [sess] });
    const active = document.querySelector('.card-section:not(.done-section)')!;
    expect(active.querySelectorAll('.card').length).toBe(1);

    // Status flips running -> done: the card must end up in the done
    // section, with exactly one element for the session across the panel
    // (the old element is removed outright, not left as a fading ghost).
    sendUpdate({ sessions: [{ ...sess, status: 'done' }] });
    const all = document.querySelectorAll(`.card[data-session-id="${sess.sessionId}"]`);
    expect(all.length).toBe(1);
    expect(all[0].closest('.done-section')).toBeTruthy();
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

  it('renders not-done subagents as inline agent rows on cards', () => {
    sendSettings({ show: { subagents: true } });
    sendUpdate({
      sessions: [makeSession({
        subagents: [
          { parentToolUseId: 't1', description: 'Explore code', running: true, waitingOnPermission: false, startedAt: Date.now(), resultPreview: null, toolsCompleted: 3, blocking: true },
          { parentToolUseId: 't2', description: 'Run tests', running: false, waitingOnPermission: false, startedAt: Date.now() - 5000, resultPreview: 'All passed', toolsCompleted: 1, blocking: false },
        ],
      })],
    });
    const card = document.querySelector('.card')!;
    // The still-working subagent shows inline; the done one is click-through only.
    const rows = card.querySelectorAll('.card-agent-row[data-detail-source="subagents"]');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.card-agent-name')!.textContent).toBe('Explore code');
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

  it('scrolls a newly auto-focused card into view (focusSession from the extension)', () => {
    const a = makeSession({ sessionId: 'sess-a', status: 'running' });
    const b = makeSession({ sessionId: 'sess-b', status: 'running' });
    sendUpdate({ sessions: [a, b] });
    const cardB = Array.from(document.querySelectorAll('.card'))
      .find(el => (el as HTMLElement).dataset.sessionId === 'sess-b') as HTMLElement;
    // jsdom does not implement scrollIntoView; install a spy on the element.
    const spy = vi.fn();
    cardB.scrollIntoView = spy;
    // A plain render must NOT scroll — only the auto-focus message reveals.
    sendUpdate({ sessions: [a, b] });
    expect(spy).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'focusSession', sessionId: 'sess-b' },
    }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ block: 'nearest' });
    expect(cardB.classList.contains('focused')).toBe(true);
  });

  it('does not render sibling-worktree sessions as cards (Worktrees pane handles them)', () => {
    const localSess = makeSession({ sessionId: 'local-1', status: 'running' });
    const siblingSess = makeSession({
      sessionId: 'sib-1',
      status: 'running',
      worktreeRoot: '/test-spike-a',
      worktreeLabel: 'test-spike-a',
    });
    sendUpdate({ sessions: [localSess, siblingSess] });
    const cards = document.querySelectorAll('.card');
    expect(cards).toHaveLength(1);
    expect((cards[0] as HTMLElement).dataset.sessionId).toBe('local-1');
  });

  it('keeps sessions whose worktreeRoot equals the current workspace (current workspace is a worktree)', () => {
    // workspacePath defaults to '/test'. When the current workspace IS a
    // worktree, its sessions carry worktreeRoot = workspacePath. Those are
    // local and must stay in the main card list.
    const sess = makeSession({
      sessionId: 'local-wt',
      status: 'running',
      worktreeRoot: '/test',
      worktreeLabel: 'test',
    });
    sendUpdate({ sessions: [sess] });
    const cards = document.querySelectorAll('.card');
    expect(cards).toHaveLength(1);
    expect((cards[0] as HTMLElement).dataset.sessionId).toBe('local-wt');
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

  it('aggregates worktrees of the same repo into a single row with a worktree-count chip', () => {
    sendUpdate({
      sessions: [makeSession()],
      foreignWorkspaces: [
        { workspaceKey: '-ws-a', displayName: 'feat-a', cwd: '/repos/myrepo/feat-a', repoRoot: '/repos/myrepo', counts: { running: 1, done: 2 }, confidence: 'medium' },
        { workspaceKey: '-ws-b', displayName: 'feat-b', cwd: '/repos/myrepo/feat-b', repoRoot: '/repos/myrepo', counts: { running: 1 }, confidence: 'medium' },
        { workspaceKey: '-ws-c', displayName: 'main', cwd: '/repos/myrepo', repoRoot: '/repos/myrepo', counts: { done: 1 }, confidence: 'low' },
      ],
    });
    const foreignRows = document.querySelector('.ws-foreign-rows');
    expect(foreignRows).toBeTruthy();
    const rows = foreignRows!.querySelectorAll('.ws-row');
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.querySelector('.ws-name')?.textContent).toBe('myrepo');
    const chip = row.querySelector('.worktree-count-chip');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe('3wt');
    const counts = row.querySelector('.ws-counts')!.textContent;
    expect(counts).toContain('2R');
    expect(counts).toContain('3D');
  });

  it('does not collapse unrelated workspaces that just share a parent dir', () => {
    sendUpdate({
      sessions: [makeSession()],
      foreignWorkspaces: [
        { workspaceKey: '-ws-a', displayName: 'alpha', cwd: '/path-a/alpha', counts: { done: 1 }, confidence: 'low' },
        { workspaceKey: '-ws-b', displayName: 'beta', cwd: '/path-b/beta', counts: { done: 1 }, confidence: 'low' },
      ],
    });
    const foreignRows = document.querySelector('.ws-foreign-rows');
    const rows = foreignRows!.querySelectorAll('.ws-row');
    expect(rows.length).toBe(2);
    const names = Array.from(rows).map(r => r.querySelector('.ws-name')?.textContent);
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('renders status summary without action buttons (actions live in title bar)', () => {
    sendUpdate({ sessions: [makeSession()] });
    expect(document.querySelector('.top-bar .status-summary')).toBeTruthy();
    expect(document.getElementById('newChatBtn')).toBeNull();
    expect(document.getElementById('cleanupBtn')).toBeNull();
  });

  describe('worktree picker', () => {
    /** Build a foreign workspaces payload mirroring what ForeignWorkspaceManager
     *  emits when two worktrees of the same repo are tracked. The extension
     *  emits raw per-workspace rows; groupForeignWorkspaces (run inside the
     *  webview) aggregates them. */
    function pickerFixture() {
      const worktrees = [
        { path: '/repos/myrepo', branch: 'main', isMain: true },
        { path: '/repos/myrepo-feat-a', branch: 'feat-a', isMain: false },
        { path: '/repos/myrepo-feat-b', branch: 'feat-b', isMain: false },
      ];
      return [
        { workspaceKey: '-ws-a', displayName: 'feat-a', cwd: '/repos/myrepo-feat-a', repoRoot: '/repos/myrepo', counts: { running: 1, done: 2 }, confidence: 'medium', worktrees },
        { workspaceKey: '-ws-b', displayName: 'feat-b', cwd: '/repos/myrepo-feat-b', repoRoot: '/repos/myrepo', counts: { waiting: 1 }, confidence: 'medium', worktrees },
      ];
    }

    it('aggregated row with worktrees array is rendered as expandable (chevron, no data-cwd)', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: pickerFixture() });
      const row = document.querySelector('.ws-foreign-rows .ws-row') as HTMLElement;
      expect(row).toBeTruthy();
      expect(row.classList.contains('ws-row-expandable')).toBe(true);
      expect(row.dataset.cwd).toBeUndefined();
      expect(row.dataset.workspaceKey).toBe('repo:/repos/myrepo');
      expect(row.querySelector('.ws-chevron')).toBeTruthy();
    });

    it('clicking expandable row does NOT post openWorkspace; instead reveals picker children', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: pickerFixture() });
      const row = document.querySelector('.ws-row-expandable') as HTMLElement;
      postedMessages = [];
      row.click();
      expect(postedMessages.find((m: any) => m?.type === 'openWorkspace')).toBeUndefined();
      const children = document.querySelectorAll('.ws-picker-child');
      expect(children.length).toBeGreaterThan(0);
      // Children carry data-cwd and a parent-key so collapse-on-pick can fire.
      const first = children[0] as HTMLElement;
      expect(first.dataset.cwd).toBeTruthy();
      expect(first.dataset.parentKey).toBe('repo:/repos/myrepo');
    });

    it('picker children include the main checkout with a `main` chip', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: pickerFixture() });
      (document.querySelector('.ws-row-expandable') as HTMLElement).click();
      const children = Array.from(document.querySelectorAll('.ws-picker-child')) as HTMLElement[];
      const mainChild = children.find(c => c.dataset.cwd === '/repos/myrepo');
      expect(mainChild).toBeTruthy();
      expect(mainChild!.querySelector('.ws-main-chip')).toBeTruthy();
    });

    it('picker children show per-worktree counts from matching member workspace', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: pickerFixture() });
      (document.querySelector('.ws-row-expandable') as HTMLElement).click();
      const featA = document.querySelector('.ws-picker-child[data-cwd="/repos/myrepo-feat-a"]') as HTMLElement;
      expect(featA).toBeTruthy();
      const counts = featA.querySelector('.ws-counts')!.textContent;
      expect(counts).toContain('1R');
      expect(counts).toContain('2D');
      const featB = document.querySelector('.ws-picker-child[data-cwd="/repos/myrepo-feat-b"]') as HTMLElement;
      expect(featB.querySelector('.ws-counts')!.textContent).toContain('1W');
    });

    it('worktrees with no matching member render a quiet "no activity" hint', () => {
      // feat-b worktree exists but has no member entry (no Claude Code activity)
      const worktrees = [
        { path: '/repos/myrepo', branch: 'main', isMain: true },
        { path: '/repos/myrepo-feat-a', branch: 'feat-a', isMain: false },
        { path: '/repos/myrepo-feat-untouched', branch: 'feat-untouched', isMain: false },
      ];
      const foreignWorkspaces = [
        { workspaceKey: '-ws-a', displayName: 'feat-a', cwd: '/repos/myrepo-feat-a', repoRoot: '/repos/myrepo', counts: { running: 1 }, confidence: 'medium', worktrees },
        { workspaceKey: '-ws-main', displayName: 'main', cwd: '/repos/myrepo', repoRoot: '/repos/myrepo', counts: { done: 1 }, confidence: 'medium', worktrees },
      ];
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces });
      (document.querySelector('.ws-row-expandable') as HTMLElement).click();
      const untouched = document.querySelector('.ws-picker-child[data-cwd="/repos/myrepo-feat-untouched"]') as HTMLElement;
      expect(untouched).toBeTruthy();
      expect(untouched.querySelector('.ws-picker-quiet')).toBeTruthy();
    });

    it('picker excludes the current workspace from child rows', () => {
      // workspacePath is '/repos/myrepo', so the main checkout should be filtered out
      sendUpdate({
        sessions: [makeSession()],
        workspacePath: '/repos/myrepo',
        foreignWorkspaces: pickerFixture(),
      });
      (document.querySelector('.ws-row-expandable') as HTMLElement).click();
      const children = Array.from(document.querySelectorAll('.ws-picker-child')) as HTMLElement[];
      const cwds = children.map(c => c.dataset.cwd);
      expect(cwds).not.toContain('/repos/myrepo');
      expect(cwds).toContain('/repos/myrepo-feat-a');
    });

    it('clicking a picker child posts openWorkspace with the child path and collapses the parent', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: pickerFixture() });
      (document.querySelector('.ws-row-expandable') as HTMLElement).click();
      postedMessages = [];
      const featA = document.querySelector('.ws-picker-child[data-cwd="/repos/myrepo-feat-a"]') as HTMLElement;
      featA.click();
      const openMsg = postedMessages.find((m: any) => m?.type === 'openWorkspace') as any;
      expect(openMsg).toBeTruthy();
      expect(openMsg.cwd).toBe('/repos/myrepo-feat-a');
      // Parent collapsed: chevron no longer expanded, children gone.
      expect(document.querySelectorAll('.ws-picker-child').length).toBe(0);
      const chevron = document.querySelector('.ws-chevron');
      expect(chevron!.classList.contains('expanded')).toBe(false);
    });

    it('clicking the expandable row twice toggles open then closed', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: pickerFixture() });
      const row = () => document.querySelector('.ws-row-expandable') as HTMLElement;
      row().click();
      expect(document.querySelectorAll('.ws-picker-child').length).toBeGreaterThan(0);
      row().click();
      expect(document.querySelectorAll('.ws-picker-child').length).toBe(0);
    });

    it('single-worktree foreign rows are NOT expandable and open immediately', () => {
      sendUpdate({
        sessions: [makeSession()],
        foreignWorkspaces: [
          { workspaceKey: '-ws-x', displayName: 'lone', cwd: '/path/lone', repoRoot: '/path/lone', counts: { done: 1 }, confidence: 'low' },
        ],
      });
      const row = document.querySelector('.ws-foreign-rows .ws-row') as HTMLElement;
      expect(row.classList.contains('ws-row-expandable')).toBe(false);
      expect(row.dataset.cwd).toBe('/path/lone');
      postedMessages = [];
      row.click();
      const openMsg = postedMessages.find((m: any) => m?.type === 'openWorkspace') as any;
      expect(openMsg).toBeTruthy();
      expect(openMsg.cwd).toBe('/path/lone');
    });

    it('aggregated row without worktrees array falls back to direct-open (legacy path)', () => {
      // No worktrees on the foreign workspaces (e.g. foreign manager hasn't
      // populated yet, or repo dir was removed). Aggregation still happens
      // via groupForeignWorkspaces, but the row isn't a picker.
      sendUpdate({
        sessions: [makeSession()],
        foreignWorkspaces: [
          { workspaceKey: '-ws-a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo', counts: { done: 1 }, confidence: 'low' },
          { workspaceKey: '-ws-b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo', counts: { done: 1 }, confidence: 'low' },
        ],
      });
      const row = document.querySelector('.ws-foreign-rows .ws-row') as HTMLElement;
      expect(row.classList.contains('ws-row-expandable')).toBe(false);
      expect(row.dataset.cwd).toBeTruthy();
    });
  });

  describe('tmp pseudo-repo picker', () => {
    /** Per-workspace scratch rows as ForeignWorkspaceManager emits them with
     *  the overlay on: shared pseudo repoRoot, no worktrees array. The webview's
     *  groupForeignWorkspaces folds them into one pseudoRepo row. */
    function scratchFixture() {
      return [
        { workspaceKey: '-private-tmp-serac-hook-spike', displayName: 'serac-hook-spike', cwd: '/private/tmp/serac-hook-spike', repoRoot: '/private/tmp', counts: { running: 1 }, confidence: 'medium' },
        { workspaceKey: '-private-tmp-serac-spike-subagent', displayName: 'serac-spike-subagent', cwd: '/private/tmp/serac-spike-subagent', repoRoot: '/private/tmp', counts: { stale: 1 }, confidence: 'low' },
      ];
    }

    it('consolidates scratch dirs into one expandable tmp row with a dir-count chip', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: scratchFixture() });
      const rows = document.querySelectorAll('.ws-foreign-rows .ws-row');
      expect(rows.length).toBe(1);
      const row = rows[0] as HTMLElement;
      expect(row.querySelector('.ws-name')!.textContent).toBe('tmp');
      expect(row.classList.contains('ws-row-expandable')).toBe(true);
      expect(row.dataset.cwd).toBeUndefined();
      expect(row.dataset.workspaceKey).toBe('repo:/private/tmp');
      // Chip reuses the 'wt' suffix but marks pseudo rows with '*'.
      const chip = row.querySelector('.worktree-count-chip')!;
      expect(chip.textContent).toBe('2wt*');
    });

    it('expanding lists one child per scratch dir (no main/no-activity hints)', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: scratchFixture() });
      (document.querySelector('.ws-row-expandable') as HTMLElement).click();
      const children = Array.from(document.querySelectorAll('.ws-picker-child')) as HTMLElement[];
      expect(children.map(c => c.dataset.cwd).sort()).toEqual([
        '/private/tmp/serac-hook-spike',
        '/private/tmp/serac-spike-subagent',
      ]);
      expect(document.querySelector('.ws-main-chip')).toBeNull();
      expect(document.querySelector('.ws-picker-quiet')).toBeNull();
      expect(children[0].dataset.parentKey).toBe('repo:/private/tmp');
    });

    it('clicking a scratch child opens that directory', () => {
      sendUpdate({ sessions: [makeSession()], foreignWorkspaces: scratchFixture() });
      (document.querySelector('.ws-row-expandable') as HTMLElement).click();
      postedMessages = [];
      const child = document.querySelector('.ws-picker-child[data-cwd="/private/tmp/serac-hook-spike"]') as HTMLElement;
      child.click();
      const openMsg = postedMessages.find((m: any) => m?.type === 'openWorkspace') as any;
      expect(openMsg).toBeTruthy();
      expect(openMsg.cwd).toBe('/private/tmp/serac-hook-spike');
    });
  });

  describe('visibility settings', () => {
    it('hides foreign workspaces section when show.foreignWorkspaces is false', () => {
      sendSettings({ show: { foreignWorkspaces: false } });
      sendUpdate({
        sessions: [makeSession()],
        foreignWorkspaces: [
          { workspaceKey: '-other', displayName: 'Other', cwd: '/other', counts: { running: 1 }, confidence: 'high' },
        ],
      });
      expect(document.querySelector('.ws-foreign-rows')).toBeFalsy();
    });

    it('hides worktrees pane when show.worktrees is false', () => {
      sendSettings({ show: { worktrees: false } });
      sendUpdate({
        sessions: [makeSession()],
        worktrees: [
          { path: '/repo/wt-a', branch: 'main', displayName: 'wt-a', counts: { running: 1 }, confidence: 'high', isCurrent: false, isMain: true },
        ],
      });
      expect(document.querySelector('.ws-worktree-rows')).toBeFalsy();
    });

    it('hides usage section when show.usage is false', () => {
      sendSettings({ show: { usage: false } });
      sendUpdate({
        sessions: [makeSession()],
        usage: { loaded: true, apiConnected: true, platformSupported: true, quotaPct5h: 50, resetTime: Date.now() + 3_600_000, lastPoll: Date.now() },
      });
      expect(document.querySelector('.usage-section')).toBeFalsy();
    });

    it('omits subagent rows when show.subagents is false', () => {
      sendSettings({ show: { subagents: false } });
      sendUpdate({
        sessions: [makeSession({
          subagents: [
            { parentToolUseId: 't1', description: 'Explore', running: true, waitingOnPermission: false, startedAt: Date.now(), resultPreview: null, toolsCompleted: 1, blocking: true },
          ],
        })],
      });
      // Subagent containers/items should not be in the DOM
      expect(document.querySelector('.subagent-section')).toBeFalsy();
    });

    it('restoring show.foreignWorkspaces re-renders the section on the next update', () => {
      sendSettings({ show: { foreignWorkspaces: false } });
      sendUpdate({
        sessions: [makeSession()],
        foreignWorkspaces: [{ workspaceKey: '-other', displayName: 'Other', cwd: '/other', counts: { running: 1 }, confidence: 'high' }],
      });
      expect(document.querySelector('.ws-foreign-rows')).toBeFalsy();

      sendSettings({ show: { foreignWorkspaces: true } });
      sendUpdate({
        sessions: [makeSession()],
        foreignWorkspaces: [{ workspaceKey: '-other', displayName: 'Other', cwd: '/other', counts: { running: 1 }, confidence: 'high' }],
      });
      expect(document.querySelector('.ws-foreign-rows')).toBeTruthy();
    });

    it('applies maxHeightPx as a CSS custom property; 0 maps to "none"', () => {
      sendSettings({ foreignWorkspaces: { maxHeightPx: 0 }, worktrees: { maxHeightPx: 500, autoCollapseAfterSeconds: 20 } });
      const docRootStyle = document.documentElement.style;
      expect(docRootStyle.getPropertyValue('--serac-foreign-max-height')).toBe('none');
      expect(docRootStyle.getPropertyValue('--serac-worktrees-max-height')).toBe('500px');
    });

    it('disabling animations sets transition vars to 0ms', () => {
      sendSettings({ animations: { enabled: false } });
      const docRootStyle = document.documentElement.style;
      expect(docRootStyle.getPropertyValue('--serac-transition-ms')).toBe('0ms');
      expect(docRootStyle.getPropertyValue('--serac-foreign-slide-ms')).toBe('0ms');
    });
  });

  describe('workflow cards', () => {
    /** Minimal PanelWorkflow snapshot (mirrors the subset panel.ts consumes). */
    function makeWorkflow(overrides: Record<string, unknown> = {}) {
      return {
        runId: 'wf_' + Math.random().toString(36).slice(2, 10),
        sessionId: 'wf-sess',
        name: 'consistency-audit',
        status: 'completed',
        source: 'sidecar',
        phases: [
          { index: 1, title: 'Audit' },
          { index: 2, title: 'Synthesise' },
        ],
        agents: [
          { phaseIndex: 1, status: 'done' },
          { phaseIndex: 1, status: 'done' },
          { phaseIndex: 2, status: 'done' },
        ],
        counts: { done: 3 },
        agentCount: 3,
        totalTokens: 120000,
        totalToolCalls: 18,
        durationMs: 95000,
        ...overrides,
      };
    }

    it('appends one robot view chip to the card meta row when the session owns a run', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess' })],
      });
      const chip = document.querySelector('.card-meta .wf-view-chip') as HTMLElement;
      expect(chip).toBeTruthy();
      // One umbrella glyph for everything under a card — 🤖. All agents done
      // here, so no live count; the word lives in the tooltip/aria only.
      expect(chip.textContent).toContain('\u{1F916}');
      expect(chip.querySelector('.agent-live-count')).toBeFalsy();
      expect(chip.querySelector('.wf-arrow')).toBeTruthy();
      expect(chip.classList.contains('detail-chip')).toBe(true);
      expect(chip.dataset.detailSource).toBe('workflow');
      expect(chip.dataset.detailContainer).toBe('wf-sess');
      expect(chip.getAttribute('aria-label')).toBe('agents');
    });

    it('the robot chip counts live agents (workflow agents + subagents) and labels the tooltip', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({
        sessions: [makeSession({
          sessionId: 'wf-sess', status: 'running',
          subagents: [{ agentId: 'bg1', description: 'background builder', running: true }],
        })],
        workflows: [makeWorkflow({
          runId: 'wf_live2', sessionId: 'wf-sess', status: 'running', counts: { done: 1, running: 1, waiting: 1 },
          agents: [
            { phaseIndex: 1, status: 'done', agentId: 'd1' },
            { phaseIndex: 1, status: 'running', agentId: 'r1' },
            { phaseIndex: 2, status: 'waiting', agentId: 'w1' },
          ],
        })],
      });
      const chip = document.querySelector('.card-meta .wf-view-chip') as HTMLElement;
      // 2 live workflow agents (running + waiting) + 1 live subagent.
      expect(chip.querySelector('.agent-live-count')!.textContent).toBe('3');
      expect(chip.getAttribute('aria-label')).toBe('agents — 3 running');
    });

    it('a done card with a live background agent keeps a running-tinted chip, count, and roster row', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({
        sessions: [makeSession({
          sessionId: 'bg-sess', status: 'done',
          subagents: [
            { agentId: 'bg1', description: 'vp matrix build', running: true, background: true },
            { agentId: 'done1', description: 'recon', running: false },
          ],
        })],
      });
      const card = document.querySelector('.card')!;
      const chip = card.querySelector('.wf-view-chip') as HTMLElement;
      // The chip tints by the agents' own state, not the done card's.
      expect(chip.classList.contains('wf-chip-running')).toBe(true);
      expect(chip.querySelector('.agent-live-count')!.textContent).toBe('1');
      // The live robot earns its inline roster row despite the done status.
      const rows = card.querySelectorAll('.card-agent-row');
      expect(Array.from(rows).map(r => r.querySelector('.card-agent-name')!.textContent)).toEqual(['vp matrix build']);
    });

    it('a completed run shows the chip but NO bar, count tick, or inline rows', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess' })], // default: completed, all done
      });
      const card = document.querySelector('.card')!;
      expect(card.querySelector('.wf-view-chip')).toBeTruthy();
      // No progress bar, no "✓ N agents" tick — done agents are click-through only.
      expect(card.querySelector('.wf-bar')).toBeFalsy();
      expect(card.querySelector('.wf-rollup')).toBeFalsy();
      expect(card.querySelector('.card-agent-row')).toBeFalsy();
    });

    it('a running run lists its still-working agents inline (excludes done), no bar', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess', status: 'running' })],
        workflows: [makeWorkflow({
          runId: 'wf_live1', sessionId: 'wf-sess', status: 'running', counts: { done: 1, running: 2 },
          agents: [
            { phaseIndex: 1, status: 'done', agentId: 'd1', label: 'done one' },
            { phaseIndex: 1, status: 'running', agentId: 'r1', label: 'reviewer' },
            { phaseIndex: 2, status: 'waiting', agentId: 'w1', label: 'waiter' },
          ],
        })],
      });
      const card = document.querySelector('.card')!;
      expect(card.querySelector('.wf-bar')).toBeFalsy();
      const rows = card.querySelectorAll('.card-agent-row[data-detail-source="workflow"]');
      // Only the still-working agents appear inline; the done one is click-through only.
      expect(Array.from(rows).map(r => r.querySelector('.card-agent-name')!.textContent)).toEqual(['reviewer', 'waiter']);
      // Each row deep-links to its agent under the run's groupKey (= runId).
      expect((rows[0] as HTMLElement).dataset.group).toBe('wf_live1');
      expect((rows[0] as HTMLElement).dataset.agent).toBe('r1');
      expect((rows[0] as HTMLElement).dataset.detailSession).toBe('wf-sess');
    });

    it('a killed/incomplete run shows no inline rows (terminal — chip only)', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess', status: 'stale' })],
        workflows: [makeWorkflow({
          sessionId: 'wf-sess', status: 'incomplete', counts: {},
          agents: [
            { phaseIndex: 1, status: 'running', agentId: 'r1', label: 'abandoned' },
          ],
        })],
      });
      const card = document.querySelector('.card')!;
      expect(card.querySelector('.card-agent-row')).toBeFalsy();
      expect(card.querySelector('.wf-bar')).toBeFalsy();
      expect(card.querySelector('.wf-view-chip')).toBeTruthy();
    });

    it('plain session (no run) shows no chip and no inline rows', () => {
      sendUpdate({ sessions: [makeSession({ sessionId: 'plain' })] });
      const card = document.querySelector('.card')!;
      expect(card.querySelector('.wf-view-chip')).toBeFalsy();
      expect(card.querySelector('.card-agent-row')).toBeFalsy();
    });

    it('clicking the chip posts openDetail for the workflow source and focuses the conversation', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess' })],
      });
      postedMessages = [];
      (document.querySelector('.wf-view-chip') as HTMLElement).click();
      expect(postedMessages).toContainEqual({
        type: 'openDetail', source: 'workflow', containerId: 'wf-sess', sessionId: 'wf-sess',
      });
      expect(postedMessages.filter((m: any) => m.type === 'focusSession')).toEqual([{ type: 'focusSession', sessionId: 'wf-sess' }]);
    });

    it('Enter on the focused chip posts openDetail', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess' })],
      });
      postedMessages = [];
      const chip = document.querySelector('.wf-view-chip') as HTMLElement;
      chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(postedMessages).toContainEqual({
        type: 'openDetail', source: 'workflow', containerId: 'wf-sess', sessionId: 'wf-sess',
      });
    });

    it('tints the chip by the run state (completed → done, running → running, failed → failed)', () => {
      sendUpdate({ sessions: [makeSession({ sessionId: 'wf-sess' })], workflows: [makeWorkflow({ sessionId: 'wf-sess', status: 'completed' })] });
      expect((document.querySelector('.wf-view-chip') as HTMLElement).classList.contains('wf-chip-done')).toBe(true);

      sendUpdate({ sessions: [makeSession({ sessionId: 'wf-sess' })], workflows: [makeWorkflow({ sessionId: 'wf-sess', status: 'running' })] });
      expect((document.querySelector('.wf-view-chip') as HTMLElement).classList.contains('wf-chip-running')).toBe(true);

      sendUpdate({ sessions: [makeSession({ sessionId: 'wf-sess' })], workflows: [makeWorkflow({ sessionId: 'wf-sess', status: 'failed' })] });
      expect((document.querySelector('.wf-view-chip') as HTMLElement).classList.contains('wf-chip-failed')).toBe(true);

      // Killed/abandoned ≠ errored: incomplete gets its own warning-orange
      // state, matching the detail panel (audit ui-consistency-2).
      sendUpdate({ sessions: [makeSession({ sessionId: 'wf-sess' })], workflows: [makeWorkflow({ sessionId: 'wf-sess', status: 'incomplete' })] });
      expect((document.querySelector('.wf-view-chip') as HTMLElement).classList.contains('wf-chip-incomplete')).toBe(true);
    });

    it('tints the chip running for a live run even when the parent card is done/idle', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess', status: 'done' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess', status: 'running' })],
      });
      const chip = document.querySelector('.wf-view-chip') as HTMLElement;
      expect(chip.classList.contains('wf-chip-running')).toBe(true);
      expect(chip.classList.contains('wf-chip-done')).toBe(false);
    });

    it('consolidates to ONE "agents" chip when the session has both a run and subagents', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess', subagents: [{ description: 'explore', running: false }] })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess' })],
      });
      const chips = document.querySelectorAll('.card-meta .detail-chip');
      expect(chips).toHaveLength(1);
      const chip = chips[0] as HTMLElement;
      expect(chip.textContent).toContain('\u{1F916}');
      expect(chip.getAttribute('aria-label')).toContain('agents');
      // Initial source is the workflow (richer); the in-pane switcher carries the
      // subagents view, so there is no separate subagents chip on the card.
      expect(chip.dataset.detailSource).toBe('workflow');
      expect(document.querySelector('.detail-chip[data-detail-source="subagents"]')).toBeFalsy();
    });

    it('show.workflows=false removes the chip and any inline rows', () => {
      sendSettings({ show: { workflows: false } });
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess', status: 'running' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess', status: 'running', agents: [{ phaseIndex: 1, status: 'running', agentId: 'r1', label: 'x' }] })],
      });
      const card = document.querySelector('.card')!;
      expect(card.querySelector('.wf-view-chip')).toBeFalsy();
      expect(card.querySelector('.card-agent-row[data-detail-source="workflow"]')).toBeFalsy();
    });

    it('re-enabling show.workflows restores the chip on the next update', () => {
      sendSettings({ show: { workflows: false } });
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess' })],
      });
      expect(document.querySelector('.wf-view-chip')).toBeFalsy();

      sendSettings({ show: { workflows: true } });
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeWorkflow({ sessionId: 'wf-sess' })],
      });
      expect(document.querySelector('.wf-view-chip')).toBeTruthy();
    });

    it('multiple runs on one session still collapse to ONE chip', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [
          makeWorkflow({ sessionId: 'wf-sess', runId: 'wf_recent' }),
          makeWorkflow({ sessionId: 'wf-sess', runId: 'wf_older' }),
        ],
      });
      expect(document.querySelector('.card')!.querySelectorAll('.wf-view-chip').length).toBe(1);
    });
  });

  describe('workflow archive', () => {
    /** A run snapshot with the timestamp fields the archive pipeline reads. */
    function makeRun(overrides: Record<string, unknown> = {}) {
      return {
        runId: 'wf_archived',
        sessionId: 'wf-sess',
        name: 'consistency-audit',
        status: 'completed',
        source: 'sidecar',
        phases: [{ index: 1, title: 'Audit' }],
        agents: [{ phaseIndex: 1, status: 'done' }],
        counts: { done: 1 },
        agentCount: 1,
        totalTokens: 1000,
        totalToolCalls: 4,
        durationMs: 1000,
        startTime: Date.now() - 1000,
        dismissed: false,
        ...overrides,
      };
    }

    it('renders a dismissed run as a workflow-compact-row in the archive, not a roll-up', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess', status: 'running' })],
        workflows: [makeRun({ dismissed: true })],
      });
      // The parent session card stays — only the run roll-up is archived.
      const card = document.querySelector('.card[data-session-id="wf-sess"]')!;
      expect(card).toBeTruthy();
      expect(card.querySelector('.wf-rollup')).toBeFalsy();
      // And a compact archive row appears, badged "wf".
      const row = document.querySelector('.archive-list .workflow-compact-row') as HTMLElement;
      expect(row).toBeTruthy();
      expect(row.dataset.runId).toBe('wf_archived');
      expect(row.querySelector('.wf-badge')!.textContent).toBe('wf');
      expect(row.querySelector('.compact-name')!.textContent).toContain('consistency-audit');
    });

    it('clicking the archive row posts undismissWorkflow', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeRun({ dismissed: true })],
      });
      postedMessages = [];
      (document.querySelector('.archive-list .workflow-compact-row') as HTMLElement).click();
      expect(postedMessages).toContainEqual({ type: 'undismissWorkflow', runId: 'wf_archived' });
    });

    it('shows no dismiss affordance on an active run — a workflow follows its parent session', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeRun({ dismissed: false })],
      });
      // The "agents" chip surfaces the run, but there is no per-run × to archive
      // it: a workflow belongs to its parent session and is dismissed with it.
      expect(document.querySelector('.card[data-session-id="wf-sess"] .wf-view-chip')).toBeTruthy();
      expect(document.querySelector('.wf-dismiss')).toBeFalsy();
      expect(document.querySelector('[data-dismiss-workflow]')).toBeFalsy();
    });

    it('interleaves archived sessions, teams, and workflows newest-first', () => {
      const base = Date.now();
      sendUpdate({
        // session oldest, team middle, workflow newest — all within the last day
        // so the default 1d range shows them all.
        sessions: [makeSession({ sessionId: 'old-sess', status: 'done', dismissed: true, lastActivity: base - 3000 })],
        teams: [{
          teamId: 'orch-1', name: 'mid-team',
          orchestrator: { sessionId: 'orch-1', status: 'done', activity: '', confidence: 'high', contextTokens: 0, modelLabel: 'Opus' },
          agents: [], counts: {}, updatedAt: base - 2000, dismissed: true,
        }],
        workflows: [makeRun({ runId: 'wf_new', sessionId: 'wf-sess', dismissed: true, startTime: base - 1000, durationMs: 0 })],
      });
      const rows = Array.from(document.querySelectorAll('.archive-list > div')) as HTMLElement[];
      const order = rows.map(r => r.className);
      // Newest (workflow) first, then team, then session.
      expect(order[0]).toContain('workflow-compact-row');
      expect(order[1]).toContain('team-compact-row');
      expect(order[2]).toContain('compact-row');
    });

    it('keeps an old archived team/workflow visible under the default 1d range (no age-window on containers)', () => {
      const base = Date.now();
      const threeDays = 3 * 24 * 60 * 60 * 1000;
      // A team and a workflow whose recency ts is 3 days old, plus a 3-day-old
      // plain session — under the default '1d' range only the session is hidden.
      sendUpdate({
        sessions: [makeSession({ sessionId: 'old-sess', status: 'done', dismissed: true, lastActivity: base - threeDays })],
        teams: [{
          teamId: 'orch-old', name: 'old-team',
          orchestrator: { sessionId: 'orch-old', status: 'done', activity: '', confidence: 'high', contextTokens: 0, modelLabel: 'Opus' },
          agents: [], counts: {}, updatedAt: base - threeDays, dismissed: true,
        }],
        workflows: [makeRun({ runId: 'wf_old', sessionId: 'wf-sess', dismissed: true, startTime: base - threeDays, durationMs: 0 })],
      });
      // Containers survive the window; the old plain session does not.
      expect(document.querySelector('.archive-list .team-compact-row')).toBeTruthy();
      expect(document.querySelector('.archive-list .workflow-compact-row')).toBeTruthy();
      expect(document.querySelector('.archive-list .compact-row[data-session-id="old-sess"]')).toBeFalsy();
    });

    it('Enter on a focused archive row posts undismissWorkflow', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess' })],
        workflows: [makeRun({ dismissed: true })],
      });
      postedMessages = [];
      const row = document.querySelector('.archive-list .workflow-compact-row') as HTMLElement;
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(postedMessages).toContainEqual({ type: 'undismissWorkflow', runId: 'wf_archived' });
    });
  });

  describe('view subagents chip', () => {
    const subs = [
      { description: 'explore auth', running: false },
      { description: 'explore db', running: true },
    ];

    it('appends an "agents" chip (subagents source) when the session has subagents', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa-sess', subagents: subs })] });
      const chip = document.querySelector('.card-meta .detail-chip[data-detail-source="subagents"]') as HTMLElement;
      expect(chip).toBeTruthy();
      // One umbrella glyph; the source attribute still routes the drill-in.
      expect(chip.textContent).toContain('\u{1F916}');
      expect(chip.getAttribute('aria-label')).toContain('agents');
      expect(chip.dataset.detailContainer).toBe('sa-sess');
      expect(chip.dataset.detailSession).toBe('sa-sess');
    });

    it('clicking it posts openDetail for the subagents source', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa-sess', subagents: subs })] });
      postedMessages = [];
      (document.querySelector('.detail-chip[data-detail-source="subagents"]') as HTMLElement).click();
      expect(postedMessages).toContainEqual({
        type: 'openDetail', source: 'subagents', containerId: 'sa-sess', sessionId: 'sa-sess',
      });
    });

    it('omits the chip on a session with no subagents', () => {
      sendUpdate({ sessions: [makeSession({ sessionId: 'plain', subagents: [] })] });
      expect(document.querySelector('.detail-chip[data-detail-source="subagents"]')).toBeFalsy();
    });

    it('tints the subagents chip by state (running, or waiting when one awaits permission)', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa-sess', subagents: subs })] }); // explore db is running
      expect((document.querySelector('.detail-chip[data-detail-source="subagents"]') as HTMLElement)
        .classList.contains('wf-chip-running')).toBe(true);

      sendUpdate({ sessions: [makeSession({ sessionId: 'sa-sess', subagents: [{ description: 'gated', running: true, waitingOnPermission: true }] })] });
      expect((document.querySelector('.detail-chip[data-detail-source="subagents"]') as HTMLElement)
        .classList.contains('wf-chip-waiting')).toBe(true);
    });

    it('keeps the chip when show.subagents is false — it opens the detail panel, not the inline rows', () => {
      sendSettings({ show: { subagents: false } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa-sess', subagents: subs })] });
      expect(document.querySelector('.detail-chip[data-detail-source="subagents"]')).toBeTruthy();
      // The inline rows the setting actually controls stay hidden.
      expect(document.querySelector('.card-agent-list')).toBeFalsy();
    });
  });

  describe('team folds into the orchestrator card', () => {
    // A team has no separate section: it rides on its orchestrator's normal
    // session card (we always go through the lead), and its in-process teammates
    // surface as that session's subagents — framed as teammates.
    function makeTeam(overrides: Record<string, unknown> = {}) {
      return {
        teamId: 'at:cupcake-lab',
        name: 'cupcake-lab',
        orchestrator: {
          sessionId: 'orch-1', status: 'running', activity: 'leading',
          confidence: 'high', contextTokens: 5000, modelLabel: 'Opus',
        },
        agents: [],
        counts: {},
        updatedAt: Date.now(),
        dismissed: false,
        ...overrides,
      };
    }
    const teammates = [
      { description: 'crumb', running: true },
      { description: 'frosting', running: false },
    ];

    it('renders no separate Agent teams section', () => {
      sendUpdate({ sessions: [makeSession({ sessionId: 'orch-1', subagents: teammates })], teams: [makeTeam()] });
      expect(document.querySelector('.team-section')).toBeFalsy();
      expect(document.querySelector('.team-orchestrator')).toBeFalsy();
    });

    it('gives the orchestrator card the same "agents" chip (subagents source)', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'orch-1', subagents: teammates })], teams: [makeTeam()] });
      const card = document.querySelector('.card[data-session-id="orch-1"]')!;
      const chip = card.querySelector('.detail-chip[data-detail-source="subagents"]') as HTMLElement;
      expect(chip).toBeTruthy();
      // One glyph for all agents; the teammate framing lives in the detail panel,
      // not the card. No special "team" label, no summary line on the card.
      expect(chip.textContent).toContain('\u{1F916}');
      expect(card.querySelector('.subagent-summary')).toBeFalsy();
    });

    it('opens the drill-in (subagents source, where teammates live) on click', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'orch-1', subagents: teammates })], teams: [makeTeam()] });
      postedMessages = [];
      (document.querySelector('.card[data-session-id="orch-1"] .detail-chip[data-detail-source="subagents"]') as HTMLElement).click();
      expect(postedMessages).toContainEqual({
        type: 'openDetail', source: 'subagents', containerId: 'orch-1', sessionId: 'orch-1',
      });
    });

    it('uses the same "agents" chip on a session that is not a team', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'plain', subagents: teammates })] });
      const chip = document.querySelector('.card[data-session-id="plain"] .detail-chip[data-detail-source="subagents"]') as HTMLElement;
      expect(chip.textContent).toContain('\u{1F916}');
      expect(document.querySelector('.card[data-session-id="plain"] .subagent-summary')).toBeFalsy();
    });
  });

  describe('inline not-done agent rows', () => {
    it('lists not-done subagents inline and excludes done ones', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa', status: 'running', subagents: [
        { agentId: 'a1', description: 'running one', running: true },
        { agentId: 'a2', description: 'waiting one', running: true, waitingOnPermission: true },
        { agentId: 'a3', description: 'done one', running: false },
      ] })] });
      const rows = document.querySelectorAll('.card[data-session-id="sa"] .card-agent-row');
      expect(rows.length).toBe(2);
      expect(Array.from(rows).map(r => r.querySelector('.card-agent-name')!.textContent)).toEqual(['running one', 'waiting one']);
    });

    it('caps height for scroll (renders all not-done rows; CSS scrolls past ~6)', () => {
      sendSettings({ show: { subagents: true } });
      const many = Array.from({ length: 9 }, (_, i) => ({ agentId: 'a' + i, description: 'agent ' + i, running: true }));
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa', status: 'running', subagents: many })] });
      expect(document.querySelectorAll('.card[data-session-id="sa"] .card-agent-list .card-agent-row').length).toBe(9);
    });

    it('clicking an inline subagent row deep-links openDetail to that agent', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa', status: 'running', subagents: [
        { agentId: 'a1', description: 'running one', running: true },
      ] })] });
      postedMessages = [];
      (document.querySelector('.card[data-session-id="sa"] .card-agent-row') as HTMLElement).click();
      expect(postedMessages).toContainEqual({ type: 'openDetail', source: 'subagents', containerId: 'sa', sessionId: 'sa', agentId: 'a1', groupKey: '' });
    });

    it('lists not-done workflow agents inline and deep-links with the runId as groupKey', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({
        sessions: [makeSession({ sessionId: 'wf-sess', status: 'running' })],
        workflows: [{
          runId: 'wf_live', sessionId: 'wf-sess', name: 'live-run', status: 'running', source: 'sidecar',
          phases: [{ index: 1, title: 'Go' }], counts: { running: 1, done: 1 }, agentCount: 2,
          totalTokens: 0, totalToolCalls: 0, durationMs: 0, startTime: Date.now() - 1000, dismissed: false,
          agents: [
            { phaseIndex: 1, status: 'running', agentId: 'wfa1', label: 'reviewer' },
            { phaseIndex: 1, status: 'done', agentId: 'wfa2', label: 'done one' },
          ],
        }],
      });
      const rows = document.querySelectorAll('.card[data-session-id="wf-sess"] .card-agent-row[data-detail-source="workflow"]');
      expect(rows.length).toBe(1);
      expect(rows[0].querySelector('.card-agent-name')!.textContent).toBe('reviewer');
      postedMessages = [];
      (rows[0] as HTMLElement).click();
      expect(postedMessages).toContainEqual({ type: 'openDetail', source: 'workflow', containerId: 'wf-sess', sessionId: 'wf-sess', agentId: 'wfa1', groupKey: 'wf_live' });
    });

    it('Enter on an inline row activates the deep-link (not the card-body open)', () => {
      sendSettings({ show: { subagents: true } });
      sendUpdate({ sessions: [makeSession({ sessionId: 'sa', status: 'running', subagents: [
        { agentId: 'a1', description: 'running one', running: true },
      ] })] });
      postedMessages = [];
      const row = document.querySelector('.card[data-session-id="sa"] .card-agent-row') as HTMLElement;
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(postedMessages.some((m: any) => m.type === 'openDetail' && m.agentId === 'a1')).toBe(true);
    });
  });

  describe('background-shell badge', () => {
    it('renders a running-tinted badge on a done card with a live background shell', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'bg-1', status: 'done', backgroundShellCount: 1 })],
      });
      const badge = document.querySelector('.card-meta .bg-shell-badge') as HTMLElement;
      expect(badge).toBeTruthy();
      expect(badge.textContent).toContain('1 shell running');
      // Non-status: the card keeps its real status (done), badge is additive.
      expect(document.querySelector('.card')!.classList.contains('done')).toBe(true);
    });

    it('pluralises the count', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'bg-2', status: 'done', backgroundShellCount: 3 })],
      });
      expect((document.querySelector('.bg-shell-badge') as HTMLElement).textContent).toContain('3 shells running');
    });

    it('omits the badge when there are no background shells', () => {
      sendUpdate({ sessions: [makeSession({ sessionId: 'bg-3', status: 'done' })] });
      expect(document.querySelector('.bg-shell-badge')).toBeFalsy();
    });

    it('omits the badge when the count is zero', () => {
      sendUpdate({
        sessions: [makeSession({ sessionId: 'bg-4', status: 'done', backgroundShellCount: 0 })],
      });
      expect(document.querySelector('.bg-shell-badge')).toBeFalsy();
    });
  });

  describe('keyboard: native card buttons keep their own activation', () => {
    it('Enter on a card action button does not steal focus to the card', () => {
      sendUpdate({ sessions: [makeSession({ sessionId: 'kb-sess' })] });
      postedMessages = [];
      const btn = document.querySelector('.transcript-btn') as HTMLElement;
      expect(btn).toBeTruthy();
      // The delegated keydown handler must bail on native <button>s rather than
      // matching the enclosing .card (which would preventDefault the button's own
      // activation and fire focusSession instead). So: no focusSession posted.
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(postedMessages.filter((m: any) => m.type === 'focusSession').length).toBe(0);
    });
  });
});
