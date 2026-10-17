import { describe, it, expect } from 'vitest';
import {
  classifyBring, isIdle, parseBringHint, parseBringAck, receiverVerdict, ackFor, ineligibleText,
  BRING_QUIET_MS, type BringInput, type BringHint,
} from './bringHere.js';
import type { LiveProcess } from './processRegistry.js';

const NOW = 1_800_000_000_000;
const proc = (over: Partial<LiveProcess> = {}): LiveProcess => ({
  pid: 4242, sessionId: 's1', cwd: '/ws', startedAt: NOW - 60_000, kind: 'interactive',
  entrypoint: 'claude-vscode', version: '2.1.300', status: 'idle', ...over,
});
const input = (over: Partial<BringInput> = {}): BringInput => ({
  entrypoint: 'claude-vscode',
  procs: [proc()],
  ownershipOf: () => true,
  owner: { ownerPid: 999, ownerCwd: '/ws', addressable: true },
  sessionRunning: false,
  hasLiveBackgroundAgents: false,
  lastWriteMtimeMs: NOW - BRING_QUIET_MS - 1,
  nowMs: NOW,
  ...over,
});

describe('classifyBring', () => {
  it('is eligible for an idle, local session held by one addressable window', () => {
    const v = classifyBring(input());
    expect(v).toMatchObject({ kind: 'eligible', ownerPid: 999, ownerCwd: '/ws' });
  });

  it.each([
    ['not-local', { entrypoint: undefined }],
    ['phone-session', { entrypoint: 'sdk-cli' }],
    ['not-external', { procs: [] }],
    ['several-writers', { procs: [proc(), proc({ pid: 5 })] }],
    ['not-external', { ownershipOf: (): boolean | undefined => false }],
    ['not-external', { ownershipOf: (): boolean | undefined => undefined }],
    ['unaddressable', { owner: null }],
    ['unaddressable', { owner: { ownerPid: 999, ownerCwd: null, addressable: false } }],
    ['unaddressable', { owner: { ownerPid: null, ownerCwd: null, addressable: true } }],
    ['busy', { procs: [proc({ status: 'busy' })] }],
    ['busy', { procs: [proc({ status: 'waiting' })] }],
    ['busy', { sessionRunning: true }],
    ['busy', { hasLiveBackgroundAgents: true }],
    ['busy', { lastWriteMtimeMs: NOW - 1_000 }],
  ] as const)('ineligible: %s (%o)', (reason, over) => {
    expect(classifyBring(input(over as Partial<BringInput>))).toEqual({ kind: 'ineligible', reason });
  });

  it('every reason has status-bar text', () => {
    for (const r of ['not-local', 'phone-session', 'not-external', 'unaddressable', 'several-writers', 'busy'] as const) {
      expect(ineligibleText(r).length).toBeGreaterThan(0);
    }
  });
});

describe('isIdle', () => {
  const quiet = { sessionRunning: false, hasLiveBackgroundAgents: false, lastWriteMtimeMs: null, nowMs: NOW };
  it('treats a missing registry status (older CLI) as no objection', () => {
    expect(isIdle({ status: null }, quiet)).toBe(true);
    expect(isIdle({}, quiet)).toBe(true);
  });
  it('busy covers background agents and Workflow runs on the CLI side', () => {
    expect(isIdle({ status: 'busy' }, quiet)).toBe(false);
  });
});

const hint = (over: Partial<BringHint> = {}): BringHint => ({
  sessionId: 's1', requestedAt: NOW, expiresAt: NOW + 3_000, nonce: 'n1',
  requesterPid: 777, requesterKey: '-Users-me-repo', ...over,
});

describe('parseBringHint / parseBringAck', () => {
  it('round-trips a valid hint', () => {
    expect(parseBringHint(JSON.parse(JSON.stringify(hint())))).toEqual(hint());
  });
  it.each([
    ['traversal session id', { sessionId: '../x' }],
    ['traversal key', { requesterKey: '../etc' }],
    ['slash in key', { requesterKey: 'a/b' }],
    ['bad pid', { requesterPid: -1 }],
    ['float pid', { requesterPid: 1.5 }],
    ['empty nonce', { nonce: '' }],
    ['no expiry', { expiresAt: 'soon' }],
  ])('rejects %s', (_label, over) => {
    expect(parseBringHint({ ...hint(), ...over })).toBeNull();
  });
  it('rejects non-objects', () => {
    expect(parseBringHint(null)).toBeNull();
    expect(parseBringHint('x')).toBeNull();
  });
  it('parses acks and rejects unknown results', () => {
    expect(parseBringAck({ sessionId: 's1', nonce: 'n1', result: 'closing', at: NOW }))
      .toEqual({ sessionId: 's1', nonce: 'n1', result: 'closing', at: NOW });
    expect(parseBringAck({ sessionId: 's1', nonce: 'n1', result: 'maybe', at: NOW })).toBeNull();
  });
});

describe('ackFor', () => {
  const raw = { sessionId: 's1', nonce: 'n1', result: 'closing', at: NOW };
  it('accepts only this request\'s nonce and session', () => {
    expect(ackFor(raw, 's1', 'n1')).toMatchObject({ result: 'closing' });
    expect(ackFor(raw, 's1', 'other')).toBe('none'); // another requester's answer
    expect(ackFor(raw, 's2', 'n1')).toBe('none');
    expect(ackFor(null, 's1', 'n1')).toBe('none');
  });
});

describe('receiverVerdict', () => {
  const base = { hint: hint(), nowMs: NOW + 500, requesterAlive: true, ownedHereOnly: true, inFlightHere: false, idle: true };
  it('closes when everything checks out', () => {
    expect(receiverVerdict(base)).toEqual({ kind: 'close' });
  });
  it('ignores (no ack) an expired hint, even if all else is fine', () => {
    expect(receiverVerdict({ ...base, nowMs: NOW + 3_001 })).toEqual({ kind: 'ignore', reason: 'expired' });
  });
  it('ignores a request from a window that has gone', () => {
    expect(receiverVerdict({ ...base, requesterAlive: false })).toEqual({ kind: 'ignore', reason: 'requester-gone' });
  });
  it('refuses when busy, not owned here, or bringing the same session itself', () => {
    expect(receiverVerdict({ ...base, idle: false })).toEqual({ kind: 'refuse', reason: 'busy' });
    expect(receiverVerdict({ ...base, ownedHereOnly: false })).toEqual({ kind: 'refuse', reason: 'not-owned-here' });
    expect(receiverVerdict({ ...base, inFlightHere: true })).toEqual({ kind: 'refuse', reason: 'in-flight-here' });
  });
});
