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
 *  launchd installer is macOS-only. Empty when everything is on (the
 *  indicator is not a button then, so this is a guard, not a state). */
export function rcQuickPickItems(facts: RcFacts, platform: NodeJS.Platform): RcQuickPickItem[] {
  const items: RcQuickPickItem[] = [];
  if (!facts.serving) {
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
