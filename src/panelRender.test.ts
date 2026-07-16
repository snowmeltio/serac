/**
 * Unit tests for the pure HTML renderers extracted from the panel.ts IIFE
 * (audit refactor-panel-4). These run without jsdom — every renderer is
 * string-in, string-out, with ambient state passed via RenderContext.
 * Structural DOM behaviour (reconciler, FLIP, event wiring) stays covered by
 * panel.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { PanelSession } from './panelUtils.js';
import {
  DEFAULT_PANEL_SETTINGS,
  agentsChipHtml,
  archiveListHtml,
  countLiveAgents,
  detailChipState,
  emptyStateHtml,
  modelHue,
  renderCardInner,
  renderCompactRow,
  renderDetailChip,
  renderFooterSlots,
  renderInlineAgents,
  renderTeamCompactRow,
  renderUsageHtml,
  renderWorkflowBlock,
  renderWorkflowCompactRow,
  renderWorktreeRow,
  renderWsRow,
  statusSummaryHtml,
  tildeAbbrev,
  timeRangePillsHtml,
  type PanelTeam,
  type PanelWorkflow,
  type PanelWorktreeRow,
  type RenderContext,
  type WorkspaceGroup,
} from './panelRender.js';

const NOW = 1_750_000_000_000;

function makeCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    settings: DEFAULT_PANEL_SETTINGS,
    workspacePath: '/Users/me/repos/proj',
    homeDir: '/Users/me',
    fileCollisions: new Map(),
    workflowsBySession: new Map(),
    compactSettings: null,
    expandedWorkspaces: new Set(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<PanelSession> = {}): PanelSession {
  return {
    sessionId: 'sess-1234abcd',
    status: 'running',
    lastActivity: NOW - 60_000,
    ...overrides,
  } as PanelSession;
}

function makeWorkflow(overrides: Partial<PanelWorkflow> = {}): PanelWorkflow {
  return {
    runId: 'wf_abc123',
    sessionId: 'sess-1234abcd',
    name: 'review-changes',
    status: 'running',
    source: 'live',
    phases: [],
    agents: [],
    counts: {},
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    durationMs: null,
    startTime: NOW - 120_000,
    dismissed: false,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<PanelTeam> = {}): PanelTeam {
  return {
    teamId: 'at:demo',
    name: 'demo',
    orchestrator: {
      sessionId: 'sess-lead', status: 'running', activity: '',
      confidence: 'high', contextTokens: 0, modelLabel: 'Opus',
    },
    agents: [],
    counts: {},
    updatedAt: NOW - 60_000,
    dismissed: true,
    ...overrides,
  };
}

// ===== chip state & counts =====

describe('detailChipState', () => {
  it('a waiting subagent outranks everything', () => {
    expect(detailChipState(
      [makeWorkflow({ status: 'failed' })],
      [{ description: 'a', running: true, waitingOnPermission: true }],
    )).toBe('waiting');
  });

  it('running workflow or subagent outranks failed/incomplete', () => {
    expect(detailChipState([makeWorkflow({ status: 'running' })], [])).toBe('running');
    expect(detailChipState(
      [makeWorkflow({ status: 'failed' })],
      [{ description: 'a', running: true }],
    )).toBe('running');
  });

  it('failed outranks incomplete, which outranks done', () => {
    expect(detailChipState([
      makeWorkflow({ status: 'failed' }), makeWorkflow({ status: 'incomplete' }),
    ], [])).toBe('failed');
    expect(detailChipState([makeWorkflow({ status: 'incomplete' })], [])).toBe('incomplete');
    expect(detailChipState([makeWorkflow({ status: 'completed' })], [])).toBe('done');
    expect(detailChipState(undefined, undefined)).toBe('done');
  });
});

describe('countLiveAgents', () => {
  it('sums running/waiting workflow agents and live subagents', () => {
    const wfs = [makeWorkflow({
      agents: [
        { phaseIndex: 0, status: 'running' },
        { phaseIndex: 0, status: 'waiting' },
        { phaseIndex: 0, status: 'completed' },
      ],
    })];
    const subs = [
      { description: 'a', running: true },
      { description: 'b', running: false, waitingOnPermission: true },
      { description: 'c', running: false },
    ];
    expect(countLiveAgents(wfs, subs)).toBe(4);
    expect(countLiveAgents(undefined, undefined)).toBe(0);
  });
});

describe('agentsChipHtml', () => {
  it('renders glyph only at zero and a count above', () => {
    expect(agentsChipHtml(0)).toBe('🤖');
    expect(agentsChipHtml(3)).toContain('<span class="agent-live-count">3</span>');
  });
});

describe('modelHue', () => {
  it('is stable and within [0, 360)', () => {
    expect(modelHue('Opus')).toBe(modelHue('Opus'));
    for (const label of ['Opus', 'Sonnet', 'Haiku', 'Fable']) {
      const h = modelHue(label);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('gives known families a fixed cost-tier hue, cheapest closest to blue', () => {
    // Pinned so a future edit to MODEL_COST_HUE is a deliberate, reviewed change.
    expect(modelHue('Haiku')).toBe(208);
    expect(modelHue('Sonnet')).toBe(232);
    expect(modelHue('Opus')).toBe(38);
    expect(modelHue('Fable')).toBe(18);
  });

  it('gives Fable and Mythos the same hue — same price, same tier', () => {
    expect(modelHue('Mythos')).toBe(modelHue('Fable'));
  });

  it('falls back to a stable hash hue for a family not yet classified', () => {
    expect(modelHue('Zephyr')).toBe(modelHue('Zephyr'));
    expect(modelHue('Zephyr')).not.toBe(modelHue('Opus'));
  });
});

describe('model pill hue with unconfirmed (*-suffixed) labels', () => {
  it('an unconfirmed bare-tier guess shares its hue with the confirmed tier', () => {
    // "Opus*" (guessed, no version yet) must hash to the same --model-hue as
    // "Opus" — the trailing '*' must not get glued onto the family word.
    const confirmed = renderCardInner(makeCtx(), makeSession({ modelLabel: 'Opus' }), NOW, false);
    const unconfirmed = renderCardInner(makeCtx(), makeSession({ modelLabel: 'Opus*' }), NOW, false);
    const hueOf = (html: string) => html.match(/--model-hue:(-?\d+)/)?.[1];
    expect(hueOf(unconfirmed)).toBe(hueOf(confirmed));
  });

  it('an unconfirmed versioned guess shares its hue with the confirmed version', () => {
    const confirmed = renderCardInner(makeCtx(), makeSession({ modelLabel: 'Opus 4.8' }), NOW, false);
    const unconfirmed = renderCardInner(makeCtx(), makeSession({ modelLabel: 'Opus 4.8*' }), NOW, false);
    const hueOf = (html: string) => html.match(/--model-hue:(-?\d+)/)?.[1];
    expect(hueOf(unconfirmed)).toBe(hueOf(confirmed));
  });
});

// ===== chips and inline rows =====

describe('renderDetailChip', () => {
  it('carries the drill-in data attributes and escapes the label', () => {
    const html = renderDetailChip('a <b> label', 'workflow', 'cid', 'sid', 'running');
    expect(html).toContain('data-detail-source="workflow"');
    expect(html).toContain('data-detail-container="cid"');
    expect(html).toContain('data-detail-session="sid"');
    expect(html).toContain('wf-chip-running');
    expect(html).toContain('a &lt;b&gt; label');
    expect(html).not.toContain('<b>');
  });
});

describe('renderInlineAgents', () => {
  it('returns empty string for no agents', () => {
    expect(renderInlineAgents([], 'subagents', 'c', 's', '')).toBe('');
  });

  it('renders a row per agent with status dot and deep-link attributes', () => {
    const html = renderInlineAgents(
      [
        { agentId: 'ag-1', label: 'finder <x>', status: 'running' },
        { agentId: null, label: 'judge', status: 'waiting' },
      ],
      'workflow', 'cid', 'sid', 'wf_run',
    );
    expect(html).toContain('card-agent-dot running');
    expect(html).toContain('card-agent-dot waiting');
    expect(html).toContain('data-agent="ag-1"');
    expect(html).toContain('data-agent=""');
    expect(html).toContain('data-group="wf_run"');
    expect(html).toContain('finder &lt;x&gt;');
  });
});

describe('renderWorkflowBlock', () => {
  it('renders nothing for a terminal run', () => {
    expect(renderWorkflowBlock([makeWorkflow({ status: 'completed' })])).toBe('');
    expect(renderWorkflowBlock([makeWorkflow({ status: 'incomplete' })])).toBe('');
  });

  it('lists only the still-working agents of a running run', () => {
    const html = renderWorkflowBlock([makeWorkflow({
      agents: [
        { phaseIndex: 0, status: 'running', agentId: 'ag-1', label: 'finder' },
        { phaseIndex: 0, status: 'completed', agentId: 'ag-2', label: 'done-agent' },
      ],
    })]);
    expect(html).toContain('finder');
    expect(html).not.toContain('done-agent');
  });
});

// ===== card inner =====

describe('renderCardInner', () => {
  it('renders name, status pill, id pill, and activity', () => {
    const html = renderCardInner(makeCtx(), makeSession({ activity: 'Running Bash' }), NOW, false);
    expect(html).toContain('status-pill');
    expect(html).toContain('sess-123');
    expect(html).toContain('Running Bash');
  });

  it('chip still reflects live subagents with show.subagents off — only the inline row is hidden', () => {
    const s = makeSession({
      subagents: [{ description: 'sub', running: true }],
    });
    const wfs = new Map([[s.sessionId, [makeWorkflow()]]]);
    const settings = {
      ...DEFAULT_PANEL_SETTINGS,
      show: { ...DEFAULT_PANEL_SETTINGS.show, subagents: false },
    };
    const html = renderCardInner(makeCtx({ settings, workflowsBySession: wfs }), s, NOW, false);
    // The chip is the click-through to the detail panel, not inline noise — it
    // stays live even with the rows hidden. Only the roster row is gated.
    expect(html).toContain('detail-chip');
    expect(html).toContain('agent-live-count');
    expect(html).not.toContain('card-agent-row');
  });

  it('chip appears (and is clickable) for a subagents-only session even with show.subagents off', () => {
    const s = makeSession({
      subagents: [{ description: 'sub', running: true }],
    });
    const settings = {
      ...DEFAULT_PANEL_SETTINGS,
      show: { ...DEFAULT_PANEL_SETTINGS.show, subagents: false },
    };
    const html = renderCardInner(makeCtx({ settings }), s, NOW, false);
    expect(html).toContain('detail-chip');
    expect(html).toContain('data-detail-source="subagents"');
    expect(html).toContain('agent-live-count');
  });

  it('subagent roster rows render for live subagents when enabled', () => {
    const s = makeSession({
      subagents: [
        { agentId: 'ag-1', description: 'worker', running: true },
        { agentId: 'ag-2', description: 'finished', running: false },
      ],
    });
    const html = renderCardInner(makeCtx({
      settings: { ...DEFAULT_PANEL_SETTINGS, show: { ...DEFAULT_PANEL_SETTINGS.show, subagents: true } },
    }), s, NOW, false);
    expect(html).toContain('card-agent-row');
    expect(html).toContain('worker');
    expect(html).not.toContain('finished'); // only still-working agents inline
    expect(html).toContain('agent-live-count');
  });

  it('collision badge is gated on show.fileCollisions', () => {
    const s = makeSession();
    const collisions = new Map([[s.sessionId, ['/a/b.ts', '/a/c.ts']]]);
    const off = renderCardInner(makeCtx({ fileCollisions: collisions }), s, NOW, false);
    expect(off).not.toContain('shared file');
    const settings = {
      ...DEFAULT_PANEL_SETTINGS,
      show: { ...DEFAULT_PANEL_SETTINGS.show, fileCollisions: true },
    };
    const on = renderCardInner(makeCtx({ settings, fileCollisions: collisions }), s, NOW, false);
    expect(on).toContain('2 shared files');
  });

  it('external-writer badge names the state explicitly, not just via opacity', () => {
    const off = renderCardInner(makeCtx(), makeSession(), NOW, false);
    expect(off).not.toContain('external-writer-badge');
    const on = renderCardInner(makeCtx(), makeSession({ externalWriter: true }), NOW, false);
    expect(on).toContain('external-writer-badge');
    expect(on).toContain('Active elsewhere');
  });

  it('permission-mode badge renders the glyph and label for a known mode', () => {
    const html = renderCardInner(makeCtx(), makeSession({ permissionMode: 'bypassPermissions' }), NOW, false);
    expect(html).toContain('mode-badge-bypass');
    expect(html).toContain('🔀');
    expect(html).toContain('bypass');
  });

  it('permission-mode badge is absent for an unrecognised mode or when unset', () => {
    expect(renderCardInner(makeCtx(), makeSession(), NOW, false)).not.toContain('mode-badge');
    const html = renderCardInner(makeCtx(), makeSession({ permissionMode: 'dontAsk' }), NOW, false);
    expect(html).not.toContain('mode-badge');
  });

  it('context bar renders when contextTokens > 0 and respects compactSettings', () => {
    const s = makeSession({ contextTokens: 100_000, modelLabel: 'Opus' });
    const html = renderCardInner(makeCtx({ compactSettings: { autoCompactWindow: 200_000, autoCompactPct: 95 } }), s, NOW, false);
    expect(html).toContain('context-bar');
    expect(renderCardInner(makeCtx(), makeSession(), NOW, false)).not.toContain('context-bar');
  });

  it('a done card prefers the last assistant reply over the final activity', () => {
    const s = makeSession({ status: 'done', activity: 'Running Bash', lastAssistantText: 'All tests green.' });
    const html = renderCardInner(makeCtx(), s, NOW, false);
    expect(html).toContain('All tests green.');
    expect(html).not.toContain('Running Bash');
  });

  it('escapes session-derived text', () => {
    const s = makeSession({ customTitle: '<img src=x onerror=1>' });
    const html = renderCardInner(makeCtx(), s, NOW, false);
    expect(html).not.toContain('<img');
  });

  it('suppresses the quiet qualifier on a card owning a live workflow', () => {
    // Workflow-upgraded card: applyWorkflowLiveStatus pins it running+high even
    // though its own JSONL has been idle 13m (the fan-out runs under a separate
    // pipeline). The pill must read plain Running, not "quiet".
    const s = makeSession({ status: 'running', confidence: 'high', lastActivity: NOW - 13 * 60_000 });
    const wfs = new Map([[s.sessionId, [makeWorkflow({ status: 'running' })]]]);
    const html = renderCardInner(makeCtx({ workflowsBySession: wfs }), s, NOW, false);
    expect(html).toContain('status-pill');
    expect(html).not.toContain('quiet');
  });

  it('still flags quiet when the only workflow has stopped running (incomplete)', () => {
    const s = makeSession({ status: 'running', confidence: 'high', lastActivity: NOW - 13 * 60_000 });
    const wfs = new Map([[s.sessionId, [makeWorkflow({ status: 'incomplete' })]]]);
    const html = renderCardInner(makeCtx({ workflowsBySession: wfs }), s, NOW, false);
    expect(html).toContain('quiet');
  });

  it('still flags quiet on a plain running card with no workflow', () => {
    const s = makeSession({ status: 'running', confidence: 'high', lastActivity: NOW - 13 * 60_000 });
    const html = renderCardInner(makeCtx(), s, NOW, false);
    expect(html).toContain('quiet');
  });
});

// ===== foreign workspace / worktree rows =====

describe('tildeAbbrev', () => {
  it('abbreviates the home prefix and leaves other paths alone', () => {
    const ctx = makeCtx();
    expect(tildeAbbrev(ctx, '/Users/me/repos/x')).toBe('~/repos/x');
    expect(tildeAbbrev(ctx, '/opt/y')).toBe('/opt/y');
    expect(tildeAbbrev(makeCtx({ homeDir: '' }), '/Users/me/z')).toBe('/Users/me/z');
  });
});

describe('renderWsRow', () => {
  const aggregated: WorkspaceGroup = {
    workspaceKey: 'repo:/Users/me/repos/other',
    displayName: 'other',
    counts: { running: 1 },
    confidence: 'high',
    worktreeCount: 2,
    worktreeMembersLabel: 'main, spike',
    worktrees: [
      { path: '/Users/me/repos/other', branch: 'main', isMain: true },
      { path: '/Users/me/repos/other-spike', branch: 'spike', isMain: false },
    ],
    members: [],
  };

  it('an aggregated row with worktree data becomes an expandable picker (no data-cwd)', () => {
    const html = renderWsRow(makeCtx(), aggregated);
    expect(html).toContain('ws-row-expandable');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('ws-chevron');
    expect(html).toContain('2wt');
    expect(html).not.toContain('data-cwd');
    expect(html).not.toContain('ws-picker-children');
  });

  it('an expanded row renders picker children, skipping the current workspace', () => {
    const ctx = makeCtx({
      workspacePath: '/Users/me/repos/other',
      expandedWorkspaces: new Set(['repo:/Users/me/repos/other']),
    });
    const html = renderWsRow(ctx, aggregated);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('ws-picker-children');
    expect(html).toContain('data-cwd="/Users/me/repos/other-spike"');
    // The current workspace's own worktree is never offered as a target.
    expect(html).not.toContain('data-cwd="/Users/me/repos/other"');
  });

  it('a plain row opens its cwd directly', () => {
    const html = renderWsRow(makeCtx(), {
      workspaceKey: 'k', displayName: 'plain', counts: {}, cwd: '/Users/me/plain',
    });
    expect(html).toContain('data-cwd="/Users/me/plain"');
    expect(html).not.toContain('ws-chevron');
  });
});

describe('renderWorktreeRow', () => {
  const base: PanelWorktreeRow = {
    path: '/Users/me/repos/proj-wt', branch: 'feature', displayName: 'feature',
    counts: { running: 1 }, confidence: 'high', isCurrent: false, isMain: false,
  };

  it('a non-current row is clickable with data-cwd', () => {
    const html = renderWorktreeRow(makeCtx(), base);
    expect(html).toContain('ws-row-clickable');
    expect(html).toContain('data-cwd="/Users/me/repos/proj-wt"');
    expect(html).not.toContain('ws-current-pin');
  });

  it('the current row gets the pin and no data-cwd', () => {
    const html = renderWorktreeRow(makeCtx(), { ...base, isCurrent: true });
    expect(html).toContain('ws-row-current');
    expect(html).toContain('ws-current-pin');
    expect(html).not.toContain('data-cwd');
    expect(html).toContain('(current)');
  });
});

// ===== archive rows and list =====

describe('archive compact rows', () => {
  it('session row carries undismiss + transcript hooks', () => {
    const html = renderCompactRow(makeSession(), NOW);
    expect(html).toContain('data-session-id="sess-1234abcd"');
    expect(html).toContain('data-transcript-id="sess-1234abcd"');
  });

  it('team row deep-links the team detail view', () => {
    const html = renderTeamCompactRow(makeTeam());
    expect(html).toContain('data-team-id="at:demo"');
    expect(html).toContain('data-detail-source="team"');
    expect(html).toContain('data-detail-session="sess-lead"');
    expect(html).toContain('0 agents');
  });

  it('workflow row deep-links the workflow detail view', () => {
    const html = renderWorkflowCompactRow(makeWorkflow({ dismissed: true }), NOW);
    expect(html).toContain('data-run-id="wf_abc123"');
    expect(html).toContain('data-detail-source="workflow"');
    expect(html).toContain('wf-badge');
  });
});

describe('archiveListHtml', () => {
  const DAY = 86_400_000;
  const fresh = makeSession({ sessionId: 'fresh', lastActivity: NOW - 1_000 });
  const old = makeSession({ sessionId: 'old-sess', lastActivity: NOW - 3 * DAY });
  const team = makeTeam({ updatedAt: NOW - 10 * DAY });

  it('hides out-of-window sessions on 1d but always shows teams/workflows', () => {
    const html = archiveListHtml([fresh, old], [team], [], NOW, '1d');
    expect(html).toContain('fresh');
    expect(html).not.toContain('old-sess');
    expect(html).toContain('at:demo'); // 10 days old, container rows are exempt
  });

  it('a wider range reveals older sessions, newest first', () => {
    const html = archiveListHtml([old, fresh], [], [], NOW, '7d');
    expect(html).toContain('old-sess');
    expect(html.indexOf('fresh')).toBeLessThan(html.indexOf('old-sess'));
  });

  it("'all' shows everything", () => {
    const ancient = makeSession({ sessionId: 'ancient', lastActivity: NOW - 100 * DAY });
    expect(archiveListHtml([ancient], [], [], NOW, 'all')).toContain('ancient');
  });
});

// ===== top bar / empty state / time-range =====

describe('statusSummaryHtml', () => {
  it('renders one chip per non-zero count and a fallback when idle', () => {
    const html = statusSummaryHtml({ waiting: 1, running: 2, done: 0, stale: 3 });
    expect(html).toContain('1 waiting');
    expect(html).toContain('2 running');
    expect(html).not.toContain('done</span>');
    expect(html).toContain('3 seen');
    expect(statusSummaryHtml({})).toContain('No active sessions');
  });
});

describe('emptyStateHtml', () => {
  it('mentions older sessions when present', () => {
    expect(emptyStateHtml(0)).toContain('No Claude Code sessions detected.');
    expect(emptyStateHtml(5)).toContain('5 older sessions beyond the 7-day window.');
    expect(emptyStateHtml(1)).toContain('1 older session beyond');
  });
});

describe('timeRangePillsHtml', () => {
  it('marks only the active range pill', () => {
    const html = timeRangePillsHtml('7d');
    expect(html).toContain('data-range="7d"');
    expect(html.match(/time-pill active/g)).toHaveLength(1);
    expect(html).toContain('time-pill active" data-range="7d"');
  });
});

// ===== usage section =====

describe('renderUsageHtml', () => {
  const liveUsage = {
    loaded: true, apiConnected: true, platformSupported: true,
    quotaPct5h: 42, resetTime: NOW + 3_600_000,
    quotaPctWeekly: 10, weeklyResetTime: NOW + 3 * 86_400_000,
    lastPoll: NOW - 30_000,
  };

  it('ghost state before any data', () => {
    expect(renderUsageHtml(makeCtx(), null, [], NOW)).toContain('Calling usage API');
    expect(renderUsageHtml(makeCtx(), { loaded: false }, [], NOW)).toContain('Calling usage API');
  });

  it('platform-unsupported and disconnected states link out', () => {
    expect(renderUsageHtml(makeCtx(), { loaded: true, platformSupported: false }, [], NOW))
      .toContain('Live usage not available');
    expect(renderUsageHtml(makeCtx(), { loaded: true, platformSupported: true, apiConnected: false }, [], NOW))
      .toContain('Live usage unavailable');
  });

  it('renders session and weekly bars with the updated-ago footer', () => {
    const html = renderUsageHtml(makeCtx(), liveUsage, [], NOW);
    expect(html).toContain('Current session usage');
    expect(html).toContain('42%');
    expect(html).toContain('Weekly session usage');
    expect(html).toContain('Updated <1m ago');
  });

  it('an expired 5h window renders the ghost row', () => {
    const html = renderUsageHtml(makeCtx(), { ...liveUsage, resetTime: NOW - 1 }, [], NOW);
    expect(html).toContain('window expired');
    expect(html).toContain('Next interaction starts new session.');
  });

  it('over-quota flips the status label by extraUsageEnabled', () => {
    expect(renderUsageHtml(makeCtx(), { ...liveUsage, quotaPct5h: 120 }, [], NOW)).toContain('LIMIT REACHED');
    expect(renderUsageHtml(makeCtx(), { ...liveUsage, quotaPct5h: 120, extraUsageEnabled: true }, [], NOW)).toContain('EXTRA USAGE');
  });

  it('showWeekly=false suppresses the weekly block but keeps the footer', () => {
    const settings = {
      ...DEFAULT_PANEL_SETTINGS,
      usage: { ...DEFAULT_PANEL_SETTINGS.usage, showWeekly: false },
    };
    const html = renderUsageHtml(makeCtx({ settings }), liveUsage, [], NOW);
    expect(html).not.toContain('Weekly session usage');
    expect(html).toContain('Updated <1m ago');
  });

  it('omits the Weekly Fable row when no model-scoped quota is present', () => {
    const html = renderUsageHtml(makeCtx(), liveUsage, [], NOW);
    expect(html).not.toContain('Weekly Fable');
  });

  it('renders the Weekly Fable bar when present', () => {
    const html = renderUsageHtml(makeCtx(), {
      ...liveUsage, quotaPctWeeklyFable: 74, weeklyResetTimeFable: NOW + 3 * 86_400_000,
    }, [], NOW);
    expect(html).toContain('Weekly Fable usage');
    expect(html).toContain('74%');
  });

  it('renders the Weekly Fable bar at 0% once the tier is known, even with no usage yet this window', () => {
    const html = renderUsageHtml(makeCtx(), {
      ...liveUsage, quotaPctWeeklyFable: 0, weeklyResetTimeFable: undefined,
    }, [], NOW);
    expect(html).toContain('Weekly Fable usage');
    expect(html).toContain('0%');
  });

  it('an expired Weekly Fable window renders the ghost row', () => {
    const html = renderUsageHtml(makeCtx(), {
      ...liveUsage, quotaPctWeeklyFable: 74, weeklyResetTimeFable: NOW - 1,
    }, [], NOW);
    expect(html).toContain('Weekly Fable usage');
    expect(html).toContain('no active window');
  });

  it('showWeekly=false also suppresses the Weekly Fable block', () => {
    const settings = {
      ...DEFAULT_PANEL_SETTINGS,
      usage: { ...DEFAULT_PANEL_SETTINGS.usage, showWeekly: false },
    };
    const html = renderUsageHtml(makeCtx({ settings }), {
      ...liveUsage, quotaPctWeeklyFable: 74, weeklyResetTimeFable: NOW + 3 * 86_400_000,
    }, [], NOW);
    expect(html).not.toContain('Weekly Fable');
  });
});

describe('renderFooterSlots', () => {
  it('escapes companion-supplied strings and wires clickable rows', () => {
    const html = renderFooterSlots([
      { slotId: 's1', label: '<b>bold</b>', hasCommand: true, tooltip: 'tip<x>' },
      { slotId: 's2', label: 'plain', hasCommand: false, status: 'warn' },
    ]);
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold');
    expect(html).toContain('role="button"');
    expect(html).toContain('api-dot warn');
    expect(renderFooterSlots([])).toBe('');
  });
});
