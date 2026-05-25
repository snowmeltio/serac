import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryAcquireLeader } from './leaderElection.js';

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'serac-leader-'));
}

describe('tryAcquireLeader', () => {
  let dir: string;
  beforeEach(() => { dir = mktemp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('first caller becomes leader and writes its pid', () => {
    const h = tryAcquireLeader(dir, { pid: 42, isAlive: () => true });
    expect(h.isLeader).toBe(true);
    const lockPath = path.join(dir, '.serac', 'hook.lock');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('42');
    h.dispose();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('second caller becomes follower when leader is alive', () => {
    const a = tryAcquireLeader(dir, { pid: 10, isAlive: () => true });
    const b = tryAcquireLeader(dir, { pid: 11, isAlive: () => true });
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);
    a.dispose();
  });

  it('reclaims a stale lock when previous pid is dead', () => {
    fs.mkdirSync(path.join(dir, '.serac'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.serac', 'hook.lock'), '99999');
    const h = tryAcquireLeader(dir, { pid: 42, isAlive: () => false });
    expect(h.isLeader).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.serac', 'hook.lock'), 'utf8')).toBe('42');
    h.dispose();
  });

  it('does not reclaim when previous pid is alive', () => {
    fs.mkdirSync(path.join(dir, '.serac'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.serac', 'hook.lock'), '12345');
    const h = tryAcquireLeader(dir, { pid: 42, isAlive: () => true });
    expect(h.isLeader).toBe(false);
  });

  it('treats malformed lock content as stale', () => {
    fs.mkdirSync(path.join(dir, '.serac'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.serac', 'hook.lock'), 'not-a-pid');
    const h = tryAcquireLeader(dir, { pid: 42, isAlive: () => true });
    expect(h.isLeader).toBe(true);
    h.dispose();
  });

  it('treats empty lock content as stale', () => {
    fs.mkdirSync(path.join(dir, '.serac'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.serac', 'hook.lock'), '');
    const h = tryAcquireLeader(dir, { pid: 42, isAlive: () => true });
    expect(h.isLeader).toBe(true);
    h.dispose();
  });

  it('dispose() is idempotent', () => {
    const h = tryAcquireLeader(dir, { pid: 42, isAlive: () => true });
    expect(h.isLeader).toBe(true);
    h.dispose();
    h.dispose();  // should not throw
    expect(fs.existsSync(path.join(dir, '.serac', 'hook.lock'))).toBe(false);
  });

  it('follower dispose() is a no-op (does not remove leader lock)', () => {
    const a = tryAcquireLeader(dir, { pid: 10, isAlive: () => true });
    const b = tryAcquireLeader(dir, { pid: 11, isAlive: () => true });
    expect(b.isLeader).toBe(false);
    b.dispose();
    expect(fs.existsSync(path.join(dir, '.serac', 'hook.lock'))).toBe(true);
    a.dispose();
  });

  it('creates .serac directory when missing', () => {
    expect(fs.existsSync(path.join(dir, '.serac'))).toBe(false);
    const h = tryAcquireLeader(dir, { pid: 42, isAlive: () => true });
    expect(h.isLeader).toBe(true);
    expect(fs.existsSync(path.join(dir, '.serac'))).toBe(true);
    h.dispose();
  });

  it('after leader dispose, a fresh caller becomes the new leader', () => {
    const a = tryAcquireLeader(dir, { pid: 10, isAlive: () => true });
    a.dispose();
    const b = tryAcquireLeader(dir, { pid: 11, isAlive: () => true });
    expect(b.isLeader).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.serac', 'hook.lock'), 'utf8')).toBe('11');
    b.dispose();
  });
});
