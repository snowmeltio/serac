import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  escapeHtml,
  stripMarkdown,
  isPlaceholderTitle,
  formatSlug,
  getDisplayName,
  isGhost,
  formatAge,
  formatAgeCoarse,
  getStatusLabel,
  isForeignSession,
  groupForeignWorkspaces,
  GroupableWorkspace,
  debounceStatuses,
  getElapsedPct,
  quotaClass,
  formatResetTime,
  sanitiseWorkspaceKey,
  getModelCapacity,
  getCompactThreshold,
  formatTokenCount,
  PanelSession,
  PSEUDO_TMP_REPO_ROOT,
  isTmpScratchPath,
  computeFileCollisions, RUNNING_QUIET_MS,
} from './panelUtils.js';
import { applyWorkflowLiveStatus } from './panelUtils.js';

// Helper to create a minimal session
function session(overrides: Partial<PanelSession> = {}): PanelSession {
  return {
    sessionId: 'abcdef1234567890',
    status: 'running',
    lastActivity: Date.now(),
    ...overrides,
  };
}

// ===== escapeHtml =====
describe('escapeHtml', () => {
  it('escapes all HTML special characters', () => {
    expect(escapeHtml('<b>"Tom & Jerry\'s"</b>')).toBe(
      '&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;'
    );
  });
  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml('')).toBe('');
  });
  it('passes through plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

// ===== stripMarkdown =====
describe('stripMarkdown', () => {
  it('strips bold and italic markers', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });
  it('strips underscore bold/italic', () => {
    expect(stripMarkdown('__bold__ and _italic_')).toBe('bold and italic');
  });
  it('strips inline code', () => {
    expect(stripMarkdown('run `npm test` now')).toBe('run npm test now');
  });
  it('strips markdown links', () => {
    expect(stripMarkdown('[click here](https://example.com)')).toBe('click here');
  });
  it('strips headings', () => {
    expect(stripMarkdown('## Heading')).toBe('Heading');
  });
  it('strips bullet points', () => {
    expect(stripMarkdown('- item one\n* item two')).toBe('item one\nitem two');
  });
  it('strips numbered lists', () => {
    expect(stripMarkdown('1. first\n2. second')).toBe('first\nsecond');
  });
  it('returns empty string for null/undefined', () => {
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown(undefined)).toBe('');
  });
});

// ===== isPlaceholderTitle =====
describe('isPlaceholderTitle', () => {
  it('matches placeholder pattern', () => {
    expect(isPlaceholderTitle('Session 3600bebf')).toBe(true);
    expect(isPlaceholderTitle('Session ABCDEF12')).toBe(true);
  });
  it('rejects non-placeholder titles', () => {
    expect(isPlaceholderTitle('My Project')).toBe(false);
    expect(isPlaceholderTitle('Session')).toBe(false);
    expect(isPlaceholderTitle('Session 3600bebf extra')).toBe(false);
  });
});

// ===== formatSlug =====
describe('formatSlug', () => {
  it('capitalises and joins slug segments', () => {
    expect(formatSlug('my-cool-project')).toBe('My Cool Project');
  });
  it('handles single word', () => {
    expect(formatSlug('hello')).toBe('Hello');
  });
});

// ===== getDisplayName =====
describe('getDisplayName', () => {
  it('prefers customTitle', () => {
    expect(getDisplayName(session({ customTitle: 'My Title' }))).toBe('My Title');
  });
  it('skips placeholder customTitle', () => {
    expect(getDisplayName(session({ customTitle: 'Session abcdef12', topic: 'Real topic' }))).toBe('Real topic');
  });
  it('falls back to title', () => {
    expect(getDisplayName(session({ title: 'Generated Title' }))).toBe('Generated Title');
  });
  it('falls back to aiTitle when title is unset', () => {
    expect(getDisplayName(session({ aiTitle: 'Auto-generated Title' }))).toBe('Auto-generated Title');
  });
  it('prefers customTitle over aiTitle', () => {
    expect(getDisplayName(session({ customTitle: 'My Title', aiTitle: 'Auto Title' }))).toBe('My Title');
  });
  it('skips placeholder aiTitle', () => {
    expect(getDisplayName(session({ aiTitle: 'Session abcdef12', topic: 'Real topic' }))).toBe('Real topic');
  });
  it('falls back to topic', () => {
    expect(getDisplayName(session({ topic: 'Fix the bug' }))).toBe('Fix the bug');
  });
  it('falls back to cwd folder name', () => {
    expect(getDisplayName(session({ cwd: '/home/user/my-project' }))).toBe('my-project');
  });
  it('skips cwd if folder is claudecode', () => {
    expect(getDisplayName(session({ cwd: '/home/user/claudecode', slug: 'test-slug' }))).toBe('Test Slug');
  });
  it('falls back to formatted slug', () => {
    expect(getDisplayName(session({ slug: 'cool-session' }))).toBe('Cool Session');
  });
  it('skips slug matching session ID prefix', () => {
    expect(getDisplayName(session({ sessionId: 'abcdef1234567890', slug: 'abcdef12' }))).toBe('abcdef12');
  });
  it('falls back to session ID prefix', () => {
    expect(getDisplayName(session())).toBe('abcdef12');
  });
});

