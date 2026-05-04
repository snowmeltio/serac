/**
 * Resolves Claude Code's state directory and derived paths. Serac follows
 * whichever environment Claude Code is using (CLAUDE_CONFIG_DIR if set,
 * otherwise ~/.claude/).
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

/** Path to the Claude Code config file, or null if not found. */
export function claudeConfigFile(): string | null {
  const dir = claudeStateDir();
  const sibling = `${dir}.json`;
  if (fs.existsSync(sibling)) { return sibling; }
  const inline = path.join(dir, '.claude.json');
  if (fs.existsSync(inline)) { return inline; }
  return null;
}

/** macOS Keychain service name for the active environment's credentials. */
export function claudeKeychainService(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (!env || env.length === 0) { return 'Claude Code-credentials'; }
  const resolved = path.resolve(env);
  const defaultDir = path.join(os.homedir(), '.claude');
  if (resolved === defaultDir) { return 'Claude Code-credentials'; }
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}
