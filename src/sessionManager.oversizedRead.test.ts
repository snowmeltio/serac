/**
 * Oversized-transcript drain (PR B). JsonlTailer caps a single readNewRecords()
 * call to MAX_READ_PER_CYCLE (16 MB, see jsonlTailer.ts) so one poll can't OOM
 * on a huge append. A transcript already over that cap at window open is
 * therefore replayed across several update() calls — but the dormant poll
 * loop (sessionPolling.ts pollTrackedSessions) only calls update() again when
 * checkMtime() says the file changed. Before this fix checkMtime() compared
 * mtime only, so a dormant classification taken right after the first
 * oversized slice — mtime unchanged, unread bytes still on disk — would
 * strand the rest of the transcript forever. Uses real fs (no JsonlTailer
 * mock): the whole point is exercising the real MAX_READ_PER_CYCLE cap.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';

const SESSION_ID = 'oversized-sid';

/** ~18 MB fixture: 20 padding `user` records (900 KB text payload each) —
 *  comfortably over the 16 MB single-read cap — followed by one
 *  `queue-operation: enqueue` record, which the state machine transitions to
 *  `done` on unconditionally (see the state transition table at the top of
 *  sessionManager.ts). A single writeFileSync of the whole in-memory buffer,
 *  not a loop of small appends, keeps fixture generation fast. */
function buildOversizedFixture(): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oversized-jsonl-'));
  const filePath = path.join(dir, 'session.jsonl');
  const text = 'x'.repeat(900 * 1024);
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: [{ type: 'text', text }] },
    }));
  }
  lines.push(JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId: SESSION_ID,
    timestamp: '2026-01-01T00:00:01.000Z',
  }));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return { dir, filePath };
}

describe('SessionManager oversized-transcript drain', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('checkMtime() reports unread bytes after a capped read, and a second update() drains the tail', async () => {
    const { dir, filePath } = buildOversizedFixture();
    tmpDir = dir;
    const fileSize = fs.statSync(filePath).size;
    expect(fileSize).toBeGreaterThan(16 * 1024 * 1024);

    const mgr = new SessionManager(SESSION_ID, filePath, 'test-workspace');
    try {
      // First update(): the tailer's MAX_READ_PER_CYCLE cap means this reads
      // only the first 16 MB — some, not all, of the padding records.
      const firstChanged = await mgr.update();
      expect(firstChanged).toBe(true);
      // The file has not been touched since — mtime is provably unchanged —
      // yet bytes remain unread past the tailer's offset.
      const mtimeAfterFirstRead = fs.statSync(filePath).mtimeMs;

      const mtimeChanged = await mgr.checkMtime();
      expect(mtimeChanged).toBe(true);
      expect(fs.statSync(filePath).mtimeMs).toBe(mtimeAfterFirstRead);

      // Second update() drains the remainder, including the trailing
      // queue-operation — proof the tail actually got read, not just that
      // checkMtime() flipped true.
      const secondChanged = await mgr.update();
      expect(secondChanged).toBe(true);
      expect(mgr.getStatus()).toBe('done');

      // Now fully caught up: no more unread bytes, checkMtime() goes quiet.
      expect(await mgr.checkMtime()).toBe(false);
    } finally {
      mgr.dispose();
    }
  });

  it('getReadStamp().caughtUp is false after the first capped read and true once drained', async () => {
    const { dir, filePath } = buildOversizedFixture();
    tmpDir = dir;

    const mgr = new SessionManager(SESSION_ID, filePath, 'test-workspace');
    try {
      await mgr.update();
      const midStamp = mgr.getReadStamp();
      expect(midStamp.caughtUp).toBe(false);
      expect(midStamp.size).toBeGreaterThan(16 * 1024 * 1024);

      await mgr.update();
      const finalStamp = mgr.getReadStamp();
      expect(finalStamp.caughtUp).toBe(true);
      expect(finalStamp.size).toBe(fs.statSync(filePath).size);
    } finally {
      mgr.dispose();
    }
  });
});
