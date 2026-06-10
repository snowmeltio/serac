import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readMcpNeedsAuth, readIdeOpenFolders } from './claudeEnvSignals.js';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-signals-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('readMcpNeedsAuth', () => {
  const FILE = () => path.join(stateDir, 'mcp-needs-auth-cache.json');
  const NOW = 1_780_000_000_000;

  it('returns fresh entries newest-first, named as on disk', () => {
    fs.writeFileSync(FILE(), JSON.stringify({
      'claude.ai Webflow': { timestamp: NOW - 60_000, id: 'mcpsrv_1' },
      'claude.ai Google Drive': { timestamp: NOW - 5_000, id: 'mcpsrv_2' },
    }));
    expect(readMcpNeedsAuth(stateDir, NOW).map(e => e.name))
      .toEqual(['claude.ai Google Drive', 'claude.ai Webflow']);
  });

  it('filters stale (>24h) and future-dated entries', () => {
    fs.writeFileSync(FILE(), JSON.stringify({
      old: { timestamp: NOW - 25 * 60 * 60 * 1000 },
      future: { timestamp: NOW + 10 * 60_000 },
      fresh: { timestamp: NOW - 1000 },
    }));
    expect(readMcpNeedsAuth(stateDir, NOW).map(e => e.name)).toEqual(['fresh']);
  });

  it('is empty on a missing, malformed, or wrong-shape file', () => {
    expect(readMcpNeedsAuth(stateDir, NOW)).toEqual([]);
    fs.writeFileSync(FILE(), 'not json');
    expect(readMcpNeedsAuth(stateDir, NOW)).toEqual([]);
    fs.writeFileSync(FILE(), JSON.stringify([1, 2]));
    expect(readMcpNeedsAuth(stateDir, NOW)).toEqual([]);
    fs.writeFileSync(FILE(), JSON.stringify({ bad: { timestamp: 'soon' }, worse: 7 }));
    expect(readMcpNeedsAuth(stateDir, NOW)).toEqual([]);
  });

  it('refuses an implausibly large cache file', () => {
    fs.writeFileSync(FILE(), '{"pad":"' + 'x'.repeat(300 * 1024) + '"}');
    expect(readMcpNeedsAuth(stateDir, NOW)).toEqual([]);
  });
});

describe('readIdeOpenFolders', () => {
  const ideDir = () => path.join(stateDir, 'ide');
  function writeLock(name: string, body: unknown): void {
    fs.mkdirSync(ideDir(), { recursive: true });
    fs.writeFileSync(path.join(ideDir(), name), JSON.stringify(body));
  }

  it('returns folders from a lock whose pid is alive; never the auth token', () => {
    writeLock('1234.lock', {
      pid: process.pid, workspaceFolders: ['/repo/a', '/repo/b'],
      ideName: 'Visual Studio Code', authToken: 'SECRET-DO-NOT-SURFACE',
    });
    const folders = readIdeOpenFolders(stateDir);
    expect([...folders].sort()).toEqual(['/repo/a', '/repo/b']);
    expect(JSON.stringify([...folders])).not.toContain('SECRET');
  });

  it('skips a stale lock (pid no longer running)', () => {
    // PID near the macOS max (99998) — vanishingly unlikely to be alive.
    writeLock('9999.lock', { pid: 99998, workspaceFolders: ['/repo/dead'] });
    expect(readIdeOpenFolders(stateDir).size).toBe(0);
  });

  it('skips malformed locks and non-absolute folders, keeps good ones', () => {
    writeLock('1.lock', 'not an object');
    writeLock('2.lock', { pid: 'x', workspaceFolders: ['/r'] });
    writeLock('3.lock', { pid: process.pid, workspaceFolders: ['relative/path', 17, '/repo/ok'] });
    expect([...readIdeOpenFolders(stateDir)]).toEqual(['/repo/ok']);
  });

  it('is empty when the ide dir does not exist', () => {
    expect(readIdeOpenFolders(stateDir).size).toBe(0);
  });
});
