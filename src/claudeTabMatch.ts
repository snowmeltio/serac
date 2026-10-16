/** Identify the Claude Code editor tab that hosts a given session.
 *
 *  Claude tabs are `TabInputWebview`s sharing one viewType
 *  (`claudeVSCodePanel`), so nothing in the tab input names the session. The
 *  only per-session signal is the tab label: Claude Code sets it to the
 *  session's title (custom title, else AI title, else first prompt) cut to 25
 *  characters (24 + "…"), and infers its own tab↔session mapping from that
 *  label the same way (2.1.300 bundle, `vL1`).
 *
 *  A close driven by the release flow must never fall back to "whichever
 *  Claude tab is active". When the Claude sidebar holds the session, or the
 *  reveal lands after `claude-vscode.editor.open` resolves, the active tab
 *  belongs to a DIFFERENT session — and closing a Claude tab aborts its turn
 *  with no prompt. Every picker here returns undefined rather than guess. */

/** The label Claude Code gives a tab with no title yet — never evidence. */
export const CLAUDE_DEFAULT_TAB_LABEL = 'Claude Code';

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Mirrors Claude Code's own label test: equal after whitespace
 *  normalisation, or — for a label truncated with "…" — a strict prefix. */
export function tabLabelMatchesTitle(label: string, title: string): boolean {
  const l = normalise(label);
  const t = normalise(title);
  if (!l || !t || l === CLAUDE_DEFAULT_TAB_LABEL) { return false; }
  if (l.endsWith('…')) {
    const prefix = l.slice(0, -1);
    return prefix !== '' && t !== prefix && t.startsWith(prefix);
  }
  return l === t;
}

export interface SessionTitleFields {
  customTitle?: string;
  aiTitle?: string;
  title?: string | null;
  topic?: string;
}

/** Every title Claude Code might have put on the session's tab. Serac's
 *  `title`/`topic` stand in for Claude's first-prompt fallback. */
export function sessionTitleCandidates(s: SessionTitleFields): string[] {
  const out: string[] = [];
  for (const t of [s.customTitle, s.aiTitle, s.title, s.topic]) {
    if (typeof t === 'string' && t.trim() !== '' && !out.includes(t)) { out.push(t); }
  }
  return out;
}

/** The titles strong enough to close a tab WITHOUT a reveal: the custom and
 *  AI titles. Serac's `title`/`topic` are first-prompt extractions, and
 *  sessions started from the same pasted prompt share them — a label match on
 *  those alone is left to the reveal pass. */
export function strongTitleCandidates(s: SessionTitleFields): string[] {
  return sessionTitleCandidates({ customTitle: s.customTitle, aiTitle: s.aiTitle });
}

function matchesAny(label: string, titles: readonly string[]): boolean {
  return titles.some(t => tabLabelMatchesTitle(label, t));
}

/** The one tab whose label identifies the target session, without revealing
 *  anything. Undefined when no tab matches, when two do, or when the matching
 *  label also fits another known session (a shared 24-character prefix). */
export function findTabByLabel<T extends { label: string }>(
  tabs: readonly T[],
  targetTitles: readonly string[],
  otherTitles: readonly (readonly string[])[],
): T | undefined {
  const hits = tabs.filter(t => matchesAny(t.label, targetTitles));
  if (hits.length !== 1) { return undefined; }
  const hit = hits[0];
  if (otherTitles.some(o => matchesAny(hit.label, o))) { return undefined; }
  return hit;
}

/** After revealing the session, the tab the reveal produced:
 *  - a tab that did not exist before (the open created it, so closing it
 *    never leaves an extra writer behind; its label is usually still the
 *    untitled default), refused only when its label names another session,
 *    and taken by label match if several appeared; else
 *  - the single Claude tab that went from inactive to active in its group
 *    AND whose label matches the target's titles. During the watch the user
 *    can click a tab, or another open can land, so activation alone is not
 *    evidence.
 *  `before` maps each pre-reveal tab to its `isActive` AT THAT MOMENT (tab
 *  objects are live, so the boolean must be captured, not re-read).
 *  Undefined when nothing qualifies: the sidebar holds the session, or its
 *  tab was already active, or the label does not match. */
export function findRevealedTab<T extends { label: string; isActive: boolean }>(
  before: ReadonlyMap<T, boolean>,
  after: readonly T[],
  targetTitles: readonly string[],
  otherTitles: readonly (readonly string[])[],
): T | undefined {
  const created = after.filter(t => !before.has(t));
  if (created.length === 1) {
    const tab = created[0];
    const namesOther = !matchesAny(tab.label, targetTitles) && otherTitles.some(o => matchesAny(tab.label, o));
    return namesOther ? undefined : tab;
  }
  if (created.length > 1) { return findTabByLabel(created, targetTitles, otherTitles); }
  const activated = after.filter(t => t.isActive && before.get(t) === false);
  return findTabByLabel(activated, targetTitles, otherTitles);
}
