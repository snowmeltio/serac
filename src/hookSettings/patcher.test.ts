import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyForwarderPatch,
  removeForwarderPatch,
  HOOK_EVENTS,
  SENTINEL_KEY,
} from './patcher.js';

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'serac-patcher-'));
}

function readSettings(workspaceDir: string): any {
  const p = path.join(workspaceDir, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeSettings(workspaceDir: string, value: any): void {
  const dir = path.join(workspaceDir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(value, null, 2));
}

const FORWARDER = '/abs/path/to/serac-hook-forward.cjs';

describe('applyForwarderPatch', () => {
  let ws: string;
  beforeEach(() => { ws = mktemp(); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('creates settings.json with managed entries for every hook event', () => {
    const result = applyForwarderPatch(ws, FORWARDER);
    expect(result.changed).toBe(true);
    const s = readSettings(ws);
    for (const event of HOOK_EVENTS) {
      expect(s.hooks[event]).toHaveLength(1);
      expect(s.hooks[event][0][SENTINEL_KEY]).toBe(true);
      expect(s.hooks[event][0].matcher).toBe('*');
      expect(s.hooks[event][0].hooks[0].command).toBe(FORWARDER);
      expect(s.hooks[event][0].hooks[0].timeout).toBe(5);
    }
  });

  it('preserves unrelated top-level settings', () => {
    writeSettings(ws, { env: { FOO: 'bar' }, model: 'sonnet' });
    applyForwarderPatch(ws, FORWARDER);
    const s = readSettings(ws);
    expect(s.env).toEqual({ FOO: 'bar' });
    expect(s.model).toBe('sonnet');
    expect(s.hooks).toBeDefined();
  });

  it('preserves user-authored hook entries alongside ours', () => {
    const userHook = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/user/script.sh', timeout: 10 }],
    };
    writeSettings(ws, { hooks: { PreToolUse: [userHook] } });
    applyForwarderPatch(ws, FORWARDER);
    const s = readSettings(ws);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0]).toEqual(userHook);
    expect(s.hooks.PreToolUse[1][SENTINEL_KEY]).toBe(true);
  });

  it('is idempotent — second call reports changed=false', () => {
    const first = applyForwarderPatch(ws, FORWARDER);
    const second = applyForwarderPatch(ws, FORWARDER);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it('refreshes managed entries when the forwarder path changes', () => {
    applyForwarderPatch(ws, '/old/path/forwarder.cjs');
    const result = applyForwarderPatch(ws, FORWARDER);
    expect(result.changed).toBe(true);
    const s = readSettings(ws);
    for (const event of HOOK_EVENTS) {
      // No duplicates: exactly one managed entry per event.
      const managed = s.hooks[event].filter((e: any) => e[SENTINEL_KEY] === true);
      expect(managed).toHaveLength(1);
      expect(managed[0].hooks[0].command).toBe(FORWARDER);
    }
  });

  it('rejects relative forwarder paths', () => {
    expect(() => applyForwarderPatch(ws, 'relative/path.cjs')).toThrow(/absolute/);
  });

  it('throws on malformed existing settings.json (preserves the file)', () => {
    const dir = path.join(ws, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
    expect(() => applyForwarderPatch(ws, FORWARDER)).toThrow();
    // File must be untouched after the throw.
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{ not json');
  });
});

describe('removeForwarderPatch', () => {
  let ws: string;
  beforeEach(() => { ws = mktemp(); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('removes managed entries and leaves user entries', () => {
    const userHook = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/user/script.sh', timeout: 10 }],
    };
    writeSettings(ws, { hooks: { PreToolUse: [userHook] } });
    applyForwarderPatch(ws, FORWARDER);
    removeForwarderPatch(ws);
    const s = readSettings(ws);
    expect(s.hooks.PreToolUse).toEqual([userHook]);
    // Other events that had no user entries should be gone entirely.
    expect(s.hooks.PostToolUse).toBeUndefined();
  });

  it('deletes the file when removal leaves it semantically empty', () => {
    applyForwarderPatch(ws, FORWARDER);
    const result = removeForwarderPatch(ws);
    expect(result.changed).toBe(true);
    expect(fs.existsSync(path.join(ws, '.claude', 'settings.json'))).toBe(false);
  });

  it('cleans up .claude directory when settings.json was the only file', () => {
    applyForwarderPatch(ws, FORWARDER);
    removeForwarderPatch(ws);
    expect(fs.existsSync(path.join(ws, '.claude'))).toBe(false);
  });

  it('leaves .claude directory when it contains other files', () => {
    applyForwarderPatch(ws, FORWARDER);
    fs.writeFileSync(path.join(ws, '.claude', 'commands.md'), '# stuff');
    removeForwarderPatch(ws);
    expect(fs.existsSync(path.join(ws, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.claude', 'commands.md'))).toBe(true);
  });

  it('preserves non-hook top-level settings on removal', () => {
    writeSettings(ws, { env: { FOO: 'bar' } });
    applyForwarderPatch(ws, FORWARDER);
    removeForwarderPatch(ws);
    const s = readSettings(ws);
    expect(s).toEqual({ env: { FOO: 'bar' } });
  });

  it('is a no-op when settings.json does not exist', () => {
    const result = removeForwarderPatch(ws);
    expect(result.changed).toBe(false);
  });

  it('is a no-op when settings.json has no managed entries', () => {
    writeSettings(ws, { env: { FOO: 'bar' } });
    const result = removeForwarderPatch(ws);
    expect(result.changed).toBe(false);
    expect(readSettings(ws)).toEqual({ env: { FOO: 'bar' } });
  });

  it('round-trip: apply then remove returns to original semantics', () => {
    const original = { env: { FOO: 'bar' }, hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/u', timeout: 10 }] }],
    } };
    writeSettings(ws, original);
    applyForwarderPatch(ws, FORWARDER);
    removeForwarderPatch(ws);
    const after = readSettings(ws);
    expect(after).toEqual(original);
  });
});
