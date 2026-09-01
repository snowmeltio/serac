import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { WriterOwnership, resolveParentPid, aggregateWriterOwnership, classifyProcessArgs, isExtensionHostPid, NON_OWN_VERDICT_TTL_MS } from './writerOwnership.js';
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

describe('resolveParentPid', () => {
  it('resolves the parent pid from ps output', async () => {
    mockPs('4321\n');
    await expect(resolveParentPid(1234)).resolves.toBe(4321);
  });

  it('resolves null when ps errors (timeout, missing binary, etc.)', async () => {
    mockPsError();
    await expect(resolveParentPid(1234)).resolves.toBeNull();
  });

  it('resolves null on empty stdout', async () => {
    mockPs('');
    await expect(resolveParentPid(1234)).resolves.toBeNull();
  });

  it('resolves null on unparseable stdout', async () => {
    mockPs('not-a-number\n');
    await expect(resolveParentPid(1234)).resolves.toBeNull();
  });

  it('settles null when ps never calls back — a wedged probe must not wedge the queue', async () => {
    // execFile's timeout only SENDS SIGTERM; a child that never exits never
    // fires the callback. The settle-guard bounds it so resolveFor()/refresh()
    // (and everything queued behind them) cannot hang for the window's life.
    vi.useFakeTimers();
    try {
      vi.mocked(execFile).mockImplementation(() => ({} as ReturnType<typeof execFile>));
      const pending = resolveParentPid(1234);
      vi.advanceTimersByTime(3001);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('classifyProcessArgs', () => {
  it('recognises the macOS Extension Host argv shape', () => {
    expect(classifyProcessArgs(
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-AU',
    )).toBe('extension-host');
  });

  it('recognises the Linux Extension Host argv shape', () => {
    expect(classifyProcessArgs(
      '/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-US',
    )).toBe('extension-host');
  });

  it('classifies shells as other — the terminal-started false-positive guard', () => {
    expect(classifyProcessArgs('-zsh')).toBe('other');
    expect(classifyProcessArgs('/bin/bash')).toBe('other');
  });

  it('classifies an empty line as other', () => {
    expect(classifyProcessArgs('')).toBe('other');
  });
});

describe('isExtensionHostPid', () => {
  it('resolves true for an Extension Host argv line', async () => {
    mockPs('/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService\n');
    await expect(isExtensionHostPid(999)).resolves.toBe(true);
  });

  it('resolves false for a shell', async () => {
    mockPs('-zsh\n');
    await expect(isExtensionHostPid(999)).resolves.toBe(false);
  });

  it('resolves null when ps fails — never addressable on unknown', async () => {
    mockPsError();
    await expect(isExtensionHostPid(999)).resolves.toBeNull();
  });

  it('resolves null on empty stdout', async () => {
    mockPs('\n');
    await expect(isExtensionHostPid(999)).resolves.toBeNull();
  });
});

describe('aggregateWriterOwnership', () => {
  it('is undefined for an empty list (no live process for the session)', () => {
    expect(aggregateWriterOwnership([])).toBeUndefined();
  });

  it("is 'external' when the single verdict is confirmed external", () => {
    expect(aggregateWriterOwnership([true])).toBe('external');
  });

  it("is 'own' when the single verdict is confirmed own-window", () => {
    expect(aggregateWriterOwnership([false])).toBe('own');
  });

  it('is undefined when the single verdict is unresolved', () => {
    expect(aggregateWriterOwnership([undefined])).toBeUndefined();
  });

  it("is 'external' when any process is confirmed external and none is own-window", () => {
    expect(aggregateWriterOwnership([undefined, true])).toBe('external');
    expect(aggregateWriterOwnership([true, true])).toBe('external');
  });

  it("own + external at once is 'dual' — surfaced, never silently cleared or bounced", () => {
    // A session live in two windows used to classify as external in BOTH
    // (each offered a handoff to the other — an infinite hint ping-pong),
    // then from v1.18.2 as own in both (silent about two processes sharing
    // one JSONL). 'dual' names the hazard so both windows can surface the
    // resolve chip; neither treats the other as "elsewhere".
    expect(aggregateWriterOwnership([false, true])).toBe('dual');
    expect(aggregateWriterOwnership([undefined, true, false])).toBe('dual');
  });

  it("is 'own' when every process is confirmed own-window", () => {
    expect(aggregateWriterOwnership([false, false, false])).toBe('own');
  });

  it('own-window precedence also applies over unresolved verdicts', () => {
    // An own-window process is a direct proof the session is usable here;
    // an unresolved sibling proves nothing (dual requires a CONFIRMED
    // external alongside).
    expect(aggregateWriterOwnership([false, undefined])).toBe('own');
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

  it('re-resolves an external verdict past the TTL — the owner address must not outlive the owner', async () => {
    vi.useFakeTimers();
    try {
      mockPs('4321\n'); // another window's Extension Host
      const wo = new WriterOwnership();
      const proc = liveProcess({ pid: 1234 });
      await wo.refresh([proc]);
      expect(wo.getInfo(1234)).toBe(true);
      expect(wo.getOwnerPid(1234)).toBe(4321);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);

      // Within the TTL: cache hit, no second ps.
      vi.advanceTimersByTime(NON_OWN_VERDICT_TTL_MS - 1000);
      await wo.refresh([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);

      // Past the TTL: the owning window has died and the writer survived,
      // reparented to launchd. Still external (a surviving orphan is not this
      // window's writer), but the address refreshes — pid 1 fails
      // isExtensionHostPid downstream, so the unfulfillable switch offer goes.
      vi.advanceTimersByTime(2000);
      mockPs('1\n');
      await wo.refresh([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
      expect(wo.getInfo(1234)).toBe(true);
      expect(wo.getOwnerPid(1234)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an own-window verdict never expires — this window cannot stop being the parent while both live', async () => {
    vi.useFakeTimers();
    try {
      mockPs(`${process.pid}\n`);
      const wo = new WriterOwnership();
      const proc = liveProcess({ pid: 1234 });
      await wo.refresh([proc]);
      expect(wo.getInfo(1234)).toBe(false);
      vi.advanceTimersByTime(NON_OWN_VERDICT_TTL_MS * 5);
      await wo.refresh([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the standing verdict when a TTL re-resolve fails — same process, so stale beats wrong', async () => {
    vi.useFakeTimers();
    try {
      mockPs('4321\n');
      const wo = new WriterOwnership();
      const proc = liveProcess({ pid: 1234 });
      await wo.refresh([proc]);
      expect(wo.getInfo(1234)).toBe(true);

      // ps fails on the re-check. Unlike the pid-reuse case (startedAt
      // mismatch — the old entry is known-wrong and dropped), this is still
      // the same process: the old verdict is merely unconfirmed, and the next
      // refresh retries.
      vi.advanceTimersByTime(NON_OWN_VERDICT_TTL_MS + 1000);
      mockPsError();
      await wo.refresh([proc]);
      expect(wo.getInfo(1234)).toBe(true);
      expect(wo.getOwnerPid(1234)).toBe(4321);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed TTL re-resolve buys another TTL — failure must not tighten the cadence to every refresh', async () => {
    // The adversarial-review catch: without re-stamping resolvedAt on the
    // keep-the-verdict path, the entry stays permanently expired and every
    // poll-loop refresh (2–8s) spawns another ps, forever.
    vi.useFakeTimers();
    try {
      mockPs('4321\n');
      const wo = new WriterOwnership();
      const proc = liveProcess({ pid: 1234 });
      await wo.refresh([proc]);
      vi.advanceTimersByTime(NON_OWN_VERDICT_TTL_MS + 1000);
      mockPsError();
      await wo.refresh([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);

      // The next few refreshes inside the fresh TTL are cache hits again.
      vi.advanceTimersByTime(5000);
      await wo.refresh([proc]);
      await wo.refresh([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);

      // And once THIS TTL lapses too, it retries.
      vi.advanceTimersByTime(NON_OWN_VERDICT_TTL_MS);
      await wo.refresh([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolveFor honours the TTL the same way — the gate path never trusts an expired non-own verdict', async () => {
    vi.useFakeTimers();
    try {
      mockPs('4321\n');
      const wo = new WriterOwnership();
      const proc = liveProcess({ pid: 1234 });
      await wo.resolveFor([proc]);
      expect(wo.getOwnerPid(1234)).toBe(4321);
      await wo.resolveFor([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(NON_OWN_VERDICT_TTL_MS + 1000);
      mockPs('1\n');
      await wo.resolveFor([proc]);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
      expect(wo.getOwnerPid(1234)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

  it('getOwnerPid returns the resolved parent pid for an external process', async () => {
    mockPs('4321\n');
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234 })]);
    expect(wo.getOwnerPid(1234)).toBe(4321);
  });

  it('getOwnerPid is undefined before resolution and after ps failure', async () => {
    const wo = new WriterOwnership();
    expect(wo.getOwnerPid(1234)).toBeUndefined();
    mockPsError();
    await wo.refresh([liveProcess({ pid: 1234 })]);
    expect(wo.getOwnerPid(1234)).toBeUndefined();
  });

  it('getOwnerPid re-resolves alongside the verdict on startedAt mismatch — pid reuse never serves a stale owner', async () => {
    mockPs('4321\n');
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234, startedAt: 1000 })]);
    expect(wo.getOwnerPid(1234)).toBe(4321);

    mockPs('8765\n');
    await wo.refresh([liveProcess({ pid: 1234, startedAt: 2000 })]);
    expect(wo.getOwnerPid(1234)).toBe(8765);
  });

  it('getOwnerPid drops with the entry when re-resolution after pid reuse fails', async () => {
    mockPs('4321\n');
    const wo = new WriterOwnership();
    await wo.refresh([liveProcess({ pid: 1234, startedAt: 1000 })]);
    mockPsError();
    await wo.refresh([liveProcess({ pid: 1234, startedAt: 2000 })]);
    expect(wo.getOwnerPid(1234)).toBeUndefined();
  });
});
