import { describe, it, expect } from 'vitest';
import { JsonlDerivedCwdTracker, makeCwdTracker } from './cwdTracker.js';

describe('JsonlDerivedCwdTracker', () => {
  it('returns empty state on construction', () => {
    const t = new JsonlDerivedCwdTracker('-Users-foo-bar');
    expect(t.getState()).toEqual({ cwd: '', initialCwd: '' });
  });

  it('mirrors latest cwd from any record', () => {
    const t = new JsonlDerivedCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar');
    expect(t.getState().cwd).toBe('/Users/foo/bar');
    t.onCwd('/tmp/elsewhere');
    expect(t.getState().cwd).toBe('/tmp/elsewhere');
  });

  it('captures initialCwd only when cwd sanitises to workspaceKey', () => {
    const t = new JsonlDerivedCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar/subdir');     // sanitises to a different key
    expect(t.getState().initialCwd).toBe('');
    t.onCwd('/Users/foo/bar');             // matches
    expect(t.getState().initialCwd).toBe('/Users/foo/bar');
  });

  it('initialCwd is sticky once captured (immune to mid-session cd)', () => {
    const t = new JsonlDerivedCwdTracker('-Users-foo-bar');
    t.onCwd('/Users/foo/bar');
    expect(t.getState().initialCwd).toBe('/Users/foo/bar');
    t.onCwd('/Users/foo/bar/subdir');
    expect(t.getState().initialCwd).toBe('/Users/foo/bar');  // unchanged
    expect(t.getState().cwd).toBe('/Users/foo/bar/subdir');   // drifted
  });

  it('no-ops on undefined or empty cwd', () => {
    const t = new JsonlDerivedCwdTracker('-Users-foo-bar');
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
    const t = new JsonlDerivedCwdTracker('-Users-foo-bar');
    t.dispose();
    t.dispose();
  });
});
