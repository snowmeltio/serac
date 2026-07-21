import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeSessionMetaStore, type SessionMetaStore } from './sessionMetaStore.js';
import type { Logger } from './sessionDiscovery.js';
import type { SessionMetaFile } from './types.js';

const silentLog: Logger = {
  trace: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

let tmpDir: string;
let metaPath: string;
let store: SessionMetaStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-store-'));
  metaPath = path.join(tmpDir, 'session-meta.json');
  store = makeSessionMetaStore(metaPath, silentLog);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readDisk(): SessionMetaFile {
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
}

describe('load', () => {
  it('starts empty when no file exists', async () => {
    await store.load();
    expect(store.entries()).toEqual([]);
  });

  it('loads existing entries from disk', async () => {
    fs.writeFileSync(metaPath, JSON.stringify({
      sessions: { s1: { title: 'T', dismissed: true, acknowledged: false, acknowledgedAt: null, firstSeen: 1 } },
    }));
    await store.load();
    expect(store.get('s1')?.dismissed).toBe(true);
    expect(store.get('s1')?.title).toBe('T');
  });

  it('preserves in-memory state when the file is corrupted', async () => {
    store.getOrCreate('kept').dismissed = true;
    fs.writeFileSync(metaPath, 'not json {{{');
    await store.load();
    expect(store.get('kept')?.dismissed).toBe(true);
  });

  it('migrates legacy dismissed-sessions and acknowledged-sessions files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dismissed-sessions'), 'a\nb\n');
    fs.writeFileSync(path.join(tmpDir, 'acknowledged-sessions'), 'b\n');
    await store.load();
    expect(store.get('a')?.dismissed).toBe(true);
    expect(store.get('b')?.dismissed).toBe(true);
    expect(store.get('b')?.acknowledged).toBe(true);
    // Timestamp 0 = immediately stale on reload (matches old behaviour)
    expect(store.get('b')?.acknowledgedAt).toBe(0);
    // Migration persists to the new file
    expect(readDisk().sessions.a.dismissed).toBe(true);
  });
});