// ===== isGhost =====
describe('isGhost', () => {
  it('detects ghost sessions (no topic, no activity, done/stale)', () => {
    expect(isGhost(session({ status: 'done' }))).toBe(true);
    expect(isGhost(session({ status: 'stale' }))).toBe(true);
  });
  it('not ghost if has topic', () => {
    expect(isGhost(session({ status: 'done', topic: 'something' }))).toBe(false);
  });
  it('not ghost if has activity', () => {
    expect(isGhost(session({ status: 'done', activity: 'doing stuff' }))).toBe(false);
  });
  it('not ghost if running', () => {
    expect(isGhost(session({ status: 'running' }))).toBe(false);
  });
});

// ===== formatAge =====
describe('formatAge', () => {
  it('formats seconds', () => {
    expect(formatAge(45_000)).toBe('45s');
  });
  it('formats minutes', () => {
    expect(formatAge(300_000)).toBe('5m');
  });
  it('formats hours', () => {
    expect(formatAge(7_200_000)).toBe('2h');
  });
  it('formats days', () => {
    expect(formatAge(172_800_000)).toBe('2d');
  });
});

// ===== formatAgeCoarse =====
describe('formatAgeCoarse', () => {
  it('returns <1m for very short durations', () => {
    expect(formatAgeCoarse(30_000)).toBe('<1m');
  });
  it('formats minutes', () => {
    expect(formatAgeCoarse(300_000)).toBe('5m');
  });
  it('formats hours', () => {
    expect(formatAgeCoarse(7_200_000)).toBe('2h');
  });
  it('formats days', () => {
    expect(formatAgeCoarse(172_800_000)).toBe('2d');
  });
});

// ===== getStatusLabel =====
describe('getStatusLabel', () => {
  const now = 1710000000000;
  it('returns Waiting with the blocked-for age (oldest-blocked triage)', () => {
    expect(getStatusLabel(session({ status: 'waiting', lastActivity: now - 5 * 60_000 }), now)).toBe('Waiting · <span class="status-pill-time">5m</span>');
  });
  it('returns Running for running', () => {
    expect(getStatusLabel(session({ status: 'running', lastActivity: now }), now)).toBe('Running');
  });
  it('returns Done with age', () => {
    expect(getStatusLabel(session({ status: 'done', lastActivity: now - 120_000 }), now)).toBe('Done · <span class="status-pill-time">2m</span>');
  });
  it('returns Seen with age for stale', () => {
    expect(getStatusLabel(session({ status: 'stale', lastActivity: now - 3_600_000 }), now)).toBe('Seen · <span class="status-pill-time">1h</span>');
  });
  it('returns raw status for unknown', () => {
    expect(getStatusLabel(session({ status: 'mystery' as any, lastActivity: now }), now)).toBe('mystery');
  });
  it('returns elapsed-time-only for low-confidence running', () => {
    const label = getStatusLabel(session({ status: 'running', lastActivity: now - 60_000, confidence: 'low' }), now);
    expect(label).toBe('<span class="status-pill-time">1m</span>\u2026');
  });
  it('returns elapsed-time-only for low-confidence waiting', () => {
    const label = getStatusLabel(session({ status: 'waiting', lastActivity: now - 45_000, confidence: 'low' }), now);
    expect(label).toBe('<span class="status-pill-time">45s</span>\u2026');
  });
  it('returns normal label for high-confidence running', () => {
    expect(getStatusLabel(session({ status: 'running', lastActivity: now, confidence: 'high' }), now)).toBe('Running');
  });
  it('returns normal label for medium-confidence running', () => {
    expect(getStatusLabel(session({ status: 'running', lastActivity: now, confidence: 'medium' }), now)).toBe('Running');
  });
  it('returns normal label for low-confidence done (terminal)', () => {
    expect(getStatusLabel(session({ status: 'done', lastActivity: now - 60_000, confidence: 'low' }), now)).toBe('Done · <span class="status-pill-time">1m</span>');
  });
});

