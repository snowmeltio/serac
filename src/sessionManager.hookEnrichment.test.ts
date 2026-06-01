/**
 * Integration tests for steps 2 & 3 of hook consumption:
 *  - PostToolUse/PreToolUse enrichment lands on the snapshot WITHOUT moving status.
 *  - SessionEnd records an end reason WITHOUT moving status.
 *  - PreCompact opens a compacting grace window that holds `running`/high-
 *    confidence and survives truncation (the mid-compaction running→done fix).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JsonlRecord } from './types.js';
import { HookEventRouter } from './hookEventRouter.js';

let mockRecords: JsonlRecord[] = [];
let mockTruncated = false;
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    lastMtimeMs = 0;
    async readNewRecords() {
      this.truncated = mockTruncated;
      const r = mockRecords;
      mockRecords = [];
      mockTruncated = false;
      return r;
    }
  },
}));

const { SessionManager } = await import('./sessionManager.js');

const SID = 'enrich-session';
function mgrWith(router: HookEventRouter) {
  return new SessionManager(SID, '/tmp/test.jsonl', 'test-workspace', { hookRouter: router });
}
async function feed(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[], truncated = false) {
  mockRecords = records;
  mockTruncated = truncated;
  return mgr.update();
}
const ts = () => new Date().toISOString();
const assistant = (text: string): JsonlRecord => ({
  type: 'assistant', timestamp: ts(), message: { content: [{ type: 'text', text }] },
});

describe('Hook enrichment (PostToolUse / PreToolUse / SessionEnd)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; mockTruncated = false; });

  it('PostToolUse populates lastTool without changing status', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('working')]);
    expect(mgr.getStatus()).toBe('running');

    router.onHookEvent(SID, 'PostToolUse', { tool_name: 'Bash', duration_ms: 42, tool_response: {} });
    expect(mgr.getStatus()).toBe('running'); // unchanged
    expect(mgr.getSnapshot().lastTool).toEqual({ name: 'Bash', durationMs: 42, isError: false });
  });

  it('PreToolUse populates permissionMode without changing status', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('working')]);
    router.onHookEvent(SID, 'PreToolUse', { tool_name: 'Bash', permission_mode: 'bypassPermissions' });
    expect(mgr.getStatus()).toBe('running');
    expect(mgr.getSnapshot().permissionMode).toBe('bypassPermissions');
  });

  it('SessionEnd records endReason without changing status', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('done answer')]);
    router.onHookEvent(SID, 'SessionEnd', { reason: 'clear' });
    expect(mgr.getSnapshot().endReason).toBe('clear');
    expect(mgr.getStatus()).toBe('running'); // enrichment-only, no status effect
  });
});

describe('PreCompact compacting grace window', () => {
  beforeEach(() => { vi.useFakeTimers(); mockRecords = []; mockTruncated = false; });

  it('opens the window: running + compacting + high confidence', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('thinking')]);

    router.onHookEvent(SID, 'PreCompact', { trigger: 'auto' });
    const snap = mgr.getSnapshot();
    expect(snap.status).toBe('running');
    expect(snap.compacting).toBe(true);
    expect(snap.confidence).toBe('high');
  });

  it('suppresses demotion while compacting', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('thinking')]);
    router.onHookEvent(SID, 'PreCompact', { trigger: 'manual' });

    // Advance within the 60s grace window: idle timer re-arms, no demotion.
    vi.advanceTimersByTime(40_000);
    expect(mgr.demoteIfStale(30_000)).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('survives truncation (the mid-compaction running→done fix)', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('pre-compact work')]);
    router.onHookEvent(SID, 'PreCompact', { trigger: 'auto' });
    expect(mgr.getStatus()).toBe('running');

    // Compaction rewrites the JSONL → tailer reports truncation → resetState.
    await feed(mgr, [], /* truncated */ true);
    expect(mgr.getStatus()).toBe('running'); // would be 'done' without the window
    expect(mgr.getSnapshot().compacting).toBe(true);
  });

  it('closes on compact_boundary', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('work')]);
    router.onHookEvent(SID, 'PreCompact', { trigger: 'auto' });
    expect(mgr.getSnapshot().compacting).toBe(true);

    await feed(mgr, [{ type: 'system', subtype: 'compact_boundary', timestamp: ts() }]);
    expect(mgr.getSnapshot().compacting).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('closes on the safety timeout if no boundary arrives', async () => {
    const router = new HookEventRouter();
    const mgr = mgrWith(router);
    await feed(mgr, [assistant('work')]);
    router.onHookEvent(SID, 'PreCompact', { trigger: 'auto' });
    expect(mgr.getSnapshot().compacting).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(mgr.getSnapshot().compacting).toBe(false);
  });
});
