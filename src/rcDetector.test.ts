import { describe, expect, it } from 'vitest';
import { isRcServing, RC_ENTRYPOINT } from './rcDetector.js';
import type { LiveProcess } from './processRegistry.js';

const WS = '/Users/murraystubbs/repos/snowmeltio/serac';

function proc(over: Partial<LiveProcess>): LiveProcess {
  return {
    pid: 1,
    sessionId: '00000000-0000-4000-8000-000000000000',
    cwd: WS,
    startedAt: null,
    kind: 'interactive',
    entrypoint: 'claude-vscode',
    version: null,
    ...over,
  };
}

/** The three registry entries a live `claude rc --spawn worktree` server had
 *  on disk while this was written (2026-08-20): one session pre-created in the
 *  serving directory, two spawned from the phone into per-session worktrees. */
const LIVE_RC_FIXTURES: LiveProcess[] = [
  proc({ pid: 59776, entrypoint: 'sdk-cli', cwd: WS }),
  proc({ pid: 61768, entrypoint: 'sdk-cli', cwd: WS + '/.claude/worktrees/bridge-cse_014QrugKwCG6H7hdVzwYa2UV' }),
  proc({ pid: 19587, entrypoint: 'sdk-cli', cwd: WS + '/.claude/worktrees/bridge-cse_01YQUpjNY4uEeRLJdJkmFy9e' }),
];

describe('isRcServing', () => {
  it('detects the live server via its pre-created workspace-root session', () => {
    expect(isRcServing([LIVE_RC_FIXTURES[0]], WS)).toBe(true);
  });

  it('detects it via a phone-spawned bridge worktree alone', () => {
    // The --no-create-session-in-dir case still resolves once a session spawns.
    expect(isRcServing([LIVE_RC_FIXTURES[1]], WS)).toBe(true);
    expect(isRcServing([LIVE_RC_FIXTURES[2]], WS)).toBe(true);
  });

  it('detects it from the full live snapshot, ordinary sessions included', () => {
    const mixed = [proc({ pid: 4242, entrypoint: 'claude-vscode' }), ...LIVE_RC_FIXTURES];
    expect(isRcServing(mixed, WS)).toBe(true);
  });

  it('is false with no processes at all', () => {
    expect(isRcServing([], WS)).toBe(false);
  });

  it('ignores ordinary VS Code sessions in this very workspace', () => {
    // The common case: plenty of local sessions, no RC server. The entrypoint
    // is the whole discriminator — cwd matches for both classes.
    const local = [proc({ pid: 1, entrypoint: 'claude-vscode' }), proc({ pid: 2, entrypoint: null })];
    expect(isRcServing(local, WS)).toBe(false);
  });

  it('ignores an RC session serving a different workspace', () => {
    const elsewhere = [proc({ pid: 3, entrypoint: 'sdk-cli', cwd: '/Users/murraystubbs/repos/other' })];
    expect(isRcServing(elsewhere, WS)).toBe(false);
  });

  it('does not match a sibling path that merely shares our prefix', () => {
    const sibling = [proc({ pid: 4, entrypoint: 'sdk-cli', cwd: WS + '-old' })];
    expect(isRcServing(sibling, WS)).toBe(false);
  });

  it('does not match an unrelated subdirectory of this workspace', () => {
    // Only the workspace root itself and the RC spawn dir count — an sdk-cli
    // process running in src/ is some other SDK use, not a hosted session.
    const inSrc = [proc({ pid: 5, entrypoint: 'sdk-cli', cwd: WS + '/src' })];
    expect(isRcServing(inSrc, WS)).toBe(false);
  });

  it('matches regardless of trailing slashes or unnormalised segments', () => {
    expect(isRcServing(LIVE_RC_FIXTURES, WS + '/')).toBe(true);
    expect(isRcServing(LIVE_RC_FIXTURES, WS + '/src/..')).toBe(true);
  });

  it('is false when the workspace path is empty', () => {
    expect(isRcServing(LIVE_RC_FIXTURES, '')).toBe(false);
  });

  it('pins the registry entrypoint value the detector keys on', () => {
    expect(RC_ENTRYPOINT).toBe('sdk-cli');
  });
});
