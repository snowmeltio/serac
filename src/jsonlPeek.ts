/**
 * Head-only JSONL peeking: read a bounded window from the start of a
 * transcript to answer a single cheap question (e.g. "what's the cwd?")
 * without replaying the whole file through a SessionManager. Used by
 * SiblingWorktreeManager's dir-classification probe (see siblingWorktreeManager.ts)
 * and can be adopted by other head-only lookups over time (e.g.
 * sessionDiscovery.ts:readSubagentModel).
 */
import * as fs from 'fs';
import { validateRecord } from './jsonlValidator.js';

/** Split a chunk of file content into complete lines. A trailing partial
 *  line (no terminating `\n`) is kept only when the read reached EOF — a
 *  short file with no trailing newline still gets its last line. Otherwise
 *  the trailing fragment is dropped: there is more file beyond the read
 *  window, so the fragment is truncated mid-record and worth discarding
 *  explicitly rather than relying on JSON.parse to fail on it. */
export function splitCompleteLines(chunk: string, atEof: boolean): string[] {
  const lines = chunk.split('\n'); // always >= 1 element, even for ''
  // Drop the trailing element when it's the empty tail of a chunk that ends
  // exactly on a newline (nothing lost either way), OR when the read didn't
  // reach EOF (a genuine partial line beyond the window).
  if (lines[lines.length - 1] === '' || !atEof) {
    lines.pop();
  }
  return lines;
}

/** Read at most `maxBytes` from the start of `filePath` and return its
 *  complete lines (see splitCompleteLines). Never throws — a missing file,
 *  permission error, or any other I/O failure yields an empty array so
 *  callers can treat "couldn't peek" the same as "found nothing". */
export async function readJsonlHeadLines(filePath: string, maxBytes = 64 * 1024): Promise<string[]> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const stat = await fh.stat();
    if (stat.size <= 0) { return []; }
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, 0);
    const atEof = bytesRead >= stat.size;
    const chunk = buf.toString('utf8', 0, bytesRead);
    return splitCompleteLines(chunk, atEof);
  } catch {
    return [];
  } finally {
    if (fh) {
      try { await fh.close(); } catch { /* already closed */ }
    }
  }
}

/** Scan `lines` for the first record matching a cheap substring pre-filter
 *  (avoids JSON.parse on every line) whose `pick()` returns a defined value.
 *  Malformed or non-matching lines are skipped, not thrown. */
export function findInLines<T>(
  lines: string[],
  prefilter: string,
  pick: (rec: unknown) => T | undefined,
): T | undefined {
  for (const line of lines) {
    if (!line.includes(prefilter)) { continue; }
    try {
      const result = pick(JSON.parse(line));
      if (result !== undefined) { return result; }
    } catch {
      // malformed or window-truncated line — keep scanning
    }
  }
  return undefined;
}

/** First `cwd` found on any valid record (`validateRecord()` — requires a
 *  string `type`, same as a real replay would accept, so a typeless line
 *  drops out here too) in the head of a transcript. Not restricted to a
 *  particular record type or the transcript's own sessionId:
 *  `cwdTracker.onCwd()` runs on every record in `processRecord()`, BEFORE the
 *  sessionId guard — so a foreign record earlier in the same file still
 *  counts there, and this peek agrees.
 *
 *  Deliberately returns the FIRST cwd seen, not the latest — this is the
 *  launch cwd that produced the on-disk workspace key
 *  (`~/.claude/projects/<workspaceKey>/`), the correct anchor for
 *  `SiblingWorktreeManager.worktreeRootForKey`. A later mid-session `cd`
 *  must not retroactively reclassify which worktree a session belongs to.
 *  This is NOT full parity with a live `SessionManager`: its snapshot's
 *  `cwd` is the LATEST seen across the whole replay (cwdTracker keeps
 *  overwriting), which drifts on a mid-session `cd` — exactly the value
 *  this function must not return.
 *
 *  Bounded to `maxBytes` (default 1 MB, matching the old full-replay probe's
 *  `MAX_LINE_BUFFER` tolerance for a single line — see jsonlTailer.ts). A
 *  64 KB window is not enough in practice: `cwd` is serialised AFTER
 *  `message` on a `user` record, and the first user record commonly carries
 *  an injected CLAUDE.md/system-reminder payload ahead of the real prompt
 *  text — measured up to ~184 KB on one real transcript on this disk, with
 *  roughly an eighth of recent transcripts having no `cwd` within a naive
 *  64 KB window. A smaller default would silently fail to classify those
 *  sessions' worktree. */
export async function peekCwd(filePath: string, maxBytes = 1024 * 1024): Promise<string | null> {
  const lines = await readJsonlHeadLines(filePath, maxBytes);
  const cwd = findInLines(lines, '"cwd"', (rec) => validateRecord(rec)?.cwd || undefined);
  return cwd ?? null;
}
