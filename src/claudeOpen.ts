import * as vscode from 'vscode';

/** Arguments for `claude-vscode.editor.open`, honouring where the user keeps
 *  Claude Code.
 *
 *  The command's signature (2.1.310 bundle) is
 *  `(sessionId, initialPrompt, viewColumn, groupId, fullEditor, opts)`. Called
 *  with no `opts`, Claude Code opens an editor TAB and resets
 *  `claudeCode.preferredLocation` to "panel", unless the side view already
 *  holds that session. So every card click would undo a user's choice to keep
 *  Claude in its side view (and drop a Claude tab next to their files).
 *  `opts.programmatic` (internal to Claude Code; its own sessions list passes
 *  it) never touches the setting:
 *  - 'honor-preferred-location' activates the session in the side view,
 *    unless Claude Code has a live panel bound to it, which it reveals. A
 *    restored tab that has not been revived yet does not count.
 *  - 'pin-to-panel' keeps the historical tab semantics: reveal, revive, or
 *    create a tab (a session the side view holds is still shown there).
 *
 *  `opts` is sent only when the user has chosen the side view: with "panel"
 *  (the default) the call is exactly the historical one, focus on the chat
 *  input included. If Claude Code ever drops the option, the sidebar case
 *  degrades to the old behaviour, a tab, rather than failing.
 *
 *  `purpose`: 'show' for opens the user asked for (they land where Claude
 *  lives); 'tab' for the release reveal pass, which needs a tab it can find
 *  and close. In sidebar mode, editor.open resolving means the request was
 *  accepted, not that the session is on screen: poll for evidence. */
export function claudeOpenArgs(sessionId: string | undefined, purpose: OpenPurpose = 'show'): unknown[] {
  return claudeOpenArgsFor(sessionId, preferredClaudeLocation(), purpose);
}

export type ClaudeLocation = 'sidebar' | 'panel';
export type OpenPurpose = 'show' | 'tab';

/** Claude Code's own setting; anything but "sidebar" means tabs. */
export function preferredClaudeLocation(): ClaudeLocation {
  const v = vscode.workspace.getConfiguration('claudeCode').get<string>('preferredLocation');
  return v === 'sidebar' ? 'sidebar' : 'panel';
}

/** Pure core of {@link claudeOpenArgs}. */
export function claudeOpenArgsFor(
  sessionId: string | undefined, location: ClaudeLocation, purpose: OpenPurpose = 'show',
): unknown[] {
  const base: unknown[] = [sessionId, undefined, vscode.ViewColumn.One];
  if (location !== 'sidebar') { return base; }
  const programmatic = purpose === 'tab' ? 'pin-to-panel' : 'honor-preferred-location';
  return [...base, undefined, undefined, { programmatic }];
}