// ===== sanitiseWorkspaceKey =====
describe('sanitiseWorkspaceKey', () => {
  it('replaces non-alphanumeric characters with hyphens', () => {
    expect(sanitiseWorkspaceKey('/Users/murray/claudecode')).toBe('-Users-murray-claudecode');
  });
  it('preserves alphanumeric characters', () => {
    expect(sanitiseWorkspaceKey('abc123')).toBe('abc123');
  });
  it('handles spaces and special characters', () => {
    expect(sanitiseWorkspaceKey('/path/to/my project (v2)')).toBe('-path-to-my-project--v2-');
  });
  it('handles empty string', () => {
    expect(sanitiseWorkspaceKey('')).toBe('');
  });
});

// ===== isForeignSession =====
describe('isForeignSession', () => {
  it('detects foreign workspace', () => {
    expect(isForeignSession(session({ workspaceKey: 'other-key' }), 'my-key')).toBe(true);
  });
  it('not foreign for same workspace', () => {
    expect(isForeignSession(session({ workspaceKey: 'my-key' }), 'my-key')).toBe(false);
  });
  it('not foreign when no workspace key', () => {
    expect(isForeignSession(session(), 'my-key')).toBe(false);
  });
});

// ===== debounceStatuses =====
describe('debounceStatuses', () => {
  it('holds waiting status during debounce window', () => {
    const since: Record<string, number> = {};
    const s1 = session({ sessionId: 'a', status: 'waiting' });
    debounceStatuses([s1], since, 1000);
    expect(since['a']).toBe(1000);

    // Now status changes to running within debounce window
    s1.status = 'running';
    debounceStatuses([s1], since, 2500); // 1500ms later, within 2000ms debounce
    expect(s1.status).toBe('waiting'); // held
  });

  it('releases waiting after debounce expires', () => {
    const since: Record<string, number> = {};
    const s1 = session({ sessionId: 'a', status: 'waiting' });
    debounceStatuses([s1], since, 1000);

    s1.status = 'running';
    debounceStatuses([s1], since, 3500); // 2500ms later, past 2000ms debounce
    expect(s1.status).toBe('running'); // released
    expect(since['a']).toBeUndefined();
  });

  it('clears tracker on non-running status', () => {
    const since: Record<string, number> = { a: 1000 };
    const s1 = session({ sessionId: 'a', status: 'done' });
    debounceStatuses([s1], since, 2000);
    expect(since['a']).toBeUndefined();
  });
});

// ===== getElapsedPct =====
describe('getElapsedPct', () => {
  it('returns 0 for undefined resetMs', () => {
    expect(getElapsedPct(undefined, 18_000_000)).toBe(0);
  });

  it('returns 100 when reset time has passed', () => {
    expect(getElapsedPct(Date.now() - 1000, 18_000_000)).toBe(100);
  });

  it('calculates correct percentage mid-window', () => {
    const windowMs = 18_000_000; // 5h
    const resetMs = Date.now() + windowMs / 2; // halfway through
    const pct = getElapsedPct(resetMs, windowMs);
    expect(pct).toBeGreaterThan(45);
    expect(pct).toBeLessThan(55);
  });
});

