/**
 * Stop-hook acceleration + turn-close guard (ARCHITECTURE.md "The Stop
 * turn-close guard"). The headline risk the design red-team caught: a naive
 * Stop→done flickers done→running→done because the turn's trailing assistant
 * record is polled after the hook and re-fires running. These tests pin the
 * guard that prevents it, and prove genuine new turns still reopen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JsonlRecord } from './types.js';
import { HookEventRouter } from './hookEventRouter.js';

let mockRecords: JsonlRecord[] = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    async readNewRecords() {
      const r = mockRecords;
      mockRecords = [];
      return r;
    }
  },
}));

const { SessionManager } = await import('./sessionManager.js');

const SID = 'stop-session';
function makeManager(router: HookEventRouter): InstanceType<typeof SessionManager> {
  return new SessionManager(SID, '/tmp/test.jsonl', 'test-workspace', { hookRouter: router });
}
async function feed(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}
function ts(): string { return new Date().toISOString(); }
const fireStop = (router: HookEventRouter, stopHookActive = false) =>
  router.onHookEvent(SID, 'Stop', { hook_event_name: 'Stop', stop_hook_active: stopHookActive });

describe('Stop hook: acceleration + turn-close guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  it('Stop accelerates running → done', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager(router);
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'working' }] } }]);
    expect(mgr.getStatus()).toBe('running');

    fireStop(router);
    expect(mgr.getStatus()).toBe('done');
  });

  it('the turn\'s trailing assistant record does NOT reopen to running (no flicker)', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager(router);
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'partial' }] } }]);

    fireStop(router);
    expect(mgr.getStatus()).toBe('done');

    // Poll catches up on the turn's final text record AFTER the hook.
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'final answer' }] } }]);
    expect(mgr.getStatus()).toBe('done'); // guard held — would be 'running' without it
  });

  it('a trailing tool_use does not repopulate activeTools on a closed turn', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager(router);
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'done thinking' }] } }]);
    fireStop(router);

    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Read', id: 'late1' }] } }]);
    // Still done, and no stray tool keeping it alive → demoteIfStale can't flip it.
    expect(mgr.getStatus()).toBe('done');
    vi.advanceTimersByTime(60_000);
    mgr.demoteIfStale(30_000);
    expect(mgr.getStatus()).toBe('done');
  });

  it('a genuine new turn (user record) reopens to running after Stop', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager(router);
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'answer' }] } }]);
    fireStop(router);
    expect(mgr.getStatus()).toBe('done');

    await feed(mgr, [{ type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'next question' }] } }]);
    expect(mgr.getStatus()).toBe('running');

    // And a subsequent assistant record now processes normally (guard released).
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'replying' }] } }]);
    expect(mgr.getStatus()).toBe('running');
  });

  it('dequeue reopens to running after Stop', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager(router);
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'answer' }] } }]);
    fireStop(router);

    await feed(mgr, [{ type: 'queue-operation', operation: 'dequeue', timestamp: ts() }]);
    expect(mgr.getStatus()).toBe('running');
  });

  it('continuation Stop (stop_hook_active: true) does not close the turn', async () => {
    const router = new HookEventRouter();
    const mgr = makeManager(router);
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'still going' }] } }]);
    expect(mgr.getStatus()).toBe('running');

    fireStop(router, true);
    expect(mgr.getStatus()).toBe('running');
  });

  it('hookless session is unchanged — trailing record still drives running', async () => {
    // No router → JSONL-only. Sanity that the guard never engages without Stop.
    const mgr = new SessionManager(SID, '/tmp/test.jsonl', 'test-workspace');
    await feed(mgr, [{ type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'answer' }] } }]);
    expect(mgr.getStatus()).toBe('running');
  });
});
