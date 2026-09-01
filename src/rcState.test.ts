import { describe, it, expect } from 'vitest';
import { rcLevel, rcTooltip, rcAriaLabel, rcHasOffers } from './rcState.js';

describe('rcLevel', () => {
  it('counts the facts that are on', () => {
    expect(rcLevel({ autoEnrol: false, serving: false, companionProfile: false })).toBe(0);
    expect(rcLevel({ autoEnrol: true, serving: false, companionProfile: false })).toBe(1);
    expect(rcLevel({ autoEnrol: false, serving: true, companionProfile: false })).toBe(1);
    expect(rcLevel({ autoEnrol: true, serving: true, companionProfile: false })).toBe(2);
  });
  it('treats an unreadable auto-enrol setting as off', () => {
    expect(rcLevel({ autoEnrol: null, serving: false, companionProfile: false })).toBe(0);
    expect(rcLevel({ autoEnrol: null, serving: true, companionProfile: false })).toBe(1);
  });
  it('a companion profile does not change the level — it reports facts', () => {
    expect(rcLevel({ autoEnrol: true, serving: true, companionProfile: true })).toBe(2);
    expect(rcLevel({ autoEnrol: false, serving: true, companionProfile: true })).toBe(1);
  });
});

describe('rcTooltip', () => {
  it('names both facts in every state', () => {
    const t = rcTooltip({ autoEnrol: true, serving: false, companionProfile: false });
    expect(t).toContain('go to your phone automatically');
    expect(t).toContain('No Remote Control server is running here');
    expect(t).toContain('Click for ways');
  });
  it('the full state carries no call to action', () => {
    const t = rcTooltip({ autoEnrol: true, serving: true, companionProfile: false });
    expect(t).toContain('full');
    expect(t).not.toContain('Click');
  });
  it('the rare inverse (server on, auto-enrol off) is spelled out rather than hidden', () => {
    const t = rcTooltip({ autoEnrol: false, serving: true, companionProfile: false });
    expect(t).toContain('partial');
    expect(t).toContain('do not go to your phone automatically');
    expect(t).toContain('server is running here');
  });
  it('says when settings.json could not be read instead of guessing', () => {
    expect(rcTooltip({ autoEnrol: null, serving: false, companionProfile: false })).toContain('could not read');
  });
  it('never tells the user to run a terminal command', () => {
    for (const f of [
      { autoEnrol: true, serving: false, companionProfile: false },
      { autoEnrol: false, serving: false, companionProfile: false },
      { autoEnrol: false, serving: true, companionProfile: false },
      { autoEnrol: null, serving: false, companionProfile: false },
      { autoEnrol: true, serving: false, companionProfile: true },
      { autoEnrol: false, serving: true, companionProfile: true },
    ] as const) {
      expect(rcTooltip(f)).not.toContain('claude rc');
    }
  });
  it('a hand-started server in a companion profile keeps its level but gains the caveat', () => {
    const t = rcTooltip({ autoEnrol: true, serving: true, companionProfile: true });
    expect(t).toContain('full');
    expect(t).toContain('companion account');
    expect(t).toContain('switching accounts');
  });
  it('a companion profile with no server says why Serac does not offer to start one', () => {
    const t = rcTooltip({ autoEnrol: false, serving: false, companionProfile: true });
    expect(t).toContain('does not offer to start one from a companion profile');
    // The settings row is still offerable, so the call to action stays.
    expect(t).toContain('Click for ways');
  });
  it('a companion profile with nothing left to offer drops the call to action', () => {
    // auto-enrol on, no server: the only rows would be the withheld server
    // ones, so "click for ways" would point at an empty picker.
    const t = rcTooltip({ autoEnrol: true, serving: false, companionProfile: true });
    expect(t).not.toContain('Click');
  });
});

describe('rcHasOffers', () => {
  it('mirrors the picker rows: server rows outside companion, settings row while auto-enrol is not confirmed on', () => {
    expect(rcHasOffers({ autoEnrol: true, serving: false, companionProfile: false })).toBe(true);
    expect(rcHasOffers({ autoEnrol: true, serving: false, companionProfile: true })).toBe(false);
    expect(rcHasOffers({ autoEnrol: false, serving: false, companionProfile: true })).toBe(true);
    expect(rcHasOffers({ autoEnrol: null, serving: true, companionProfile: true })).toBe(true);
    expect(rcHasOffers({ autoEnrol: true, serving: true, companionProfile: false })).toBe(false);
  });
});

describe('rcAriaLabel', () => {
  it('offers activation only when something is off', () => {
    expect(rcAriaLabel({ autoEnrol: true, serving: true, companionProfile: false })).not.toContain('activate');
    expect(rcAriaLabel({ autoEnrol: true, serving: false, companionProfile: false })).toContain('activate');
    expect(rcAriaLabel({ autoEnrol: false, serving: false, companionProfile: false })).toContain('activate');
  });
  it('says why instead of offering activation when the profile gate leaves nothing to offer', () => {
    // The span is still a button below full, so a bare "partial" would be a
    // dead button to a screen reader — the label carries the reason.
    const label = rcAriaLabel({ autoEnrol: true, serving: false, companionProfile: true });
    expect(label).not.toContain('activate');
    expect(label).toContain('unavailable in a companion profile');
    expect(rcAriaLabel({ autoEnrol: false, serving: false, companionProfile: true })).toContain('activate');
  });
});