// ===== quotaClass =====
describe('quotaClass', () => {
  it('returns ok for low burn rate', () => {
    expect(quotaClass(10, 50)).toBe('ok');
  });
  it('returns good for moderate burn rate', () => {
    expect(quotaClass(40, 50)).toBe('good');
  });
  it('returns warn for high burn rate', () => {
    expect(quotaClass(45, 50)).toBe('warn');
  });
  it('returns critical at or above pace', () => {
    expect(quotaClass(50, 50)).toBe('critical');
    expect(quotaClass(60, 50)).toBe('critical');
  });
  it('returns ok when elapsed is 0 and not capped', () => {
    expect(quotaClass(50, 0)).toBe('ok');
  });
  it('locks to critical at 100% quota regardless of elapsed', () => {
    expect(quotaClass(100, 0)).toBe('critical');
    expect(quotaClass(100, 96)).toBe('critical');
    expect(quotaClass(105, 99)).toBe('critical');
  });
  it('does not flash red on trivial usage just after a quota reset (early-window floor)', () => {
    // Without the floor, 2% quota at 0.33% elapsed = (2/0.33)*100 ≈ 606 →
    // critical (a red flash moments after reset). With the 5% floor it is
    // (2/5)*100 = 40 → ok. The floor only changes the near-empty-window regime:
    expect(quotaClass(2, 0.33)).toBe('ok');
    // Genuinely high early usage is NOT masked — 6% at 0.33% elapsed →
    // (6/5)*100 = 120 ≥ 100 → still critical.
    expect(quotaClass(6, 0.33)).toBe('critical');
  });
});

// ===== formatResetTime =====
describe('formatResetTime', () => {
  it('returns empty for undefined', () => {
    expect(formatResetTime(undefined)).toBe('');
  });
  it('returns reset when past', () => {
    expect(formatResetTime(Date.now() - 1000)).toBe('reset');
  });
  it('formats minutes', () => {
    const result = formatResetTime(Date.now() + 30 * 60_000);
    expect(result).toMatch(/^\d+m$/);
  });
  it('formats hours and minutes', () => {
    const result = formatResetTime(Date.now() + 90 * 60_000);
    expect(result).toMatch(/^1h \d+m$/);
  });
});

describe('getModelCapacity', () => {
  it('returns 1M for Opus', () => {
    expect(getModelCapacity('Opus')).toBe(1_000_000);
  });
  it('returns 1M for Opus 4.6', () => {
    expect(getModelCapacity('Opus 4.6')).toBe(1_000_000);
  });
  it('returns 1M for Sonnet', () => {
    expect(getModelCapacity('Sonnet')).toBe(1_000_000);
  });
  it('returns 200K for Haiku', () => {
    expect(getModelCapacity('Haiku')).toBe(200_000);
  });
  it('returns 200K for unknown model', () => {
    expect(getModelCapacity('FutureModel')).toBe(200_000);
  });
  it('returns 200K for undefined', () => {
    expect(getModelCapacity(undefined)).toBe(200_000);
  });
});

describe('getCompactThreshold', () => {
  it('computes 95% of 200K', () => {
    expect(getCompactThreshold(200_000, 95)).toBe(190_000);
  });
  it('computes 80% of 100K', () => {
    expect(getCompactThreshold(100_000, 80)).toBe(80_000);
  });
  it('computes 100% of 500K', () => {
    expect(getCompactThreshold(500_000, 100)).toBe(500_000);
  });
});

describe('formatTokenCount', () => {
  it('formats thousands as K', () => {
    expect(formatTokenCount(190_000)).toBe('190K');
  });
  it('formats millions as M', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
  });
  it('rounds to nearest K', () => {
    expect(formatTokenCount(167_500)).toBe('168K');
  });
  it('formats small counts as K', () => {
    expect(formatTokenCount(500)).toBe('1K');
  });
});

