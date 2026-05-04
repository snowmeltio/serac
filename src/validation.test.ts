import { describe, it, expect } from 'vitest';
import { isValidSessionId, parseWebviewCommand } from './validation.js';

describe('isValidSessionId', () => {
  it('accepts a normal UUID-style session ID', () => {
    expect(isValidSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  });

  it('accepts a short hex ID', () => {
    expect(isValidSessionId('abc123')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects non-string types', () => {
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
    expect(isValidSessionId({})).toBe(false);
  });

  it('rejects forward slash (path traversal)', () => {
    expect(isValidSessionId('../etc/passwd')).toBe(false);
    expect(isValidSessionId('foo/bar')).toBe(false);
  });

  it('rejects backslash', () => {
    expect(isValidSessionId('foo\\bar')).toBe(false);
  });

  it('rejects dot-dot without slash', () => {
    expect(isValidSessionId('..hidden')).toBe(false);
  });

  it('rejects null bytes', () => {
    expect(isValidSessionId('abc\0def')).toBe(false);
  });

  it('rejects strings over 200 chars', () => {
    expect(isValidSessionId('a'.repeat(201))).toBe(false);
  });

  it('accepts strings at 200 chars', () => {
    expect(isValidSessionId('a'.repeat(200))).toBe(true);
  });
});

describe('parseWebviewCommand', () => {
  it('rejects null/undefined/non-object', () => {
    expect(parseWebviewCommand(null)).toBeNull();
    expect(parseWebviewCommand(undefined)).toBeNull();
    expect(parseWebviewCommand('string')).toBeNull();
    expect(parseWebviewCommand(42)).toBeNull();
  });

  it('rejects unknown type', () => {
    expect(parseWebviewCommand({ type: 'hackTheSystem' })).toBeNull();
  });

  it('rejects missing type', () => {
    expect(parseWebviewCommand({ sessionId: 'abc123' })).toBeNull();
  });

  it('parses focusSession with valid sessionId', () => {
    const result = parseWebviewCommand({ type: 'focusSession', sessionId: 'abc123' });
    expect(result).toEqual({ type: 'focusSession', sessionId: 'abc123' });
  });

  it('rejects focusSession with invalid sessionId', () => {
    expect(parseWebviewCommand({ type: 'focusSession', sessionId: '../etc' })).toBeNull();
    expect(parseWebviewCommand({ type: 'focusSession', sessionId: 123 })).toBeNull();
    expect(parseWebviewCommand({ type: 'focusSession' })).toBeNull();
  });

  it('parses copyToClipboard with valid text', () => {
    const result = parseWebviewCommand({ type: 'copyToClipboard', text: 'abc123' });
    expect(result).toEqual({ type: 'copyToClipboard', text: 'abc123' });
  });

  it('rejects copyToClipboard with non-string text', () => {
    expect(parseWebviewCommand({ type: 'copyToClipboard', text: 123 })).toBeNull();
  });

  it('rejects copyToClipboard with overly long text', () => {
    expect(parseWebviewCommand({ type: 'copyToClipboard', text: 'x'.repeat(1001) })).toBeNull();
  });

  it('parses simple commands', () => {
    expect(parseWebviewCommand({ type: 'newChat' })).toEqual({ type: 'newChat' });
    expect(parseWebviewCommand({ type: 'requestUpdate' })).toEqual({ type: 'requestUpdate' });
    expect(parseWebviewCommand({ type: 'cleanup' })).toEqual({ type: 'cleanup' });
  });

  it('ignores extra fields on valid commands', () => {
    const result = parseWebviewCommand({
      type: 'focusSession',
      sessionId: 'valid-id',
      extra: { nested: true },
    });
    expect(result).toEqual({ type: 'focusSession', sessionId: 'valid-id' });
  });

  it('rejects type as number, boolean, null, or undefined', () => {
    expect(parseWebviewCommand({ type: 42 })).toBeNull();
    expect(parseWebviewCommand({ type: true })).toBeNull();
    expect(parseWebviewCommand({ type: null })).toBeNull();
    expect(parseWebviewCommand({ type: undefined })).toBeNull();
  });

  it('accepts copyToClipboard with text at exactly 1000 chars', () => {
    const result = parseWebviewCommand({ type: 'copyToClipboard', text: 'x'.repeat(1000) });
    expect(result).toEqual({ type: 'copyToClipboard', text: 'x'.repeat(1000) });
  });

  it('rejects copyToClipboard with text at 1001 chars', () => {
    expect(parseWebviewCommand({ type: 'copyToClipboard', text: 'x'.repeat(1001) })).toBeNull();
  });

  it('rejects empty string, array, and bare number inputs', () => {
    expect(parseWebviewCommand('')).toBeNull();
    expect(parseWebviewCommand([])).toBeNull();
    expect(parseWebviewCommand(0)).toBeNull();
  });

  it('parses footerSlotClick with a valid slot id', () => {
    const result = parseWebviewCommand({ type: 'footerSlotClick', slotId: 'snowmelt-account' });
    expect(result).toEqual({ type: 'footerSlotClick', slotId: 'snowmelt-account' });
  });

  it('rejects footerSlotClick with a malformed slot id', () => {
    expect(parseWebviewCommand({ type: 'footerSlotClick', slotId: '../etc' })).toBeNull();
    expect(parseWebviewCommand({ type: 'footerSlotClick', slotId: '' })).toBeNull();
    expect(parseWebviewCommand({ type: 'footerSlotClick', slotId: 1 })).toBeNull();
    expect(parseWebviewCommand({ type: 'footerSlotClick' })).toBeNull();
    expect(parseWebviewCommand({ type: 'footerSlotClick', slotId: '1starts-with-digit' })).toBeNull();
  });
});

describe('isValidSessionId — boundary and traversal cases', () => {
  it('accepts exactly 200 characters', () => {
    expect(isValidSessionId('a'.repeat(200))).toBe(true);
  });

  it('rejects exactly 201 characters', () => {
    expect(isValidSessionId('a'.repeat(201))).toBe(false);
  });

  it('rejects null bytes in various positions', () => {
    expect(isValidSessionId('\0abc')).toBe(false);
    expect(isValidSessionId('abc\0')).toBe(false);
    expect(isValidSessionId('ab\0cd')).toBe(false);
  });

  it('rejects forward and back slashes in various positions', () => {
    expect(isValidSessionId('/leading')).toBe(false);
    expect(isValidSessionId('trailing/')).toBe(false);
    expect(isValidSessionId('mid/dle')).toBe(false);
    expect(isValidSessionId('\\leading')).toBe(false);
    expect(isValidSessionId('trailing\\')).toBe(false);
  });

  it('rejects dot-dot in various positions', () => {
    expect(isValidSessionId('..')).toBe(false);
    expect(isValidSessionId('..start')).toBe(false);
    expect(isValidSessionId('end..')).toBe(false);
    expect(isValidSessionId('mid..dle')).toBe(false);
    expect(isValidSessionId('foo/../bar')).toBe(false);
  });
});

