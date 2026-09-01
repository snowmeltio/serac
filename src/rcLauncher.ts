/**
 * Remote Control "turn the rest on" helpers — the pure half of the top-bar
 * indicator's click. extension.ts owns the VS Code side (quick pick, terminal,
 * open-document); everything here is string and env assembly, so it is
 * testable without the vscode module.
 *
 * Principle (plan §6): Serac may START a Remote Control server, but only in a
 * visible terminal the user can see and close, and it never stops one. It
 * also never writes Claude Code's `remoteControlAtStartup` flag — that is the
 * user's account-level consent, so the third action only opens settings.json
 * and points at the key.
 */
import * as path from 'path';
import type { RcFacts } from './rcState.js';

export type RcAction = 'start' | 'install' | 'settings';

/** Default user-data-dir names across the Electron editors Serac runs in.
 *  Anything else — Murray's `Code-<name>` companion launchers especially —
 *  reads as a companion instance. A future editor not in this list fails
 *  CLOSED (start routes withheld, reason shown on click); that costs its user
 *  one manual `claude rc` in a terminal, where failing open would offer a
 *  server their phone cannot reach. */
const DEFAULT_USER_DATA_DIR_NAMES = new Set([
  'Code', 'Code - Insiders', 'Code - OSS', 'VSCodium', 'Cursor', 'Windsurf',
]);

/** Remote-development server dirs (`~/.vscode-server`, `~/.cursor-server`,
 *  `-insiders` variants…): there the extension host runs on the remote and
 *  globalStorage sits under `<server-dir>/data/User/…` — a layout the
 *  editor-name list structurally cannot express. A remote window with a
 *  default `~/.claude` on the remote host is exactly where the rc server
 *  should run, so it must not read as a companion. */
const REMOTE_SERVER_DIR = /^\.[a-z]+-server(?:-insiders)?$/;

/** Why Serac withholds the server-start routes in a companion profile — said
 *  identically by the empty-picker click and the startRcServer() guard, so it
 *  lives here once (the RC_STOPPED_MESSAGE precedent). */
export const RC_COMPANION_START_WITHHELD_MESSAGE =
  'Serac does not start Remote Control servers from a companion profile — your phone could not reach this account\'s server. '
  + 'Run claude rc in a terminal yourself if you want one.';

/** Is this window the DEFAULT profile — the one whose Remote Control servers
 *  the phone can actually reach?
 *
 *  "Companion profile" is two uncoupled axes, and both must agree on default:
 *   - Claude account: `CLAUDE_CONFIG_DIR` unset, or resolving to `~/.claude`
 *     (the same comparison paths.ts:claudeKeychainService encodes). The
 *     phone's Remote Control view is per account.
 *   - VS Code instance: the `--user-data-dir` this window runs under, read
 *     from the globalStorage path because the env var is not guaranteed to
 *     survive a Dock relaunch or window restore. The dir name is the segment
 *     before the last `User` segment — parsed that way rather than reusing
 *     workspaceOpener.ts:deriveUserDataDir because VS Code's built-in
 *     profiles feature nests globalStorage under `User/profiles/<id>/`, which
 *     that helper (rightly, for spawn targeting) refuses to parse; a profile
 *     inside the default install still counts as default here.
 *
 *  Anything unrecognised is a companion: fail closed (see
 *  DEFAULT_USER_DATA_DIR_NAMES for the cost asymmetry). */
export function isDefaultProfile(args: {
  configDir: string | undefined;
  globalStoragePath: string;
  home: string;
}): boolean {
  const { configDir, globalStoragePath, home } = args;
  // Emptiness test matches paths.ts exactly (length, no trim): a whitespace
  // CLAUDE_CONFIG_DIR resolves to some cwd-relative dir ≠ ~/.claude and reads
  // companion here, just as claudeKeychainService hashes it as non-default.
  if (configDir && configDir.length > 0) {
    if (path.resolve(configDir) !== path.join(home, '.claude')) { return false; }
  }
  const segments = path.resolve(globalStoragePath).split(path.sep);
  const userIdx = segments.lastIndexOf('User');
  if (userIdx <= 0) { return false; }
  const dataDirName = segments[userIdx - 1];
  if (DEFAULT_USER_DATA_DIR_NAMES.has(dataDirName)) { return true; }
  // Remote development: `~/.vscode-server/data/User/globalStorage/…`.
  return dataDirName === 'data' && userIdx >= 2 && REMOTE_SERVER_DIR.test(segments[userIdx - 2]);
}