describe('groupForeignWorkspaces', () => {
  function ws(overrides: Partial<GroupableWorkspace> & { workspaceKey: string; displayName: string }): GroupableWorkspace {
    return { counts: {}, ...overrides };
  }

  it('aggregates 2+ worktrees of the same repo into a single synthetic row', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo', counts: { running: 1, done: 2 } }),
      ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo', counts: { running: 1 } }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows).toHaveLength(1);
    const agg = rows[0];
    expect(agg.displayName).toBe('repo');
    expect(agg.repoRoot).toBe('/r/repo');
    expect(agg.workspaceKey).toBe('repo:/r/repo');
    expect(agg.worktreeCount).toBe(2);
    expect(agg.counts).toEqual({ running: 2, done: 2 });
  });

  it('worktreeCount + members tooltip include every tracked worktree, regardless of dismissal state', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo', counts: { running: 1 } }),
      ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo', counts: { done: 2 } }),
      // c has no live sessions — all dismissed (foreign manager zeroes counts).
      // The chip is a stable "this repo has N worktrees" fact, so c still counts.
      ws({ workspaceKey: 'c', displayName: 'feat-c', cwd: '/r/repo/feat-c', repoRoot: '/r/repo', counts: {} }),
    ];
    const rows = groupForeignWorkspaces(list);
    const agg = rows[0];
    expect(agg.worktreeCount).toBe(3);
    expect(agg.worktreeMembersLabel).toContain('/r/repo/feat-a');
    expect(agg.worktreeMembersLabel).toContain('/r/repo/feat-b');
    expect(agg.worktreeMembersLabel).toContain('/r/repo/feat-c');
  });

  it('worktreeCount still reflects total members when every worktree has only dismissed sessions', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo', counts: {} }),
      ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo', counts: {} }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows).toHaveLength(1);
    expect(rows[0].worktreeCount).toBe(2);
  });

  it('worktreeCount + tooltip use the enumerated worktree list when present (matching the picker rows)', () => {
    // The repo has 4 worktrees but only 2 have Claude Code activity. The chip
    // count must reflect the enumerated list (what the picker expands to), not
    // the 2 active members.
    const wts = [
      { path: '/r/repo', branch: 'main', isMain: true },
      { path: '/r/repo/feat-a', branch: 'feat-a', isMain: false },
      { path: '/r/repo/feat-b', branch: 'feat-b', isMain: false },
      { path: '/r/repo/feat-c', branch: 'feat-c', isMain: false },
    ];
    const list = [
      { ...ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo', counts: { running: 1 } }), worktrees: wts },
      { ...ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo', counts: { done: 1 } }), worktrees: wts },
    ];
    const rows = groupForeignWorkspaces(list as GroupableWorkspace[]);
    const agg = rows[0];
    expect(agg.worktreeCount).toBe(4);
    // Tooltip lists the enumerated worktree paths, including the no-activity one.
    expect(agg.worktreeMembersLabel).toContain('/r/repo/feat-c');
    expect(agg.worktreeMembersLabel).toContain('/r/repo');
  });

  it('aggregated row prefers the main worktree cwd (cwd === repoRoot) over a worktree path', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo' }),
      ws({ workspaceKey: 'main', displayName: 'repo', cwd: '/r/repo', repoRoot: '/r/repo' }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows[0].cwd).toBe('/r/repo');
  });

  it('aggregated row falls back to repoRoot when no member has cwd === repoRoot', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/work/feat-a', repoRoot: '/r/repo' }),
      ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/work/feat-b', repoRoot: '/r/repo' }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows[0].cwd).toBe('/r/repo');
  });

  it('does not aggregate a single workspace; passes through unchanged', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'lone', cwd: '/r/repo/wt', repoRoot: '/r/repo' }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceKey).toBe('a');
    expect(rows[0].worktreeCount).toBeUndefined();
  });

  it('passes workspaces with null repoRoot through as flat rows (no parent-dir grouping)', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'p1', cwd: '/scratch/p1', repoRoot: null }),
      ws({ workspaceKey: 'b', displayName: 'p2', cwd: '/scratch/p2', repoRoot: null }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows.map(r => r.workspaceKey)).toEqual(['a', 'b']);
    expect(rows.every(r => r.worktreeCount === undefined)).toBe(true);
  });

  it('aggregates same-repo worktrees while leaving siblings with different repoRoots flat', () => {
    const list = [
      // Two repos in /code; one of them has a sibling worktree in /work
      ws({ workspaceKey: 'a', displayName: 'repo-a-wt', cwd: '/work/repo-a-wt', repoRoot: '/code/repo-a', counts: { running: 1 } }),
      ws({ workspaceKey: 'a2', displayName: 'repo-a', cwd: '/code/repo-a', repoRoot: '/code/repo-a', counts: { done: 1 } }),
      ws({ workspaceKey: 'b', displayName: 'repo-b', cwd: '/code/repo-b', repoRoot: '/code/repo-b', counts: { done: 1 } }),
    ];
    const rows = groupForeignWorkspaces(list);
    const agg = rows.find(r => r.repoRoot === '/code/repo-a');
    expect(agg).toBeDefined();
    expect(agg!.worktreeCount).toBe(2);
    const lone = rows.find(r => r.workspaceKey === 'b');
    expect(lone).toBeDefined();
    expect(lone!.worktreeCount).toBeUndefined();
  });

  it('aggregated rows sort alphabetically with other rows', () => {
    const list = [
      ws({ workspaceKey: 'z1', displayName: 'zeta-1', cwd: '/r/zeta/z1', repoRoot: '/r/zeta' }),
      ws({ workspaceKey: 'z2', displayName: 'zeta-2', cwd: '/r/zeta/z2', repoRoot: '/r/zeta' }),
      ws({ workspaceKey: 'm', displayName: 'middle', cwd: '/scratch/middle', repoRoot: null }),
    ];
    const rows = groupForeignWorkspaces(list);
    // 'middle' < 'zeta' so the lone workspace sorts before the aggregated row.
    expect(rows.map(r => r.displayName)).toEqual(['middle', 'zeta']);
  });

  it('aggregated row exposes a members tooltip listing each worktree path', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo', counts: { done: 1 } }),
      ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo', counts: { done: 1 } }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows[0].worktreeMembersLabel).toContain('/r/repo/feat-a');
    expect(rows[0].worktreeMembersLabel).toContain('/r/repo/feat-b');
  });

  it('applies tildeAbbrev to the members tooltip on aggregated rows', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'a', cwd: '/home/u/repo/a', repoRoot: '/home/u/repo', counts: { done: 1 } }),
      ws({ workspaceKey: 'b', displayName: 'b', cwd: '/home/u/repo/b', repoRoot: '/home/u/repo', counts: { done: 1 } }),
    ];
    const rows = groupForeignWorkspaces(list, p => p.replace('/home/u', '~'));
    expect(rows[0].worktreeMembersLabel).toContain('~/repo/a');
    expect(rows[0].worktreeMembersLabel).toContain('~/repo/b');
  });

  it('preserves the worktrees array on the aggregated row', () => {
    const worktrees = [
      { path: '/r/repo', branch: 'main', isMain: true },
      { path: '/r/repo-feat-a', branch: 'feat-a', isMain: false },
      { path: '/r/repo-feat-b', branch: 'feat-b', isMain: false },
    ];
    const list = [
      ws({ workspaceKey: 'a', displayName: 'a', cwd: '/r/repo-feat-a', repoRoot: '/r/repo', counts: { running: 1 }, worktrees }),
      ws({ workspaceKey: 'b', displayName: 'b', cwd: '/r/repo-feat-b', repoRoot: '/r/repo', counts: { done: 2 }, worktrees }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows[0].worktrees).toEqual(worktrees);
  });

  it('preserves per-worktree members on the aggregated row, stripped of nested worktrees/members', () => {
    const worktrees = [
      { path: '/r/repo', branch: 'main', isMain: true },
      { path: '/r/repo-feat-a', branch: 'feat-a', isMain: false },
    ];
    const list = [
      ws({ workspaceKey: 'a', displayName: 'a', cwd: '/r/repo-feat-a', repoRoot: '/r/repo', counts: { running: 1 }, worktrees }),
      ws({ workspaceKey: 'b', displayName: 'b', cwd: '/r/repo-feat-b', repoRoot: '/r/repo', counts: { done: 2 }, worktrees }),
    ];
    const rows = groupForeignWorkspaces(list);
    const agg = rows[0];
    expect(agg.members).toBeDefined();
    expect(agg.members!.length).toBe(2);
    // Members are stripped of nested worktrees/members so the payload is flat.
    for (const m of agg.members!) {
      expect((m as { worktrees?: unknown }).worktrees).toBeUndefined();
      expect((m as { members?: unknown }).members).toBeUndefined();
    }
    // But original counts + cwd survive so the picker can match by path.
    const cwds = agg.members!.map(m => m.cwd);
    expect(cwds).toContain('/r/repo-feat-a');
    expect(cwds).toContain('/r/repo-feat-b');
  });

  it('does not set worktrees/members on non-aggregated (single workspace) rows', () => {
    const list = [
      ws({
        workspaceKey: 'a', displayName: 'lone', cwd: '/r/lone', repoRoot: '/r/lone',
        worktrees: [{ path: '/r/lone', branch: 'main', isMain: true }],
      }),
    ];
    const rows = groupForeignWorkspaces(list);
    // Single-workspace rows pass through unchanged — the worktrees array is
    // still there (it was on the original) but no aggregation/members logic
    // kicks in.
    expect(rows[0].members).toBeUndefined();
    expect(rows[0].worktreeCount).toBeUndefined();
  });

  it('consolidates scratch dirs sharing the pseudo /private/tmp root into one tmp row', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'serac-hook-spike', cwd: '/private/tmp/serac-hook-spike', repoRoot: PSEUDO_TMP_REPO_ROOT, counts: { running: 1 } }),
      ws({ workspaceKey: 'b', displayName: 'serac-spike-subagent', cwd: '/private/tmp/serac-spike-subagent', repoRoot: PSEUDO_TMP_REPO_ROOT, counts: { stale: 1 } }),
    ];
    const rows = groupForeignWorkspaces(list);
    expect(rows).toHaveLength(1);
    const agg = rows[0];
    expect(agg.displayName).toBe('tmp');
    expect(agg.pseudoRepo).toBe(true);
    expect(agg.worktreeCount).toBe(2);
    expect(agg.counts).toEqual({ running: 1, stale: 1 });
  });

  it('pseudo (tmp) rows withhold cwd and worktrees so the picker drives off members', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'p1', cwd: '/private/tmp/p1', repoRoot: PSEUDO_TMP_REPO_ROOT, counts: { done: 1 } }),
      ws({ workspaceKey: 'b', displayName: 'p2', cwd: '/private/tmp/p2', repoRoot: PSEUDO_TMP_REPO_ROOT, counts: { done: 1 } }),
    ];
    const agg = groupForeignWorkspaces(list)[0];
    expect(agg.cwd).toBeNull();
    expect(agg.worktrees).toBeUndefined();
    expect(agg.members).toBeDefined();
    expect(agg.members!.map(m => m.cwd)).toEqual(
      expect.arrayContaining(['/private/tmp/p1', '/private/tmp/p2']),
    );
  });

  it('does not set pseudoRepo on real git repo aggregations', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo', counts: { running: 1 } }),
      ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo', counts: { done: 1 } }),
    ];
    expect(groupForeignWorkspaces(list)[0].pseudoRepo).toBeUndefined();
  });
});

