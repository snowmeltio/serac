import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProcessRegistry } from './processRegistry.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };

// process.pid is guaranteed alive during the test; a pid this high is never
// assigned on any real OS, so kill(pid, 0) throws ESRCH → "dead".
const LIVE_PID = process.pid;
const DEAD_PID = 2_147_483_647;
const SID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

let dir: string;

function writeEntry(file: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(body), 'utf-8');
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: LIVE_PID,
    sessionId: SID,
    cwd: '/repo/x',
    startedAt: 1780000000000,
    kind: 'interactive',
    entrypoint: 'claude-vscode',
    version: '2.1.161',
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preg-'));
  log.warn.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProcessRegistry', () => {
  it('keeps a live process and drops a stale (dead-pid) file', async () => {
    writeEntry(`${LIVE_PID}.json`, entry({ pid: LIVE_PID, sessionId: 'live-1111', cwd: '/live' }));
    writeEntry(`${DEAD_PID}.json`, entry({ pid: DEAD_PID, sessionId: 'dead-2222', cwd: '/dead' }));
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();

    expect(reg.getLiveProcesses()).toHaveLength(1);
    expect(reg.getLiveProcesses()[0].sessionId).toBe('live-1111');
    expect(reg.isSessionLive('live-1111')).toBe(true);
    expect(reg.isSessionLive('dead-2222')).toBe(false);
  });

  it('returns empty when the sessions dir does not exist', async () => {
    const reg = new ProcessRegistry(path.join(dir, 'nope'), log);
    await reg.scan();
    expect(reg.getLiveProcesses()).toHaveLength(0);
    expect(reg.isSessionLive(SID)).toBe(false);
  });

  it('parses the full record shape and tolerates missing optional fields', async () => {
    writeEntry('full.json', entry({ sessionId: 'full-1111', cwd: '/full' }));
    writeEntry('min.json', { pid: LIVE_PID, sessionId: 'min-2222', cwd: '/min' });
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();

    const full = reg.getProcessForSession('full-1111')!;
    expect(full).toMatchObject({ pid: LIVE_PID, cwd: '/full', kind: 'interactive', entrypoint: 'claude-vscode', version: '2.1.161', startedAt: 1780000000000 });
    const min = reg.getProcessForSession('min-2222')!;
    expect(min).toMatchObject({ kind: null, entrypoint: null, version: null, startedAt: null });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips malformed JSON and structurally-invalid entries (and warns)', async () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf-8');
    // All three below carry a LIVE pid, so the ONLY reason to exclude them is
    // validation — proving the guard, not the liveness probe.
    writeEntry('nonint.json', entry({ pid: 'x', sessionId: 'a-3333' }));
    writeEntry('traversal.json', entry({ sessionId: '../etc/passwd', cwd: '/x' }));
    writeEntry('nocwd.json', { pid: LIVE_PID, sessionId: 'b-4444' });
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();

    expect(reg.getLiveProcesses()).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('non-.json files are ignored', async () => {
    fs.writeFileSync(path.join(dir, 'README.txt'), 'hi', 'utf-8');
    writeEntry(`${LIVE_PID}.json`, entry({ sessionId: 'keep-1111' }));
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.getLiveProcesses().map(p => p.sessionId)).toEqual(['keep-1111']);
  });

  it('dedupes a session id backed by more than one live entry', async () => {
    writeEntry('one.json', entry({ sessionId: 'shared-1111', cwd: '/a' }));
    writeEntry('two.json', entry({ sessionId: 'shared-1111', cwd: '/b' }));
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    // Both live entries are retained, but the session id resolves once.
    expect(reg.getLiveProcesses()).toHaveLength(2);
    expect(reg.isSessionLive('shared-1111')).toBe(true);
    expect(reg.getProcessForSession('shared-1111')).not.toBeNull();
  });

  it('isCwdLive reflects a live process rooted at a cwd', async () => {
    writeEntry(`${LIVE_PID}.json`, entry({ cwd: '/repos/serac' }));
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.isCwdLive('/repos/serac')).toBe(true);
    expect(reg.isCwdLive('/repos/other')).toBe(false);
  });

  it('getProcessForSession returns null for an unknown session', async () => {
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.getProcessForSession('nope-0000')).toBeNull();
  });

  it('shouldRescan throttles to every 4th cycle', () => {
    const reg = new ProcessRegistry(dir, log);
    expect([reg.shouldRescan(), reg.shouldRescan(), reg.shouldRescan(), reg.shouldRescan()])
      .toEqual([false, false, false, true]);
    // Counter resets after firing.
    expect([reg.shouldRescan(), reg.shouldRescan(), reg.shouldRescan(), reg.shouldRescan()])
      .toEqual([false, false, false, true]);
  });

  it('isActive reflects whether any live entry was found', async () => {
    const empty = new ProcessRegistry(path.join(dir, 'nope'), log);
    await empty.scan();
    expect(empty.isActive()).toBe(false);

    // A dir with only a stale (dead-pid) file is still inactive.
    writeEntry(`${DEAD_PID}.json`, entry({ pid: DEAD_PID, sessionId: 'dead-2222' }));
    const stale = new ProcessRegistry(dir, log);
    await stale.scan();
    expect(stale.isActive()).toBe(false);

    // One live entry flips it active.
    writeEntry(`${LIVE_PID}.json`, entry({ sessionId: 'live-1111' }));
    const active = new ProcessRegistry(dir, log);
    await active.scan();
    expect(active.isActive()).toBe(true);
  });

  it('a clean scan (all present files readable) is marked clean', async () => {
    writeEntry(`${LIVE_PID}.json`, entry({ sessionId: 'live-1111' }));
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.isScanClean()).toBe(true);
  });

  it('an absent registry dir is a clean (empty) observation', async () => {
    const reg = new ProcessRegistry(path.join(dir, 'nope'), log);
    await reg.scan();
    expect(reg.isScanClean()).toBe(true);
    expect(reg.isActive()).toBe(false);
  });

  it('a present-but-unreadable file (non-ENOENT) degrades the scan without disabling it', async () => {
    writeEntry(`${LIVE_PID}.json`, entry({ sessionId: 'live-1111' }));
    // A directory named like a registry file → readFile throws EISDIR: a present
    // entry we could not read, standing in for a transient EIO/EMFILE/EACCES.
    fs.mkdirSync(path.join(dir, '99999.json'));
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.isActive()).toBe(true);     // the live entry still read fine
    expect(reg.isScanClean()).toBe(false); // but absence is now untrustworthy
  });

  it('an unparseable file (possible partial write of a live session) degrades the scan', async () => {
    writeEntry(`${LIVE_PID}.json`, entry({ sessionId: 'live-1111' }));
    fs.writeFileSync(path.join(dir, '424242.json'), '{ partial write', 'utf-8');
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.isActive()).toBe(true);
    expect(reg.isScanClean()).toBe(false);
  });

  it('a parseable-but-structurally-invalid entry does NOT degrade the scan', async () => {
    writeEntry(`${LIVE_PID}.json`, entry({ sessionId: 'live-1111' }));
    writeEntry('stray.json', { not: 'a registry entry' }); // valid JSON, no pid
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.isActive()).toBe(true);
    expect(reg.isScanClean()).toBe(true);  // a stray/corrupt file ≠ unread live session
    expect(log.warn).toHaveBeenCalled();
  });

  it('dispose clears cached state', async () => {
    writeEntry(`${LIVE_PID}.json`, entry({ sessionId: 'live-9999' }));
    const reg = new ProcessRegistry(dir, log);
    await reg.scan();
    expect(reg.isSessionLive('live-9999')).toBe(true);
    reg.dispose();
    expect(reg.getLiveProcesses()).toHaveLength(0);
    expect(reg.isSessionLive('live-9999')).toBe(false);
  });
});
