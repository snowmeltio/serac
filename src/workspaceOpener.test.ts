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