describe('isTmpScratchPath', () => {
  it('matches sub-paths of /private/tmp and /tmp', () => {
    expect(isTmpScratchPath('/private/tmp/serac-hook-spike')).toBe(true);
    expect(isTmpScratchPath('/tmp/serac-spike-subagent')).toBe(true);
  });

  it('excludes the temp root itself and unrelated paths', () => {
    expect(isTmpScratchPath('/private/tmp')).toBe(false);
    expect(isTmpScratchPath('/tmp')).toBe(false);
    expect(isTmpScratchPath('/Users/me/repos/serac')).toBe(false);
    expect(isTmpScratchPath('/var/tmp/thing')).toBe(false);
    expect(isTmpScratchPath(null)).toBe(false);
    expect(isTmpScratchPath(undefined)).toBe(false);
  });
});

describe('getStatusLabel — orphan/live annotation', () => {
  const now = Date.now();
  function session(overrides: Partial<PanelSession>): PanelSession {
    return { sessionId: 's', status: 'done', lastActivity: now, ...overrides };
  }

  it('annotates done · live when the process is still attached', () => {
    expect(getStatusLabel(session({ processLive: true, lastActivity: now - 120_000 }), now))
      .toBe('Done · <span class="status-pill-time">2m</span> · <span class="status-pill-time">live</span>');
  });

  it('annotates done · ended when confirmed gone', () => {
    expect(getStatusLabel(session({ processLive: false, lastActivity: now - 120_000 }), now))
      .toBe('Done · <span class="status-pill-time">2m</span> · <span class="status-pill-time">ended</span>');
  });

  it('annotates stale (Seen) cards the same way', () => {
    expect(getStatusLabel(session({ status: 'stale', processLive: true, lastActivity: now - 3_600_000 }), now))
      .toBe('Seen · <span class="status-pill-time">1h</span> · <span class="status-pill-time">live</span>');
  });

  it('unknown tri-state leaves the label untouched', () => {
    expect(getStatusLabel(session({ lastActivity: now - 120_000 }), now))
      .toBe('Done · <span class="status-pill-time">2m</span>');
  });

  it('never annotates active cards (running/waiting)', () => {
    expect(getStatusLabel(session({ status: 'running', processLive: false }), now)).toBe('Running');
    expect(getStatusLabel(session({ status: 'waiting', processLive: false, lastActivity: now - 60_000 }), now))
      .toBe('Waiting · <span class="status-pill-time">1m</span>');
  });
});

