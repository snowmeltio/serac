// Serac's ONLY write into ~/.claude/: appending a message to an Agent Teams
// member's inbox (`<teamsDir>/<team>/inboxes/<member>.json`). Hardened per the
// teammate-messaging red-team audit. Pure fs (no vscode), so it is unit-testable.
//
// Guarantees:
//  - the write is CONFINED under <teamsDir>/<team>/inboxes/ via realpath/lstat —
//    a symlinked team dir, inboxes dir, or target file is refused, and the
//    team/member components must be strict identifiers (no traversal);
//  - the existing file is read with a strict KILL-SWITCH: a non-array, unparseable,
//    or surprising shape is refused rather than overwritten, and foreign entries
//    we did not author are preserved verbatim (never corrupted);
//  - the write is ATOMIC (crypto-random temp + exclusive create 0o600 + rename);
//  - Serac's own concurrent sends to one inbox are SERIALISED with a per-file
//    queue (depth-capped, so a burst can't grow unbounded);
//  - the file is size-capped (ring-buffer) so it can't grow without bound;
//  - message text is NFKC-normalised and rejected if it carries control or
//    bidirectional characters (which would hide injected instructions).
//
// Residual (cannot be solved here, disclosed in the UI): the owner drains its
// inbox on its own ~5s poll, so a send in that window can still be lost — we
// narrow the window (re-read immediately before write) but cannot hold its lock.

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** One inbox entry (v2.x Agent Teams schema). `from` is an honest operator
 *  label, never another roster member (no impersonation). */
export interface InboxEntry {
  from: string;
  text: string;
  timestamp: string;
  color: string;
  type: 'message';
  read: boolean;
}

/** A refusal from the write path — surfaced to the operator (in-webview), never
 *  as a focus-stealing toast, and logged as metadata only (never the message). */
export class InboxError extends Error {
  constructor(message: string) { super(message); this.name = 'InboxError'; }
}

/** Strict single path component — no separators, traversal, or leading dot. */
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9_-]+$/;
/** The operator label written as `from`. */
const SAFE_FROM = /^[A-Za-z0-9_-]{1,100}$/;
/** Max message length (chars, post-NFKC). */
export const MAX_TEXT = 8000;
/** Ring-buffer the inbox to at most this many entries / bytes (UTF-8 bytes on
 *  disk, not UTF-16 code units — CJK/emoji content is up to ~3x larger in
 *  UTF-8 than its string length suggests). */
const MAX_INBOX_ENTRIES = 200;
const MAX_INBOX_BYTES = 1024 * 1024;
/** Refuse to slurp an inbox larger than this (foreign writers can bloat the
 *  file; every other read path in the codebase is size-capped too). Above the
 *  ring cap to tolerate legacy files written under the code-unit measure. */
const MAX_INBOX_READ_BYTES = 4 * 1024 * 1024;
/** Per-inbox in-flight send cap (backpressure). */
const MAX_QUEUE_DEPTH = 10;
/** Cosmetic accent the receiver may use to tint the message; fixed default. */
const DEFAULT_COLOR = 'blue';
/** Own keys that must never appear on an inbox entry (prototype-pollution / smuggling). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** C0 controls (except \t \n \r), DEL, zero-width, and bidirectional overrides.
 *  These render invisibly but still reach the receiving agent's LLM context, so
 *  they could hide injected instructions from a human reading the transcript. */
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/;

/**
 * Normalise + validate a candidate message body. Returns the NFKC-normalised
 * text on success, or a human reason on failure (so the webview can show it).
 */
export function validateMessageText(text: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof text !== 'string') { return { ok: false, reason: 'Message is empty.' }; }
  const normalised = text.normalize('NFKC');
  if (normalised.length === 0) { return { ok: false, reason: 'Message is empty.' }; }
  if (normalised.length > MAX_TEXT) { return { ok: false, reason: `Message is too long (max ${MAX_TEXT} characters).` }; }
  if (UNSAFE_CHARS.test(normalised)) { return { ok: false, reason: 'Message contains control or invisible characters.' }; }
  return { ok: true, text: normalised };
}

/** Resolve + CONFINE the inbox file under <teamsDir>/<team>/inboxes/. Creates the
 *  inboxes dir (inside the confirmed-real team dir) if absent. Throws InboxError
 *  on any traversal/symlink/confinement violation. */
