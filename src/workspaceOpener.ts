/**
 * Open another VS Code workspace from inside Serac.
 *
 * Two responsibilities:
 *
 *  1. openWorkspaceFolder(cwd) — focus an existing window for the same folder if
 *     one is open, otherwise launch a new one. Uses the bundled `code`/`cursor`
 *     CLI (which talks to the running app via IPC and is the only path that
 *     gets the focus-existing behaviour). Falls back to vscode.openFolder with
 *     forceNewWindow: true if the CLI can't be located.
 *
 *  2. writeFocusHint / readPendingFocusHint — leave a tiny JSON file under the
 *     foreign workspace's projects directory so its Serac instance can pick up
 *     a "focus this session" request once the window opens. Hints expire after
 *     FOCUS_HINT_TTL_MS so a stale file from a crashed run never auto-fires.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';

/** Hints older than this are ignored on read (and deleted). */
export const FOCUS_HINT_TTL_MS = 60_000;

export interface FocusHint {
  sessionId: string;
  requestedAt: number;
}

/** Locate the `code`/`cursor` CLI shipped with the running editor.
 *  Derived from process.execPath so it works for VS Code, Cursor, Windsurf, etc. */
function locateCli(): string | null {
  try {
    const execDir = path.dirname(process.execPath);
    const candidates: string[] = [];
    if (process.platform === 'darwin') {
      // /Applications/<App>.app/Contents/MacOS/Electron → ../Resources/app/bin/code
      candidates.push(path.join(execDir, '..', 'Resources', 'app', 'bin', 'code'));
      candidates.push(path.join(execDir, '..', 'Resources', 'app', 'bin', 'cursor'));
    } else if (process.platform === 'win32') {
      candidates.push(path.join(execDir, 'bin', 'code.cmd'));
      candidates.push(path.join(execDir, 'bin', 'cursor.cmd'));
    } else {
      candidates.push(path.join(execDir, 'bin', 'code'));
      candidates.push(path.join(execDir, 'bin', 'cursor'));
    }
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile()) { return c; }
      } catch { /* try next */ }
    }
  } catch { /* fall through */ }
  return null;
}

/** Open a folder in VS Code, focusing an existing matching window where possible. */
export async function openWorkspaceFolder(cwd: string): Promise<void> {
  // Sanity: the folder must exist. Refuse to silently open a phantom folder.
  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) {
      vscode.window.showWarningMessage(`Cannot open workspace: ${cwd} is not a directory.`);
      return;
    }
  } catch {
    vscode.window.showWarningMessage(`Cannot open workspace: ${cwd} no longer exists.`);
    return;
  }

  const cli = locateCli();
  if (cli) {
    const launched = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn(cli, [cwd], { detached: true, stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.unref();
        // Spawn errors fire asynchronously; assume success after a short grace period.
        setTimeout(() => resolve(true), 200);
      } catch {
        resolve(false);
      }
    });
    if (launched) { return; }
  }

  // Fallback: opens a new window every time (no focus-existing behaviour).
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(cwd),
    { forceNewWindow: true },
  );
}

/** Path to the focus-hint file for a given workspace key. */
export function focusHintPath(projectsDir: string, workspaceKey: string): string {
  return path.join(projectsDir, workspaceKey, 'focus-hint.json');
}

/** Drop a focus hint into the foreign workspace's projects directory. */
export async function writeFocusHint(
  projectsDir: string,
  workspaceKey: string,
  sessionId: string,
): Promise<void> {
  const hintPath = focusHintPath(projectsDir, workspaceKey);
  const dir = path.dirname(hintPath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch { /* directory may already exist */ }
  const hint: FocusHint = { sessionId, requestedAt: Date.now() };
  await fs.promises.writeFile(hintPath, JSON.stringify(hint), 'utf-8');
}

/** Read and consume (delete) a focus-hint file. Returns null if absent or stale. */
export async function consumeFocusHint(hintPath: string): Promise<FocusHint | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(hintPath, 'utf-8');
  } catch {
    return null;
  }
  // Always delete — even invalid/stale hints shouldn't linger
  fs.promises.unlink(hintPath).catch(() => { /* best effort */ });
  try {
    const parsed = JSON.parse(raw) as FocusHint;
    if (typeof parsed?.sessionId !== 'string' || typeof parsed?.requestedAt !== 'number') {
      return null;
    }
    if (Date.now() - parsed.requestedAt > FOCUS_HINT_TTL_MS) { return null; }
    return parsed;
  } catch {
    return null;
  }
}
