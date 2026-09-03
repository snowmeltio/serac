import { describe, it, expect } from 'vitest';
import {
  classifyTransfer, isSameProcess, waitForRelease, rcProcesses, TRANSFER_QUIET_MS,
} from './transferClassifier.js';
import type { LiveProcess } from './processRegistry.js';

const NOW = 1_750_000_000_000;

function proc(over: Partial<LiveProcess> = {}): LiveProcess {
  return {
    pid: 4242, sessionId: 'sess-1', cwd: '/Users/me/proj', startedAt: NOW - 60_000,
    kind: 'interactive', entrypoint: 'sdk-cli', version: '2.1.258', ...over,
  };
}

describe('classifyTransfer', () => {
  it('dead: no live process at all', () => {
    expect(classifyTransfer({ procs: [], sessionRunning: false, lastWriteMtimeMs: null, nowMs: NOW })).toEqual({ kind: 'dead' });
  });

  it('rc-idle: a phone process, status quiet, transcript older than the quiet window', () => {
    const p = proc();
    const v = classifyTransfer({ procs: [p], sessionRunning: false, lastWriteMtimeMs: NOW - TRANSFER_QUIET_MS - 1, nowMs: NOW });
    expect(v).toEqual({ kind: 'rc-idle', proc: p });
  });

  it('rc-idle when nothing could be stat-ed (null mtime) and status is quiet', () => {
    const v = classifyTransfer({ procs: [proc()], sessionRunning: false, lastWriteMtimeMs: null, nowMs: NOW });
    expect(v.kind).toBe('rc-idle');
  });

  it('rc-busy (active-status): Serac still sees a turn in flight', () => {
    const v = classifyTransfer({ procs: [proc()], sessionRunning: true, lastWriteMtimeMs: NOW - 60_000, nowMs: NOW });
    expect(v).toMatchObject({ kind: 'rc-busy', reason: 'active-status' });
  });

  it('rc-busy (recent-write): a write inside the quiet window, boundary exclusive', () => {
    const inside = classifyTransfer({ procs: [proc()], sessionRunning: false, lastWriteMtimeMs: NOW - TRANSFER_QUIET_MS + 1, nowMs: NOW });
    expect(inside).toMatchObject({ kind: 'rc-busy', reason: 'recent-write' });
    const atBoundary = classifyTransfer({ procs: [proc()], sessionRunning: false, lastWriteMtimeMs: NOW - TRANSFER_QUIET_MS, nowMs: NOW });
    expect(atBoundary.kind).toBe('rc-idle');
  });

  it('desktop wins over a phone process when both are registered', () => {
    const desk = proc({ pid: 1, entrypoint: 'claude-vscode' });
    const v = classifyTransfer({ procs: [proc(), desk], sessionRunning: true, lastWriteMtimeMs: NOW, nowMs: NOW });
    expect(v).toEqual({ kind: 'desktop', procs: [desk] });
  });

  it('names the newest-started phone process when two are registered', () => {
    const older = proc({ pid: 10, startedAt: NOW - 600_000 });
    const newer = proc({ pid: 11, startedAt: NOW - 30_000 });
    const v = classifyTransfer({ procs: [older, newer], sessionRunning: false, lastWriteMtimeMs: null, nowMs: NOW });
    expect(v).toMatchObject({ kind: 'rc-idle', proc: newer });
  });

  it('honours a custom quiet window', () => {
    const v = classifyTransfer({ procs: [proc()], sessionRunning: false, lastWriteMtimeMs: NOW - 2_000, nowMs: NOW, quietMs: 1_000 });
    expect(v.kind).toBe('rc-idle');
  });
});

describe('isSameProcess', () => {
  it('same pid and startedAt', () => {
    expect(isSameProcess(proc(), proc())).toBe(true);
  });
  it('same pid, different startedAt = a reused pid, not the same process', () => {
    expect(isSameProcess(proc(), proc({ startedAt: NOW - 1 }))).toBe(false);
  });
  it('different pid', () => {
    expect(isSameProcess(proc(), proc({ pid: 1 }))).toBe(false);
  });
  it('null startedAt on either side falls back to pid equality', () => {
    expect(isSameProcess(proc({ startedAt: null }), proc())).toBe(true);
    expect(isSameProcess(proc(), proc({ startedAt: null }))).toBe(true);
  });
});

describe('waitForRelease', () => {
  const noSleep = async (): Promise<void> => { /* instant */ };

  it('released once the target leaves the registry', async () => {
    let calls = 0;
    const poll = async (): Promise<LiveProcess[]> => (++calls < 3 ? [proc()] : []);
    let t = NOW;
    const now = () => t;
    const sleep = async (ms: number) => { t += ms; };
    const r = await waitForRelease(poll, proc(), { timeoutMs: 5_000, intervalMs: 250, sleep, now });
    expect(r).toBe('released');
    expect(calls).toBe(3);
  });

  it('released when a different process reuses the pid', async () => {
    const poll = async (): Promise<LiveProcess[]> => [proc({ startedAt: NOW + 5 })];
    const r = await waitForRelease(poll, proc(), { timeoutMs: 5_000, intervalMs: 250, sleep: noSleep, now: () => NOW });
    expect(r).toBe('released');
  });

  it('timeout when the target never leaves', async () => {
    let t = NOW;
    const sleep = async (ms: number) => { t += ms; };
    const poll = async (): Promise<LiveProcess[]> => [proc()];
    const r = await waitForRelease(poll, proc(), { timeoutMs: 1_000, intervalMs: 250, sleep, now: () => t });
    expect(r).toBe('timeout');
    expect(t - NOW).toBeGreaterThanOrEqual(1_000);
  });

});

describe('rcProcesses', () => {
  it('keeps only sdk-cli writers', () => {
    const a = proc(); const b = proc({ pid: 2, entrypoint: 'claude-vscode' });
    expect(rcProcesses([a, b])).toEqual([a]);
  });
});