function confineInboxPath(teamsDir: string, teamDir: string, member: string): string {
  if (!SAFE_PATH_COMPONENT.test(teamDir) || !SAFE_PATH_COMPONENT.test(member)) {
    throw new InboxError('invalid team/member name');
  }
  // The teams root and the team dir must resolve to a real, non-symlinked dir
  // under the root. realpathSync throws if a segment is missing.
  const realTeamsDir = fs.realpathSync(teamsDir);
  const teamPath = path.join(teamsDir, teamDir);
  const teamLstat = fs.lstatSync(teamPath); // throws if the team dir is gone
  if (teamLstat.isSymbolicLink() || !teamLstat.isDirectory()) {
    throw new InboxError('team directory is not a real directory');
  }
  const realTeamPath = fs.realpathSync(teamPath);
  if (realTeamPath !== path.join(realTeamsDir, teamDir) && !realTeamPath.startsWith(realTeamsDir + path.sep)) {
    throw new InboxError('team directory escapes the teams root');
  }

  // inboxes/: create inside the confirmed-real team dir if absent; else it must
  // itself be a real (non-symlinked) directory.
  const inboxesPath = path.join(realTeamPath, 'inboxes');
  let inboxesLstat: fs.Stats | null = null;
  try { inboxesLstat = fs.lstatSync(inboxesPath); } catch { inboxesLstat = null; }
  if (inboxesLstat) {
    if (inboxesLstat.isSymbolicLink() || !inboxesLstat.isDirectory()) {
      throw new InboxError('inboxes is not a real directory');
    }
  } else {
    try {
      fs.mkdirSync(inboxesPath, { recursive: false, mode: 0o700 });
    } catch (e) {
      // A second writer (another VS Code window, or a concurrent send to a
      // DIFFERENT member of the same team — the queue serialises per inbox FILE,
      // not per team) can win the race to create inboxes/. EEXIST is then benign,
      // but re-assert it's a real directory (not a symlink swapped in during the
      // race). Re-throw anything else (EACCES, ENOSPC, …).
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { throw e; }
      const again = fs.lstatSync(inboxesPath);
      if (again.isSymbolicLink() || !again.isDirectory()) { throw new InboxError('inboxes is not a real directory'); }
    }
  }

  // The target file, if it already exists, must not be a symlink.
  const inboxFile = path.join(inboxesPath, `${member}.json`);
  let fileLstat: fs.Stats | null = null;
  try { fileLstat = fs.lstatSync(inboxFile); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { throw e; } }
  if (fileLstat && fileLstat.isSymbolicLink()) { throw new InboxError('inbox file is a symlink'); }
  return inboxFile;
}

/** Read the existing inbox as an array of entries, preserving them verbatim.
 *  KILL-SWITCH: throws (refuse to overwrite) on a non-array, unparseable, or
 *  surprising shape, rather than guessing. Absent/empty file → []. */
function readExistingEntries(inboxFile: string): unknown[] {
  let raw: string;
  try {
    // O_NOFOLLOW closes the read-side TOCTOU: if the target was swapped for a
    // symlink between confineInboxPath's lstat check and now, the open fails
    // (ELOOP) instead of reading through it. (The write side is safe because
    // rename replaces a symlink rather than following it — see atomicWrite.)
    const fd = fs.openSync(inboxFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      // Size-cap the read like every other on-disk read path (config 1MB,
      // meta 64KB, transcripts 50MB): a foreign writer could have bloated the
      // file, and an uncapped readFileSync would buffer it all before JSON.parse.
      if (fs.fstatSync(fd).size > MAX_INBOX_READ_BYTES) {
        throw new InboxError('inbox file is implausibly large — refusing to overwrite');
      }
      raw = fs.readFileSync(fd, 'utf8');
    }
    finally { fs.closeSync(fd); }
  }
  catch (e) {
    if (e instanceof InboxError) { throw e; }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') { return []; }
    if (code === 'ELOOP') { throw new InboxError('inbox file is a symlink'); }
    throw e;
  }
  if (raw.trim() === '') { return []; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new InboxError('inbox file is not valid JSON — refusing to overwrite'); }
  if (!Array.isArray(parsed)) { throw new InboxError('inbox file is not a JSON array — refusing to overwrite'); }
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new InboxError('inbox contains a non-object entry — refusing to overwrite');
    }
    for (const k of Object.keys(entry as object)) {
      if (FORBIDDEN_KEYS.has(k)) { throw new InboxError('inbox entry has a forbidden key — refusing to overwrite'); }
    }
    const rec = entry as Record<string, unknown>;
    if ('text' in rec && typeof rec.text !== 'string') { throw new InboxError('inbox entry text is not a string — refusing'); }
    if ('from' in rec && typeof rec.from !== 'string') { throw new InboxError('inbox entry from is not a string — refusing'); }
  }
  return parsed; // foreign entries preserved verbatim
}

