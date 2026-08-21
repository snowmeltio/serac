import { describe, it, expect } from 'vitest';
import { rcLevel, rcTooltip, rcAriaLabel } from './rcState.js';

describe('rcLevel', () => {
  it('counts the facts that are on', () => {
    expect(rcLevel({ autoEnrol: false, serving: false })).toBe(0);
    expect(rcLevel({ autoEnrol: true, serving: false })).toBe(1);
    expect(rcLevel({ autoEnrol: false, serving: true })).toBe(1);
    expect(rcLevel({ autoEnrol: true, serving: true })).toBe(2);
  });
  it('treats an unreadable auto-enrol setting as off', () => {
    expect(rcLevel({ autoEnrol: null, serving: false })).toBe(0);
    expect(rcLevel({ autoEnrol: null, serving: true })).toBe(1);
  });
});

describe('rcTooltip', () => {
  it('names both facts in every state', () => {
    const t = rcTooltip({ autoEnrol: true, serving: false });
    expect(t).toContain('go to your phone automatically');
    expect(t).toContain('No Remote Control server is running here');
    expect(t).toContain('Click for ways');
  });
  it('the full state carries no call to action', () => {
    const t = rcTooltip({ autoEnrol: true, serving: true });
    expect(t).toContain('full');
    expect(t).not.toContain('Click');
  });
  it('the rare inverse (server on, auto-enrol off) is spelled out rather than hidden', () => {
    const t = rcTooltip({ autoEnrol: false, serving: true });
    expect(t).toContain('partial');
    expect(t).toContain('do not go to your phone automatically');
    expect(t).toContain('server is running here');
  });
  it('says when settings.json could not be read instead of guessing', () => {
    expect(rcTooltip({ autoEnrol: null, serving: false })).toContain('could not read');
  });
  it('never tells the user to run a terminal command', () => {
    for (const f of [
      { autoEnrol: true, serving: false }, { autoEnrol: false, serving: false },
      { autoEnrol: false, serving: true }, { autoEnrol: null, serving: false },
    ] as const) {
      expect(rcTooltip(f)).not.toContain('claude rc');
    }
  });
});

describe('rcAriaLabel', () => {
  it('offers activation only when something is off', () => {
    expect(rcAriaLabel({ autoEnrol: true, serving: true })).not.toContain('activate');
    expect(rcAriaLabel({ autoEnrol: true, serving: false })).toContain('activate');
    expect(rcAriaLabel({ autoEnrol: false, serving: false })).toContain('activate');
  });
});
