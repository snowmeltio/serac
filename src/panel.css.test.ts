import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Mechanical invariants over media/panel.css — the render-layer CSS that
 * ordinary component tests cannot see (they assert emitted class strings,
 * never the rules those strings land on). Each invariant encodes a shipped
 * regression class from the 2026-07-21 audit:
 *
 *  1. Theme-token parity — the light block must redefine exactly the accent
 *     tokens the dark block declares (the half-themed-chrome family: the
 *     light DONE pill shipped at 1.44:1 from v1.0.0 to v1.16.21).
 *  2. No base-recipe colour overrides under body.vscode-light — the
 *     specificity trap: `body.vscode-light .wf-tag` (0,2,1) outranked every
 *     unthemed `.wf-view-chip.wf-chip-*` state rule (0,2,0), so each new
 *     state silently shipped grey in light mode (PR #35, wf-chip-failed).
 *  3. State-family rules must colour via var(--…) tokens, never literals —
 *     new states then theme correctly with zero extra rules.
 *  4. Selector ↔ generator — every class panel.css styles must be emitted
 *     somewhere in the render layer (the CSS-cut rule, 2026-06-12: tests
 *     can't see CSS, so orphans linger silently — `.team-agent-status` and
 *     friends survived only as light-theme rules long after their markup
 *     was removed in the v1.11 team-section fold).
 *  5. Every state the renderer can emit has a rule for its family.
 */

const cssPath = path.resolve(__dirname, '..', 'media', 'panel.css');
const rawCss = fs.readFileSync(cssPath, 'utf8');
/** CSS with comments stripped — selector/declaration parsing only. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** The render layer: every file that emits panel class names. */
const generatorSource = ['panel.ts', 'panelRender.ts', 'panelUtils.ts', 'extension.ts']
  .map(f => fs.readFileSync(path.resolve(__dirname, f), 'utf8'))
  .join('\n');

/** Flat rule list: [selectorText, declarationText]. Good enough for this
 *  file — panel.css has no nested at-rule selectors beyond @keyframes,
 *  whose inner blocks parse as harmless pseudo-rules we ignore. */
const rules: Array<{ selector: string; body: string }> = [];
{
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    rules.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2].trim() });
  }
}

/** Token names declared in a block selector (e.g. ':root'). */
function tokensIn(selectorMatch: (sel: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const r of rules) {
    if (!selectorMatch(r.selector)) { continue; }
    for (const t of r.body.matchAll(/(--[\w-]+)\s*:/g)) { out.add(t[1]); }
  }
  return out;
}

describe('panel.css invariants', () => {
  it('1. light theme redefines exactly the accent/role tokens the dark theme declares', () => {
    // Role tokens are the themable accent register: --accent-*, --mode-*,
    // --chip-*, --wf-badge-*, --usage-*, --count-*. Brand tokens (--sm-*)
    // are theme-invariant by design and excluded.
    const isRole = (t: string) => /^--(accent|mode|chip|wf-badge|usage|count)-/.test(t);
    // The light token block is a comma list of body-level theme classes
    // (light + high-contrast-light) with no descendant part.
    const isThemeBlock = (s: string) =>
      s.includes('vscode-light') && s.split(',').every(p => /^body\.[\w-]+$/.test(p.trim()));
    const dark = [...tokensIn(s => s === ':root')].filter(isRole).sort();
    const light = [...tokensIn(isThemeBlock)].filter(isRole).sort();
    expect(dark.length).toBeGreaterThan(0);
    expect(light).toEqual(dark);
  });

  it('2. no body.vscode-light colour override on a base recipe (.wf-tag / .worktree-count-chip) — the specificity trap', () => {
    const offenders = rules.filter(r =>
      r.selector.includes('vscode-light')
      && /\.(wf-tag|worktree-count-chip)(?![\w-])/.test(r.selector)
      && /(?:^|;|\s)color\s*:/.test(r.body));
    expect(offenders.map(r => r.selector)).toEqual([]);
  });

  it('3. state-family rules colour via tokens, never literals', () => {
    // Families whose members are minted per-state: a literal colour in one
    // member means the next state needs a hand-written light override again.
    const family = /\.(wf-chip-[\w-]+|mode-badge-(?!glyph)[\w-]+|status-count\.[\w-]+|usage-bar-pct\.[\w-]+|usage-status\.[\w-]+)/;
    const offenders = rules.filter(r => {
      if (!family.test(r.selector)) { return false; }
      const colour = r.body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
      return colour !== null && !colour[1].includes('var(--');
    });
    expect(offenders.map(r => `${r.selector} → ${r.body}`)).toEqual([]);
  });

  it('4. every class panel.css styles is emitted by the render layer (no orphaned selectors)', () => {
    // Classes VS Code stamps on <body>, plus state classes set via classList
    // toggles rather than template literals.
    const external = new Set(['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']);
    // Dynamic families: emitted as prefix + runtime state, so the full name
    // never appears in source. Verified by presence of the prefix AND the
    // suffix string independently.
    const dynamicPrefixes = ['wf-chip-', 'mode-badge-'];
    const classes = new Set<string>();
    for (const r of rules) {
      for (const c of r.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) { classes.add(c[1]); }
    }
    const orphans: string[] = [];
    for (const cls of [...classes].sort()) {
      if (external.has(cls)) { continue; }
      if (generatorSource.includes(cls)) { continue; }
      const prefix = dynamicPrefixes.find(p => cls.startsWith(p));
      if (prefix && generatorSource.includes(prefix) && generatorSource.includes(cls.slice(prefix.length))) { continue; }
      orphans.push(cls);
    }
    expect(orphans).toEqual([]);
  });

  it('5. every state the renderer can emit has a rule in its family', () => {
    // Closed sets, pinned here on purpose: adding a state to the renderer
    // without a rule for it is exactly the wf-chip-failed regression.
    const chipStates = ['running', 'waiting', 'done', 'failed', 'incomplete'];
    for (const s of chipStates) {
      expect(css, `.wf-view-chip.wf-chip-${s} has no rule`).toMatch(new RegExp(`\\.wf-view-chip\\.wf-chip-${s}[\\s:,{.]`));
    }
    const modes = ['manual', 'edit', 'plan', 'auto', 'bypass'];
    for (const m of modes) {
      expect(css, `.mode-badge-${m} has no rule`).toMatch(new RegExp(`\\.mode-badge-${m}[\\s:,{.]`));
    }
  });
});