describe('computeFileCollisions', () => {
  function s(id: string, status: string, files?: string[]): PanelSession {
    return { sessionId: id, status: status as PanelSession['status'], lastActivity: 0, trackedFiles: files };
  }

  it('flags both active sessions sharing a file, with the shared paths', () => {
    const map = computeFileCollisions([
      s('a', 'running', ['/r/x.ts', '/r/y.ts']),
      s('b', 'waiting', ['/r/y.ts', '/r/z.ts']),
    ]);
    expect(map.get('a')).toEqual(['/r/y.ts']);
    expect(map.get('b')).toEqual(['/r/y.ts']);
  });

  it('ignores terminal sessions — a finished session is not a live conflict', () => {
    const map = computeFileCollisions([
      s('a', 'running', ['/r/y.ts']),
      s('b', 'done', ['/r/y.ts']),
    ]);
    expect(map.size).toBe(0);
  });

  it('no collision when files are disjoint or only one session is active', () => {
    expect(computeFileCollisions([
      s('a', 'running', ['/r/x.ts']),
      s('b', 'running', ['/r/y.ts']),
    ]).size).toBe(0);
    expect(computeFileCollisions([s('a', 'running', ['/r/x.ts'])]).size).toBe(0);
  });

  it('duplicate paths within ONE session do not self-collide', () => {
    expect(computeFileCollisions([
      s('a', 'running', ['/r/x.ts', '/r/x.ts']),
      s('b', 'running', ['/r/other.ts']),
    ]).size).toBe(0);
  });
});

