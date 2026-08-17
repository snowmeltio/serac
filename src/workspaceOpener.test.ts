import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import { window, commands } from './__mocks__/vscode.js';
import {
  openWorkspaceFolder, focusHintPath, writeFocusHint, consumeFocusHint, FOCUS_HINT_TTL_MS,
  addressedFocusHintPath, writeAddressedFocusHint, sweepStaleAddressedHints,
  deriveUserDataDir, buildCliArgs,
} from './workspaceOpener.js';

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wso-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('focus hints — write / consume round-trip', () => {
  it('round-trips a hint and deletes it on read (single consumption)', async () => {
    await writeFocusHint(tmpDir, 'ws-key', 'sess-123');
    const hintPath = focusHintPath(tmpDir, 'ws-key');
    const hint = await consumeFocusHint(hintPath);
    expect(hint?.sessionId).toBe('sess-123');
    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(hintPath)).toBe(false);          // consumed
    expect(await consumeFocusHint(hintPath)).toBeNull();  // second read empty
  });

  it('creates the workspace directory if missing', async () => {
    await writeFocusHint(path.join(tmpDir, 'deep'), 'new-key', 's1');
    expect(fs.existsSync(focusHintPath(path.join(tmpDir, 'deep'), 'new-key'))).toBe(true);
  });

  it('a stale hint (past TTL) is rejected AND deleted — crashed-run hints never auto-fire', async () => {
    const hintPath = focusHintPath(tmpDir, 'k');
    fs.mkdirSync(path.dirname(hintPath), { recursive: true });
    fs.writeFileSync(hintPath, JSON.stringify({ sessionId: 's', requestedAt: Date.now() - FOCUS_HINT_TTL_MS - 1000 }));
    expect(await consumeFocusHint(hintPath)).toBeNull();
    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(hintPath)).toBe(false);
  });

  it('malformed or wrong-shape hints are rejected and deleted', async () => {
    const hintPath = focusHintPath(tmpDir, 'k');
    fs.mkdirSync(path.dirname(hintPath), { recursive: true });
    for (const body of ['not json', '{"sessionId":42,"requestedAt":1}', '{"requestedAt":1}']) {
      fs.writeFileSync(hintPath, body);
      expect(await consumeFocusHint(hintPath)).toBeNull();
      // The delete is deliberately fire-and-forget (best effort) — give the
      // unlink promise a tick to settle before asserting it happened.
      await new Promise(r => setTimeout(r, 20));
      expect(fs.existsSync(hintPath)).toBe(false);
    }
  });

  it('absent hint file is a quiet null', async () => {
    expect(await consumeFocusHint(path.join(tmpDir, 'nope', 'focus-hint.json'))).toBeNull();
  });
});

describe('addressed focus hints — the cross-window handoff', () => {
  it('names the file by target pid, distinct from the legacy basename', () => {
    expect(addressedFocusHintPath(tmpDir, 'ws-key', 4321))
      .toBe(path.join(tmpDir, 'ws-key', 'focus-hint-4321.json'));
    expect(path.basename(addressedFocusHintPath(tmpDir, 'ws-key', 4321)))
      .not.toBe(path.basename(focusHintPath(tmpDir, 'ws-key')));
  });

  it('round-trips through the same consumeFocusHint the receiver uses, deleting on read', async () => {
    await writeAddressedFocusHint(tmpDir, 'ws-key', 4321, 'sess-abc');
    const hintPath = addressedFocusHintPath(tmpDir, 'ws-key', 4321);
    const hint = await consumeFocusHint(hintPath);
    expect(hint?.sessionId).toBe('sess-abc');
    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(hintPath)).toBe(false);
  });

  it('an addressed hint past the TTL is rejected on consume like a legacy one', async () => {
    const hintPath = addressedFocusHintPath(tmpDir, 'k', 4321);
    fs.mkdirSync(path.dirname(hintPath), { recursive: true });
    fs.writeFileSync(hintPath, JSON.stringify({ sessionId: 's', requestedAt: Date.now() - FOCUS_HINT_TTL_MS - 1000 }));
    expect(await consumeFocusHint(hintPath)).toBeNull();
  });
});

