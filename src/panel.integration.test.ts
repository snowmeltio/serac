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
    show: { foreignWorkspaces: true, worktrees: true, usage: true, subagents: true, teams: true },
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
});
