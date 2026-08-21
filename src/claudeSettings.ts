/**
 * Reads Claude Code compact-related settings from <claudeStateDir>/settings.json.
 * Extension-side only (uses fs/os/path — not bundled into the webview).
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeStateDir } from './paths.js';

export interface CompactSettings {
  /** Effective context window in tokens (CLAUDE_CODE_AUTO_COMPACT_WINDOW, default 200K) */
  autoCompactWindow: number;
  /** Percentage of window at which auto-compact fires (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, default 95) */
  autoCompactPct: number;
}

const DEFAULTS: CompactSettings = {
  autoCompactWindow: 200_000,
  autoCompactPct: 95,
};

export function getClaudeSettingsPath(): string {
  return path.join(claudeStateDir(), 'settings.json');
}

export function readCompactSettings(): CompactSettings {
  try {
    const raw = fs.readFileSync(getClaudeSettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    const env: Record<string, string> = parsed?.env ?? {};
    const window = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    const pct = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
    return {
      autoCompactWindow: window > 0 ? window : DEFAULTS.autoCompactWindow,
      autoCompactPct: pct > 0 && pct <= 100 ? pct : DEFAULTS.autoCompactPct,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Claude Code's `remoteControlAtStartup` ("Enable Remote Control for all
 *  sessions"): whether sessions started in this workspace enrol with the
 *  Remote Control bridge automatically, i.e. show up on the phone. Read from
 *  the same three settings files Claude Code merges, lowest to highest
 *  precedence: user (<claudeStateDir>/settings.json), project
 *  (<workspace>/.claude/settings.json), local (<workspace>/.claude/
 *  settings.local.json). Returns `null` only when the USER file cannot be
 *  read or parsed (then nothing is known); a readable file without the key
 *  means the Claude Code default, which is off. Serac never writes this key —
 *  it is the user's account-level consent. */
export function readRemoteControlAtStartup(workspacePath: string): boolean | null {
  let value: boolean | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(getClaudeSettingsPath(), 'utf-8'));
    value = parsed?.remoteControlAtStartup === true;
  } catch {
    return null;
  }
  for (const rel of ['settings.json', 'settings.local.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(workspacePath, '.claude', rel), 'utf-8'));
      if (typeof parsed?.remoteControlAtStartup === 'boolean') { value = parsed.remoteControlAtStartup; }
    } catch { /* absent or malformed project/local file: keep the lower layer */ }
  }
  return value;
}

/** Reads the configured default model (the top-level `model` field in
 *  settings.json, e.g. "sonnet" or "claude-opus-4-8") used to seed a
 *  session's model pill before its first assistant record confirms the
 *  actual model. Empty string if unset/unreadable. */
export function readDefaultModel(): string {
  try {
    const raw = fs.readFileSync(getClaudeSettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.model === 'string' ? parsed.model : '';
  } catch {
    return '';
  }
}
