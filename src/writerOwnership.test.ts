import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { WriterOwnership, isOwnWindowWriter, aggregateWriterOwnership } from './writerOwnership.js';
import type { LiveProcess } from './processRegistry.js';

/** Mock execFile to invoke its callback with the given stdout. */
function mockPs(stdout: string): void {
  vi.mocked(execFile).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(null, stdout);
      return {} as ReturnType<typeof execFile>;
    },
  );
}

/** Mock execFile to invoke its callback with an error (ps failed/timed out). */
function mockPsError(err: Error = new Error('ps failed')): void {
  vi.mocked(execFile).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(err, '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function liveProcess(over: Partial<LiveProcess> = {}): LiveProcess {
  return {
    pid: 1234,
    sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    cwd: '/repo/x',
    startedAt: 1780000000000,
    kind: 'interactive',
    entrypoint: 'claude-vscode',
    version: '2.1.201',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isOwnWindowWriter', () => {
  it('resolves true when the pid\'s parent is this process', async () => {
    mockPs(`${process.pid}\n`);
    await expect(isOwnWindowWriter(1234)).resolves.toBe(true);
  });

  it('resolves false when the pid\'s parent is a different process', async () => {
    mockPs('1\n'); // pid 1 is never this test process
    await expect(isOwnWindowWriter(1234)).resolves.toBe(false);
  });

  it('resolves null when ps errors (timeout, missing binary, etc.)', async () => {
    mockPsError();
    await expect(isOwnWindowWriter(1234)).resolves.toBeNull();
  });

  it('resolves null on empty stdout', async () => {
    mockPs('');
    await expect(isOwnWindowWriter(1234)).resolves.toBeNull();
  });

  it('resolves null on unparseable stdout', async () => {
    mockPs('not-a-number\n');
    await expect(isOwnWindowWriter(1234)).resolves.toBeNull();
  });
});

describe('aggregateWriterOwnership', () => {
  it('is undefined for an empty list (no live process for the session)', () => {
    expect(aggregateWriterOwnership([])).toBeUndefined();
  });

  it('is true when the single verdict is confirmed external', () => {
    expect(aggregateWriterOwnership([true])).toBe(true);
  });

  it('is false when the single verdict is confirmed own-window', () => {
    expect(aggregateWriterOwnership([false])).toBe(false);
  });

  it('is undefined when the single verdict is unresolved', () => {
    expect(aggregateWriterOwnership([undefined])).toBeUndefined();
  });

  it('is true when ANY of several processes is confirmed external — fails toward flagging', () => {
    expect(aggregateWriterOwnership([false, true])).toBe(true);
    expect(aggregateWriterOwnership([undefined, true, false])).toBe(true);
  });

  it('is false only when EVERY process is confirmed own-window', () => {
    expect(aggregateWriterOwnership([false, false, false])).toBe(false);
  });

  it('is undefined (never falsely "safe") when own-window mixes with unresolved', () => {
    expect(aggregateWriterOwnership([false, undefined])).toBeUndefined();
  });
});

describe('WriterOwnership', () => {
  it('getInfo returns undefined before any refresh', () => {
    const wo = new WriterOwnership();
    expect(wo.getInfo(1234)).toBeUndefined();
  });

  it('marks a same-window pid as not-external after refresh', async () => {
    mockPs(`${process.pid}\n`);
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234 })]);
    expect(wo.getInfo(1234)).toBe(false);
  });

  it('marks a different-window pid as external after refresh', async () => {
    mockPs('1\n');
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234 })]);
    expect(wo.getInfo(1234)).toBe(true);
  });

  it('leaves a pid unresolved (undefined) when ps fails — never flags on unknown', async () => {
    mockPsError();
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234 })]);
    expect(wo.getInfo(1234)).toBeUndefined();
  });

  it('does not re-query an already-resolved pid on a later refresh', async () => {
    mockPs(`${process.pid}\n`);
    const wo = new WriterOwnership();
    const proc = liveProcess({ pid: 1234 });
    await wo.refresh([proc]);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    await wo.refresh([proc]);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  it('retries a pid that previously failed to resolve', async () => {
    mockPsError();
    const wo = new WriterOwnership();
    const proc = liveProcess({ pid: 1234 });
    await wo.refresh([proc]);
    expect(wo.getInfo(1234)).toBeUndefined();
    mockPs(`${process.pid}\n`);
    await wo.refresh([proc]);
    expect(wo.getInfo(1234)).toBe(false);
  });

  it('re-resolves a pid whose startedAt changed — pid reuse, not a cache hit', async () => {
    mockPs('1\n'); // different window
    const wo = new WriterOwnership();
    const first = liveProcess({ pid: 1234, startedAt: 1000 });
    await wo.refresh([first]);
    expect(wo.getInfo(1234)).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);

    // The OS recycled pid 1234 for an unrelated process before a scan ever
    // observed the gap — same pid, different startedAt. Must NOT reuse the
    // stale verdict.
    mockPs(`${process.pid}\n`); // this window's own
    const recycled = liveProcess({ pid: 1234, startedAt: 2000 });
    await wo.refresh([recycled]);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
    expect(wo.getInfo(1234)).toBe(false);
  });

  it('always re-resolves a pid with a null startedAt — can\'t prove continuity, so never trusts the cache', async () => {
    mockPs('1\n'); // different window
    const wo = new WriterOwnership();
    const first = liveProcess({ pid: 1234, startedAt: null });
    await wo.refresh([first]);
    expect(wo.getInfo(1234)).toBe(true);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);

    // Same pid, still null startedAt (e.g. an older client) — `null !== null`
    // would look like a cache hit, but null proves nothing about continuity,
    // so this must still re-query rather than silently reuse the old verdict.
    mockPs(`${process.pid}\n`); // this window's own
    const recycled = liveProcess({ pid: 1234, startedAt: null });
    await wo.refresh([recycled]);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
    expect(wo.getInfo(1234)).toBe(false);
  });

  it('drops (never keeps) a stale verdict when re-resolution after pid reuse fails', async () => {
    mockPs('1\n'); // different window
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234, startedAt: 1000 })]);
    expect(wo.getInfo(1234)).toBe(true);

    // Pid recycled (different startedAt) but the re-resolution ps call itself
    // fails — must NOT silently keep serving the OLD process's verdict as if
    // it were current.
    mockPsError();
    await wo.refresh([liveProcess({ pid: 1234, startedAt: 2000 })]);
    expect(wo.getInfo(1234)).toBeUndefined();
  });

  it('resolveFor resolves exactly the given processes without pruning anything else', async () => {
    mockPs('1\n');
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 111 })]);
    expect(wo.getInfo(111)).toBe(true);

    mockPs(`${process.pid}\n`);
    await wo.resolveFor([liveProcess({ pid: 222, sessionId: 'other-session' })]);
    expect(wo.getInfo(222)).toBe(false);
    // pid 111 was outside resolveFor()'s scope — a plain refresh([]) would have
    // pruned it for being absent from the live set; resolveFor() must not.
    expect(wo.getInfo(111)).toBe(true);
  });

  it('serializes refresh()/resolveFor() calls — a later call never mutates the cache until the earlier one fully finishes', async () => {
    let releaseFirstPs: ((stdout: string) => void) | undefined;
    const firstPsGate = new Promise<string>(resolve => { releaseFirstPs = resolve; });
    const callOrder: number[] = [];
    vi.mocked(execFile).mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        const pid = Number((args as string[])[3]);
        callOrder.push(pid);
        const callback = cb as (err: Error | null, stdout: string) => void;
        if (pid === 111) {
          void firstPsGate.then(stdout => callback(null, stdout));
        } else {
          callback(null, `${process.pid}\n`);
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const wo = new WriterOwnership();
    const refreshPromise = wo.refresh([liveProcess({ pid: 111, startedAt: 1 })]);
    // Fired immediately after, without awaiting the above — proving the two
    // calls are genuinely concurrent from the caller's perspective.
    const resolveForPromise = wo.resolveFor([liveProcess({ pid: 222, startedAt: 1, sessionId: 'other' })]);

    // Let pending microtasks settle while pid 111's ps call is still gated.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // If the calls ran concurrently, pid 222 would already have been queried —
    // serialization means it must not have started yet.
    expect(callOrder).toEqual([111]);
    expect(wo.getInfo(222)).toBeUndefined();

    releaseFirstPs!(`${process.pid}\n`);
    await refreshPromise;
    await resolveForPromise;

    expect(callOrder).toEqual([111, 222]);
    expect(wo.getInfo(111)).toBe(false);
    expect(wo.getInfo(222)).toBe(false);
  });

  it('prunes a resolved pid once it drops out of the live set', async () => {
    mockPs('1\n');
    const wo = new WriterOwnership();
    const proc = liveProcess({ pid: 1234 });
    await wo.refresh([proc]);
    expect(wo.getInfo(1234)).toBe(true);
    await wo.refresh([]); // pid no longer live
    expect(wo.getInfo(1234)).toBeUndefined();
  });

  it('dispose clears all resolved state', async () => {
    mockPs('1\n');
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234 })]);
    wo.dispose();
    expect(wo.getInfo(1234)).toBeUndefined();
  });
});
