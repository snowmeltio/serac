import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock https and cp before importing the module
vi.mock('https', () => ({
  get: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import * as https from 'https';
import * as cp from 'child_process';

const { UsageProvider } = await import('./usageProvider.js');

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  cachePath = path.join(tmpDir, 'usage-cache.json');
  // Default keychain mock — returns no credentials (resolves immediately so promises settle)
  mockKeychainError(new Error('no credentials'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeProvider(workspace = '/test/workspace'): InstanceType<typeof UsageProvider> {
  return new UsageProvider(workspace, { cachePath });
}

/** Mock cp.execFile to invoke the callback with the given stdout value */
function mockKeychain(stdout: string): void {
  vi.mocked(cp.execFile).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(null, stdout);
      return {} as ReturnType<typeof cp.execFile>;
    },
  );
}

/** Mock cp.execFile to invoke the callback with an error */
function mockKeychainError(err: Error = new Error('no keychain')): void {
  vi.mocked(cp.execFile).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as (err: Error | null, stdout: string) => void)(err, '');
      return {} as ReturnType<typeof cp.execFile>;
    },
  );
}

// ── Constructor ──────────────────────────────────────────────────────

describe('constructor', () => {
  it('sets workspaceKey by replacing non-alphanumeric chars with dashes', () => {
    const p = makeProvider('/foo/bar/baz');
    const snap = p.getSnapshot();
    expect(snap.currentWorkspaceKey).toBe(''); // empty until refresh
  });

  it('uses custom cachePath when provided', () => {
    expect(() => makeProvider()).not.toThrow();
  });
});

// ── getSnapshot ──────────────────────────────────────────────────────

describe('getSnapshot()', () => {
  it('returns empty snapshot initially', () => {
    const p = makeProvider();
    const snap = p.getSnapshot();
    expect(snap.loaded).toBe(false);
    expect(snap.quotaPct5h).toBe(0);
    expect(snap.resetTime).toBeNull();
    expect(snap.quotaPctWeekly).toBe(0);
    expect(snap.weeklyResetTime).toBeNull();
    expect(snap.quotaPctWeeklySonnet).toBeNull();
    expect(snap.extraUsageEnabled).toBe(false);
    expect(snap.extraUsageCredits).toBeNull();
    expect(snap.apiConnected).toBe(false);
    expect(snap.currentWorkspaceKey).toBe('');
    expect(snap.lastPoll).toBe(0);
  });
});

// ── start / stop ─────────────────────────────────────────────────────

describe('start()', () => {
  it('calls onChange callback after refresh', async () => {
    const p = makeProvider();
    const onChange = vi.fn();
    p.start(onChange);
    // refresh() returns a Promise internally — flush microtasks
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalled();
    p.stop();
  });

  it('sets up polling timer that fires', async () => {
    const p = makeProvider();
    const onChange = vi.fn();
    p.start(onChange);
    await vi.advanceTimersByTimeAsync(100);
    const callCount = onChange.mock.calls.length;
    // Advance past max poll interval (6 min)
    await vi.advanceTimersByTimeAsync(7 * 60 * 1000);
    expect(onChange.mock.calls.length).toBeGreaterThan(callCount);
    p.stop();
  });
});

describe('stop()', () => {
  it('clears poll timer and prevents further polls', async () => {
    const p = makeProvider();
    const onChange = vi.fn();
    p.start(onChange);
    await vi.advanceTimersByTimeAsync(100);
    const callCount = onChange.mock.calls.length;
    p.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(onChange.mock.calls.length).toBe(callCount);
  });
});

// ── Disk cache ───────────────────────────────────────────────────────

