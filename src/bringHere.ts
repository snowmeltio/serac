/**
 * Pure decision logic for "Bring it here": take a session that is live in
 * ANOTHER VS Code window and open it in this one, closing it there first.
 *
 * The flow (host side in extension.ts):
 *  1. Requester: offer Bring on the ⛔ chip only when classifyBring() says
 *     eligible — idle, this window's own transcript, exactly one addressable
 *     owner window. Otherwise the chip stays a one-click switch.
 *  2. Requester writes a bring hint (nonce, short expiry) to the owner.
 *  3. Owner: receiverVerdict() re-checks fresh and before the expiry, writes a
 *     `closing` ack naming the nonce, closes its tab (or acks `refused`).
 *  4. Requester: only on a `closing` ack carrying ITS nonce, waits for the
 *     owner's CLI process to exit (the registry entry goes ~2 s BEFORE the
 *     process does, so liveness is checked directly), then opens here.
 *
 * Claude Code 2.1.300 shows a session that is live elsewhere read-only with
 * an "Open here anyway" banner and starts no process, and a later open only
 * reveals that held panel. So the final open closes any held tab for the
 * session here first, then opens fresh. Nothing in this module touches I/O.
 */

import type { LiveProcess } from './processRegistry.js';
import { RC_ENTRYPOINT } from './rcOrigin.js';
import { isValidSessionId } from './validation.js';

/** The transcript must have been quiet this long (same bar as the phone
 *  transfer): a turn mid-flight writes continuously. */
export const BRING_QUIET_MS = 8_000;
/** The owner answers a hint only within this window of it being written
 *  (its watcher, a registry scan, and up to 2 s of ps all fit inside). */
export const BRING_HINT_EXPIRY_MS = 5_000;
/** How long the requester waits for an answer before it writes an abort. */
export const BRING_ACK_WAIT_MS = 10_000;
/** The owner never STARTS closing later than this after the request: a close
 *  can sit in the tab queue behind another, and an unbounded wait there could
 *  outlast the requester. */
export const BRING_CLOSE_DEADLINE_MS = 15_000;
/** How long the requester waits for the owner's CLI to exit after a
 *  `closing` answer: the close deadline, plus the close itself (~11 s bound:
 *  5 s open + 1 s settle + 5 s close), plus Claude Code's own shutdown (~2 s,
 *  up to 7 s with SIGKILL), with margin. */
export const BRING_EXIT_WAIT_MS = 40_000;
/** How long after the final open a process must register here. */
export const BRING_LAUNCH_WAIT_MS = 8_000;
/** Nonces name files, so they are restricted to UUID-safe characters. */
const NONCE_RE = /^[A-Za-z0-9-]{8,64}$/;

export type BringIneligible =
  | 'not-local'      // transcript not under this window's key (sibling, foreign, team)
  | 'phone-session'  // sdk-cli: the 📡→ transfer flow owns these
  | 'not-external'   // no other window holds it (or this one does too)
  | 'unaddressable'  // owner isn't a verified extension host
  | 'several-writers'
  | 'busy';          // a turn, a prompt, background agents, or recent writes

export type BringVerdict =
  | { kind: 'eligible'; proc: LiveProcess; ownerPid: number; ownerCwd: string | null }
  | { kind: 'ineligible'; reason: BringIneligible };

export interface BringInput {
  /** Transcript entrypoint as this window tracks it; undefined = not a
   *  session this window tails (its transcript is under another key). */
  entrypoint: string | undefined;
  /** Window-writer processes for the session, fresh. */
  procs: readonly LiveProcess[];
  /** Per-process ownership: true = another window, false = this window,
   *  undefined = unknown. */
  ownershipOf: (pid: number) => boolean | undefined;
  /** The open gate's owner, fresh: addressable only when the parent pid was
   *  just verified as a live extension host. */
  owner: { ownerPid: number | null; ownerCwd: string | null; addressable: boolean } | null;
  sessionRunning: boolean;
  hasLiveBackgroundAgents: boolean;
  lastWriteMtimeMs: number | null;
  nowMs: number;
}

export function classifyBring(input: BringInput): BringVerdict {
  if (input.entrypoint === undefined) { return { kind: 'ineligible', reason: 'not-local' }; }
  if (input.entrypoint === RC_ENTRYPOINT) { return { kind: 'ineligible', reason: 'phone-session' }; }
  if (input.procs.length === 0) { return { kind: 'ineligible', reason: 'not-external' }; }
  if (input.procs.length > 1) { return { kind: 'ineligible', reason: 'several-writers' }; }
  const proc = input.procs[0]!;
  if (input.ownershipOf(proc.pid) !== true) { return { kind: 'ineligible', reason: 'not-external' }; }
  if (!input.owner || !input.owner.addressable || input.owner.ownerPid === null) {
    return { kind: 'ineligible', reason: 'unaddressable' };
  }
  if (!isIdle(proc, input)) { return { kind: 'ineligible', reason: 'busy' }; }
  return { kind: 'eligible', proc, ownerPid: input.owner.ownerPid, ownerCwd: input.owner.ownerCwd };
}

/** Idle by every signal available: the CLI's own registry status when it
 *  writes one (`busy` also covers background agents and Workflow runs), this
 *  window's own reading of the transcript, live background agents, and a
 *  quiet transcript (subagents tree included). */
export function isIdle(
  proc: Pick<LiveProcess, 'status'>,
  input: Pick<BringInput, 'sessionRunning' | 'hasLiveBackgroundAgents' | 'lastWriteMtimeMs' | 'nowMs'>,
): boolean {
  if (proc.status !== undefined && proc.status !== null && proc.status !== 'idle') { return false; }
  if (input.sessionRunning || input.hasLiveBackgroundAgents) { return false; }
  if (input.lastWriteMtimeMs !== null && input.nowMs - input.lastWriteMtimeMs < BRING_QUIET_MS) { return false; }
  return true;
}

