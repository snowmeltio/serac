import type { WebviewCommand } from './types.js';

/** Reject session IDs that could be used for path traversal */
export function isValidSessionId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) { return false; }
  if (id.includes('/') || id.includes('\\') || id.includes('..') || id.includes('\0')) { return false; }
  return true;
}

/** Known webview command types */
const VALID_COMMAND_TYPES = new Set([
  'focusSession', 'dismissSession', 'undismissSession', 'viewTranscript',
  'newChat', 'copyToClipboard', 'requestUpdate', 'cleanup', 'archiveRange',
  'dismissTeam', 'undismissTeam', 'openWorkspace', 'footerSlotClick',
]);

/** Slot ids must mirror FooterSlotRegistry's regex (kept in sync there). */
const SLOT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;


/** Reject working directories that aren't an absolute filesystem path */
function isValidCwd(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) { return false; }
  if (p.includes('\0')) { return false; }
  // Must be absolute on POSIX or a Windows drive path
  if (!(p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p))) { return false; }
  return true;
}

/** Validate a raw webview message into a typed WebviewCommand, or return null */
export function parseWebviewCommand(raw: unknown): WebviewCommand | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const msg = raw as Record<string, unknown>;

  if (typeof msg.type !== 'string' || !VALID_COMMAND_TYPES.has(msg.type)) { return null; }

  // Commands with sessionId
  if (msg.type === 'focusSession' || msg.type === 'dismissSession' ||
      msg.type === 'undismissSession' || msg.type === 'viewTranscript') {
    if (!isValidSessionId(msg.sessionId)) { return null; }
    return { type: msg.type, sessionId: msg.sessionId } as WebviewCommand;
  }

  // Team commands with teamId
  if (msg.type === 'dismissTeam' || msg.type === 'undismissTeam') {
    if (!isValidSessionId(msg.teamId)) { return null; }
    return { type: msg.type, teamId: msg.teamId } as WebviewCommand;
  }

  // archiveRange needs a numeric rangeMs
  if (msg.type === 'archiveRange') {
    if (typeof msg.rangeMs !== 'number' || msg.rangeMs < 0) { return null; }
    return { type: 'archiveRange', rangeMs: msg.rangeMs };
  }

  // copyToClipboard needs a text string
  if (msg.type === 'copyToClipboard') {
    if (typeof msg.text !== 'string' || msg.text.length > 1000) { return null; }
    return { type: 'copyToClipboard', text: msg.text };
  }

  // footerSlotClick needs a valid slotId
  if (msg.type === 'footerSlotClick') {
    if (typeof msg.slotId !== 'string' || !SLOT_ID_RE.test(msg.slotId)) { return null; }
    return { type: 'footerSlotClick', slotId: msg.slotId };
  }


  // openWorkspace requires an absolute cwd, optional sessionId
  if (msg.type === 'openWorkspace') {
    if (!isValidCwd(msg.cwd)) { return null; }
    const result: WebviewCommand = { type: 'openWorkspace', cwd: msg.cwd };
    if (msg.sessionId !== undefined) {
      if (!isValidSessionId(msg.sessionId)) { return null; }
      result.sessionId = msg.sessionId;
    }
    return result;
  }

  // Simple commands (no payload)
  return { type: msg.type } as WebviewCommand;
}
