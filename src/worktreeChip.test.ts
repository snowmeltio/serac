import { describe, expect, it } from 'vitest';
import { chipHue, chipMonogram, isRemoteWorktree, REMOTE_WORKTREE_PREFIX } from './worktreeChip.js';

describe('chipHue', () => {
  it('is stable for the same input', () => {
    expect(chipHue('fix-workflow-resume-liveness')).toBe(chipHue('fix-workflow-resume-liveness'));
  });

  it('stays within [0, 360)', () => {
    for (const name of ['main', 'silly-ptolemy', 'fix-workflow-resume-liveness', 'a', 'x'.repeat(120)]) {
      const h = chipHue(name);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('separates the real sibling basenames on disk', () => {
    // Not a collision-freedom guarantee (monogram + hue together carry
    // identity) — just pins that today's actual worktrees don't collide.
    expect(chipHue('fix-workflow-resume-liveness')).not.toBe(chipHue('silly-ptolemy'));
  });
});

describe('chipMonogram', () => {
  it('takes initials of the last two hyphen-words', () => {
    expect(chipMonogram('fix-workflow-resume-liveness')).toBe('RL');
    expect(chipMonogram('silly-ptolemy')).toBe('SP');
  });

  it('takes the first two letters of a single-word name', () => {
    expect(chipMonogram('main')).toBe('MA');
  });

  it('strips a repo-name prefix before deriving', () => {
    expect(chipMonogram('serac-spike-detail-pane', 'serac')).toBe('DP');
    // No prefix present → unchanged derivation.
    expect(chipMonogram('spike-detail-pane', 'serac')).toBe('DP');
  });

  it('does not strip a repo name that is not a whole leading word', () => {
    expect(chipMonogram('seracish-thing', 'serac')).toBe('ST');
  });

  it('survives degenerate input', () => {
    expect(chipMonogram('-')).toBe('?');
    expect(chipMonogram('--a')).toBe('A');
  });
});

describe('isRemoteWorktree', () => {
  it('matches the real bridge worktrees on disk today', () => {
    expect(isRemoteWorktree('bridge-cse_014QrugKwCG6H7hdVzwYa2UV')).toBe(true);
    expect(isRemoteWorktree('bridge-cse_01YQUpjNY4uEeRLJdJkmFy9e')).toBe(true);
  });

  it('rejects ordinary worktrees, including one merely named like it', () => {
    expect(isRemoteWorktree('fix-workflow-resume-liveness')).toBe(false);
    expect(isRemoteWorktree('bridge-cse')).toBe(false); // no underscore — not the marker
    expect(REMOTE_WORKTREE_PREFIX.endsWith('_')).toBe(true);
  });
});