describe('sweepStaleAddressedHints — GC for unconsumed hints', () => {
  it('removes a hint addressed to a dead pid', async () => {
    // Spawn-and-reap a real child so the pid is known-dead (not a guess that
    // could collide with a live process).
    const { spawnSync } = await import('node:child_process');
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeAddressedFocusHint(tmpDir, 'k', deadPid, 's1');
    await sweepStaleAddressedHints(tmpDir, 'k');
    expect(fs.existsSync(addressedFocusHintPath(tmpDir, 'k', deadPid))).toBe(false);
  });

  it('keeps a fresh hint addressed to a live pid (our own)', async () => {
    await writeAddressedFocusHint(tmpDir, 'k', process.pid, 's1');
    await sweepStaleAddressedHints(tmpDir, 'k');
    expect(fs.existsSync(addressedFocusHintPath(tmpDir, 'k', process.pid))).toBe(true);
  });

  it('removes a hint addressed to a live pid once its mtime is past the TTL', async () => {
    await writeAddressedFocusHint(tmpDir, 'k', process.pid, 's1');
    const hintPath = addressedFocusHintPath(tmpDir, 'k', process.pid);
    const old = new Date(Date.now() - FOCUS_HINT_TTL_MS - 60_000);
    fs.utimesSync(hintPath, old, old);
    await sweepStaleAddressedHints(tmpDir, 'k');
    expect(fs.existsSync(hintPath)).toBe(false);
  });

  it('never touches the legacy focus-hint.json', async () => {
    await writeFocusHint(tmpDir, 'k', 'legacy-sess');
    const legacyPath = focusHintPath(tmpDir, 'k');
    const old = new Date(Date.now() - FOCUS_HINT_TTL_MS - 60_000);
    fs.utimesSync(legacyPath, old, old); // even stale, not this sweep's business
    await sweepStaleAddressedHints(tmpDir, 'k');
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('is a quiet no-op on a missing workspace dir', async () => {
    await expect(sweepStaleAddressedHints(tmpDir, 'no-such-key')).resolves.toBeUndefined();
  });
});

describe('deriveUserDataDir', () => {
  it('derives three-up from a standard macOS globalStorage path (spaces intact)', () => {
    expect(deriveUserDataDir('/Users/m/Library/Application Support/Code-overwatch/User/globalStorage/snowmeltio.serac-claude-code'))
      .toBe('/Users/m/Library/Application Support/Code-overwatch');
  });

  it('derives from a standard Linux path', () => {
    expect(deriveUserDataDir('/home/m/.config/Code/User/globalStorage/snowmeltio.serac-claude-code'))
      .toBe('/home/m/.config/Code');
  });

  it('returns null for a layout that does not match User/globalStorage — never target a guessed instance', () => {
    expect(deriveUserDataDir('/some/portable/mode/storage/snowmeltio.serac')).toBeNull();
    expect(deriveUserDataDir('/User/globalStorage')).toBeNull();
  });
});

describe('buildCliArgs', () => {
  it('is just the folder without a user-data dir', () => {
    expect(buildCliArgs('/repo/x')).toEqual(['/repo/x']);
  });

  it('prepends --user-data-dir as separate argv entries — spaces survive without quoting', () => {
    expect(buildCliArgs('/repo/x', '/Users/m/Library/Application Support/Code-overwatch'))
      .toEqual(['--user-data-dir', '/Users/m/Library/Application Support/Code-overwatch', '/repo/x']);
  });
});

describe('openWorkspaceFolder — refusal and fallback paths', () => {
  it('refuses a non-existent folder with a warning (no phantom window)', async () => {
    await openWorkspaceFolder(path.join(tmpDir, 'gone'));
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('no longer exists'));
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('refuses a file path (not a directory)', async () => {
    const f = path.join(tmpDir, 'a-file');
    fs.writeFileSync(f, 'x');
    await openWorkspaceFolder(f);
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('is not a directory'));
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });

  it('falls back to vscode.openFolder when no editor CLI can be located', async () => {
    // Under vitest, process.execPath is the node binary — locateCli() finds no
    // bundled code/cursor CLI next to it, so the command fallback must fire.
    await openWorkspaceFolder(tmpDir);
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder', expect.anything(), { forceNewWindow: true });
  });
});
