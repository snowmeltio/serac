import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SubagentTailerManager } from './subagentTailerManager.js';
import type { TailerContext, SubagentRecordBatch } from './subagentTailerManager.js';
import type { SubagentInfo, JsonlRecord } from './types.js';

/** Create a minimal SubagentInfo for testing */
function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    parentToolUseId: 'toolu_test',
    description: 'test subagent',
    running: true,
    waitingOnPermission: false,
    lastActivity: new Date(),
    activeTools: new Map(),
    permissionTimerId: undefined,
    acknowledged: false,
    tailer: null,
    silenceTimerId: undefined,
    agentId: null,
    startedAt: new Date(),
    resultPreview: null,
    toolsCompleted: 0,
    ...overrides,
  };
}

function makeContext(overrides: Partial<TailerContext> = {}): TailerContext {
  return {
    isDisposed: () => false,
    getSessionFilePath: () => '/tmp/test-session.jsonl',
    getAllSubagents: () => [],
    ...overrides,
  };
}

describe('SubagentTailerManager', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('can be instantiated with a mock context (boundary validation)', () => {
    const ctx = makeContext();
    const mgr = new SubagentTailerManager(ctx);
    expect(mgr.getActiveTailerCount()).toBe(0);
  });

  describe('silence timers', () => {
    it('starts and cancels silence timer', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const sub = makeSubagent();

      mgr.startSilenceTimer(sub);
      expect(sub.silenceTimerId).toBeDefined();

      mgr.cancelSilenceTimer(sub);
      expect(sub.silenceTimerId).toBeUndefined();
    });

    it('silence timer clears itself if disposed', () => {
      let disposed = false;
      const mgr = new SubagentTailerManager(makeContext({
        isDisposed: () => disposed,
      }));
      const sub = makeSubagent();

      mgr.startSilenceTimer(sub);
      disposed = true;
      vi.advanceTimersByTime(9000);
      // Tailer should NOT have been opened (disposed check)
      expect(sub.tailer).toBeNull();
    });

    it('silence timer is no-op if subagent stopped running', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const sub = makeSubagent({ running: true });

      mgr.startSilenceTimer(sub);
      sub.running = false;
      vi.advanceTimersByTime(9000);
      expect(sub.tailer).toBeNull();
    });

    it('cancelProgressSilence cancels timer and disposes tailer', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const sub = makeSubagent();

      mgr.startSilenceTimer(sub);
      // Simulate a tailer that was opened
      const mockTailer = { readNewRecords: vi.fn(), getFilePath: () => '/tmp/agent-x.jsonl' } as any;
      sub.tailer = mockTailer;
      (mgr as any).activeTailerCount = 1;

      mgr.cancelProgressSilence(sub);
      expect(sub.silenceTimerId).toBeUndefined();
      expect(sub.tailer).toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(0);
    });
  });

  describe('poll', () => {
    it('returns empty batches when no tailers active', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const sub = makeSubagent();
      const batches = await mgr.poll([sub]);
      expect(batches).toEqual([]);
    });

    it('returns records grouped by subagent', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const records: JsonlRecord[] = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      ];
      const mockTailer = { readNewRecords: vi.fn().mockResolvedValue(records), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({ tailer: mockTailer });

      const batches = await mgr.poll([sub]);
      expect(batches).toHaveLength(1);
      expect(batches[0].subagent).toBe(sub);
      expect(batches[0].records).toBe(records);
    });

    it('disposes tailer for non-running subagents during poll', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const mockTailer = { readNewRecords: vi.fn(), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({ running: false, tailer: mockTailer });
      (mgr as any).activeTailerCount = 1;

      const batches = await mgr.poll([sub]);
      expect(batches).toEqual([]);
      expect(sub.tailer).toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(0);
    });

    it('skips subagents with empty records', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const mockTailer = { readNewRecords: vi.fn().mockResolvedValue([]), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({ tailer: mockTailer });

      const batches = await mgr.poll([sub]);
      expect(batches).toEqual([]);
    });
  });

  describe('disposeSubagent', () => {
    it('cleans up tailer, silence timer, and agentId', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const mockTailer = { readNewRecords: vi.fn(), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({
        tailer: mockTailer,
        agentId: 'agent-123',
      });
      mgr.startSilenceTimer(sub);
      (mgr as any).activeTailerCount = 1;

      mgr.disposeSubagent(sub);
      expect(sub.tailer).toBeNull();
      expect(sub.silenceTimerId).toBeUndefined();
      expect(sub.agentId).toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(0);
    });

    it('does NOT touch permissionTimerId (owned by SessionManager)', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const timerId = setTimeout(() => {}, 99999);
      const sub = makeSubagent({ permissionTimerId: timerId });

      mgr.disposeSubagent(sub);
      expect(sub.permissionTimerId).toBe(timerId);
      clearTimeout(timerId);
    });
  });

  describe('disposeAll', () => {
    it('disposes all subagents and resets tailer count', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const subs = [
        makeSubagent({ tailer: { readNewRecords: vi.fn(), getFilePath: () => '/tmp/a.jsonl' } as any }),
        makeSubagent({ tailer: { readNewRecords: vi.fn(), getFilePath: () => '/tmp/b.jsonl' } as any }),
      ];
      (mgr as any).activeTailerCount = 2;
      mgr.startSilenceTimer(subs[0]);

      mgr.disposeAll(subs);
      expect(subs[0].tailer).toBeNull();
      expect(subs[1].tailer).toBeNull();
      expect(subs[0].silenceTimerId).toBeUndefined();
      expect(mgr.getActiveTailerCount()).toBe(0);
    });
  });

  describe('multi-subagent scanForFile dedup', () => {
    let tmpRoot: string;
    let sessionFile: string;
    let subagentsDir: string;

    beforeEach(() => {
      vi.useRealTimers(); // need real fs ops
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-tailer-'));
      sessionFile = path.join(tmpRoot, 'session.jsonl');
      fs.writeFileSync(sessionFile, '');
      subagentsDir = path.join(tmpRoot, 'session', 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function writeAgentFile(name: string): void {
      fs.writeFileSync(path.join(subagentsDir, name), '');
    }

    it('attaches distinct files to parallel silent subagents (FIFO by birthtime)', async () => {
      // Three subagent JSONL files, written in order so birthtime is monotonic.
      writeAgentFile('agent-aaa.jsonl');
      // Small delay to keep birthtimes distinct on filesystems with coarse timestamps
      await new Promise(r => setTimeout(r, 10));
      writeAgentFile('agent-bbb.jsonl');
      await new Promise(r => setTimeout(r, 10));
      writeAgentFile('agent-ccc.jsonl');

      const subs: SubagentInfo[] = [makeSubagent(), makeSubagent(), makeSubagent()];
      const mgr = new SubagentTailerManager({
        isDisposed: () => false,
        getSessionFilePath: () => sessionFile,
        getAllSubagents: () => subs,
      });

      // Open tailers in spawn order — each call should claim the oldest unmatched file.
      await (mgr as any).openTailer(subs[0]);
      await (mgr as any).openTailer(subs[1]);
      await (mgr as any).openTailer(subs[2]);

      const ids = subs.map(s => s.agentId).sort();
      expect(ids).toEqual(['aaa', 'bbb', 'ccc']);
      // No two subagents should hold the same tailer file
      const paths = subs.map(s => s.tailer!.getFilePath());
      expect(new Set(paths).size).toBe(3);
      expect(mgr.getActiveTailerCount()).toBe(3);
    });

    it('still attaches when only one unmatched file remains', async () => {
      writeAgentFile('agent-only.jsonl');
      const sub = makeSubagent();
      const mgr = new SubagentTailerManager({
        isDisposed: () => false,
        getSessionFilePath: () => sessionFile,
        getAllSubagents: () => [sub],
      });

      await (mgr as any).openTailer(sub);
      expect(sub.agentId).toBe('only');
      expect(sub.tailer).not.toBeNull();
    });

    it('does nothing when no unmatched files remain', async () => {
      writeAgentFile('agent-claimed.jsonl');
      const claimed = makeSubagent({
        tailer: { readNewRecords: vi.fn(), getFilePath: () => path.join(subagentsDir, 'agent-claimed.jsonl') } as any,
        agentId: 'claimed',
      });
      const silent = makeSubagent();
      const mgr = new SubagentTailerManager({
        isDisposed: () => false,
        getSessionFilePath: () => sessionFile,
        getAllSubagents: () => [claimed, silent],
      });
      (mgr as any).activeTailerCount = 1;

      await (mgr as any).openTailer(silent);
      expect(silent.tailer).toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(1);
    });
  });
});
