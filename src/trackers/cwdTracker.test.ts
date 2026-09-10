import { describe, it, expect } from 'vitest';
import { makeCwdTracker } from './cwdTracker.js';
import { HookEventRouter } from '../hookEventRouter.js';

describe('CwdTracker', () => {
  it('returns empty state on construction', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    expect(t.getState()).toEqual({ cwd: '', initialCwd: '' });
  });

  it('mirrors latest cwd from any record', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar');
    expect(t.getState().cwd).toBe('/Users/foo/bar');
    t.onCwd('/tmp/elsewhere');
    expect(t.getState().cwd).toBe('/tmp/elsewhere');
  });

  it('captures initialCwd only when cwd sanitises to workspaceKey', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar/subdir');     // sanitises to a different key
    expect(t.getState().initialCwd).toBe('');
    t.onCwd('/Users/foo/bar');             // matches
    expect(t.getState().initialCwd).toBe('/Users/foo/bar');
  });

  it('initialCwd is sticky once captured (immune to mid-session cd)', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar');
    expect(t.getState().initialCwd).toBe('/Users/foo/bar');
    t.onCwd('/Users/foo/bar/subdir');
    expect(t.getState().initialCwd).toBe('/Users/foo/bar');  // unchanged
    expect(t.getState().cwd).toBe('/Users/foo/bar/subdir');   // drifted
  });

  it('no-ops on undefined or empty cwd', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    t.onCwd(undefined);
    t.onCwd('');
    expect(t.getState()).toEqual({ cwd: '', initialCwd: '' });
  });

  it('factory returns a working JSONL-derived tracker', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar');
    expect(t.getState().cwd).toBe('/Users/foo/bar');
  });

  it('dispose is idempotent and does not throw', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    t.dispose();
    t.dispose();
  });

  it('restore() sets cwd/initialCwd verbatim, bypassing the sanitisation-match gate', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    // A cwd that would NOT pass onCwd()'s workspaceKey match (it sanitises to
    // a different key) still round-trips through restore() unchanged — the
    // cached value was already validated when it was captured.
    t.restore({ cwd: '/Users/foo/bar/subdir', initialCwd: '/Users/foo/bar' });
    expect(t.getState()).toEqual({ cwd: '/Users/foo/bar/subdir', initialCwd: '/Users/foo/bar' });
  });

  it('restore() round-trips whatever getState() previously produced', () => {
    const original = makeCwdTracker('-Users-foo-bar');
    original.onCwd('/Users/foo/bar');
    original.onCwd('/Users/foo/bar/subdir');
    const state = original.getState();

    const restored = makeCwdTracker('-Users-foo-bar');
    restored.restore(state);
    expect(restored.getState()).toEqual(state);
  });

  it('restore() overwrites any prior state', () => {
    const t = makeCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar');
    t.restore({ cwd: '/elsewhere', initialCwd: '' });
    expect(t.getState()).toEqual({ cwd: '/elsewhere', initialCwd: '' });
  });
});

describe('CwdTracker (hook overlay)', () => {
  const KEY = '-Users-foo-bar';
  const SID = 'session-uuid-123';

  function setup() {
    const router = new HookEventRouter();
    const tracker = makeCwdTracker(KEY, { hookRouter: router, sessionId: SID });
    return { router, tracker };
  }

  it('updates cwd from SessionStart payload', () => {
    const { router, tracker } = setup();
    router.onHookEvent(SID, 'SessionStart', { cwd: '/Users/foo/bar', source: 'startup' });
    expect(tracker.getState().cwd).toBe('/Users/foo/bar');
    expect(tracker.getState().initialCwd).toBe('/Users/foo/bar');
    tracker.dispose();
  });

  it('updates cwd from UserPromptSubmit payload', () => {
    const { router, tracker } = setup();
    router.onHookEvent(SID, 'UserPromptSubmit', { cwd: '/Users/foo/bar/sub' });
    expect(tracker.getState().cwd).toBe('/Users/foo/bar/sub');
    tracker.dispose();
  });

  it('still accepts onCwd() from the JSONL path', () => {
    const { tracker } = setup();
    tracker.onCwd('/Users/foo/bar');
    expect(tracker.getState().cwd).toBe('/Users/foo/bar');
    tracker.dispose();
  });

  it('ignores hook events for other sessions', () => {
    const { router, tracker } = setup();
    router.onHookEvent('different-session', 'SessionStart', { cwd: '/other/path' });
    expect(tracker.getState().cwd).toBe('');
    tracker.dispose();
  });

  it('ignores non-string cwd field', () => {
    const { router, tracker } = setup();
    router.onHookEvent(SID, 'SessionStart', { cwd: 42 });
    router.onHookEvent(SID, 'SessionStart', {});
    router.onHookEvent(SID, 'SessionStart', null);
    expect(tracker.getState().cwd).toBe('');
    tracker.dispose();
  });

  it('dispose unsubscribes — further events do nothing', () => {
    const { router, tracker } = setup();
    tracker.dispose();
    router.onHookEvent(SID, 'SessionStart', { cwd: '/should/not/apply' });
    expect(tracker.getState().cwd).toBe('');
  });

  it('restore() delegates to the JSONL-derived fallback', () => {
    const { tracker } = setup();
    tracker.restore({ cwd: '/cached/cwd', initialCwd: '/cached/initial' });
    expect(tracker.getState()).toEqual({ cwd: '/cached/cwd', initialCwd: '/cached/initial' });
    tracker.dispose();
  });
});
