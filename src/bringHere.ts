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
/** The owner must act on a hint within this window of it being written. A
 *  receiver that picks it up later ignores it, so a requester that has given
 *  up can never be followed by a late close. */
export const BRING_HINT_EXPIRY_MS = 3_000;
/** How long the requester waits for the owner's ack. Comfortably past the
 *  expiry plus the owner's fresh checks (a registry scan and up to 2 s of ps). */
export const BRING_ACK_WAIT_MS = 8_000;
/** How long the requester waits for the owner's CLI to exit after a `closing`
 *  ack: the owner's close is bounded at ~11 s (5 s open + 1 s settle + 5 s
 *  close) and Claude Code's own shutdown takes ~2 s, up to 7 s with SIGKILL. */
export const BRING_EXIT_WAIT_MS = 20_000;
/** How long after the final open a process must register here. */
export const BRING_LAUNCH_WAIT_MS = 8_000;

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
  if (typeof h.nonce !== 'string' || h.nonce.length === 0 || h.nonce.length > 100) { return null; }
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

export type ReceiverVerdict =
  | { kind: 'close' }
  /** Answer `refused` so the requester stops waiting. */
  | { kind: 'refuse'; reason: 'busy' | 'not-owned-here' | 'in-flight-here' }
  /** Say nothing: the requester has (or will have) given up by itself. */
  | { kind: 'ignore'; reason: 'expired' | 'requester-gone' };

export interface ReceiverInput {
  hint: BringHint;
  nowMs: number;
  requesterAlive: boolean;
  /** Fresh: this window holds the session and no other window does. */
  ownedHereOnly: boolean;
  /** This window is itself bringing the same session in right now. */
  inFlightHere: boolean;
  idle: boolean;
}

/** The owner's decision. Expiry is checked first and must be checked AGAIN
 *  by the host immediately before acking: the fresh checks take time. */
export function receiverVerdict(input: ReceiverInput): ReceiverVerdict {
  if (input.nowMs > input.hint.expiresAt) { return { kind: 'ignore', reason: 'expired' }; }
  if (!input.requesterAlive) { return { kind: 'ignore', reason: 'requester-gone' }; }
  if (input.inFlightHere) { return { kind: 'refuse', reason: 'in-flight-here' }; }
  if (!input.ownedHereOnly) { return { kind: 'refuse', reason: 'not-owned-here' }; }
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
  'unaddressable': 'the other window cannot be reached',
  'several-writers': 'more than one process holds it',
  'busy': 'it is busy there',
};
/** Short reason for the status bar when the chip falls back to Switch. */
export function ineligibleText(reason: BringIneligible): string {
  return INELIGIBLE_TEXT[reason];
}
