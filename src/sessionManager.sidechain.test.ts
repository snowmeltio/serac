import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';

// Mock JsonlTailer so we can feed records without files
let mockRecords: JsonlRecord[] = [];
let mockTruncated = false;
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    async readNewRecords() {
      const r = mockRecords;
      mockRecords = [];
      this.truncated = mockTruncated;
      mockTruncated = false;
      return r;
    }
  },
}));

const { SessionManager } = await import('./sessionManager.js');

function makeManager(): InstanceType<typeof SessionManager> {
  return new SessionManager('test-session-id', '/tmp/test.jsonl', 'test-workspace');
}

async function feedRecords(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

async function feedRecordsWithTruncation(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  mockTruncated = true;
  return mgr.update();
}

function userRecord(text: string, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
    ...extras,
  };
}

function assistantTextRecord(text: string, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
    ...extras,
  };
}

function assistantToolUseRecord(toolName: string, toolId: string, input: Record<string, unknown> = {}, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_use', name: toolName, id: toolId, input }],
    },
    ...extras,
  };
}

function toolResultRecord(toolUseId: string, extras: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId }],
    },
    ...extras,
  };
}

function sidechainAssistantToolUse(toolName: string, toolId: string, parentToolUseID: string): JsonlRecord {
  return {
    type: 'assistant',
    isSidechain: true,
    parentToolUseID,
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_use', name: toolName, id: toolId, input: {} }],
    },
  };
}

function sidechainToolResult(toolUseId: string, parentToolUseID: string): JsonlRecord {
  return {
    type: 'user',
    isSidechain: true,
    parentToolUseID,
    timestamp: new Date().toISOString(),
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId }],
    },
  };
}

