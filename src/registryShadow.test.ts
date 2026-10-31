import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Wraps fs.watch in a vi.fn() so the debounce test can drive the watcher
// listener directly under fake timers. `fs` is a sealed ES module namespace,
// so vi.spyOn(fs, 'watch') can't redefine it; the wrap has to happen at
// vi.mock() time. Every other export passes through unchanged, and watch
// itself stays real unless a test overrides it.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

import * as fs from 'fs';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import type { LiveProcess } from './processRegistry.js';
import type { SessionStatus } from './types.js';
import {
  deriveRegistryStatus, createRegistryShadow, watchRegistryDir,
  SHADOW_LONG_EPISODE_MS, type RegistryVerdict,
} from './registryShadow.js';

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ID8 = SID.slice(0, 8);

function proc(over: Partial<LiveProcess> = {}): LiveProcess {
  return {
    pid: 100, sessionId: SID, cwd: '/repo', startedAt: null, kind: 'interactive',
    entrypoint: 'claude-vscode', version: '2.1.286', status: null, waitingFor: null, statusUpdatedAt: null,
    ...over,
  };
}

describe('deriveRegistryStatus', () => {
  it('maps busy → running, idle → done, waiting → waiting', () => {
    expect(deriveRegistryStatus([proc({ status: 'busy' })], true)).toEqual({ status: 'running', raw: 'busy', waitingFor: null });
    expect(deriveRegistryStatus([proc({ status: 'idle' })], true)).toEqual({ status: 'done', raw: 'idle', waitingFor: null });
    expect(deriveRegistryStatus([proc({ status: 'waiting', waitingFor: 'input needed' })], true))
      .toEqual({ status: 'waiting', raw: 'waiting', waitingFor: 'input needed' });
  });

  it('no live entry on a clean scan → done (absent)', () => {
    expect(deriveRegistryStatus([], true)).toEqual({ status: 'done', raw: 'absent', waitingFor: null });
  });

  it('no live entry on a degraded scan → no verdict', () => {
    expect(deriveRegistryStatus([], false)).toBeNull();
  });

  it('takes the most urgent status across processes: waiting > busy > idle', () => {
    const v = deriveRegistryStatus([
      proc({ pid: 1, status: 'idle' }),
      proc({ pid: 2, status: 'waiting', waitingFor: 'permission prompt' }),
      proc({ pid: 3, status: 'busy' }),
    ], true);
    expect(v).toEqual({ status: 'waiting', raw: 'waiting', waitingFor: 'permission prompt' });
    expect(deriveRegistryStatus([proc({ pid: 1, status: 'idle' }), proc({ pid: 2, status: 'busy' })], true)?.raw).toBe('busy');
  });

  it('ignores status-less entries; all status-less → no verdict', () => {
    expect(deriveRegistryStatus([proc()], true)).toBeNull();
    expect(deriveRegistryStatus([proc({ pid: 1 }), proc({ pid: 2, status: 'idle' })], true)?.raw).toBe('idle');
  });

  it('drops a stray waitingFor when the winning status is not waiting', () => {
    expect(deriveRegistryStatus([proc({ status: 'busy', waitingFor: 'permission prompt' })], true)?.waitingFor).toBeNull();
  });
});

