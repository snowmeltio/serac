import { describe, it, expect } from 'vitest';
import { isRcOriginTranscript, RC_ENTRYPOINT } from './rcOrigin.js';
import { isRcOriginTranscript as viaDetector, RC_ENTRYPOINT as viaDetectorConst } from './rcDetector.js';

describe('isRcOriginTranscript', () => {
  it('true only for the sdk-cli stamp', () => {
    expect(isRcOriginTranscript('sdk-cli')).toBe(true);
    expect(isRcOriginTranscript('claude-vscode')).toBe(false);
    expect(isRcOriginTranscript('cli')).toBe(false);
    expect(isRcOriginTranscript('sdk-ts')).toBe(false); // programmatic, but not a phone session
    expect(isRcOriginTranscript(undefined)).toBe(false);
    expect(isRcOriginTranscript('')).toBe(false);
  });
  it('rcDetector re-exports the same predicate and constant', () => {
    expect(viaDetector).toBe(isRcOriginTranscript);
    expect(viaDetectorConst).toBe(RC_ENTRYPOINT);
    expect(RC_ENTRYPOINT).toBe('sdk-cli');
  });
});
