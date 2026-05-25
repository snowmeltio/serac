import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  JsonlDerivedSubagentLifecycleTracker,
  makeSubagentLifecycleTracker,
  type SubagentLifecycleTrackerHost,
} from './subagentLifecycleTracker.js';
import type { SubagentInfo } from '../types.js';

function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    parentToolUseId: 'tu1',
    description: 'test',
    running: true,
    waitingOnPermission: false,
    lastActivity: new Date(),
    activeTools: new Map(),
    permissionTracker: undefined,
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

function makeHost(opts: {
  sessionFilePath?: string;
  allSubagents?: SubagentInfo[];
} = {}): SubagentLifecycleTrackerHost {
  return {
    isDisposed: () => false,
    getSessionFilePath: () => opts.sessionFilePath ?? '/tmp/session.jsonl',
    getAllSubagents: () => opts.allSubagents ?? [],
  };
}

describe('JsonlDerivedSubagentLifecycleTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('onSpawn starts a silence timer on the subagent', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent();
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
  });

  it('onProgress cancels silence timer (no tailer to dispose)', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent();
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
    t.onProgress(sub);
    expect(sub.silenceTimerId).toBeUndefined();
  });

  it('onComplete releases agentId and silence timer', () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent({ agentId: 'abc' });
    t.onSpawn(sub);
    t.onComplete(sub);
    expect(sub.silenceTimerId).toBeUndefined();
    expect(sub.agentId).toBeNull();
  });

  it('getActiveTailerCount starts at 0 and stays 0 with no progress-silent subagents', async () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    expect(t.getActiveTailerCount()).toBe(0);
    const sub = makeSubagent();
    t.onSpawn(sub);
    // Silence timer scheduled but not yet fired
    expect(t.getActiveTailerCount()).toBe(0);
  });

  it('pollDirect returns empty when no subagents have tailers', async () => {
    const t = new JsonlDerivedSubagentLifecycleTracker(makeHost());
    const batches = await t.pollDirect([makeSubagent()]);
    expect(batches).toEqual([]);
  });

  it('disposeAll clears tailer count and clears agentId on each subagent', async () => {
    // Build a real subagents directory so silence-fire can attach a tailer.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sub-lifecycle-'));
    const sessionFile = path.join(dir, 'session.jsonl');
    const subagentsDir = path.join(dir, 'session', 'subagents');
    await fs.promises.mkdir(subagentsDir, { recursive: true });
    const agentFile = path.join(subagentsDir, 'agent-aaa.jsonl');
    await fs.promises.writeFile(agentFile, '');

    const sub = makeSubagent({ agentId: 'aaa' });
    const host = makeHost({ sessionFilePath: sessionFile, allSubagents: [sub] });
    const t = new JsonlDerivedSubagentLifecycleTracker(host);

    t.onSpawn(sub);
    // Fire the silence timer so a tailer is opened.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sub.tailer).not.toBeNull();
    expect(t.getActiveTailerCount()).toBe(1);

    t.disposeAll([sub]);
    expect(t.getActiveTailerCount()).toBe(0);
    expect(sub.tailer).toBeNull();
    expect(sub.agentId).toBeNull();

    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('factory returns a working JSONL-derived tracker', () => {
    const t = makeSubagentLifecycleTracker(makeHost());
    const sub = makeSubagent();
    t.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
    t.onComplete(sub);
    expect(sub.silenceTimerId).toBeUndefined();
  });
});