export interface RcQuickPickItem {
  label: string;
  description: string;
  detail?: string;
  action: RcAction;
}

/** Environment OVERRIDES for the terminal that runs `claude rc` (VS Code's
 *  TerminalOptions.env: a null value removes the variable). The extension host
 *  leaks `VSCODE_*` and `ELECTRON_RUN_AS_NODE` into children, and a Claude CLI
 *  launched under those misbehaves (companion v0.8.1/0.8.2, 2026-07-15).
 *  `CLAUDE_CONFIG_DIR` is deliberately KEPT: the server must run under the
 *  same account the sessions here use, or the phone sees a different farm. */
export function rcTerminalEnvOverrides(env: NodeJS.ProcessEnv): Record<string, null> {
  const out: Record<string, null> = {};
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') { out[key] = null; }
  }
  return out;
}

/** The Claude CLI to run. Claude Code's native installer puts it at
 *  `~/.local/bin/claude`, which a minimal shell PATH can miss; prefer that
 *  absolute path when it exists, else trust the terminal's PATH. */
export function locateClaudeCli(home: string, exists: (p: string) => boolean): string {
  const native = path.join(home, '.local', 'bin', 'claude');
  return exists(native) ? native : 'claude';
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/** `claude rc --spawn worktree` — the same invocation the launchd wrapper
 *  uses, so phone-started sessions land in their own worktrees rather than on
 *  whatever is checked out here. */
export function rcStartCommand(cli: string): string {
  return shellQuote(cli) + ' rc --spawn worktree';
}

/** Runs the shipped installer against this workspace. `bash` rather than
 *  relying on the execute bit, which a .vsix unpack does not promise. */
export function rcInstallCommand(extensionPath: string, workspacePath: string): string {
  const script = path.join(extensionPath, 'scripts', 'rc-headless', 'install.sh');
  return 'bash ' + shellQuote(script) + ' ' + shellQuote(workspacePath);
}

/** The picker's rows for the current facts. Only what is OFF is offered; the
 *  launchd installer is macOS-only. Both server rows (terminal and launchd)
 *  are withheld in a companion profile — a server started there serves an
 *  account the phone cannot reach without switching accounts, so offering it
 *  is offering a dead end. Empty when everything is on, or when nothing
 *  offerable remains (the click handler shows the reason in the status bar
 *  instead of an empty picker — rcHasOffers is the shared spelling of
 *  "would this be empty"). */
export function rcQuickPickItems(facts: RcFacts, platform: NodeJS.Platform): RcQuickPickItem[] {
  const items: RcQuickPickItem[] = [];
  if (!facts.serving && !facts.companionProfile) {
    items.push({
      label: '$(terminal) Start a Remote Control server here',
      description: 'in a VS Code terminal — lets your phone start sessions in this workspace',
      detail: 'Runs claude rc --spawn worktree. Leave the terminal open; closing it stops the server. Serac never stops it for you.',
      action: 'start',
    });
    if (platform === 'darwin') {
      items.push({
        label: '$(pulse) Install an always-on server (launchd)',
        description: 'keeps serving this workspace after VS Code closes',
        detail: 'Runs scripts/rc-headless/install.sh for this repo in a terminal. It checks Remote Control is enabled on your account first and installs nothing otherwise.',
        action: 'install',
      });
    }
  }
  if (facts.autoEnrol !== true) {
    items.push({
      label: '$(settings-gear) Turn on Remote Control for sessions you start here',
      description: facts.autoEnrol === null
        ? 'open Claude Code\'s settings.json (Serac could not read it)'
        : 'open Claude Code\'s settings.json at remoteControlAtStartup',
      detail: 'Enable it from Claude Code\'s "Remote Control" popup ("Enable Remote Control for all sessions"), or set "remoteControlAtStartup": true yourself. Serac does not write this setting.',
      action: 'settings',
    });
  }
  return items;
}

/** The name Serac gives a terminal it starts a server in — and the handle it
 *  finds that terminal by on the next start (see `findLiveRcTerminal`). */
export const RC_TERMINAL_NAME = 'Remote Control server';

/** Structural stand-in for `vscode.Terminal`, so the reuse rule stays testable
 *  without the vscode module. `exitStatus` is set once the SHELL has exited (a
 *  dead tab still sitting in the panel). That is NOT the same as the `claude
 *  rc` process inside it having stopped: that leaves the shell at a prompt
 *  with the server's last painted frame — "Connected" — above it. */
export interface TerminalLike {
  readonly name: string;
  readonly exitStatus?: unknown;
}

/** The Remote Control terminal already open in this window, if any.
 *
 *  Reused rather than opening a second one: two `claude rc` servers on one
 *  directory displace each other, and the loser's shutdown lines land in
 *  whichever terminal you are not looking at. Cross-WINDOW duplicates are
 *  already covered elsewhere — the picker only offers "start" while the
 *  registry says nothing is serving this workspace, and that fact is
 *  machine-wide, not per window.
 *
 *  Matched by name, so a terminal the user named this themselves would be
 *  reused too; the cost is a command typed into their terminal, not a lost
 *  server. */
export function findLiveRcTerminal<T extends TerminalLike>(terminals: readonly T[]): T | undefined {
  return terminals.find(t => t.name === RC_TERMINAL_NAME && t.exitStatus === undefined);
}

/** How long the registry must keep saying the server is gone before Serac
 *  says so. Long enough to ride out one degraded scan (rcDetector reads an
 *  empty registry as "not serving" — a soft negative, not proof) plus several
 *  poll cycles at any sane refresh interval. */
export const RC_STOPPED_GRACE_MS = 20_000;

/** Watch over the server Serac started in THIS window. Serac still never
 *  stops one; this only notices when one has stopped without saying so. */
export interface RcWatchState {
  /** A server was started here and has not yet been reported gone. */
  started: boolean;
  /** The registry has confirmed it at least once. Until it does, silence:
   *  rcDetector cannot see a server that has not registered a session yet, so
   *  "it never started" is not a claim this watch is entitled to make. */
  confirmed: boolean;
  /** When the registry first stopped seeing it, else null. */
  missingSince: number | null;
}

export const RC_WATCH_IDLE: RcWatchState = { started: false, confirmed: false, missingSince: null };

/** Arm the watch — called at the moment the start command is sent. */
export function rcWatchStarted(): RcWatchState {
  return { started: true, confirmed: false, missingSince: null };
}

/** One poll's worth of the watch. Pure: the caller owns the clock, the
 *  serving fact, and the telling. Notifies at most once per start — the
 *  returned state goes idle with it. */
export function rcWatchTick(
  state: RcWatchState,
  serving: boolean,
  now: number,
): { state: RcWatchState; notify: boolean } {
  if (!state.started) { return { state, notify: false }; }
  if (serving) { return { state: { started: true, confirmed: true, missingSince: null }, notify: false }; }
  if (!state.confirmed) { return { state, notify: false }; }
  const missingSince = state.missingSince ?? now;
  if (now - missingSince < RC_STOPPED_GRACE_MS) {
    return { state: { ...state, missingSince }, notify: false };
  }
  return { state: RC_WATCH_IDLE, notify: true };
}

/** Said once, when the server Serac started has gone but its terminal is
 *  still open. The terminal is the misleading part: `claude rc` paints its
 *  status as a pinned footer and never repaints it on exit, so a dead server
 *  reads "Connected" indefinitely, above a live shell prompt. */
export const RC_STOPPED_MESSAGE =
  'The Remote Control server Serac started here has stopped, so your phone can no longer start sessions in this workspace. '
  + 'Its terminal may still say "Connected" — that is the last frame of a dead process, not the current state.';
