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
    permissionTracker: { reschedule: () => {}, cancel: () => {}, dispose: () => {} },
    acknowledged: false,
    tailer: null,
    progressRelayed: false,
    agentId: null,
    startedAt: new Date(),
    resultPreview: null,
    toolsCompleted: 0,
    background: false,
    revivalCount: 0,
    completedFileSize: null,
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

  describe('progress relay suppression', () => {
    it('suppressForProgressRelay disposes the tailer and flags the subagent', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const sub = makeSubagent();
      sub.tailer = { getOffset: () => 0, readNewRecords: vi.fn(), getFilePath: () => '/tmp/agent-x.jsonl' } as any;
      (mgr as any).activeTailerCount = 1;

      mgr.suppressForProgressRelay(sub);
      expect(sub.progressRelayed).toBe(true);
      expect(sub.tailer).toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(0);
    });

    it('needsPoll: false for a relayed or finished subagent, true for a running untailed one', () => {
      const mgr = new SubagentTailerManager(makeContext());
      expect(mgr.needsPoll([makeSubagent({ progressRelayed: true })])).toBe(false);
      expect(mgr.needsPoll([makeSubagent({ running: false })])).toBe(false);
      expect(mgr.needsPoll([makeSubagent()])).toBe(true);
    });
  });

  describe('poll', () => {
    it('returns empty batches when no tailers active', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const sub = makeSubagent({ running: false });
      const batches = await mgr.poll([sub]);
      expect(batches).toEqual([]);
    });

    it('returns records grouped by subagent', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const records: JsonlRecord[] = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      ];
      const mockTailer = { getOffset: () => 0, readNewRecords: vi.fn().mockResolvedValue(records), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({ tailer: mockTailer });

      const batches = await mgr.poll([sub]);
      expect(batches).toHaveLength(1);
      expect(batches[0].subagent).toBe(sub);
      expect(batches[0].records).toBe(records);
    });

    it('disposes tailer for non-running subagents during poll', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const mockTailer = { getOffset: () => 0, readNewRecords: vi.fn(), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({ running: false, tailer: mockTailer });
      (mgr as any).activeTailerCount = 1;

      const batches = await mgr.poll([sub]);
      expect(batches).toEqual([]);
      expect(sub.tailer).toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(0);
    });

    it('skips subagents with empty records', async () => {
      const mgr = new SubagentTailerManager(makeContext());
      const mockTailer = { getOffset: () => 0, readNewRecords: vi.fn().mockResolvedValue([]), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({ tailer: mockTailer });

      const batches = await mgr.poll([sub]);
      expect(batches).toEqual([]);
    });
  });

  describe('disposeSubagent', () => {
    it('cleans up tailer and agentId', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const mockTailer = { getOffset: () => 0, readNewRecords: vi.fn(), getFilePath: () => '/tmp/a.jsonl' } as any;
      const sub = makeSubagent({
        tailer: mockTailer,
        agentId: 'agent-123',
      });
      (mgr as any).activeTailerCount = 1;

      mgr.disposeSubagent(sub);
      expect(sub.tailer).toBeNull();
      expect(sub.agentId).toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(0);
    });

    it('does NOT touch the permission tracker (owned by SessionManager)', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const dispose = vi.fn();
      const sub = makeSubagent({ permissionTracker: { reschedule: vi.fn(), cancel: vi.fn(), dispose } });

      mgr.disposeSubagent(sub);
      expect(dispose).not.toHaveBeenCalled();
    });
  });

  describe('disposeAll', () => {
    it('disposes all subagents and resets tailer count', () => {
      const mgr = new SubagentTailerManager(makeContext());
      const subs = [
        makeSubagent({ tailer: { getOffset: () => 0, readNewRecords: vi.fn(), getFilePath: () => '/tmp/a.jsonl' } as any }),
        makeSubagent({ tailer: { getOffset: () => 0, readNewRecords: vi.fn(), getFilePath: () => '/tmp/b.jsonl' } as any }),
      ];
      (mgr as any).activeTailerCount = 2;

      mgr.disposeAll(subs);
      expect(subs[0].tailer).toBeNull();
      expect(subs[1].tailer).toBeNull();
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

    function writeMeta(agentId: string, toolUseId: string): void {
      fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose', toolUseId, spawnDepth: 1 }));
    }

    function managerFor(subs: SubagentInfo[]): SubagentTailerManager {
      return new SubagentTailerManager({
        isDisposed: () => false,
        getSessionFilePath: () => sessionFile,
        getAllSubagents: () => subs,
      });
    }

    it('pairs by the meta toolUseId, not by birthtime order', async () => {
      // Files land in the OPPOSITE order to the spawns: birthtime would pair
      // them crosswise.
      writeAgentFile('agent-second.jsonl');
      writeMeta('second', 'toolu_B');
      await new Promise(r => setTimeout(r, 10));
      writeAgentFile('agent-first.jsonl');
      writeMeta('first', 'toolu_A');
      const a = makeSubagent({ parentToolUseId: 'toolu_A' });
      const b = makeSubagent({ parentToolUseId: 'toolu_B' });
      const mgr = managerFor([a, b]);

      await mgr.poll([a, b]);
      expect(a.agentId).toBe('first');
      expect(b.agentId).toBe('second');
    });

    it('never claims a file whose meta names another tool_use (a nested agent)', async () => {
      writeAgentFile('agent-nested.jsonl');
      writeMeta('nested', 'toolu_inside_a_subagent');
      const sub = makeSubagent({ parentToolUseId: 'toolu_A' });
      const mgr = managerFor([sub]);

      await mgr.poll([sub]);
      expect(sub.tailer).toBeNull();
      expect(sub.agentId).toBeNull();
      // Its own file appears on a later poll and is paired then.
      writeAgentFile('agent-mine.jsonl');
      writeMeta('mine', 'toolu_A');
      await mgr.poll([sub]);
      expect(sub.agentId).toBe('mine');
    });

    it('waits for its own meta rather than guessing among meta-less files when metas exist', async () => {
      writeAgentFile('agent-other.jsonl');
      writeMeta('other', 'toolu_other');
      writeAgentFile('agent-mine.jsonl'); // meta not written yet
      const sub = makeSubagent({ parentToolUseId: 'toolu_A' });
      const mgr = managerFor([sub]);

      await mgr.poll([sub]);
      expect(sub.tailer).toBeNull();
      writeMeta('mine', 'toolu_A');
      await mgr.poll([sub]);
      expect(sub.agentId).toBe('mine');
    });

    it('poll opens a tailer on the first call after spawn, with no delay', async () => {
      writeAgentFile('agent-fresh.jsonl');
      writeMeta('fresh', 'toolu_test');
      const sub = makeSubagent();
      const mgr = managerFor([sub]);

      await mgr.poll([sub]);
      expect(sub.tailer).not.toBeNull();
      expect(mgr.getActiveTailerCount()).toBe(1);
    });

    it('poll skips a subagent fed by the progress relay', async () => {
      writeAgentFile('agent-relayed.jsonl');
      const sub = makeSubagent({ progressRelayed: true });
      const mgr = managerFor([sub]);

      await mgr.poll([sub]);
      expect(sub.tailer).toBeNull();
    });

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
        tailer: { getOffset: () => 0, readNewRecords: vi.fn(), getFilePath: () => path.join(subagentsDir, 'agent-claimed.jsonl') } as any,
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

    it('does not re-point a known agentId at another file when its own is missing', async () => {
      // A resumed subagent knows its agentId, but its own JSONL isn't on disk
      // yet; an unrelated sibling file IS present and untailed. openTailer must
      // NOT scan (which would claim the sibling and overwrite the known id).
      writeAgentFile('agent-sibling.jsonl');
      const resumed = makeSubagent({ agentId: 'resumed' });
      const mgr = new SubagentTailerManager({
        isDisposed: () => false,
        getSessionFilePath: () => sessionFile,
        getAllSubagents: () => [resumed],
      });

      await (mgr as any).openTailer(resumed);
      expect(resumed.agentId).toBe('resumed'); // NOT overwritten with 'sibling'
      expect(resumed.tailer).toBeNull();        // no tailer opened this cycle
      expect(mgr.getActiveTailerCount()).toBe(0);
    });

    it('never exceeds the tailer cap under concurrent opens (hard cap re-check)', async () => {
      // MAX_SUBAGENT_TAILERS is 10. Pre-load to one below the cap; then three
      // known-agentId subagents (own files present) race to attach. Only one
      // slot is free, so the post-await re-check must keep the total at 10.
      writeAgentFile('agent-c1.jsonl');
      writeAgentFile('agent-c2.jsonl');
      writeAgentFile('agent-c3.jsonl');
      const s1 = makeSubagent({ agentId: 'c1' });
      const s2 = makeSubagent({ agentId: 'c2' });
      const s3 = makeSubagent({ agentId: 'c3' });
      const mgr = new SubagentTailerManager({
        isDisposed: () => false,
        getSessionFilePath: () => sessionFile,
        getAllSubagents: () => [s1, s2, s3],
      });
      (mgr as any).activeTailerCount = 9; // MAX - 1

      await Promise.all([
        (mgr as any).openTailer(s1),
        (mgr as any).openTailer(s2),
        (mgr as any).openTailer(s3),
      ]);
      expect(mgr.getActiveTailerCount()).toBeLessThanOrEqual(10);
    });
  });
});

