import { describe, it, expect } from 'vitest';
import { buildWorktreeRows } from './worktreeRows.js';
import type { SessionSnapshot } from './types.js';
import type { WorktreeInfo } from './gitWorktreeUtil.js';

function makeSession(opts: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: opts.sessionId ?? 'sess-1',
    workspaceKey: opts.workspaceKey ?? '-test',
    cwd: opts.cwd ?? '/test',
    title: opts.title ?? '',
    topic: opts.topic ?? '',
    status: opts.status ?? 'done',
    confidence: opts.confidence ?? 'high',
    lastActivity: opts.lastActivity ?? Date.now(),
    activity: opts.activity ?? '',
    modelLabel: opts.modelLabel ?? '',
    contextTokens: opts.contextTokens ?? 0,
    subagents: opts.subagents ?? [],
    dismissed: opts.dismissed ?? false,
    acknowledged: opts.acknowledged ?? false,
    worktreeRoot: opts.worktreeRoot,
    worktreeLabel: opts.worktreeLabel,
  } as SessionSnapshot;
}

const mainWt: WorktreeInfo = { path: '/repo', branch: 'main', isMain: true };
const spikeA: WorktreeInfo = { path: '/repo-spike-a', branch: 'spike-a', isMain: false };
const spikeB: WorktreeInfo = { path: '/repo-spike-b', branch: 'spike-b', isMain: false };

describe('buildWorktreeRows', () => {
  it('returns undefined for a single-worktree repo (nothing to show)', () => {
    expect(buildWorktreeRows([mainWt], [], '/repo')).toBeUndefined();
  });

  it('returns undefined when no worktrees are discovered', () => {
    expect(buildWorktreeRows([], [], '/repo')).toBeUndefined();
  });

  it('builds one row per worktree, marks current correctly', () => {
    const rows = buildWorktreeRows([mainWt, spikeA, spikeB], [], '/repo')!;
    expect(rows).toHaveLength(3);
    expect(rows[0].isCurrent).toBe(true);
    expect(rows[0].path).toBe('/repo');
    const aRow = rows.find(r => r.path === '/repo-spike-a')!;
    expect(aRow.isCurrent).toBe(false);
  });

  it('buckets sessions by worktreeRoot; sessions without one go to local cwd', () => {
    const sessions = [
      makeSession({ sessionId: 'local', status: 'running' }),
      makeSession({ sessionId: 'sib1', status: 'waiting', worktreeRoot: '/repo-spike-a' }),
      makeSession({ sessionId: 'sib2', status: 'done', worktreeRoot: '/repo-spike-a' }),
    ];
    const rows = buildWorktreeRows([mainWt, spikeA], sessions, '/repo')!;
    const main = rows.find(r => r.path === '/repo')!;
    const a = rows.find(r => r.path === '/repo-spike-a')!;
    expect(main.counts.running).toBe(1);
    expect(a.counts.waiting).toBe(1);
    expect(a.counts.done).toBe(1);
  });

  it('skips dismissed sessions in count buckets', () => {
    const sessions = [
      makeSession({ sessionId: 's1', status: 'done', worktreeRoot: '/repo-spike-a', dismissed: true }),
      makeSession({ sessionId: 's2', status: 'done', worktreeRoot: '/repo-spike-a' }),
    ];
    const rows = buildWorktreeRows([mainWt, spikeA], sessions, '/repo')!;
    const a = rows.find(r => r.path === '/repo-spike-a')!;
    expect(a.counts.done).toBe(1);
  });

  it('uses branch name as displayName, falls back to dir basename when detached', () => {
    const detached: WorktreeInfo = { path: '/repo-detached', branch: null, isMain: false };
    const rows = buildWorktreeRows([mainWt, detached], [], '/repo')!;
    expect(rows.find(r => r.path === '/repo-detached')!.displayName).toBe('repo-detached');
    expect(rows.find(r => r.path === '/repo')!.displayName).toBe('main');
  });

  it('includes worktrees with no CC sessions (empty counts)', () => {
    const rows = buildWorktreeRows([mainWt, spikeA], [], '/repo')!;
    const a = rows.find(r => r.path === '/repo-spike-a')!;
    expect(a.counts).toEqual({});
  });

  it('puts current worktree first, then main, then alphabetical', () => {
    const rows = buildWorktreeRows([mainWt, spikeB, spikeA], [], '/repo-spike-b')!;
    expect(rows[0].path).toBe('/repo-spike-b'); // current
    expect(rows[1].path).toBe('/repo');         // main
    expect(rows[2].path).toBe('/repo-spike-a'); // alpha-sorted last
  });
});
