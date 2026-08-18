import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Mechanical invariants over media/detailView.css — layout rules the jsdom
 * integration tests cannot see (no layout engine; they assert DOM structure
 * only). Each invariant pins a shipped regression:
 *
 *  1. The log's height floor — .wf-log-scroll shipped with min-height: 0
 *     (the flex shrink enabler), so a full agent strip (130-pill workflow,
 *     2026-08-17) legally squeezed the transcript and its facet bar to 0px.
 *  2. The expanded agent strip must be a bounded internal scroller — without
 *     max-height + overflow it grows past the pane and the floor in (1) just
 *     clips the zones below instead.
 */

const cssPath = path.resolve(__dirname, '..', 'media', 'detailView.css');
const rawCss = fs.readFileSync(cssPath, 'utf8');
/** CSS with comments stripped — selector/declaration parsing only. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** Flat rule list: [selectorText, declarationText]. detailView.css has no
 *  nested at-rule selectors, so the shallow parse is exact. */
const rules: Array<{ selector: string; body: string }> = [];
{
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    rules.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2].trim() });
  }
}

function declaration(selector: string, property: string): string | null {
  for (const r of rules) {
    if (r.selector !== selector) { continue; }
    const m = r.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (m) { return m[1].trim(); }
  }
  return null;
}

describe('detailView.css layout invariants', () => {
  it('the log keeps a non-zero height floor so tall zones cannot crush it', () => {
    const minHeight = declaration('.wf-log-scroll', 'min-height');
    expect(minHeight).not.toBeNull();
    expect(minHeight).not.toBe('0');
    expect(minHeight).not.toBe('0px');
  });

  it('the expanded agent strip is a bounded internal scroller', () => {
    const sel = '.wf-agentstrip:not(.collapsed)';
    expect(declaration(sel, 'max-height')).not.toBeNull();
    expect(declaration(sel, 'overflow-y')).toBe('auto');
    // The explicit floor is what overrides flex min-height:auto (min-content)
    // and lets the strip shrink at all — without it max-height alone caps
    // growth but the strip still refuses to give way on short panes.
    const minHeight = declaration(sel, 'min-height');
    expect(minHeight).not.toBeNull();
    expect(minHeight).not.toBe('0');
  });

  it('the collapsed strip keeps its one-line clip (no scroller leaking in)', () => {
    // The scroller rule must stay scoped to :not(.collapsed) — a bare
    // .wf-agentstrip { overflow-y: auto; … } would fight the collapsed
    // single-line clip at detailView.css `.wf-agentstrip.collapsed`.
    expect(declaration('.wf-agentstrip', 'overflow-y')).toBeNull();
    expect(declaration('.wf-agentstrip', 'max-height')).toBeNull();
  });
});