/** Atomic write: crypto-random temp name + exclusive create (0o600) + rename.
 *  The unpredictable name + exclusive create closes the predictable-tmp symlink
 *  vector; rename is atomic on the same filesystem. rename(2) also REPLACES a
 *  symlink at the destination rather than following it, so a symlink swapped
 *  into filePath during the write window is overwritten, not written through —
 *  confinement holds (pairs with the O_NOFOLLOW read above). */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await fs.promises.open(tmp, 'wx', 0o600); // 'wx' = fail if it exists
  try { await fh.writeFile(content, 'utf8'); }
  finally { await fh.close(); }
  try { await fs.promises.rename(tmp, filePath); }
  catch (e) { try { await fs.promises.unlink(tmp); } catch { /* best effort */ } throw e; }
}

// ── Per-inbox serialisation queue (depth-capped) ─────────────────────────────
const queueTails = new Map<string, Promise<void>>();
const queueDepths = new Map<string, number>();

function decrDepth(key: string): void {
  const d = (queueDepths.get(key) ?? 1) - 1;
  if (d <= 0) { queueDepths.delete(key); } else { queueDepths.set(key, d); }
}

function enqueue(key: string, op: () => Promise<void>): Promise<void> {
  const depth = queueDepths.get(key) ?? 0;
  if (depth >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new InboxError('too many messages queued for this teammate — try again in a moment'));
  }
  queueDepths.set(key, depth + 1);
  const prev = queueTails.get(key) ?? Promise.resolve();
  const run = prev.then(op, op); // run after the previous send settles, success or fail
  queueTails.set(key, run.then(() => undefined, () => undefined)); // non-rejecting tail for the next link
  void run.then(() => decrDepth(key), () => decrDepth(key));
  return run;
}

/**
 * Append a message to a teammate's inbox. Resolves when the atomic write lands;
 * rejects with InboxError on a validation/confinement/kill-switch failure or
 * when the per-inbox queue is full. Serialised per inbox file.
 */
export function appendInboxMessage(opts: {
  teamsDir: string;
  teamDir: string;
  member: string;
  from: string;
  text: string;
  color?: string;
}): Promise<void> {
  // Validate inputs up front (synchronously) so a bad request rejects fast and
  // never enqueues. These mirror the handler's checks (defence-in-depth — the
  // write module never trusts its caller).
  if (!SAFE_PATH_COMPONENT.test(opts.teamDir) || !SAFE_PATH_COMPONENT.test(opts.member)) {
    return Promise.reject(new InboxError('invalid team/member name'));
  }
  if (!SAFE_FROM.test(opts.from)) {
    return Promise.reject(new InboxError('invalid operator name'));
  }
  const checked = validateMessageText(opts.text);
  if (!checked.ok) { return Promise.reject(new InboxError(checked.reason)); }
  const text = checked.text;
  const color = typeof opts.color === 'string' && SAFE_PATH_COMPONENT.test(opts.color) ? opts.color : DEFAULT_COLOR;

  const key = path.join(opts.teamsDir, opts.teamDir, 'inboxes', `${opts.member}.json`);
  return enqueue(key, async () => {
    const inboxFile = confineInboxPath(opts.teamsDir, opts.teamDir, opts.member);
    const existing = readExistingEntries(inboxFile); // re-read immediately before write (narrows the owner-drain race)
    const entry: InboxEntry = {
      from: opts.from, text, timestamp: new Date().toISOString(), color, type: 'message', read: false,
    };
    let next = [...existing, entry];
    // Ring-buffer by count, then by serialised UTF-8 size (true on-disk bytes,
    // not code units), dropping oldest first. Bounded: ≤200 entries per pass.
    if (next.length > MAX_INBOX_ENTRIES) { next = next.slice(next.length - MAX_INBOX_ENTRIES); }
    while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_INBOX_BYTES) { next.shift(); }
    await atomicWrite(inboxFile, JSON.stringify(next));
  });
}

/** Test-only: reset the per-inbox queue state between cases. */
export function _resetQueues(): void {
  queueTails.clear();
  queueDepths.clear();
}
