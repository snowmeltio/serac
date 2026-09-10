/**
 * Head-only JSONL peeking: read a bounded window from the start of a
 * transcript to answer a single cheap question (e.g. "what's the cwd?")
 * without replaying the whole file through a SessionManager. Used by
 * SiblingWorktreeManager's dir-classification probe (see siblingWorktreeManager.ts)
 * and can be adopted by other head-only lookups over time (e.g.
 * sessionDiscovery.ts:readSubagentModel).
 */
import * as fs from 'fs';

/** Split a chunk of file content into complete lines. A trailing partial
 *  line (no terminating `\n`) is kept only when the read reached EOF — a
 *  short file with no trailing newline still gets its last line. Otherwise
 *  the trailing fragment is dropped: there is more file beyond the read
 *  window, so the fragment is truncated mid-record and worth discarding
 *  explicitly rather than relying on JSON.parse to fail on it. */
export function splitCompleteLines(chunk: string, atEof: boolean): string[] {
  const lines = chunk.split('\n');
  // A chunk that ends exactly on a newline splits into a trailing empty
  // string — nothing to drop or keep either way.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
    return lines;
  }
  if (!atEof) {
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

/** First string `cwd` found on any record in the head of a transcript.
 *  Deliberately matches SessionManager's own semantics rather than
 *  restricting to a particular record type or the transcript's own
 *  sessionId: cwdTracker.onCwd() runs on every record in processRecord(),
 *  BEFORE the sessionId guard — so a foreign record earlier in the same
 *  file still counts there, and this peek must agree with that to classify
 *  sibling worktrees the same way a full replay would. */
export async function peekCwd(filePath: string, maxBytes = 64 * 1024): Promise<string | null> {
  const lines = await readJsonlHeadLines(filePath, maxBytes);
  const cwd = findInLines(lines, '"cwd"', (rec) => {
    const r = rec as { cwd?: unknown };
    return typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined;
  });
  return cwd ?? null;
}
