import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';

/**
 * Writer-pid capture (`captureWriterPid` → `execFile('fuser', …)`).
 *
 * The capture must fire on the first LIVE record seen while running, never on
 * the startup replay: a dormant session's replay contains a running transition
 * too, and spawning fuser (Perl over lsof on macOS, ~0.3 CPU-s each) for every
 * recent session at window open cost N lsof scans for nothing. Found via the
 * "handles more sessions than UPDATE_BATCH_SIZE" discovery test, whose 60
 * replayed sessions took ~1.6 s standalone (52 ms with fuser hidden) and
 * ~2.3 s under full-suite load, against vitest's 5 s timeout.
 */

const fuserCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  const execFile = ((file: string, ...rest: unknown[]) => {
    if (file === 'fuser') {
      fuserCalls.count++;
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') { cb(null, '', ''); }
      return undefined as never;
    }
    return (mod.execFile as unknown as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof mod.execFile;
  return { ...mod, execFile, default: { ...mod, execFile } };
});

// Mock JsonlTailer so we can feed records without files.
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

function makeManager(): InstanceType<typeof SessionManager> {
  return new SessionManager('sess-pid', '/tmp/test.jsonl', 'ws');
}

async function feed(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

function userRecord(text: string): JsonlRecord {
  return { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
}

function assistantText(text: string): JsonlRecord {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] } };
}

beforeEach(() => {
  vi.useFakeTimers();
  fuserCalls.count = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionManager — writer-pid capture is live-only, never on replay', () => {
  it('does not spawn fuser for a running transition delivered by the initial replay', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('hello')]);
    expect(mgr.getStatus()).toBe('running');
    expect(fuserCalls.count).toBe(0);
  });

  it('spawns fuser once on the first live record seen while running', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('hello')]);   // replay
    await feed(mgr, [assistantText('hi')]);   // live
    expect(mgr.getStatus()).toBe('running');
    expect(fuserCalls.count).toBe(1);
  });

  it('captures at most once per session (latch survives later live records)', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('hello')]);
    await feed(mgr, [assistantText('hi')]);
    await feed(mgr, [assistantText('still going')]);
    await feed(mgr, [userRecord('more')]);
    expect(fuserCalls.count).toBe(1);
  });

  it('an empty first read still counts as the replay: the next read is live', async () => {
    // A just-created session: file exists but nothing is in it yet.
    const mgr = makeManager();
    await feed(mgr, []);
    await feed(mgr, [userRecord('first prompt')]);
    expect(mgr.getStatus()).toBe('running');
    expect(fuserCalls.count).toBe(1);
  });

  it('does not spawn fuser for a live record that leaves the session not running', async () => {
    const mgr = makeManager();
    await feed(mgr, [userRecord('hello')]);
    await feed(mgr, []);
    // No records → nothing to capture against.
    expect(fuserCalls.count).toBe(0);
  });
});
