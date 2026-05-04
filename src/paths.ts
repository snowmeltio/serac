/**
 * Resolves Claude Code's state directory and derived paths, honouring the
 * CLAUDE_CONFIG_DIR environment variable. Without it, Claude Code uses
 * ~/.claude/. With it set (e.g. ~/.claude-snowmelt), Claude Code reads
 * sessions, settings, OAuth credentials, etc. from that alternate root, and
 * Serac must follow.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Resolved state directory: $CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudeStateDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.length > 0) {
    return env;
  }
  return path.join(os.homedir(), '.claude');
}

/** Path to the Claude Code config file (.claude.json).
 *  Default profile uses sibling layout (~/.claude.json); alternates use inline
 *  layout (~/.claude-X/.claude.json). Mirrors `config_file()` in claude-account.
 *  Returns null if neither location contains the file. */
export function claudeConfigFile(): string | null {
  const dir = claudeStateDir();
  const sibling = `${dir}.json`;
  if (fs.existsSync(sibling)) { return sibling; }
  const inline = path.join(dir, '.claude.json');
  if (fs.existsSync(inline)) { return inline; }
  return null;
}

/** macOS Keychain service name for the active profile's OAuth credentials.
 *  Claude Code uses 'Claude Code-credentials' for the default profile and
 *  'Claude Code-credentials-<sha256-prefix>' for alternates, where the prefix
 *  is the first 8 hex chars of sha256(absolute CLAUDE_CONFIG_DIR path).
 *  This was reverse-engineered from binary inspection — see W4-HANDOFF.md. */
export function claudeKeychainService(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (!env || env.length === 0) { return 'Claude Code-credentials'; }
  const resolved = path.resolve(env);
  const defaultDir = path.join(os.homedir(), '.claude');
  if (resolved === defaultDir) { return 'Claude Code-credentials'; }
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}
