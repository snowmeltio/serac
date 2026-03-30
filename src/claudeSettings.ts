/**
 * Reads Claude Code compact-related settings from ~/.claude/settings.json.
 * Extension-side only (uses fs/os/path — not bundled into the webview).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  return path.join(os.homedir(), '.claude', 'settings.json');
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
