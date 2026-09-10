/**
 * Oversized-transcript drain. JsonlTailer caps a single readNewRecords() call
 * to MAX_READ_PER_CYCLE (16 MB, see jsonlTailer.ts) so one read can't OOM on
 * a huge append. updateInner() loops internally (mirroring detailPanel.ts's
 * transcript-tailing loop) to drain a bigger transcript fully within ONE
 * update() call — so a >16MB dormant transcript is never left half-read for
 * a later poll to (maybe) finish.
 *
 * Two bugs this guards against, both real and both caught by the first test
 * below:
 *  - jsonlTailer.ts's old [H6] memory guard compared the COMBINED length
 *    (carried-over partial line + new slice) against MAX_LINE_BUFFER, which
 *    is always true for a capped 16MB read — so the leftover from slice N
 *    was silently discarded and the record straddling the boundary vanished
 *    on every oversized transcript.
 *  - Without the internal drain loop, only the first 16MB slice would be
 *    processed per update() call, silently dropping every record past the
 *    cap (not just the boundary one).
 *
 * Uses real fs (no JsonlTailer mock): the whole point is exercising the real
 * MAX_READ_PER_CYCLE cap and the real H6 guard.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Writer-pid capture (`captureWriterPid` → `execFile('fuser', …)`) must never
// fire for a purely-replayed drain — see sessionManager.writerPid.test.ts for
// the general contract; this file only needs to confirm the oversized case
// doesn't regress it now that the whole file is consumed in one update().
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

const { SessionManager } = await import('./sessionManager.js');
const { JsonlTailer } = await import('./jsonlTailer.js');

const SESSION_ID = 'oversized-sid';
/** 22 alternating queue-operation records, ~800KB padding each: comfortably
 *  over the 16MB single-read cap (~17.6MB total), cheap to generate (one
 *  join + one writeFileSync) and cheap to parse (22 lines, not tens of
 *  thousands). */
const RECORD_COUNT = 22;
const PAD_SIZE = 800 * 1024;

/** Every record alternates the status (done → running → done → …), starting
 *  from the constructor's initial `done`. Each record therefore causes
 *  EXACTLY one transition: transitions.length === RECORD_COUNT is proof
 *  every single record was processed — if even one were lost (the H6
 *  boundary bug) or a whole tail were dropped (the missing-drain-loop bug),
 *  the count would fall short. */
function buildFixture(filePath: string): void {
  const pad = 'x'.repeat(PAD_SIZE);
  const lines: string[] = [];
  for (let i = 0; i < RECORD_COUNT; i++) {
    lines.push(JSON.stringify({
      type: 'queue-operation',
      operation: i % 2 === 0 ? 'dequeue' : 'enqueue',
      idx: i,
      pad,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

describe('SessionManager oversized-transcript drain', () => {
  let tmpDir: string;
  let filePath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oversized-jsonl-'));
    filePath = path.join(tmpDir, 'session.jsonl');
    buildFixture(filePath);
    expect(fs.statSync(filePath).size).toBeGreaterThan(16 * 1024 * 1024);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fuserCalls.count = 0;
  });

  it('drains fully within a single update(): every record is seen, none lost at the 16MB slice boundary', async () => {
    const transitions: { from: string; to: string }[] = [];
    const mgr = new SessionManager(SESSION_ID, filePath, 'test-workspace', {
      onTransition: (from, to) => transitions.push({ from, to }),
    });
    // The drain loop's exit condition checks "caught up" (offset reached the
    // file's last statted size) in addition to "no progress", so a call that
    // fully reads a slice and lands exactly caught-up stops immediately —
    // it does not spend one further empty read confirming there's nothing
    // left. Exactly ceil(size / MAX_READ_PER_CYCLE) reads, not one more.
    const readSpy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords');
    try {
      const changed = await mgr.update();
      expect(changed).toBe(true);
      expect(transitions).toHaveLength(RECORD_COUNT);
      // RECORD_COUNT is even, so the last record (idx 21, odd → 'enqueue')
      // leaves the session done.
      expect(mgr.getStatus()).toBe('done');
      // Confirms the drain never spawned the writer-pid probe: every record
      // in this call was replay (the whole file consumed in one update()),
      // never live.
      expect(fuserCalls.count).toBe(0);

      const expectedReads = Math.ceil(fs.statSync(filePath).size / (16 * 1024 * 1024));
      expect(expectedReads).toBe(2); // sanity: this fixture is ~17.6MB, not ~33MB+
      expect(readSpy).toHaveBeenCalledTimes(expectedReads);
    } finally {
      readSpy.mockRestore();
      mgr.dispose();
    }
  });

  it('getReadStamp().caughtUp is true after the single drain, and checkMtime() goes quiet', async () => {
    const mgr = new SessionManager(SESSION_ID, filePath, 'test-workspace');
    try {
      await mgr.update();
      const stamp = mgr.getReadStamp();
      expect(stamp.caughtUp).toBe(true);
      expect(stamp.size).toBe(fs.statSync(filePath).size);
      expect(await mgr.checkMtime()).toBe(false);
    } finally {
      mgr.dispose();
    }
  });

  it('checkMtime() reports true and update() processes new data appended after the drain', async () => {
    // A fresh copy so this test's mutation can't affect the other tests
    // sharing the beforeAll fixture.
    const growFile = path.join(tmpDir, 'growing.jsonl');
    fs.copyFileSync(filePath, growFile);
    const mgr = new SessionManager(SESSION_ID, growFile, 'test-workspace');
    try {
      await mgr.update(); // full drain
      expect(await mgr.checkMtime()).toBe(false);

      fs.appendFileSync(growFile, JSON.stringify({
        type: 'queue-operation', operation: 'dequeue', idx: RECORD_COUNT,
        sessionId: SESSION_ID, timestamp: '2026-01-01T00:00:01.000Z',
      }) + '\n');
      // Ensure a distinct mtime tick even on filesystems with coarse mtime resolution.
      const growTime = new Date(Date.now() + 2000);
      fs.utimesSync(growFile, growTime, growTime);

      expect(await mgr.checkMtime()).toBe(true);
      const changed = await mgr.update();
      expect(changed).toBe(true);
      expect(mgr.getStatus()).toBe('running');
      expect(await mgr.checkMtime()).toBe(false);
    } finally {
      mgr.dispose();
    }
  });
});