describe('getStatusLabel — stall surfacing (quiet running cards)', () => {
  const now = Date.now();
  function s(lastActivity: number): PanelSession {
    return { sessionId: 'q', status: 'running', lastActivity, confidence: 'high' } as PanelSession;
  }

  it('a recently active running card is plain Running', () => {
    expect(getStatusLabel(s(now - 60_000), now)).toBe('Running');
  });

  it('flags quiet once silence passes the threshold', () => {
    expect(getStatusLabel(s(now - RUNNING_QUIET_MS - 7 * 60_000), now))
      .toBe('Running · quiet <span class="status-pill-time">12m</span>');
  });

  it('exactly at the threshold stays plain (strictly past)', () => {
    expect(getStatusLabel(s(now - RUNNING_QUIET_MS), now)).toBe('Running');
  });
});

describe('applyWorkflowLiveStatus — done card with a live background workflow', () => {
  const sess = (status: string) => ({ sessionId: 's1', status, confidence: 'medium' });
  const wf = (status: string, dismissed = false) => ({ sessionId: 's1', status, dismissed });

  it('upgrades a done session to running (high confidence) while its workflow runs', () => {
    const out = applyWorkflowLiveStatus([sess('done')], [wf('running')]);
    expect(out[0]).toMatchObject({ status: 'running', confidence: 'high' });
  });

  it('upgrades a stale session too', () => {
    expect(applyWorkflowLiveStatus([sess('stale')], [wf('running')])[0].status).toBe('running');
  });

  it('leaves waiting sessions alone (waiting outranks running)', () => {
    expect(applyWorkflowLiveStatus([sess('waiting')], [wf('running')])[0].status).toBe('waiting');
  });

  it('ignores completed, failed, incomplete, and dismissed runs', () => {
    for (const w of [wf('completed'), wf('failed'), wf('incomplete'), wf('running', true)]) {
      expect(applyWorkflowLiveStatus([sess('done')], [w])[0].status).toBe('done');
    }
  });

  it('does not touch other sessions and is a no-op without workflows', () => {
    const other = { sessionId: 's2', status: 'done', confidence: 'high' };
    expect(applyWorkflowLiveStatus([other], [wf('running')])[0]).toBe(other);
    const input = [sess('done')];
    expect(applyWorkflowLiveStatus(input, undefined)).toBe(input);
  });
});
