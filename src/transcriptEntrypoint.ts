/**
 * Transcript entrypoint rewrite — the second half of the "bring this phone
 * session here" transfer.
 *
 * The Claude Code panel's session lister drops any transcript whose
 * `entrypoint` is `sdk-cli` (its host hard-codes includeProgrammaticSessions
 * = false), so a Remote Control-hosted session can never be restored in the
 * panel as written. Rewriting the value to `claude-vscode` on every record
 * makes the same file restorable (verified 2026-09-03, Claude Code 2.1.258).
 *
 * The rewrite is a per-line exact-token replacement, not a JSON round-trip:
 * it changes exactly the bytes that matter and cannot alter escapes or number
 * formatting elsewhere. The bare token `"entrypoint":"sdk-cli"` can only be
 * a real key — inside a JSON string value both quotes are escaped. The file
 * is streamed to a temp file in the same directory and renamed into place, so
 * a failure leaves the original untouched. One `serac-transfer` marker record
 * is appended so the change is visible, attributable, and reversible from the
 * file alone.
 *
 * Callers MUST ensure no process is writing the file (the transfer flow waits
 * for the phone's process to leave the registry first).
 */

import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { RC_ENTRYPOINT } from './rcOrigin.js';

export const SERAC_TRANSFER_RECORD_TYPE = 'serac-transfer';
/** The value the Claude Code panel itself stamps, and the one it restores. */
export const VSCODE_ENTRYPOINT = 'claude-vscode';
/** Bounded head scan for readTranscriptEntrypoint. sdk-cli transcripts open
 *  with a few token-less queue-operation records; the first user record
 *  follows within a few KB. */
const DEFAULT_HEAD_BYTES = 256 * 1024;

/** The exact JSON token for an entrypoint value, as Claude Code serialises it
 *  (no whitespace around the colon). */
export function entrypointToken(value: string): string {
  return `"entrypoint":${JSON.stringify(value)}`;
}

/** Replace every `from` token on one line. */
export function rewriteEntrypointLine(line: string, from: string, to: string): { line: string; changed: boolean } {
  const fromTok = entrypointToken(from);
  if (!line.includes(fromTok)) { return { line, changed: false }; }
  return { line: line.split(fromTok).join(entrypointToken(to)), changed: true };
}

/** The marker record appended after a rewrite. */
export function buildTransferMarker(sessionId: string, from: string, to: string, at: Date): string {
  return JSON.stringify({
    type: SERAC_TRANSFER_RECORD_TYPE,
    sessionId,
    fromEntrypoint: from,
    toEntrypoint: to,
    at: at.toISOString(),
  });
}

/** The first `entrypoint` value in the file's head, or null when none is
 *  found within `maxBytes`. Independent of the in-memory session state so the
 *  transfer flow can decide idempotence from the file itself. */
export async function readTranscriptEntrypoint(jsonlPath: string, opts: { maxBytes?: number } = {}): Promise<string | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_HEAD_BYTES;
  const fh = await fs.promises.open(jsonlPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, 64 * 1024));
    let offset = 0;
    let remainder = '';
    while (offset < maxBytes) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, maxBytes - offset), offset);
      if (bytesRead === 0) { break; }
      offset += bytesRead;
      const chunk = remainder + buf.subarray(0, bytesRead).toString('utf-8');
      const lines = chunk.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        const v = entrypointOnLine(line);
        if (v !== null) { return v; }
      }
    }
    return entrypointOnLine(remainder);
  } finally {
    await fh.close();
  }
}

const ENTRYPOINT_RE = /"entrypoint":"([^"\\]*)"/;
function entrypointOnLine(line: string): string | null {
  const m = ENTRYPOINT_RE.exec(line);
  return m ? m[1]! : null;
}

export interface RewriteResult {
  /** Lines that carried the `from` token and were changed. */
  changed: number;
  /** True when the file already read as `to` and nothing was written. */
  skipped: boolean;
}

/**
 * Stream `jsonlPath` to a same-directory temp file with every `from`
 * entrypoint token rewritten to `to`, append the marker record, fsync, and
 * rename over the original. The original's mode is preserved. Any error
 * removes the temp file and rethrows; the original is never touched.
 */
export async function rewriteTranscriptEntrypoint(
  jsonlPath: string,
  opts: { from?: string; to?: string; sessionId: string; now?: () => Date },
): Promise<RewriteResult> {
  const from = opts.from ?? RC_ENTRYPOINT;
  const to = opts.to ?? VSCODE_ENTRYPOINT;
  const current = await readTranscriptEntrypoint(jsonlPath);
  if (current === to) { return { changed: 0, skipped: true }; }

  const stat = await fs.promises.stat(jsonlPath);
  const tmp = `${jsonlPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const out = await fs.promises.open(tmp, 'wx', stat.mode & 0o777);
  let changed = 0;
  try {
    const input = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    // readline strips the terminator; every line we emit gets one, so a file
    // lacking a trailing newline gains it before the marker (Claude Code
    // always terminates its lines, so this only ever matters for a torn tail).
    let pending: string[] = [];
    let pendingBytes = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0) { return; }
      await out.write(pending.join(''));
      pending = [];
      pendingBytes = 0;
    };
    for await (const raw of rl) {
      const { line, changed: didChange } = rewriteEntrypointLine(raw, from, to);
      if (didChange) { changed++; }
      pending.push(line + '\n');
      pendingBytes += line.length + 1;
      if (pendingBytes >= 1 << 20) { await flush(); }
    }
    pending.push(buildTransferMarker(opts.sessionId, from, to, (opts.now ?? (() => new Date()))()) + '\n');
    await flush();
    await out.sync();
    await out.close();
    await fs.promises.rename(tmp, jsonlPath);
  } catch (err) {
    try { await out.close(); } catch { /* already closed */ }
    try { await fs.promises.unlink(tmp); } catch { /* best effort */ }
    throw err;
  }
  return { changed, skipped: false };
}
