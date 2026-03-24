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
]);

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

  // Simple commands (no payload)
  return { type: msg.type } as WebviewCommand;
}
