/**
 * State machine tests for SessionManager.
 * Covers key lifecycle transitions, idle timer behaviour (including streaming
 * gap re-arm), permission detection, and subagent state tracking.
 *
 * Complements sessionManager.transition.test.ts which covers record type
 * completeness. This file tests stateful sequences and timer behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';

let mockRecords: JsonlRecord[] = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    async readNewRecords() {
      const r = mockRecords;
      mockRecords = [];
      return r;
    }
    getFilePath() { return '/tmp/test.jsonl'; }
    dispose() {}
  },
}));

const { SessionManager } = await import('./sessionManager.js');

type SM = InstanceType<typeof SessionManager>;

function makeManager(): SM {
  return new SessionManager('test-session', '/tmp/test.jsonl', 'test-ws');
}

async function feed(mgr: SM, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

function ts(): string {
  return new Date().toISOString();
}

describe('SessionManager: idle timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks running session as done after idle delay with no active tools', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'response' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // After assistant output, seenOutputInTurn=true → 5s idle (no 30s grace)
    vi.advanceTimersByTime(6_000);
    expect(mgr.getStatus()).toBe('done');
  });

  it('does not mark done if active exempt tools remain', async () => {
    const mgr = makeManager();
    // Use an exempt tool (Agent) — won't trigger permission timer
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'tu1', input: { description: 'test', prompt: 'test' } }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    vi.advanceTimersByTime(36_000);
    // Still running because active exempt tool prevents idle timer from marking done
    expect(mgr.getStatus()).toBe('running');
  });

  it('new records extend session lifetime beyond initial idle timer', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'hello' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Advance 25s (within 30s grace period, no output yet)
    vi.advanceTimersByTime(25_000);
    expect(mgr.getStatus()).toBe('running');

    // Feed assistant record — sets seenOutputInTurn=true, resets idle to 5s
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'response' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Advance 4s — within the new 5s idle delay
    vi.advanceTimersByTime(4_000);
    expect(mgr.getStatus()).toBe('running');

    // Advance past the 5s idle delay from the last record
    vi.advanceTimersByTime(2_000);
    expect(mgr.getStatus()).toBe('done');
  });

  it('extended thinking grace period prevents premature done', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'hello' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // At 20s (within 30s grace, no output yet), should still be running
    vi.advanceTimersByTime(20_000);
    expect(mgr.getStatus()).toBe('running');

    // At 36s — grace fired at 30s, but process liveness check returns true
    // (no PID captured in tests = conservative assume-alive). Re-arms timer.
    vi.advanceTimersByTime(16_000);
    expect(mgr.getStatus()).toBe('running');

    // Only the hard ceiling (3min) would mark done in this case.
    // That's tested via computeDemotion, not the idle timer.
  });

  it('marks done immediately when output seen and idle expires', async () => {
    const mgr = makeManager();
    // User record starts turn (seenOutputInTurn=false)
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'hello' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Assistant record arrives (seenOutputInTurn=true)
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'thinking done, here is my answer' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // 4s later — within 5s idle
    vi.advanceTimersByTime(4_000);
    expect(mgr.getStatus()).toBe('running');

    // 6s later — past 5s idle, should be done
    vi.advanceTimersByTime(2_000);
    expect(mgr.getStatus()).toBe('done');
  });

  it('progress record also sets seenOutputInTurn', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'hello' }] },
    }]);

    // Progress record arrives (e.g. tool execution output)
    await feed(mgr, [{
      type: 'progress', timestamp: ts(),
      data: { type: 'bash_progress', content: 'npm test' },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Should use 5s idle, not 30s grace
    vi.advanceTimersByTime(6_000);
    expect(mgr.getStatus()).toBe('done');
  });
});

describe('SessionManager: permission detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('permission timer marks running → waiting for non-exempt tools', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Edit', id: 'tu1' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Permission delay is 3s for non-slow tools
    vi.advanceTimersByTime(4_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('slow tools use longer permission delay', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu1' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // At 5s: should still be running (slow tool delay is 6s)
    vi.advanceTimersByTime(5_000);
    expect(mgr.getStatus()).toBe('running');

    // At 7s: should be waiting
    vi.advanceTimersByTime(2_000);
    expect(mgr.getStatus()).toBe('waiting');
  });

  it('exempt tools do not trigger permission timer', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Read', id: 'tu1' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Read is exempt — even at 10s, no waiting
    vi.advanceTimersByTime(10_000);
    expect(mgr.getStatus()).toBe('running');
  });

  it('tool_result clears permission timer', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Edit', id: 'tu1' }] },
    }]);
    // Resolve the tool before permission timer fires
    vi.advanceTimersByTime(1_000);
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
    }]);
    // Past the 3s threshold — should not be waiting because tool resolved
    vi.advanceTimersByTime(3_000);
    expect(mgr.getStatus()).toBe('running');
  });
});

describe('SessionManager: subagent lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Agent tool_use creates a subagent', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent1', input: { description: 'test agent', prompt: 'do stuff' } }] },
    }]);
    const snap = mgr.getSnapshot();
    expect(snap.subagents).toHaveLength(1);
    expect(snap.subagents[0].description).toBe('test agent');
    expect(snap.subagents[0].running).toBe(true);
  });

  it('agent_progress resets subagent activity', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent1', input: { description: 'test', prompt: 'test' } }] },
    }]);
    const changed = await feed(mgr, [{
      type: 'progress', timestamp: ts(),
      data: { type: 'agent_progress' },
      parentToolUseID: 'agent1',
    }]);
    expect(changed).toBe(true);
  });

  it('tool_result for Agent marks subagent as done', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent1', input: { description: 'test', prompt: 'test' } }] },
    }]);
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent1' }] },
    }]);
    const snap = mgr.getSnapshot();
    expect(snap.subagents[0].running).toBe(false);
  });
});

describe('SessionManager: snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('snapshot includes topic from first user message', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Fix the login page CSS' }] },
    }]);
    const snap = mgr.getSnapshot();
    expect(snap.topic).toContain('Fix the login page CSS');
  });

  it('snapshot includes custom title when set', async () => {
    const mgr = makeManager();
    await feed(mgr, [
      { type: 'custom-title', customTitle: 'My Custom Title', timestamp: ts() },
    ]);
    const snap = mgr.getSnapshot();
    expect(snap.customTitle).toBe('My Custom Title');
  });

  it('snapshot includes context tokens from assistant message', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 500 },
      },
    } as JsonlRecord]);
    const snap = mgr.getSnapshot();
    expect(snap.contextTokens).toBe(1500);
  });

  it('searchText includes topic and activity', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Deploy the app' }] },
    }]);
    const snap = mgr.getSnapshot();
    expect(snap.searchText).toContain('Deploy the app');
  });
});

describe('SessionManager: dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposed manager does not fire timers', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'thinking' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    mgr.dispose();
    vi.advanceTimersByTime(60_000);
    // Status stays running because timer callbacks check disposed flag
    expect(mgr.getStatus()).toBe('running');
  });
});

describe('SessionManager: turn guard (extended thinking)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses demoteIfStale during active turn with no output', async () => {
    const mgr = makeManager();
    // User sends a message — turn starts, no output yet
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // 31s passes — normally this would demote to done
    vi.advanceTimersByTime(31_000);
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('allows demotion after output has been seen in the turn', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }]);
    // Assistant responds — seenOutputInTurn becomes true
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Hi there' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // 31s passes — idle timer fires first (5s), so session is already done
    // before demoteIfStale runs. The key assertion: it IS done (not stuck running).
    vi.advanceTimersByTime(31_000);
    expect(mgr.getStatus()).toBe('done');
  });

  it('still demotes at hard ceiling even during active turn', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // 3+ minutes passes — hard ceiling should override turn guard
    vi.advanceTimersByTime(181_000);
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });
});
