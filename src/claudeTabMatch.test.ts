import { describe, it, expect } from 'vitest';
import {
  tabLabelMatchesTitle, sessionTitleCandidates, strongTitleCandidates, findTabByLabel, findRevealedTab,
} from './claudeTabMatch.js';

/** Claude Code's own label rule: ≤25 chars verbatim, else 24 chars + "…". */
const label = (title: string) => (title.length > 25 ? title.substring(0, 24) + '…' : title);
const tab = (l: string, isActive = false) => ({ label: l, isActive });

describe('tabLabelMatchesTitle', () => {
  it('matches a short title exactly', () => {
    expect(tabLabelMatchesTitle('PMC meeting voting', 'PMC meeting voting')).toBe(true);
    expect(tabLabelMatchesTitle('PMC meeting voting', 'PMC meeting votes')).toBe(false);
  });

  it('matches a truncated label by strict prefix', () => {
    const title = 'Meet webcam lost in Chrome after update';
    expect(tabLabelMatchesTitle(label(title), title)).toBe(true);
    expect(tabLabelMatchesTitle(label(title), 'Meet webcam lost in Chrom')).toBe(true);
    // The bare prefix itself is not a match (Claude Code's own rule).
    expect(tabLabelMatchesTitle(label(title), 'Meet webcam lost in Chro')).toBe(false);
  });

  it('normalises whitespace on both sides', () => {
    expect(tabLabelMatchesTitle('Fix  the\nbuild', 'Fix the build')).toBe(true);
  });

  it('never treats the default "Claude Code" label or empty strings as evidence', () => {
    expect(tabLabelMatchesTitle('Claude Code', 'Claude Code')).toBe(false);
    expect(tabLabelMatchesTitle('', 'x')).toBe(false);
    expect(tabLabelMatchesTitle('x', '  ')).toBe(false);
    expect(tabLabelMatchesTitle('…', 'anything')).toBe(false);
  });
});

describe('sessionTitleCandidates', () => {
  it('collects non-empty, de-duplicated titles in priority order', () => {
    expect(sessionTitleCandidates({ customTitle: '', aiTitle: 'A', title: 'A', topic: 'T' }))
      .toEqual(['A', 'T']);
    expect(sessionTitleCandidates({ title: null })).toEqual([]);
  });

  it('strong candidates exclude the first-prompt extractions', () => {
    expect(strongTitleCandidates({ customTitle: 'C', aiTitle: 'A', title: 'T', topic: 'P' })).toEqual(['C', 'A']);
    expect(strongTitleCandidates({ title: 'T', topic: 'P' })).toEqual([]);
  });
});

describe('findTabByLabel', () => {
  const target = ['Snowmelt website refresh landing page'];

  it('returns the single matching tab', () => {
    const hit = tab(label(target[0]));
    expect(findTabByLabel([tab('Other'), hit], target, [['Other']])).toBe(hit);
  });

  it('refuses when two tabs match', () => {
    const a = tab(label(target[0]));
    const b = tab(label(target[0]));
    expect(findTabByLabel([a, b], target, [])).toBeUndefined();
  });

  it('refuses when the label also fits another known session (shared 24-char prefix)', () => {
    const other = 'Snowmelt website refresh nav menu';
    const hit = tab(label(target[0])); // "Snowmelt website refresh…" fits both
    expect(findTabByLabel([hit], target, [[other]])).toBeUndefined();
  });

  it('returns undefined with no titles to match (no guessing)', () => {
    expect(findTabByLabel([tab('x', true)], [], [])).toBeUndefined();
  });
});

describe('findRevealedTab', () => {
  const target = ['Target session'];

  it('picks a tab the reveal created', () => {
    const existing = tab('Other', true);
    const created = tab('Claude Code', true);
    const before = new Map([[existing, true]]);
    expect(findRevealedTab(before, [existing, created], target, [])).toBe(created);
  });

  it('picks the single tab that became active in its group', () => {
    const a = tab('Target session', false);
    const b = tab('Other', true);
    const before = new Map([[a, false], [b, true]]);
    a.isActive = true; // the reveal activated it (tab objects are live)
    expect(findRevealedTab(before, [a, b], target, [['Other']])).toBe(a);
  });

  it('refuses when the reveal changed nothing (sidebar-held session), even if a Claude tab is active', () => {
    // The original bug: the active Claude tab belongs to ANOTHER session.
    const unrelated = tab('Unrelated running session', true);
    const before = new Map([[unrelated, true]]);
    expect(findRevealedTab(before, [unrelated], target, [['Unrelated running session']])).toBeUndefined();
  });

  it('refuses a newly-active tab whose label identifies a different session', () => {
    const a = tab('Someone else', false);
    const before = new Map([[a, false]]);
    a.isActive = true;
    expect(findRevealedTab(before, [a], target, [['Someone else']])).toBeUndefined();
  });

  it('accepts a newly-active tab with an unknown real title, refuses the untitled default', () => {
    const a = tab('Renamed elsewhere', false);
    const before = new Map([[a, false]]);
    a.isActive = true;
    expect(findRevealedTab(before, [a], target, [['Other']])).toBe(a);
    const d = tab('Claude Code', false);
    const beforeD = new Map([[d, false]]);
    d.isActive = true;
    expect(findRevealedTab(beforeD, [d], target, [])).toBeUndefined();
  });

  it('refuses when two tabs became active', () => {
    const a = tab('x', false);
    const b = tab('y', false);
    const before = new Map([[a, false], [b, false]]);
    a.isActive = true;
    b.isActive = true;
    expect(findRevealedTab(before, [a, b], target, [])).toBeUndefined();
  });

  it('with several created tabs, takes only a unique label match', () => {
    const c1 = tab('Target session');
    const c2 = tab('Claude Code');
    expect(findRevealedTab(new Map(), [c1, c2], target, [])).toBe(c1);
    expect(findRevealedTab(new Map(), [tab('Claude Code'), tab('Claude Code')], target, [])).toBeUndefined();
  });
});