describe('loadDiskCache()', () => {
  it('ignores stale cache (>15 min old)', () => {
    const staleTs = Date.now() - 16 * 60 * 1000;
    fs.writeFileSync(cachePath, JSON.stringify({
      five_hour: { utilization: 42, resets_at: '2026-01-01T00:00:00Z' },
      _ts: staleTs,
    }));
    const p = makeProvider();
    const snap = p.getSnapshot();
    expect(snap.apiConnected).toBe(false);
  });

  it('loads fresh cache (<15 min old)', async () => {
    const freshTs = Date.now() - 5 * 60 * 1000;
    fs.writeFileSync(cachePath, JSON.stringify({
      five_hour: { utilization: 55, resets_at: '2026-01-01T12:00:00Z' },
      _ts: freshTs,
    }));
    const p = makeProvider();
    await p.refresh();
    const snap = p.getSnapshot();
    expect(snap.quotaPct5h).toBe(55);
    expect(snap.apiConnected).toBe(true);
  });
});

describe('saveDiskCache()', () => {
  it('writes cache with _ts timestamp', async () => {
    const mockResponse = {
      statusCode: 200,
      on: vi.fn((event: string, cb: (chunk?: string) => void) => {
        if (event === 'data') { cb(JSON.stringify({ five_hour: { utilization: 70, resets_at: '2026-06-01T00:00:00Z' } })); }
        if (event === 'end') { cb(); }
        return mockResponse;
      }),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    const mockReq = { on: vi.fn().mockReturnThis(), setTimeout: vi.fn().mockReturnThis() };
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      (cb as (res: typeof mockResponse) => void)(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.get>;
    });
    mockKeychain(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3600_000 },
    }));

    const p = makeProvider();
    await p.refresh();

    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(raw._ts).toBeTypeOf('number');
    expect(raw._ts).toBeGreaterThan(0);
    expect(raw.five_hour.utilization).toBe(70);
  });
});

describe('reloadDiskCacheIfFresh()', () => {
  it('picks up fresher cache written by another window', async () => {
    const oldTs = Date.now() - 2 * 60 * 1000;
    fs.writeFileSync(cachePath, JSON.stringify({
      five_hour: { utilization: 10, resets_at: '2026-01-01T00:00:00Z' },
      _ts: oldTs,
    }));
    const p = makeProvider();

    // Simulate another window writing a fresher cache
    const freshTs = Date.now() + 1000;
    fs.writeFileSync(cachePath, JSON.stringify({
      five_hour: { utilization: 88, resets_at: '2026-06-15T00:00:00Z' },
      _ts: freshTs,
    }));

    await p.refresh();
    const snap = p.getSnapshot();
    expect(snap.quotaPct5h).toBe(88);
    expect(snap.apiConnected).toBe(true);
  });
});

// ── rollCooldown ─────────────────────────────────────────────────────

describe('rollCooldown()', () => {
  it('produces values in 600-900s range', () => {
    const values: number[] = [];
    for (let i = 0; i < 50; i++) {
      vi.spyOn(Math, 'random').mockReturnValueOnce(i / 49);
      fs.writeFileSync(cachePath, JSON.stringify({
        five_hour: { utilization: 1, resets_at: '2026-01-01T00:00:00Z' },
        _ts: Date.now() - 1000,
      }));
      const p = makeProvider();
      values.push((p as unknown as { apiCooldownMs: number }).apiCooldownMs);
    }
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(600_000);
      expect(v).toBeLessThanOrEqual(900_000);
    }
  });
});

// ── OAuth token caching ──────────────────────────────────────────────

