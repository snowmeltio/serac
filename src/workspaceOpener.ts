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
 *
 *  3. Addressed hints (focus-hint-<pid>.json) — the cross-window handoff for a
 *     session another window owns. Addressed BY FILENAME, not by a field in
 *     the payload: the workspace's projects dir is shared across profile
 *     symlink farms, every window on the folder watches it, and the legacy
 *     consumeFocusHint deletes unconditionally — an addressee field wouldn't
 *     stop an older window stealing the hint, a distinct basename does. Each
 *     window watches only focus-hint-<its own extension-host pid>.json and,
 *     on consume, foregrounds ITSELF: it spawns its own bundled CLI with its
 *     own --user-data-dir (known exactly via deriveUserDataDir — never parsed
 *     out of another process's ps output, where macOS space-joined argv makes
 *     "Application Support" ambiguous) so the right instance raises the right
 *     window even when several profiles hold the same folder.
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

/** Open a folder in VS Code, focusing an existing matching window where possible.
 *  With `opts.userDataDir`, the CLI is pointed at a specific VS Code instance
 *  (`--user-data-dir`) — the instance that dir belongs to focuses its own
 *  window on the folder. Without it, the CLI routes by its own default
 *  instance resolution, which in a multi-instance (profile) setup is not
 *  necessarily the calling window's instance — callers that mean "open in MY
 *  instance" should pass their own derived dir. `opts.cliOnly` suppresses the
 *  vscode.openFolder fallback: a self-foreground call (raising a window on a
 *  folder it ALREADY has open) must degrade to a no-op, never to a forced
 *  duplicate window. */
export async function openWorkspaceFolder(cwd: string, opts: { userDataDir?: string; cliOnly?: boolean } = {}): Promise<void> {
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
    const args = buildCliArgs(cwd, opts.userDataDir);
    const launched = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn(cli, args, { detached: true, stdio: 'ignore' });
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
  if (opts.cliOnly) { return; }

  // Fallback: opens a new window every time (no focus-existing behaviour).
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(cwd),
    { forceNewWindow: true },
  );
}

/** Argv for the editor CLI spawn. An array all the way to spawn() — spaces in
 *  the user-data dir ("Application Support") never need quoting. */
export function buildCliArgs(cwd: string, userDataDir?: string): string[] {
  return userDataDir ? ['--user-data-dir', userDataDir, cwd] : [cwd];
}

/** Path to the focus-hint file for a given workspace key. */
export function focusHintPath(projectsDir: string, workspaceKey: string): string {
  return path.join(projectsDir, workspaceKey, 'focus-hint.json');
}

/** Single producer of the FocusHint wire format, shared by both hint writers.
 *  Write-to-temp-then-rename: the addressed hint's receiver watches the exact
 *  destination basename with a live FileSystemWatcher, and a plain writeFile
 *  can fire onDidCreate before the content flushes — the consumer would read
 *  a torn/empty file and (by consumeFocusHint's always-delete contract)
 *  destroy the hint. rename() makes the full payload appear atomically. */
async function writeHintFile(hintPath: string, sessionId: string): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(hintPath), { recursive: true });
  } catch { /* directory may already exist */ }
  const hint: FocusHint = { sessionId, requestedAt: Date.now() };
  const tmpPath = `${hintPath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(hint), 'utf-8');
  await fs.promises.rename(tmpPath, hintPath);
}

/** Drop a focus hint into the foreign workspace's projects directory. */
export function writeFocusHint(
  projectsDir: string,
  workspaceKey: string,
  sessionId: string,
): Promise<void> {
  return writeHintFile(focusHintPath(projectsDir, workspaceKey), sessionId);
}

/** Path to the ADDRESSED focus-hint file for a target extension-host pid.
 *  Distinct basename from the legacy focus-hint.json — see the module doc's
 *  addressed-by-filename rationale. */
export function addressedFocusHintPath(projectsDir: string, workspaceKey: string, targetPid: number): string {
  return path.join(projectsDir, workspaceKey, `focus-hint-${targetPid}.json`);
}

/** Drop a focus hint addressed to one specific window (by its extension-host
 *  pid). Same payload shape and TTL as the legacy hint — the receiver reuses
 *  consumeFocusHint on the addressed path. `workspaceKey` must be the OWNING
 *  window's key (derive it from the external process's registered cwd, not
 *  the sender's folder — a sibling-worktree owner watches a different key). */
export function writeAddressedFocusHint(
  projectsDir: string,
  workspaceKey: string,
  targetPid: number,
  sessionId: string,
): Promise<void> {
  return writeHintFile(addressedFocusHintPath(projectsDir, workspaceKey, targetPid), sessionId);
}

/** Best-effort GC for addressed hints whose target window is gone — a hint
 *  written moments before its addressee died is consumed by nobody and would
 *  otherwise sit in the shared projects dir forever. Removes files whose pid
 *  is no longer alive or whose payload is past the TTL. Never touches the
 *  legacy focus-hint.json, and never this window's own fresh hint. */
export async function sweepStaleAddressedHints(projectsDir: string, workspaceKey: string): Promise<void> {
  const dir = path.join(projectsDir, workspaceKey);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    // Orphaned temp files from a writer that crashed between writeFile and
    // rename — age out on the same TTL.
    if (/^focus-hint-.*\.tmp-\d+$/.test(name)) {
      try {
        const stat = await fs.promises.stat(path.join(dir, name));
        if (Date.now() - stat.mtimeMs > FOCUS_HINT_TTL_MS) {
          await fs.promises.unlink(path.join(dir, name)).catch(() => { /* best effort */ });
        }
      } catch { /* vanished mid-sweep */ }
      continue;
    }
    const m = /^focus-hint-(\d+)\.json$/.exec(name);
    if (!m) { continue; }
    const pid = parseInt(m[1], 10);
    let dead = false;
    try {
      process.kill(pid, 0);
    } catch (err) {
      // Only ESRCH proves death. EPERM means the pid EXISTS under another OS
      // user — deleting its fresh hint would kill a live handoff; the TTL
      // branch below still bounds how long such a hint can linger.
      dead = (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
    let stale = false;
    if (!dead) {
      try {
        const stat = await fs.promises.stat(path.join(dir, name));
        stale = Date.now() - stat.mtimeMs > FOCUS_HINT_TTL_MS;
      } catch {
        continue; // vanished mid-sweep — someone consumed it
      }
    }
    if (dead || stale) {
      await fs.promises.unlink(path.join(dir, name)).catch(() => { /* best effort */ });
    }
  }
}

/** Derive this window's own VS Code user-data dir from its globalStorage path
 *  (`<userDataDir>/User/globalStorage/<ext-id>` — three segments up). Pure and
 *  exact for the calling instance; returns null when the layout doesn't match
 *  (portable mode, future layout change) so callers can skip the explicit
 *  --user-data-dir spawn rather than target a guessed instance. */
export function deriveUserDataDir(globalStorageFsPath: string): string | null {
  const storageDir = path.dirname(globalStorageFsPath); // .../User/globalStorage
  const userDir = path.dirname(storageDir);             // .../User
  if (path.basename(storageDir) !== 'globalStorage' || path.basename(userDir) !== 'User') {
    return null;
  }
  const dataDir = path.dirname(userDir);
  return dataDir === userDir ? null : dataDir; // guard the filesystem-root degenerate case
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
