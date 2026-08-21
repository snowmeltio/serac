/**
 * Remote Control top-bar state: two independent facts folded into a signal
 * level, plus the words for the tooltip. Pure and webview-safe (bundled into
 * media/panel.js via panelRender.ts) — no fs, no vscode.
 *
 * The two facts answer two different questions:
 *  - `autoEnrol` — Claude Code's `remoteControlAtStartup` setting ("Enable
 *    Remote Control for all sessions"): do sessions started HERE go to the
 *    phone automatically? `null` = Serac could not read settings.json.
 *  - `serving` — is a `claude rc` server hosting sessions in this workspace
 *    (rcDetector.ts): can the phone START a new session here, and do those
 *    outlive this window?
 *
 * The level is simply how many are on (0 / 1 / 2). The common case is 1 bar:
 * auto-enrol on, no server. The rare inverse (server on, auto-enrol off) is
 * also 1 bar — the tooltip says which, rather than inventing a fourth glyph.
 */

export interface RcFacts {
  autoEnrol: boolean | null;
  serving: boolean;
}

export type RcLevel = 0 | 1 | 2;

export function rcLevel(f: RcFacts): RcLevel {
  return ((f.autoEnrol === true ? 1 : 0) + (f.serving ? 1 : 0)) as RcLevel;
}

/** Plain-words tooltip: both facts, always, and what the click offers when
 *  something is off. Written for the person who never opens a terminal. */
export function rcTooltip(f: RcFacts): string {
  const enrol = f.autoEnrol === true
    ? 'Sessions you start here go to your phone automatically.'
    : f.autoEnrol === false
      ? 'Sessions you start here do not go to your phone automatically (Claude Code\'s "Enable Remote Control for all sessions" is off).'
      : 'Serac could not read Claude Code\'s settings.json, so it cannot tell whether sessions you start here go to your phone automatically.';
  const server = f.serving
    ? 'A Remote Control server is running here, so the phone can also start new sessions in this workspace, and they keep running with VS Code closed.'
    : 'No Remote Control server is running here, so the phone cannot start a new session in this workspace.';
  const level = rcLevel(f);
  const head = level === 2 ? 'Remote Control: full. ' : level === 1 ? 'Remote Control: partial. ' : 'Remote Control: off. ';
  const tail = level === 2 ? '' : ' Click for ways to turn the rest on.';
  return head + enrol + ' ' + server + tail;
}

export function rcAriaLabel(f: RcFacts): string {
  const level = rcLevel(f);
  return level === 2 ? 'Remote Control full' : level === 1 ? 'Remote Control partial; activate for options' : 'Remote Control off; activate for options';
}