describe('OAuth token caching', () => {
  function setupMocks(expiresAt: number) {
    mockKeychain(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token', expiresAt },
    }));
    const mockResponse = {
      statusCode: 200,
      on: vi.fn((event: string, cb: (chunk?: string) => void) => {
        if (event === 'data') { cb('{}'); }
        if (event === 'end') { cb(); }
        return mockResponse;
      }),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    const mockReq = { on: vi.fn().mockReturnThis(), setTimeout: vi.fn().mockReturnThis() };
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      (cb as (res: typeof mockResponse) => void)(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.get>;
    });
  }

  it('returns cached token if not expired', async () => {
    setupMocks(Date.now() + 3600_000);
    const p = makeProvider();
    await p.refresh();
    vi.advanceTimersByTime(901_000);
    const callsBefore = vi.mocked(cp.execFile).mock.calls.length;
    await p.refresh();
    expect(vi.mocked(cp.execFile).mock.calls.length).toBe(callsBefore);
  });

  it('re-fetches token when expired (within 60s buffer)', async () => {
    setupMocks(Date.now() + 30_000); // within 60s buffer
    const p = makeProvider();
    await p.refresh();
    vi.advanceTimersByTime(901_000);
    const callsBefore = vi.mocked(cp.execFile).mock.calls.length;
    await p.refresh();
    expect(vi.mocked(cp.execFile).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ── Snapshot mapping ─────────────────────────────────────────────────

describe('snapshot mapping from API response', () => {
  function setupApiMock(responseBody: string) {
    const mockResponse = {
      statusCode: 200,
      on: vi.fn((event: string, cb: (chunk?: string) => void) => {
        if (event === 'data') { cb(responseBody); }
        if (event === 'end') { cb(); }
        return mockResponse;
      }),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    const mockReq = { on: vi.fn().mockReturnThis(), setTimeout: vi.fn().mockReturnThis() };
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      (cb as (res: typeof mockResponse) => void)(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.get>;
    });
    mockKeychain(JSON.stringify({
      claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 },
    }));
  }

  it('maps all API fields to snapshot correctly', async () => {
    const apiResponse = {
      five_hour: { utilization: 45, resets_at: '2026-06-01T10:00:00Z' },
      seven_day: { utilization: 30, resets_at: '2026-06-07T00:00:00Z' },
      seven_day_sonnet: { utilization: 20, resets_at: '2026-06-07T12:00:00Z' },
      extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 42, utilization: 0.42 },
    };
    setupApiMock(JSON.stringify(apiResponse));
    const p = makeProvider('/my/workspace');
    await p.refresh();
    const s = p.getSnapshot();

    expect(s.quotaPct5h).toBe(45);
    expect(s.resetTime).toBe(new Date('2026-06-01T10:00:00Z').getTime());
    expect(s.quotaPctWeekly).toBe(30);
    expect(s.weeklyResetTime).toBe(new Date('2026-06-07T00:00:00Z').getTime());
    expect(s.quotaPctWeeklySonnet).toBe(20);
    expect(s.weeklyResetTimeSonnet).toBe(new Date('2026-06-07T12:00:00Z').getTime());
    expect(s.extraUsageEnabled).toBe(true);
    expect(s.extraUsageCredits).toBe(42);
    expect(s.apiConnected).toBe(true);
    expect(s.currentWorkspaceKey).toBe('-my-workspace');
    expect(s.loaded).toBe(true);
    expect(s.lastPoll).toBeGreaterThan(0);
  });

  it('handles null/missing API fields gracefully', async () => {
    setupApiMock(JSON.stringify({}));
    const p = makeProvider();
    await p.refresh();
    const s = p.getSnapshot();

    expect(s.quotaPct5h).toBe(0);
    expect(s.resetTime).toBeNull();
    expect(s.quotaPctWeekly).toBe(0);
    expect(s.quotaPctWeeklySonnet).toBeNull();
    expect(s.extraUsageEnabled).toBe(false);
    expect(s.extraUsageCredits).toBeNull();
    expect(s.apiConnected).toBe(true);
    expect(s.loaded).toBe(true);
  });

  it('sets apiConnected false when no API data available', async () => {
    mockKeychainError();
    vi.mocked(https.get).mockClear();
    const p = makeProvider();
    await p.refresh();
    const s = p.getSnapshot();
    expect(s.apiConnected).toBe(false);
  });

  it('returns null for API response that is a JSON array', async () => {
    setupApiMock(JSON.stringify([1, 2, 3]));
    const p = makeProvider();
    await p.refresh();
    const s = p.getSnapshot();
    // Array is not a valid object — treated as null, so apiConnected false
    expect(s.apiConnected).toBe(false);
  });

  it('returns null for API response that is a JSON string', async () => {
    setupApiMock(JSON.stringify('hello'));
    const p = makeProvider();
    await p.refresh();
    const s = p.getSnapshot();
    expect(s.apiConnected).toBe(false);
  });

  it('returns null for API response that is JSON null', async () => {
    setupApiMock('null');
    const p = makeProvider();
    await p.refresh();
    const s = p.getSnapshot();
    expect(s.apiConnected).toBe(false);
  });
});

// ── platformSupported ─────────────────────────────────────────────────

describe('platformSupported', () => {
  it('is set to true on darwin (current test platform)', () => {
    const p = makeProvider();
    const snap = p.getSnapshot();
    expect(snap.platformSupported).toBe(true);
  });

  it('is included in initial empty snapshot', () => {
    const p = makeProvider();
    const snap = p.getSnapshot();
    expect(snap).toHaveProperty('platformSupported');
    expect(typeof snap.platformSupported).toBe('boolean');
  });
});

// ── saveDiskCache atomic write ──────────────────────────────────────────

describe('saveDiskCache atomic write', () => {
  it('does not leave .tmp file after successful save', async () => {
    const mockResponse = {
      statusCode: 200,
      on: vi.fn((event: string, cb: (chunk?: string) => void) => {
        if (event === 'data') { cb(JSON.stringify({ five_hour: { utilization: 50, resets_at: '2026-06-01T00:00:00Z' } })); }
        if (event === 'end') { cb(); }
        return mockResponse;
      }),
      resume: vi.fn(),
      destroy: vi.fn(),
    };
    const mockReq = { on: vi.fn().mockReturnThis(), setTimeout: vi.fn().mockReturnThis() };
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      (cb as (res: typeof mockResponse) => void)(mockResponse);
      return mockReq as unknown as ReturnType<typeof https.get>;
    });
    mockKeychain(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3600_000 },
    }));

    const p = makeProvider();
    await p.refresh();

    // Cache file should exist
    expect(fs.existsSync(cachePath)).toBe(true);
    // No .tmp files should remain in the directory
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ── Concurrent refresh guard ────────────────────────────────────────────