export interface BringHint {
  sessionId: string;
  requestedAt: number;
  expiresAt: number;
  nonce: string;
  requesterPid: number;
  /** Workspace key the ack must be filed under (the requester's own). */
  requesterKey: string;
}

export type BringAckResult = 'closing' | 'closed' | 'refused';
export interface BringAck {
  sessionId: string;
  nonce: string;
  result: BringAckResult;
  reason?: string;
  at: number;
}

const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 400 && !v.includes('/') && !v.includes('\\')
  && !v.includes('..') && !v.includes('\0');

export function parseBringHint(raw: unknown): BringHint | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const h = raw as Record<string, unknown>;
  if (!isValidSessionId(h.sessionId)) { return null; }
  if (typeof h.requestedAt !== 'number' || typeof h.expiresAt !== 'number') { return null; }
  if (typeof h.nonce !== 'string' || !NONCE_RE.test(h.nonce)) { return null; }
  if (!isPid(h.requesterPid) || !isKey(h.requesterKey)) { return null; }
  return {
    sessionId: h.sessionId, requestedAt: h.requestedAt, expiresAt: h.expiresAt,
    nonce: h.nonce, requesterPid: h.requesterPid, requesterKey: h.requesterKey,
  };
}

export function parseBringAck(raw: unknown): BringAck | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const a = raw as Record<string, unknown>;
  if (!isValidSessionId(a.sessionId) || typeof a.nonce !== 'string' || typeof a.at !== 'number') { return null; }
  if (a.result !== 'closing' && a.result !== 'closed' && a.result !== 'refused') { return null; }
  return {
    sessionId: a.sessionId, nonce: a.nonce, result: a.result, at: a.at,
    ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
  };
}

export type RefusalReason =
  | 'busy' | 'not-owned-here' | 'unverified' | 'disabled' | 'in-flight-here'
  | 'unidentified' | 'close-failed' | 'aborted' | 'deadline';

export type ReceiverVerdict =
  | { kind: 'close' }
  /** Answer `refused` so the requester stops waiting. */
  | { kind: 'refuse'; reason: RefusalReason }
  /** Say nothing: the requester has (or will have) given up by itself. */
  | { kind: 'ignore'; reason: 'expired' | 'requester-gone' };

/** The owner's fresh view of who holds the session. */
export type ReceiverOwnership =
  | 'own-only'    // every registered process confirmed this window's
  | 'not-owned'   // nothing here, or another window holds it too
  | 'unverified'  // a process whose window could not be confirmed (ps timeout)
  | 'disabled';   // serac.experimental.externalWriterBlock is off here

/** Fold the owner's per-process verdicts into a ReceiverOwnership. */
export function receiverOwnership(gateOn: boolean, verdicts: readonly (boolean | undefined)[]): ReceiverOwnership {
  if (!gateOn) { return 'disabled'; }
  if (verdicts.length === 0 || verdicts.some(v => v === true)) { return 'not-owned'; }
  if (verdicts.some(v => v === undefined)) { return 'unverified'; }
  return 'own-only';
}

export interface ReceiverInput {
  hint: BringHint;
  nowMs: number;
  requesterAlive: boolean;
  ownership: ReceiverOwnership;
  /** This window is itself bringing the same session in right now. */
  inFlightHere: boolean;
  idle: boolean;
}

/** The owner's decision. Expiry is checked first and must be checked AGAIN
 *  by the host immediately before acking: the fresh checks take time. */
export function receiverVerdict(input: ReceiverInput): ReceiverVerdict {
  if (input.nowMs > input.hint.expiresAt) { return { kind: 'ignore', reason: 'expired' }; }
  if (!input.requesterAlive) { return { kind: 'ignore', reason: 'requester-gone' }; }
  if (input.ownership === 'disabled') { return { kind: 'refuse', reason: 'disabled' }; }
  if (input.inFlightHere) { return { kind: 'refuse', reason: 'in-flight-here' }; }
  if (input.ownership === 'not-owned') { return { kind: 'refuse', reason: 'not-owned-here' }; }
  if (input.ownership === 'unverified') { return { kind: 'refuse', reason: 'unverified' }; }
  if (!input.idle) { return { kind: 'refuse', reason: 'busy' }; }
  return { kind: 'close' };
}

/** Requester's reading of the ack file: only an ack carrying THIS request's
 *  nonce counts. Anything else (absent, torn, another requester's) is 'none'. */
export function ackFor(raw: unknown, sessionId: string, nonce: string): BringAck | 'none' {
  const ack = parseBringAck(raw);
  if (!ack || ack.sessionId !== sessionId || ack.nonce !== nonce) { return 'none'; }
  return ack;
}

const INELIGIBLE_TEXT: Record<BringIneligible, string> = {
  'not-local': 'its transcript belongs to another folder',
  'phone-session': 'it is a phone session (use its 📡→ chip)',
  'not-external': 'no other window holds it',
  'unaddressable': 'whatever holds it is not a VS Code window Serac can reach',
  'several-writers': 'more than one process holds it',
  'busy': 'it is busy there',
};
/** Reasons worth a status-bar note when the chip falls back to Switch: the
 *  rest are routine (a sibling card, a terminal session) and only logged. */
export function ineligibleWorthSaying(reason: BringIneligible): boolean {
  return reason === 'busy' || reason === 'several-writers';
}

/** Short reason for the status bar when the chip falls back to Switch. */
export function ineligibleText(reason: BringIneligible): string {
  return INELIGIBLE_TEXT[reason];
}
