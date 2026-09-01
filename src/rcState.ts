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
  /** True when this window runs under a companion profile (a non-default
   *  Claude account dir or VS Code instance dir — rcLauncher.ts's
   *  isDefaultProfile). The phone's Remote Control view is per account, so a
   *  server started from a companion window serves capacity the phone cannot
   *  reach without switching accounts there — Serac withholds the START
   *  routes in that case (the rows, and startRcServer). Observability is
   *  unaffected: the level still reports the facts as they are. */
  companionProfile: boolean;
}

export type RcLevel = 0 | 1 | 2;

export function rcLevel(f: RcFacts): RcLevel {
  return ((f.autoEnrol === true ? 1 : 0) + (f.serving ? 1 : 0)) as RcLevel;
}

/** Would a click offer anything? Mirrors rcQuickPickItems' row conditions
 *  (rcLauncher.ts): the server rows only exist outside a companion profile,
 *  the settings row whenever auto-enrol isn't confirmed on. Keeps the tooltip
 *  and aria wording honest — "click for ways to turn the rest on" must not
 *  point at a picker that would come up empty. */
export function rcHasOffers(f: RcFacts): boolean {
  return (!f.serving && !f.companionProfile) || f.autoEnrol !== true;
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
      + (f.companionProfile
        ? ' Note: it serves a companion account, so your phone cannot reach it without switching accounts there.'
        : '')
    : f.companionProfile
      ? 'No Remote Control server is running here. Serac does not offer to start one from a companion profile — a server under this account would not be reachable from your phone without switching accounts there.'
      : 'No Remote Control server is running here, so the phone cannot start a new session in this workspace.';
  const level = rcLevel(f);
  const head = level === 2 ? 'Remote Control: full. ' : level === 1 ? 'Remote Control: partial. ' : 'Remote Control: off. ';
  const tail = level === 2 || !rcHasOffers(f) ? '' : ' Click for ways to turn the rest on.';
  return head + enrol + ' ' + server + tail;
}

export function rcAriaLabel(f: RcFacts): string {
  const level = rcLevel(f);
  const options = level < 2 && rcHasOffers(f) ? '; activate for options' : '';
  return (level === 2 ? 'Remote Control full' : level === 1 ? 'Remote Control partial' : 'Remote Control off') + options;
}