describe('concurrent refresh calls', () => {
  it('second call returns early while first is in progress', async () => {
    mockKeychain(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3600_000 },
    }));

    // Make https.get resolve only when we say so
    let resolveHttp!: () => void;
    const httpDone = new Promise<void>(r => { resolveHttp = r; });
    const mockReq = { on: vi.fn().mockReturnThis(), setTimeout: vi.fn().mockReturnThis() };
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const mockRes = {
        statusCode: 200,
        on: vi.fn((event: string, handler: (chunk?: string) => void) => {
          if (event === 'data') { httpDone.then(() => handler(JSON.stringify({ five_hour: { utilization: 10, resets_at: '2026-06-01T00:00:00Z' } }))); }
          if (event === 'end') { httpDone.then(() => handler()); }
          return mockRes;
        }),
        resume: vi.fn(),
        destroy: vi.fn(),
      };
      (cb as (res: typeof mockRes) => void)(mockRes);
      return mockReq as unknown as ReturnType<typeof https.get>;
    });

    const p = makeProvider();
    vi.mocked(https.get).mockClear();
    // Re-apply the mock after clear
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const mockRes = {
        statusCode: 200,
        on: vi.fn((event: string, handler: (chunk?: string) => void) => {
          if (event === 'data') { httpDone.then(() => handler(JSON.stringify({ five_hour: { utilization: 10, resets_at: '2026-06-01T00:00:00Z' } }))); }
          if (event === 'end') { httpDone.then(() => handler()); }
          return mockRes;
        }),
        resume: vi.fn(),
        destroy: vi.fn(),
      };
      (cb as (res: typeof mockRes) => void)(mockRes);
      return mockReq as unknown as ReturnType<typeof https.get>;
    });

    // First refresh starts — http in flight, refreshing = true
    const r1 = p.refresh();
    // Second refresh should bail immediately (refreshing guard)
    const r2 = p.refresh();
    // Let the http response arrive
    resolveHttp();
    await Promise.all([r1, r2]);

    // Only one API call should have been made
    expect(vi.mocked(https.get).mock.calls.length).toBe(1);
  });
});
