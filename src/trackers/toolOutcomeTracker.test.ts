import { describe, it, expect, vi } from 'vitest';
import { HookEventRouter } from '../hookEventRouter.js';
import { makeToolOutcomeTracker } from './toolOutcomeTracker.js';

function mkHost() {
  return { onToolOutcome: vi.fn(), onPermissionMode: vi.fn() };
}

describe('ToolOutcomeTracker', () => {
  it('JSONL variant (no router) is a no-op', () => {
    const host = mkHost();
    const t = makeToolOutcomeTracker(host);
    t.dispose();
    expect(host.onToolOutcome).not.toHaveBeenCalled();
    expect(host.onPermissionMode).not.toHaveBeenCalled();
  });

  it('PostToolUse → onToolOutcome with name, duration, success', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeToolOutcomeTracker(host, { hookRouter: router, sessionId: 's1' });

    router.onHookEvent('s1', 'PostToolUse', {
      tool_name: 'Bash', duration_ms: 50,
      tool_response: { stdout: 'ok', interrupted: false },
    });
    expect(host.onToolOutcome).toHaveBeenCalledWith({ name: 'Bash', durationMs: 50, isError: false });
  });

  it('PostToolUse flags errors (is_error / interrupted)', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeToolOutcomeTracker(host, { hookRouter: router, sessionId: 's1' });

    router.onHookEvent('s1', 'PostToolUse', { tool_name: 'Bash', duration_ms: 5, tool_response: { is_error: true } });
    expect(host.onToolOutcome).toHaveBeenLastCalledWith({ name: 'Bash', durationMs: 5, isError: true });

    router.onHookEvent('s1', 'PostToolUse', { tool_name: 'Bash', duration_ms: 9, tool_response: { interrupted: true } });
    expect(host.onToolOutcome).toHaveBeenLastCalledWith({ name: 'Bash', durationMs: 9, isError: true });
  });

  it('PostToolUse without a tool_name is ignored', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeToolOutcomeTracker(host, { hookRouter: router, sessionId: 's1' });
    router.onHookEvent('s1', 'PostToolUse', { duration_ms: 10 });
    expect(host.onToolOutcome).not.toHaveBeenCalled();
  });

  it('PreToolUse → onPermissionMode', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeToolOutcomeTracker(host, { hookRouter: router, sessionId: 's1' });
    router.onHookEvent('s1', 'PreToolUse', { tool_name: 'Bash', permission_mode: 'acceptEdits' });
    expect(host.onPermissionMode).toHaveBeenCalledWith('acceptEdits');
  });

  it('dispose unsubscribes from both events', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    const t = makeToolOutcomeTracker(host, { hookRouter: router, sessionId: 's1' });
    t.dispose();
    router.onHookEvent('s1', 'PostToolUse', { tool_name: 'Bash', duration_ms: 1, tool_response: {} });
    router.onHookEvent('s1', 'PreToolUse', { permission_mode: 'default' });
    expect(host.onToolOutcome).not.toHaveBeenCalled();
    expect(host.onPermissionMode).not.toHaveBeenCalled();
  });

  it('tolerates malformed payloads', () => {
    const router = new HookEventRouter();
    const host = mkHost();
    makeToolOutcomeTracker(host, { hookRouter: router, sessionId: 's1' });
    expect(() => router.onHookEvent('s1', 'PostToolUse', null)).not.toThrow();
    expect(() => router.onHookEvent('s1', 'PreToolUse', 42)).not.toThrow();
    expect(host.onToolOutcome).not.toHaveBeenCalled();
  });
});