describe('createRegistryShadow', () => {
  const v = (status: SessionStatus, raw: RegistryVerdict['raw'], waitingFor: string | null = null): RegistryVerdict =>
    ({ status, raw, waitingFor });

  function run(shadow: ReturnType<typeof createRegistryShadow>, serac: SessionStatus, verdict: RegistryVerdict | null, now: number): string[] {
    return shadow.observe(new Map([[SID, serac]]), () => verdict, now);
  }

  it('logs nothing while the two agree', () => {
    const shadow = createRegistryShadow();
    expect(run(shadow, 'done', v('done', 'idle'), 0)).toEqual([]);
    expect(run(shadow, 'done', v('done', 'idle'), 1000)).toEqual([]);
  });

  it('logs a disagreement episode with its duration when it closes', () => {
    const shadow = createRegistryShadow();
    run(shadow, 'done', v('done', 'idle'), 0);
    const opened = run(shadow, 'done', v('running', 'busy'), 1000);
    expect(opened).toEqual([`[status] ${ID8} registry done(idle)→running(busy)`]);
    expect(run(shadow, 'done', v('running', 'busy'), 1300)).toEqual([]);
    expect(run(shadow, 'running', v('running', 'busy'), 1400))
      .toEqual([`[status] ${ID8} shadow serac=done registry=running(busy) for 0.4s`]);
  });

  it('logs registry running↔done transitions, not first sight', () => {
    const shadow = createRegistryShadow();
    expect(run(shadow, 'running', v('running', 'busy'), 0)).toEqual([]);
    expect(run(shadow, 'running', v('done', 'idle'), 100)).toContain(`[status] ${ID8} registry running(busy)→done(idle)`);
  });

  it('flags an episode once when it outlasts the long threshold', () => {
    const shadow = createRegistryShadow();
    run(shadow, 'done', v('running', 'busy'), 0);
    expect(run(shadow, 'done', v('running', 'busy'), SHADOW_LONG_EPISODE_MS - 1)).toEqual([]);
    expect(run(shadow, 'done', v('running', 'busy'), SHADOW_LONG_EPISODE_MS))
      .toEqual([`[status] ${ID8} shadow serac=done registry=running(busy) open 10.0s`]);
    expect(run(shadow, 'done', v('running', 'busy'), SHADOW_LONG_EPISODE_MS * 2)).toEqual([]);
  });

  it('closes an episode and opens a new one when the disagreement changes shape', () => {
    const shadow = createRegistryShadow();
    run(shadow, 'done', v('running', 'busy'), 0);
    const lines = run(shadow, 'waiting', v('running', 'busy'), 2000);
    expect(lines).toEqual([`[status] ${ID8} shadow serac=done registry=running(busy) for 2.0s (now serac=waiting registry=running)`]);
    expect(run(shadow, 'running', v('running', 'busy'), 2500))
      .toEqual([`[status] ${ID8} shadow serac=waiting registry=running(busy) for 0.5s`]);
  });

  it('carries waitingFor into the label', () => {
    const shadow = createRegistryShadow();
    run(shadow, 'running', v('waiting', 'waiting', 'permission prompt'), 0);
    expect(run(shadow, 'waiting', v('waiting', 'waiting', 'permission prompt'), 800))
      .toEqual([`[status] ${ID8} shadow serac=running registry=waiting(waiting: permission prompt) for 0.8s`]);
  });

  it('a null verdict leaves an open episode untouched', () => {
    const shadow = createRegistryShadow();
    run(shadow, 'running', v('done', 'absent'), 0);
    expect(run(shadow, 'done', null, 500)).toEqual([]);
    expect(run(shadow, 'running', v('done', 'absent'), 900)).toEqual([]);
    expect(run(shadow, 'done', v('done', 'absent'), 1200))
      .toEqual([`[status] ${ID8} shadow serac=running registry=done(absent) for 1.2s`]);
  });

  it('closes an open episode when Serac stops tracking the session', () => {
    const shadow = createRegistryShadow();
    run(shadow, 'running', v('done', 'absent'), 0);
    expect(shadow.observe(new Map(), () => null, 3000))
      .toEqual([`[status] ${ID8} shadow serac=running registry=done(absent) for 3.0s (untracked)`]);
    // Re-tracked later: first sight again, no stale transition line.
    expect(run(shadow, 'done', v('done', 'idle'), 4000)).toEqual([]);
  });
});

describe('watchRegistryDir', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regwatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null for a missing directory', () => {
    expect(watchRegistryDir(path.join(dir, 'nope'), () => {}, () => {})).toBeNull();
  });

  it('calls back on a real write to the directory', async () => {
    const onChange = vi.fn();
    const stop = watchRegistryDir(dir, onChange, () => {}, 20);
    expect(stop).not.toBeNull();
    // macOS starts the FSEvents stream asynchronously, so a write straight
    // after watch() can go unseen. Rewrite on each poll until one lands.
    await vi.waitFor(() => {
      fs.writeFileSync(path.join(dir, '123.json'), '{}');
      expect(onChange).toHaveBeenCalled();
    }, { timeout: 5000, interval: 100 });
    stop!();
  });

  describe('debounce (driven listener, fake timers)', () => {
    type Listener = (event: string, filename: string | null) => void;
    let fire: Listener;

    beforeEach(() => {
      vi.useFakeTimers();
      // macOS can deliver fs.watch events late under load, so a real-fs burst
      // can't pin an exact callback count. Drive the listener instead.
      vi.mocked(fs.watch).mockImplementationOnce(((_dir: unknown, _opts: unknown, listener: Listener) => {
        fire = listener;
        return Object.assign(new EventEmitter(), { close: vi.fn() });
      }) as unknown as typeof fs.watch);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('collapses a burst of events into one callback', () => {
      const onChange = vi.fn();
      const stop = watchRegistryDir(dir, onChange, () => {}, 50);
      for (let i = 0; i < 5; i++) {
        fire('change', '123.json');
        vi.advanceTimersByTime(40);
      }
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      expect(onChange).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(onChange).toHaveBeenCalledTimes(1);
      stop!();
    });

    it('ignores non-JSON files but not a missing filename', () => {
      const onChange = vi.fn();
      const stop = watchRegistryDir(dir, onChange, () => {}, 50);
      fire('rename', '123.json.tmp');
      vi.advanceTimersByTime(100);
      expect(onChange).not.toHaveBeenCalled();
      fire('rename', null);
      vi.advanceTimersByTime(50);
      expect(onChange).toHaveBeenCalledTimes(1);
      stop!();
    });
  });

  it('stops calling back once disposed', async () => {
    const onChange = vi.fn();
    const stop = watchRegistryDir(dir, onChange, () => {}, 20);
    stop!();
    fs.writeFileSync(path.join(dir, '123.json'), '{}');
    await new Promise(r => setTimeout(r, 120));
    expect(onChange).not.toHaveBeenCalled();
  });
});
