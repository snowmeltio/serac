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
  isFromOtherWorktree,
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
} from './panelUtils.js';

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
  it('returns Waiting for waiting', () => {
    expect(getStatusLabel(session({ status: 'waiting', lastActivity: now }), now)).toBe('Waiting');
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

describe('isFromOtherWorktree', () => {
  it('returns false when worktreeRoot equals localWorktreeRoot', () => {
    const s = session({ worktreeRoot: '/home/u/repo' });
    expect(isFromOtherWorktree(s, '/home/u/repo')).toBe(false);
  });
  it('returns true when worktreeRoot differs', () => {
    const s = session({ worktreeRoot: '/home/u/repo-wt' });
    expect(isFromOtherWorktree(s, '/home/u/repo')).toBe(true);
  });
  it('returns false when worktreeRoot is unset', () => {
    expect(isFromOtherWorktree(session(), '/home/u/repo')).toBe(false);
  });
  it('returns false when localWorktreeRoot is empty', () => {
    expect(isFromOtherWorktree(session({ worktreeRoot: '/x' }), '')).toBe(false);
  });
});

describe('groupForeignWorkspaces', () => {
  function ws(overrides: Partial<GroupableWorkspace> & { workspaceKey: string; displayName: string }): GroupableWorkspace {
    return { counts: {}, ...overrides };
  }

  it('groups 2+ workspaces sharing a repoRoot under a repo header', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'feat-a', cwd: '/r/repo/feat-a', repoRoot: '/r/repo' }),
      ws({ workspaceKey: 'b', displayName: 'feat-b', cwd: '/r/repo/feat-b', repoRoot: '/r/repo' }),
    ];
    const { groups, singletons } = groupForeignWorkspaces(list);
    expect(singletons).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0].headerLabel).toBe('repo/');
    expect(groups[0].headerTitle).toBe('/r/repo');
    expect(groups[0].workspaces.map(w => w.workspaceKey)).toEqual(['a', 'b']);
  });

  it('does not repo-group a single workspace; falls back to singletons', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'lone', cwd: '/r/repo/wt', repoRoot: '/r/repo' }),
    ];
    const { groups, singletons } = groupForeignWorkspaces(list);
    expect(groups).toHaveLength(0);
    expect(singletons.map(w => w.workspaceKey)).toEqual(['a']);
  });

  it('falls back to parent-dir grouping when repoRoot is null', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'p1', cwd: '/scratch/p1', repoRoot: null }),
      ws({ workspaceKey: 'b', displayName: 'p2', cwd: '/scratch/p2', repoRoot: null }),
    ];
    const { groups, singletons } = groupForeignWorkspaces(list);
    expect(singletons).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0].headerLabel).toBe('/scratch/');
  });

  it('repo-grouping takes precedence over parent-dir grouping', () => {
    const list = [
      // Two repos in /code; one of them has a sibling worktree in /work
      ws({ workspaceKey: 'a', displayName: 'repo-a-wt', cwd: '/work/repo-a-wt', repoRoot: '/code/repo-a' }),
      ws({ workspaceKey: 'a2', displayName: 'repo-a', cwd: '/code/repo-a', repoRoot: '/code/repo-a' }),
      ws({ workspaceKey: 'b', displayName: 'repo-b', cwd: '/code/repo-b', repoRoot: '/code/repo-b' }),
    ];
    const { groups, singletons } = groupForeignWorkspaces(list);
    // The two repo-a entries form a repo group; repo-b is a singleton.
    expect(groups).toHaveLength(1);
    expect(groups[0].headerLabel).toBe('repo-a/');
    expect(groups[0].workspaces.map(w => w.workspaceKey).sort()).toEqual(['a', 'a2']);
    expect(singletons.map(w => w.workspaceKey)).toEqual(['b']);
  });

  it('sorts groups with active first, then alphabetically', () => {
    const list = [
      ws({ workspaceKey: 'z1', displayName: 'z1', cwd: '/r/zeta/z1', repoRoot: '/r/zeta' }),
      ws({ workspaceKey: 'z2', displayName: 'z2', cwd: '/r/zeta/z2', repoRoot: '/r/zeta' }),
      ws({ workspaceKey: 'a1', displayName: 'a1', cwd: '/r/alpha/a1', repoRoot: '/r/alpha', counts: { running: 1 } }),
      ws({ workspaceKey: 'a2', displayName: 'a2', cwd: '/r/alpha/a2', repoRoot: '/r/alpha' }),
    ];
    const { groups } = groupForeignWorkspaces(list);
    expect(groups.map(g => g.headerLabel)).toEqual(['alpha/', 'zeta/']);
  });

  it('applies tildeAbbrev to repo headerTitle', () => {
    const list = [
      ws({ workspaceKey: 'a', displayName: 'a', cwd: '/home/u/repo/a', repoRoot: '/home/u/repo' }),
      ws({ workspaceKey: 'b', displayName: 'b', cwd: '/home/u/repo/b', repoRoot: '/home/u/repo' }),
    ];
    const { groups } = groupForeignWorkspaces(list, p => p.replace('/home/u', '~'));
    expect(groups[0].headerTitle).toBe('~/repo');
  });
});
