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
    getFilePath() { return '/tmp/test.jsonl'; }
    dispose() {}
  },
}));

const { SessionManager, setConfidenceThresholds } = await import('./sessionManager.js');

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
      message: { content: [{ type: 'tool_use', name: 'SomeTool', id: 'tu1' }] },
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

    // Below the slow-tool delay (15s): still running.
    vi.advanceTimersByTime(14_000);
    expect(mgr.getStatus()).toBe('running');

    // Past the slow-tool delay: waiting.
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
      message: { content: [{ type: 'tool_use', name: 'SomeTool', id: 'tu1' }] },
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

  it('stays running past the 3-min ceiling during a no-output turn while alive', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // 3+ minutes of extended thinking (no output, no tools). The old 3-min hard
    // ceiling demoted this to done; it now defers to PID-liveness — with no
    // captured writer PID the process reads as alive, so the turn stays running.
    // (Genuine death is covered by the registry death-gate, tested separately.)
    vi.advanceTimersByTime(181_000);
    const changed = mgr.demoteIfStale(30_000);
    expect(changed).toBe(false);
    expect(mgr.getStatus()).toBe('running');
  });

  it('demotes a no-output turn past the 15-min extended-thinking backstop', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'user', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Just UNDER EXTENDED_THINKING_CEILING_MS (15 min): still deferring to
    // liveness, so it stays running (this discriminates the backstop window —
    // it would have demoted under the old 3-min ceiling).
    vi.advanceTimersByTime(880_000);
    expect(mgr.demoteIfStale(30_000)).toBe(false);
    expect(mgr.getStatus()).toBe('running');

    // Past the backstop: the generous bound fires even when liveness can't be
    // confirmed, so a truly hung turn can't read running forever.
    vi.advanceTimersByTime(21_000); // now > 901_000
    expect(mgr.demoteIfStale(30_000)).toBe(true);
    expect(mgr.getStatus()).toBe('done');
  });
});

// ── Confidence tiers [#106 / H-5] ─────────────────────────────────────────
// computeConfidence() short-circuits to 'high' for three cases (done,
// compacting, active subagents) before falling through to the age-based
// tiers. These tests isolate each short-circuit from ordinary recency by
// advancing the clock well past the age thresholds that would otherwise
// apply, and pin the age-tier boundary as strictly `<` (not `<=`).
describe('SessionManager: confidence tiers [H-5]', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('compacting short-circuits confidence to high past the low-tier age threshold, inside the 60s grace window', async () => {
    // PreCompact is hook-only (no JSONL fallback — see sessionLifecycleTracker.ts),
    // so this manager needs its own HookEventRouter, unlike the other tests
    // in this file.
    const SID = 'confidence-compact';
    const router = new HookEventRouter();
    const mgr = new SessionManager(SID, '/tmp/test.jsonl', 'test-ws', { hookRouter: router });
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'text', text: 'thinking' }] },
    }]);
    router.onHookEvent(SID, 'PreCompact', { trigger: 'auto' });
    expect(mgr.getSnapshot().compacting).toBe(true);

    // 31s of silence — past CONFIDENCE_MEDIUM_MS (30s default), which would
    // otherwise decay confidence to 'low'. Still inside the 60s compact grace
    // window, so this is the short-circuit at work, not ordinary recency
    // (hookEnrichment.test.ts only asserts this at age ~0).
    vi.advanceTimersByTime(31_000);
    const snap = mgr.getSnapshot();
    expect(snap.compacting).toBe(true);
    expect(snap.confidence).toBe('high');
  });

  it('done short-circuits confidence to high regardless of elapsed silence', async () => {
    const mgr = makeManager();
    // A freshly constructed manager starts 'done' with lastActivity = now.
    expect(mgr.getStatus()).toBe('done');

    // 120s of silence — far past the low-tier threshold.
    vi.advanceTimersByTime(120_000);
    expect(mgr.getStatus()).toBe('done');
    expect(mgr.getSnapshot().confidence).toBe('high');
  });

  it('a live blocking subagent boosts confidence to high past the 5s high-tier window', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent1', input: { description: 'test', prompt: 'do stuff' } }] },
    }]);
    expect(mgr.getSnapshot().subagents[0].running).toBe(true);

    // 6s of silence — past CONFIDENCE_HIGH_MS (5s default), which would
    // otherwise decay confidence to 'medium'. The still-running, still-blocking
    // subagent is direct evidence the session is alive [#108].
    vi.advanceTimersByTime(6_000);
    const snap = mgr.getSnapshot();
    expect(snap.subagents[0].running).toBe(true);
    expect(snap.confidence).toBe('high');
  });

  it('confidence decays to low at 31s with a non-exempt tool still open (unconditional — no status branching)', async () => {
    const mgr = makeManager();
    await feed(mgr, [{
      type: 'assistant', timestamp: ts(),
      message: { content: [{ type: 'tool_use', name: 'SomeTool', id: 'tu1' }] },
    }]);
    expect(mgr.getStatus()).toBe('running');

    // Non-exempt tool never resolves: the permission timer fires 'waiting' at
    // 3s and it stays there — no compacting, no done, no subagents, so none of
    // the confidence short-circuits apply. Deterministic outcome (no `if`
    // guard on status, unlike the previously loose assertion this replaces).
    vi.advanceTimersByTime(31_000);
    expect(mgr.getStatus()).toBe('waiting');
    expect(mgr.getSnapshot().confidence).toBe('low');
  });

  it('age-tier boundaries are strict less-than: exact threshold age is NOT within the tier', async () => {
    const mgr = makeManager();
    // Wide, easily distinguishable thresholds so the default IDLE_DELAY_MS
    // (5s) idle-timer tick can't coincide with either checkpoint.
    setConfidenceThresholds(10_000, 20_000);
    try {
      // Edit is exempt (no permission timer) and stays active with no
      // tool_result, so the session holds 'running' for the whole test —
      // isolates the age-tier math from any timer-driven status flip.
      await feed(mgr, [{
        type: 'assistant', timestamp: ts(),
        message: { content: [{ type: 'tool_use', name: 'Edit', id: 'e1' }] },
      }]);
      expect(mgr.getStatus()).toBe('running');

      // age === 10_000 exactly: `age < CONFIDENCE_HIGH_MS` is false, so this
      // must NOT read 'high'.
      vi.advanceTimersByTime(10_000);
      expect(mgr.getStatus()).toBe('running');
      expect(mgr.getSnapshot().confidence).toBe('medium');

      // age === 20_000 exactly: `age < CONFIDENCE_MEDIUM_MS` is false, so this
      // must NOT read 'medium'.
      vi.advanceTimersByTime(10_000);
      expect(mgr.getStatus()).toBe('running');
      expect(mgr.getSnapshot().confidence).toBe('low');
    } finally {
      // Restore defaults so global state doesn't bleed into other tests.
      setConfidenceThresholds(5_000, 30_000);
    }
  });
});