describe('dirty protocol + save', () => {
  it('flush() persists dirty state and clears the flag', async () => {
    store.getOrCreate('s1').dismissed = true;
    store.markDirty();
    expect(store.isDirty()).toBe(true);
    await store.flush();
    expect(store.isDirty()).toBe(false);
    expect(readDisk().sessions.s1.dismissed).toBe(true);
  });

  it('flush() is a no-op when clean (does not create the file)', async () => {
    await store.flush();
    expect(fs.existsSync(metaPath)).toBe(false);
  });

  it('delete() marks dirty only when the entry existed', () => {
    store.getOrCreate('s1');
    expect(store.delete('s1')).toBe(true);
    expect(store.isDirty()).toBe(true);
    expect(store.delete('missing')).toBe(false);
  });

  it('entries() snapshot tolerates delete-while-iterating', () => {
    store.getOrCreate('a');
    store.getOrCreate('b');
    for (const [id] of store.entries()) {
      store.delete(id);
    }
    expect(store.entries()).toEqual([]);
  });

  it('overlapping enqueueSave() calls serialise (last state wins, file intact)', async () => {
    store.getOrCreate('s1').title = 'first';
    store.markDirty();
    store.enqueueSave();
    store.getOrCreate('s1').title = 'second';
    store.markDirty();
    store.enqueueSave();
    await store.flush();
    expect(readDisk().sessions.s1.title).toBe('second');
    // No orphaned tmp files left behind
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

describe('reloadIfChanged', () => {
  it('skips reload while dirty — external read must not clobber unflushed mutations [C1]', async () => {
    await store.load();
    store.getOrCreate('mine').dismissed = true;
    store.markDirty();
    // External writer replaces the file with different content
    fs.writeFileSync(metaPath, JSON.stringify({ sessions: {} }));
    fs.utimesSync(metaPath, new Date(), new Date(Date.now() + 5000));
    await store.reloadIfChanged();
    expect(store.get('mine')?.dismissed).toBe(true);
  });

  it('reloads when the file changed externally and we are clean', async () => {
    store.getOrCreate('s1');
    store.markDirty();
    await store.flush();
    // External writer bumps content + mtime
    fs.writeFileSync(metaPath, JSON.stringify({
      sessions: { external: { title: null, dismissed: true, acknowledged: false, acknowledgedAt: null, firstSeen: 1 } },
    }));
    fs.utimesSync(metaPath, new Date(), new Date(Date.now() + 5000));
    await store.reloadIfChanged();
    expect(store.get('external')?.dismissed).toBe(true);
  });

  it('does not re-read its own write [C1]', async () => {
    store.getOrCreate('s1').title = 'ours';
    store.markDirty();
    await store.flush();
    // Mutate memory WITHOUT marking dirty — if reloadIfChanged re-read our own
    // write, this in-memory divergence would be clobbered back to 'ours'.
    store.getOrCreate('s1').title = 'memory-only';
    await store.reloadIfChanged();
    expect(store.get('s1')?.title).toBe('memory-only');
  });
});

// Interleaving hazards (2026-07-21 hardening). Each test gates one fs call
// with a deferred promise so the racing mutation lands at a DETERMINISTIC
// point inside the store's awaits — no timers, no sleeps.
describe('interleaving hazards', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a mutation landing during an in-flight save is not eaten — dirty survives, next flush persists it [C2]', async () => {
    store.getOrCreate('s1').title = 'first';
    store.markDirty();

    // Gate the save's writeFile: signal when the save has snapshotted the map
    // (writeFile is called after the snapshot), then hold it open.
    let writeStarted!: () => void;
    const started = new Promise<void>(res => { writeStarted = res; });
    let releaseWrite!: () => void;
    const gate = new Promise<void>(res => { releaseWrite = res; });
    const realWrite = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(
      (async (...args: Parameters<typeof fs.promises.writeFile>) => {
        writeStarted();
        await gate;
        return realWrite(...args);
      }),
    );

    store.enqueueSave();      // snapshots 'first', blocks inside writeFile
    await started;
    store.getOrCreate('s1').title = 'second';
    store.markDirty();        // lands mid-save — after the snapshot
    releaseWrite();

    // Let the gated save COMPLETE before flushing — flushing earlier would
    // queue behind the in-flight save while dirty is still trivially true and
    // mask the eaten-flag path this test exists to pin down.
    await vi.waitFor(() => { expect(readDisk().sessions.s1.title).toBe('first'); });
    await new Promise(r => setTimeout(r, 25)); // stat + flag logic after the rename

    await store.flush();      // must persist 'second' — only happens if dirty survived
    expect(readDisk().sessions.s1.title).toBe('second');
    expect(store.isDirty()).toBe(false);
  });

  it('a reload whose read overlaps a mutation abandons the map swap — the user action survives [C1 re-check]', async () => {
    store.getOrCreate('s1').title = 'ours';
    store.markDirty();
    await store.flush();
    // External writer replaces the file (does NOT contain 'mine') and bumps mtime.
    fs.writeFileSync(metaPath, JSON.stringify({ sessions: {} }));
    fs.utimesSync(metaPath, new Date(), new Date(Date.now() + 5000));

    let readStarted!: () => void;
    const started = new Promise<void>(res => { readStarted = res; });
    let releaseRead!: () => void;
    const gate = new Promise<void>(res => { releaseRead = res; });
    const realRead = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementationOnce(
      (async (...args: Parameters<typeof fs.promises.readFile>) => {
        readStarted();
        await gate;
        return realRead(...args);
      }) as typeof fs.promises.readFile,
    );

    const reload = store.reloadIfChanged();  // passes the pre-stat dirty check, blocks in readFile
    await started;
    // User action mid-read: the exact dismiss-click window.
    store.getOrCreate('mine').dismissed = true;
    store.markDirty();
    store.enqueueSave();
    releaseRead();
    await reload;

    // The swap must have been abandoned — a commit here would revert the dismiss.
    expect(store.get('mine')?.dismissed).toBe(true);
    await store.flush();
    expect(readDisk().sessions.mine.dismissed).toBe(true);
  });

  it('a failed save leaves dirty set, unlinks its tmp file, and the queue recovers on the next flush', async () => {
    const errors: unknown[] = [];
    const log: Logger = { ...silentLog, error: (msg: unknown) => { errors.push(msg); } };
    const failing = makeSessionMetaStore(metaPath, log);
    failing.getOrCreate('s1').title = 'x';
    failing.markDirty();

    // Fail at the RENAME so the tmp file genuinely exists and must be cleaned.
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EPERM'));
    failing.enqueueSave();
    await vi.waitFor(() => { expect(errors.length).toBe(1); });

    expect(String(errors[0])).toContain('1 consecutive');
    expect(failing.isDirty()).toBe(true); // memory is ahead of disk — flag must hold
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'))).toEqual([]);

    await failing.flush();                // rename spy consumed — this one succeeds
    expect(readDisk().sessions.s1.title).toBe('x');
    expect(failing.isDirty()).toBe(false);
  });

  it('warns once save failures look persistent (3 consecutive) that external reloads stay paused', async () => {
    const warns: unknown[] = [];
    const log: Logger = { ...silentLog, warn: (msg: unknown) => { warns.push(msg); } };
    const failing = makeSessionMetaStore(metaPath, log);
    failing.getOrCreate('s1');
    failing.markDirty();

    const spy = vi.spyOn(fs.promises, 'rename');
    spy.mockRejectedValueOnce(new Error('EPERM'))
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockRejectedValueOnce(new Error('EPERM'));
    failing.enqueueSave();
    failing.enqueueSave();
    failing.enqueueSave();
    await vi.waitFor(() => {
      expect(warns.some(w => String(w).includes('stay paused'))).toBe(true);
    });
    expect(failing.isDirty()).toBe(true);
  });
});