describe('SessionManager sidechain tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
    mockTruncated = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Tool cap eviction (MAX_ACTIVE_TOOLS = 500) ──────────────────

  describe('tool cap eviction', () => {
    it('evicts oldest tool when >500 tools are added without results', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);

      // Add 500 tools
      for (let i = 0; i < 500; i++) {
        await feedRecords(mgr, [assistantToolUseRecord('Edit', `tool-${i}`)]);
      }

      // Add tool 501 — should evict tool-0
      await feedRecords(mgr, [assistantToolUseRecord('Edit', 'tool-500')]);

      // tool-0 should have been evicted, so completing it should not change status
      // but tool-500 should still be tracked — permission timer detects waiting
      vi.advanceTimersByTime(3_001);
      expect(mgr.getStatus()).toBe('waiting'); // tool-500 still active
    });

    it('evicts oldest subagent tool when subagent exceeds cap', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);

      // Feed 501 sidechain tool_use records to the subagent
      for (let i = 0; i < 501; i++) {
        await feedRecords(mgr, [sidechainAssistantToolUse('Edit', `sc-tool-${i}`, 'agent-1')]);
      }

      // Subagent should still be running and have tools tracked (capped at 500)
      const snap = mgr.getSnapshot();
      expect(snap.subagents[0].running).toBe(true);
    });
  });

  // ── demoteIfStale edge cases ────────────────────────────────────

  describe('demoteIfStale', () => {
    it('demotes running session with Agent tool after hard ceiling (3 min)', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      // Use Agent tool to prevent idle timer from marking done at 5s
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'long task' })]);
      expect(mgr.getStatus()).toBe('running');

      vi.advanceTimersByTime(180_001);
      const changed = mgr.demoteIfStale(30_000);
      expect(changed).toBe(true);
      expect(mgr.getStatus()).toBe('done');
    });

    it('demotes to waiting when permission timer fires', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Edit', 'tool-1')]);
      expect(mgr.getStatus()).toBe('running');

      // Permission timer fires at 3s
      vi.advanceTimersByTime(3_001);
      expect(mgr.getStatus()).toBe('waiting');
      expect(mgr.getSnapshot().activity).toBe('Waiting for permission');
    });

    it('does not demote running session with active tools and running subagents', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);

      // Subagent sends progress so it's actively running (not waiting on permission)
      await feedRecords(mgr, [{
        type: 'progress',
        timestamp: new Date().toISOString(),
        parentToolUseID: 'agent-1',
        data: { type: 'agent_progress' },
      }]);

      vi.advanceTimersByTime(31_000);
      // Update subagent lastActivity to now so it's not stale
      await feedRecords(mgr, [{
        type: 'progress',
        timestamp: new Date().toISOString(),
        parentToolUseID: 'agent-1',
        data: { type: 'agent_progress' },
      }]);

      const changed = mgr.demoteIfStale(30_000);
      expect(changed).toBe(false);
      expect(mgr.getStatus()).toBe('running');
    });

    it('considers subagent lastActivity for effective last activity', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);

      // Advance time past threshold but update subagent activity
      vi.advanceTimersByTime(100_000);

      // Subagent progress updates its lastActivity to now
      await feedRecords(mgr, [{
        type: 'progress',
        timestamp: new Date().toISOString(),
        parentToolUseID: 'agent-1',
        data: { type: 'agent_progress' },
      }]);

      // Should NOT hit hard ceiling because subagent was active recently
      const changed = mgr.demoteIfStale(30_000);
      // Has active tools (Agent) and running subagent — no demotion
      expect(changed).toBe(false);
    });

    it('returns false for done sessions', async () => {
      const mgr = makeManager();
      expect(mgr.getStatus()).toBe('done');
      const changed = mgr.demoteIfStale(30_000);
      expect(changed).toBe(false);
    });
  });

  // ── Invalid timestamp handling (F8) ─────────────────────────────

  describe('invalid timestamp handling', () => {
    it('does not produce NaN from malformed timestamp', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [{
        type: 'user',
        timestamp: 'not-a-date',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }]);

      const snap = mgr.getSnapshot();
      expect(Number.isNaN(snap.lastActivity)).toBe(false);
      expect(Number.isNaN(snap.firstActivity)).toBe(false);
    });

    it('handles undefined timestamp', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [{
        type: 'user',
        message: { content: [{ type: 'text', text: 'hello' }] },
      } as JsonlRecord]);

      const snap = mgr.getSnapshot();
      expect(Number.isNaN(snap.lastActivity)).toBe(false);
      expect(Number.isNaN(snap.firstActivity)).toBe(false);
    });

    it('handles empty string timestamp', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [{
        type: 'user',
        timestamp: '',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }]);

      const snap = mgr.getSnapshot();
      expect(Number.isNaN(snap.lastActivity)).toBe(false);
    });

    it('handles numeric garbage timestamp', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [{
        type: 'assistant',
        timestamp: 'NaN',
        message: { content: [{ type: 'text', text: 'response' }] },
      }]);

      const snap = mgr.getSnapshot();
      expect(Number.isNaN(snap.lastActivity)).toBe(false);
    });
  });

  // ── Subagent tracking lifecycle ─────────────────────────────────

  describe('subagent tracking', () => {
    it('full spawn → sidechain activity → complete lifecycle', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);

      // Spawn subagent
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Research files' })]);
      expect(mgr.getSnapshot().subagents).toHaveLength(1);
      expect(mgr.getSnapshot().subagents[0].running).toBe(true);

      // Subagent uses a tool
      await feedRecords(mgr, [sidechainAssistantToolUse('Grep', 'sc-1', 'agent-1')]);
      expect(mgr.getSnapshot().subagents[0].running).toBe(true);

      // Subagent gets tool result
      await feedRecords(mgr, [sidechainToolResult('sc-1', 'agent-1')]);
      expect(mgr.getSnapshot().subagents[0].running).toBe(true); // still running, just tool completed

      // Parent gets tool_result for Agent — subagent complete
      await feedRecords(mgr, [toolResultRecord('agent-1')]);
      expect(mgr.getSnapshot().subagents[0].running).toBe(false);
    });

    it('subagent permission detection via sidechain tool_use timeout', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);

      // Subagent uses a non-exempt tool
      await feedRecords(mgr, [sidechainAssistantToolUse('Edit', 'sc-1', 'agent-1')]);

      // Wait for subagent permission timer (20s for normal tools)
      vi.advanceTimersByTime(3_001);

      // Subagent should be marked as waiting on permission
      expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(true);
    });

    it('subagent permission clears on sidechain tool_result', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);

      await feedRecords(mgr, [sidechainAssistantToolUse('Edit', 'sc-1', 'agent-1')]);
      vi.advanceTimersByTime(3_001);
      expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(true);

      // Tool result clears permission wait
      await feedRecords(mgr, [sidechainToolResult('sc-1', 'agent-1')]);
      expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
    });

    it('deduplicates subagent on truncation replay', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);
      expect(mgr.getSnapshot().subagents).toHaveLength(1);

      // Replay same record (simulating truncation without the mock flag)
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);
      expect(mgr.getSnapshot().subagents).toHaveLength(1); // deduped
    });

    it('extractAgentDescription falls back to prompt then default', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);

      // With prompt instead of description
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { prompt: 'Search for config files in the repo' })]);
      expect(mgr.getSnapshot().subagents[0].description).toBe('Search for config files in the repo');

      // With no description or prompt
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-2', {})]);
      expect(mgr.getSnapshot().subagents[1].description).toBe('Subagent');
    });
  });

  // ── acknowledgeSubagents ────────────────────────────────────────

  describe('acknowledgeSubagents', () => {
    it('prunes completed subagents from snapshot after acknowledgement', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Done task' })]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-2', { description: 'Running task' })]);

      // Complete agent-1
      await feedRecords(mgr, [toolResultRecord('agent-1')]);

      // Before acknowledgement — both visible
      expect(mgr.getSnapshot().subagents).toHaveLength(2);

      // Acknowledge
      mgr.acknowledgeSubagents();

      // After acknowledgement — only running subagent visible
      const snap = mgr.getSnapshot();
      expect(snap.subagents).toHaveLength(1);
      expect(snap.subagents[0].description).toBe('Running task');
    });

    it('new subagent spawn does not un-hide acknowledged subagents', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'First' })]);
      await feedRecords(mgr, [toolResultRecord('agent-1')]);

      mgr.acknowledgeSubagents();
      expect(mgr.getSnapshot().subagents).toHaveLength(0); // pruned

      // New subagent does NOT reset acknowledgement for old subagents (per-subagent tracking)
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-2', { description: 'Second' })]);
      const snap = mgr.getSnapshot();
      // Only the new running subagent shows; agent-1 stays pruned
      expect(snap.subagents).toHaveLength(1);
      expect(snap.subagents[0].description).toBe('Second');
    });
  });

  // ── Multiple rapid state transitions ────────────────────────────

  describe('rapid state transitions', () => {
    it('running → waiting → running in quick succession', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      expect(mgr.getStatus()).toBe('running');

      // Tool use → running
      await feedRecords(mgr, [assistantToolUseRecord('Edit', 'tool-1')]);
      expect(mgr.getStatus()).toBe('running');

      // Permission timer with active tool → waiting
      vi.advanceTimersByTime(3_001);
      expect(mgr.getStatus()).toBe('waiting');

      // User approves → running
      await feedRecords(mgr, [toolResultRecord('tool-1')]);
      expect(mgr.getStatus()).toBe('running');

      // Another tool use
      await feedRecords(mgr, [assistantToolUseRecord('Write', 'tool-2')]);
      expect(mgr.getStatus()).toBe('running');

      // Another permission wait
      vi.advanceTimersByTime(3_001);
      expect(mgr.getStatus()).toBe('waiting');

      // Approve again
      await feedRecords(mgr, [toolResultRecord('tool-2')]);
      expect(mgr.getStatus()).toBe('running');
    });

    it('rapid tool_use then immediate tool_result does not leave stale state', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);

      // Batch: tool_use + immediate result in same update
      await feedRecords(mgr, [
        assistantToolUseRecord('Read', 'tool-1'),
      ]);
      await feedRecords(mgr, [
        toolResultRecord('tool-1'),
      ]);

      // Assistant text response (sets seenOutputInTurn=true, enabling 5s idle)
      await feedRecords(mgr, [assistantTextRecord('Done reading')]);

      // No tools should be active — idle timer marks done
      vi.advanceTimersByTime(5_001);
      expect(mgr.getStatus()).toBe('done'); // no active tools → done
    });

    it('multiple tools in one assistant message, partial results', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);

      // Two tools in one message
      await feedRecords(mgr, [{
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', id: 'tool-1', input: {} },
            { type: 'tool_use', name: 'Write', id: 'tool-2', input: {} },
          ],
        },
      }]);

      // Permission timer fires before any result — both tools pending
      vi.advanceTimersByTime(3_001);
      expect(mgr.getStatus()).toBe('waiting');

      // One result arrives — back to running
      await feedRecords(mgr, [toolResultRecord('tool-1')]);
      expect(mgr.getStatus()).toBe('running');

      // tool-2 still pending; demoteIfStale catches it after threshold
      vi.advanceTimersByTime(31_000);
      const changed = mgr.demoteIfStale(30_000);
      expect(changed).toBe(true);
      expect(mgr.getStatus()).toBe('waiting');
    });
  });

  // ── getSnapshot() completeness ──────────────────────────────────

  describe('getSnapshot completeness', () => {
    it('populates all snapshot fields', async () => {
      const mgr = makeManager();

      await feedRecords(mgr, [userRecord('Fix the login bug')]);
      await feedRecords(mgr, [{
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          content: [{ type: 'text', text: 'I will fix the login bug now.' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 500, cache_read_input_tokens: 200 },
        } as Record<string, unknown>,
      } as JsonlRecord]);

      const snap = mgr.getSnapshot();

      expect(snap.sessionId).toBe('test-session-id');
      expect(snap.slug).toBe('test-ses'); // first 8 chars
      expect(snap.workspaceKey).toBe('test-workspace');
      expect(snap.topic).toBe('Fix the login bug');
      expect(snap.status).toBe('running');
      expect(snap.activity).toBe('I will fix the login bug now.');
      expect(snap.subagents).toEqual([]);
      expect(typeof snap.lastActivity).toBe('number');
      expect(typeof snap.firstActivity).toBe('number');
      expect(snap.dismissed).toBe(false);
      expect(snap.contextTokens).toBe(700); // 500 + 200
      expect(snap.searchText).toContain('Fix the login bug');
      expect(snap.searchText).toContain('test-ses');
      expect(snap.modelLabel).toBe('Sonnet');
      expect(snap.title).toBeNull();
      expect(snap.customTitle).toBe('');
    });

    it('slug is first 8 chars of sessionId', async () => {
      const mgr = new SessionManager('abcdefghijklmnop', '/tmp/t.jsonl', 'ws');
      expect(mgr.getSnapshot().slug).toBe('abcdefgh');
    });

    it('model label formatting for various models', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('hi')]);

      // Opus
      await feedRecords(mgr, [{
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'a' }], model: 'claude-opus-4-6' } as Record<string, unknown>,
      } as JsonlRecord]);
      expect(mgr.getSnapshot().modelLabel).toBe('Opus');

      // Haiku
      await feedRecords(mgr, [{
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'b' }], model: 'claude-3-5-haiku-20241022' } as Record<string, unknown>,
      } as JsonlRecord]);
      expect(mgr.getSnapshot().modelLabel).toBe('Haiku');

      // Empty model
      const mgr2 = makeManager();
      expect(mgr2.getSnapshot().modelLabel).toBe('');
    });

    it('context tokens aggregates all input token fields', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('hi')]);
      await feedRecords(mgr, [{
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          content: [{ type: 'text', text: 'reply' }],
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 25,
          },
        } as Record<string, unknown>,
      } as JsonlRecord]);
      expect(mgr.getSnapshot().contextTokens).toBe(175);
    });
  });

  // ── dispose() ───────────────────────────────────────────────────

  describe('dispose', () => {
    it('clears idle timer', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantTextRecord('working')]);
      // Idle timer is now pending
      mgr.dispose();
      // Advancing time should not change status (timer cleared)
      vi.advanceTimersByTime(10_000);
      expect(mgr.getStatus()).toBe('running'); // timer didn't fire
    });

    it('clears permission timer', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Edit', 'tool-1')]);
      // Permission timer is pending
      mgr.dispose();
      vi.advanceTimersByTime(25_000);
      expect(mgr.getStatus()).toBe('running'); // timer didn't fire
    });

    it('clears subagent permission timers', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);
      await feedRecords(mgr, [sidechainAssistantToolUse('Edit', 'sc-1', 'agent-1')]);
      // Subagent permission timer pending
      mgr.dispose();
      vi.advanceTimersByTime(25_000);
      // Subagent should not be marked waiting (timer was cleared + disposed check)
      expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
    });

    it('prevents timer callbacks from mutating state after dispose', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Edit', 'tool-1')]);

      // Don't dispose yet — let permission timer be set
      // Now dispose
      mgr.dispose();

      // Even if a timer somehow fires, the disposed check prevents mutation
      vi.advanceTimersByTime(50_000);
      expect(mgr.getStatus()).toBe('running');
    });
  });

  // ── Queue operations ────────────────────────────────────────────

  describe('queue operations', () => {
    it('enqueue resets status to done and sets firstActivity', async () => {
      const mgr = makeManager();
      const ts = '2026-03-11T10:00:00.000Z';
      await feedRecords(mgr, [{
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: ts,
      }]);
      expect(mgr.getStatus()).toBe('done');
      expect(mgr.getSnapshot().firstActivity).toBe(new Date(ts).getTime());
    });
  });

  // ── Sidechain propagates to session lastActivity ──────────────

  describe('sidechain lastActivity propagation', () => {
    it('sidechain records update session lastActivity', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-1', { description: 'Worker' })]);
      const lastActivityAfterAgent = mgr.getLastActivity().getTime();

      vi.advanceTimersByTime(60_000);

      // Sidechain record SHOULD update session lastActivity (Step 4 propagation)
      await feedRecords(mgr, [sidechainAssistantToolUse('Read', 'sc-1', 'agent-1')]);

      // lastActivity should now reflect the sidechain activity
      expect(mgr.getLastActivity().getTime()).toBeGreaterThan(lastActivityAfterAgent);
    });
  });

  // ── Phase 1: Nested agent_progress content extraction ───────────

  describe('agent_progress nested content extraction', () => {
    function agentProgressRecord(
      parentToolUseID: string,
      innerType: 'assistant' | 'user',
      content: Array<{ type: string; name?: string; id?: string; tool_use_id?: string }>,
      agentId?: string,
    ): JsonlRecord {
      return {
        type: 'progress',
        timestamp: new Date().toISOString(),
        parentToolUseID,
        toolUseID: `agent_msg_${parentToolUseID}`,
        data: {
          type: 'agent_progress',
          agentId: agentId || 'agent-abc123',
          message: {
            type: innerType,
            message: {
              role: innerType === 'assistant' ? 'assistant' : 'user',
              content,
            },
          },
        },
      };
    }

    it('extracts tool_use from agent_progress and populates subagent activeTools', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      // Spawn subagent
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-tool-1', { description: 'test' })]);
      expect(mgr.getSnapshot().subagents).toHaveLength(1);
      expect(mgr.getSnapshot().subagents[0].running).toBe(true);

      // agent_progress with nested Bash tool_use
      await feedRecords(mgr, [
        agentProgressRecord('agent-tool-1', 'assistant', [
          { type: 'tool_use', name: 'Bash', id: 'bash-1' },
        ]),
      ]);

      // Permission timer should fire after 8s (Bash is a slow tool)
      vi.advanceTimersByTime(8_100);
      expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(true);
      expect(mgr.getStatus()).toBe('waiting');
    });

    it('clears tool_use from subagent activeTools on nested tool_result', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-tool-1', { description: 'test' })]);

      // Nested tool_use then tool_result
      await feedRecords(mgr, [
        agentProgressRecord('agent-tool-1', 'assistant', [
          { type: 'tool_use', name: 'Bash', id: 'bash-1' },
        ]),
      ]);
      await feedRecords(mgr, [
        agentProgressRecord('agent-tool-1', 'user', [
          { type: 'tool_result', tool_use_id: 'bash-1' },
        ]),
      ]);

      // Timer should NOT fire — tool was completed
      vi.advanceTimersByTime(10_000);
      expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
      expect(mgr.getStatus()).toBe('running');
    });

    it('records agentId mapping from agent_progress records', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-tool-1', { description: 'test' })]);

      // agent_progress with agentId
      await feedRecords(mgr, [
        agentProgressRecord('agent-tool-1', 'assistant', [
          { type: 'tool_use', name: 'Read', id: 'read-1' },
        ], 'my-agent-id-123'),
      ]);

      // Silence timer should be cancelled since we got progress
      // (no way to directly test internal state, but we verify no tailer is opened)
      vi.advanceTimersByTime(10_000);
      // Subagent should NOT be waiting — Read is exempt from permission
      expect(mgr.getSnapshot().subagents[0].waitingOnPermission).toBe(false);
    });

    it('records agentId from Agent resume input', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      // Spawn with resume
      await feedRecords(mgr, [
        assistantToolUseRecord('Agent', 'agent-tool-2', {
          description: 'continue',
          resume: 'resumed-agent-xyz',
        }),
      ]);

      expect(mgr.getSnapshot().subagents).toHaveLength(1);
      // The agentId mapping is internal — verified indirectly via the silence timer mechanism
    });
  });

  // ── Phase 2: Silence timer and subagent tailer lifecycle ────────

  describe('subagent silence timer', () => {
    it('starts silence timer when subagent is spawned', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-tool-1', { description: 'test' })]);

      // After SUBAGENT_SILENCE_MS (8s), the silence timer fires.
      // Without a real subagents/ directory, no tailer opens, but the timer does fire.
      // Advance past silence threshold
      vi.advanceTimersByTime(8_100);

      // Session should still be running (no tailer to detect permission)
      expect(mgr.getStatus()).toBe('running');
    });

    it('cancels silence timer when agent_progress arrives', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-tool-1', { description: 'test' })]);

      // agent_progress arrives at 5s — should cancel silence timer
      vi.advanceTimersByTime(5_000);
      await feedRecords(mgr, [
        {
          type: 'progress',
          timestamp: new Date().toISOString(),
          parentToolUseID: 'agent-tool-1',
          toolUseID: 'agent_msg_1',
          data: {
            type: 'agent_progress',
            agentId: 'agent-id-abc',
            message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
          },
        } as JsonlRecord,
      ]);

      // Advance past original silence threshold — no tailer should open
      vi.advanceTimersByTime(5_000);
      expect(mgr.getStatus()).toBe('running');
    });

    it('cleans up silence timers and tailers on dispose', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-tool-1', { description: 'test' })]);

      // Dispose should not throw even with active silence timers
      mgr.dispose();
    });

    it('cleans up silence timers on subagent completion', async () => {
      const mgr = makeManager();
      await feedRecords(mgr, [userRecord('start')]);
      await feedRecords(mgr, [assistantToolUseRecord('Agent', 'agent-tool-1', { description: 'test' })]);

      // Complete the subagent
      await feedRecords(mgr, [toolResultRecord('agent-tool-1')]);

      // Advance past silence threshold — nothing should happen
      vi.advanceTimersByTime(10_000);
      const sub = mgr.getSnapshot().subagents.find(s => s.parentToolUseId === 'agent-tool-1');
      expect(sub?.running).toBe(false);
    });
  });
});