describe('reopenTailerAt (revival)', () => {
  let tmpRoot: string;
  let sessionFile: string;
  let agentFile: string;
  const AGENT = 'a1111111111111111';

  beforeEach(() => {
    vi.useRealTimers(); // real fs ops
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-reopen-'));
    sessionFile = path.join(tmpRoot, 'session.jsonl');
    fs.writeFileSync(sessionFile, '');
    agentFile = path.join(tmpRoot, 'session', 'subagents', `agent-${AGENT}.jsonl`);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, 'x'.repeat(99) + '\n');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function manager(subs: SubagentInfo[] = [], disposed = false): SubagentTailerManager {
    return new SubagentTailerManager({
      isDisposed: () => disposed,
      getSessionFilePath: () => sessionFile,
      getAllSubagents: () => subs,
    });
  }

  it('opens at the explicit offset and seeds lastSize/lastMtimeMs from the stat', async () => {
    const sub = makeSubagent({ agentId: AGENT });
    const mgr = manager([sub]);
    await mgr.reopenTailerAt(sub, 40);
    const stat = fs.statSync(agentFile);
    expect(sub.tailer).not.toBeNull();
    expect(sub.tailer!.getOffset()).toBe(40);
    expect(sub.tailer!.lastSize).toBe(stat.size);
    expect(sub.tailer!.lastMtimeMs).toBe(stat.mtimeMs);
    expect(mgr.getActiveTailerCount()).toBe(1);
  });

  it('opens at the file size when the offset is unknown (null) — never at 0', async () => {
    const sub = makeSubagent({ agentId: AGENT });
    const mgr = manager([sub]);
    await mgr.reopenTailerAt(sub, null);
    expect(sub.tailer!.getOffset()).toBe(fs.statSync(agentFile).size);
    expect(sub.tailer!.getOffset()).toBeGreaterThan(0);
  });

  it('adopts a preopened tailer as-is', async () => {
    const sub = makeSubagent({ agentId: AGENT });
    const mgr = manager([sub]);
    const preopened = { getOffset: () => 0, readNewRecords: vi.fn().mockResolvedValue([]), getFilePath: () => agentFile } as any;
    await mgr.reopenTailerAt(sub, 10, preopened);
    expect(sub.tailer).toBe(preopened);
    expect(mgr.getActiveTailerCount()).toBe(1);
  });

  it('disposes an existing tailer first so the count does not double', async () => {
    const stale = { getOffset: () => 0, readNewRecords: vi.fn(), getFilePath: () => agentFile } as any;
    const sub = makeSubagent({ agentId: AGENT, tailer: stale });
    const mgr = manager([sub]);
    (mgr as any).activeTailerCount = 1;
    await mgr.reopenTailerAt(sub, 5);
    expect(sub.tailer).not.toBe(stale);
    expect(mgr.getActiveTailerCount()).toBe(1);
  });

  it('respects the tailer cap: the row keeps no tailer', async () => {
    const sub = makeSubagent({ agentId: AGENT });
    const mgr = manager([sub]);
    (mgr as any).activeTailerCount = 10;
    await mgr.reopenTailerAt(sub, 5);
    expect(sub.tailer).toBeNull();
    expect(mgr.getActiveTailerCount()).toBe(10);
  });

  it('missing file: no tailer, count unchanged', async () => {
    fs.rmSync(agentFile);
    const sub = makeSubagent({ agentId: AGENT });
    const mgr = manager([sub]);
    await mgr.reopenTailerAt(sub, 5);
    expect(sub.tailer).toBeNull();
    expect(mgr.getActiveTailerCount()).toBe(0);
  });

  it('no agentId: opens nothing (the next poll pairs it) and clears relay suppression', async () => {
    const sub = makeSubagent({ agentId: null, progressRelayed: true });
    const mgr = manager([sub]);
    await mgr.reopenTailerAt(sub, 5);
    expect(sub.tailer).toBeNull();
    expect(sub.progressRelayed).toBe(false);
    expect(mgr.needsPoll([sub])).toBe(true);
  });

  it('subagent no longer running when the stat resolves: nothing is opened', async () => {
    const sub = makeSubagent({ agentId: AGENT });
    const mgr = manager([sub]);
    const p = mgr.reopenTailerAt(sub, 5);
    sub.running = false; // completed again before the stat came back
    await p;
    expect(sub.tailer).toBeNull();
    expect(mgr.getActiveTailerCount()).toBe(0);
  });

  it('generation mismatch: a stale reopen never assigns a second tailer', async () => {
    const sub = makeSubagent({ agentId: AGENT, revivalCount: 1 });
    const mgr = manager([sub]);
    const first = mgr.reopenTailerAt(sub, 10);
    sub.revivalCount = 2; // a newer revival landed in the same batch
    const second = mgr.reopenTailerAt(sub, 20);
    await Promise.all([first, second]);
    expect(mgr.getActiveTailerCount()).toBe(1);
    expect(sub.tailer!.getOffset()).toBe(20);
  });
});
