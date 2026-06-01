/**
 * Project-scoped Claude Code settings patcher.
 *
 * Reads/writes `<workspace>/.claude/settings.json`, registering the Serac
 * forwarder (`bin/serac-hook-forward.cjs`) for the Phase 4 hook events.
 * Every managed entry carries a `_serac_managed: true` sentinel so cleanup
 * can identify our entries without touching anything else the user (or
 * another tool) has registered.
 *
 * Scope decision: per-workspace, not user-wide (`~/.claude/settings.json`).
 * Matches the per-workspace leader scope used by `hookIngress`, gives a
 * lower corruption blast radius (one workspace's settings vs every Claude
 * Code session on the machine), and keeps zero overhead in unrelated
 * sessions launched outside any Serac workspace.
 *
 * Atomicity: writes go to `<settings>.<pid>.<rand>.tmp` then `fs.renameSync`
 * into place. The rename is atomic on macOS/Linux. We don't take backups
 * because (a) the patch is restricted to the sentinel-marked subtree we
 * own, and (b) unpatching only removes our entries. If the user wants a
 * belt-and-braces backup, they can copy the file before enabling.
 *
 * Idempotency: `applyForwarderPatch` is safe to call repeatedly. Each call
 * removes any existing `_serac_managed` entry for each event before adding
 * the current one, so a forwarder path change picks up cleanly.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Hook events we register a forwarder for. See ARCHITECTURE.md "Hook
 *  consumption". `SubagentStart` is intentionally excluded: nothing consumes it
 *  (its payload has no `tool_use_id`, so it can't bridge to the
 *  `parentToolUseId`-keyed subagent model at spawn time). `PostToolUseFailure`
 *  is excluded too — undocumented, and the same info flows through PostToolUse.
 *  `SessionEnd`/`PreCompact` are consumed by SessionLifecycleTracker. */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStop',
  'Stop',
  'PreCompact',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

/** Sentinel field. Anything we write has this; nothing we don't write does. */
export const SENTINEL_KEY = '_serac_managed';

/** Claude Code's documented hook timeout default is 5 seconds; we keep that. */
export const HOOK_TIMEOUT_SECONDS = 5;

interface ManagedHookEntry {
  matcher: string;
  hooks: Array<{ type: 'command'; command: string; timeout: number }>;
  [SENTINEL_KEY]: true;
}

interface SettingsShape {
  hooks?: Record<string, unknown[]>;
  [k: string]: unknown;
}

export interface PatchResult {
  /** Absolute path that was written (or would have been written on dry runs). */
  settingsPath: string;
  /** True if file content changed; false if the patch was already in place. */
  changed: boolean;
}

/**
 * Apply (or refresh) the Serac hook forwarder registration for a workspace.
 *
 * Creates `<workspace>/.claude/settings.json` if missing. Existing user hooks
 * are preserved; our entries are identified by the `_serac_managed` sentinel
 * and refreshed in place.
 */
export function applyForwarderPatch(
  workspaceDir: string,
  forwarderAbsPath: string,
): PatchResult {
  if (!path.isAbsolute(forwarderAbsPath)) {
    throw new Error(`forwarder path must be absolute, got: ${forwarderAbsPath}`);
  }

  const settingsPath = path.join(workspaceDir, '.claude', 'settings.json');
  const original = readSettings(settingsPath);
  const patched = withManagedEntries(original, forwarderAbsPath);

  const before = JSON.stringify(original);
  const after = JSON.stringify(patched);
  if (before === after) {
    return { settingsPath, changed: false };
  }
  writeSettingsAtomic(settingsPath, patched);
  return { settingsPath, changed: true };
}

/**
 * Remove all Serac-managed hook entries from a workspace's settings. Leaves
 * any user-authored hooks untouched. If the result is an empty settings file
 * we created earlier (no other fields, no other hooks), the file is removed.
 */
export function removeForwarderPatch(workspaceDir: string): PatchResult {
  const settingsPath = path.join(workspaceDir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { settingsPath, changed: false };
  }
  const original = readSettings(settingsPath);
  const stripped = withoutManagedEntries(original);

  const before = JSON.stringify(original);
  const after = JSON.stringify(stripped);
  if (before === after) {
    return { settingsPath, changed: false };
  }

  if (isEffectivelyEmpty(stripped)) {
    fs.unlinkSync(settingsPath);
    // Best-effort cleanup of the .claude dir if we created it and it's empty.
    try {
      const claudeDir = path.dirname(settingsPath);
      if (fs.readdirSync(claudeDir).length === 0) { fs.rmdirSync(claudeDir); }
    } catch { /* dir not empty or perms — leave it */ }
    return { settingsPath, changed: true };
  }

  writeSettingsAtomic(settingsPath, stripped);
  return { settingsPath, changed: true };
}

// ── internals ─────────────────────────────────────────────────────

function readSettings(settingsPath: string): SettingsShape {
  if (!fs.existsSync(settingsPath)) { return {}; }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (raw.trim().length === 0) { return {}; }
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`unexpected settings.json shape at ${settingsPath}`);
  }
  return parsed as SettingsShape;
}

function writeSettingsAtomic(settingsPath: string, value: SettingsShape): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, settingsPath);
}

function withManagedEntries(input: SettingsShape, forwarderAbsPath: string): SettingsShape {
  const copy: SettingsShape = { ...input };
  const hooks: Record<string, unknown[]> = { ...(copy.hooks ?? {}) };

  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const userEntries = existing.filter(e => !isManagedEntry(e));
    const managed = managedEntry(forwarderAbsPath);
    hooks[event] = [...userEntries, managed];
  }

  copy.hooks = hooks;
  return copy;
}

function withoutManagedEntries(input: SettingsShape): SettingsShape {
  if (!input.hooks || typeof input.hooks !== 'object') { return input; }
  const copy: SettingsShape = { ...input };
  const hooks: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(input.hooks)) {
    if (!Array.isArray(entries)) { continue; }
    const userOnly = entries.filter(e => !isManagedEntry(e));
    if (userOnly.length > 0) { hooks[event] = userOnly; }
  }
  if (Object.keys(hooks).length > 0) {
    copy.hooks = hooks;
  } else {
    delete copy.hooks;
  }
  return copy;
}

function isManagedEntry(entry: unknown): boolean {
  return typeof entry === 'object'
    && entry !== null
    && (entry as Record<string, unknown>)[SENTINEL_KEY] === true;
}

function managedEntry(forwarderAbsPath: string): ManagedHookEntry {
  return {
    matcher: '*',
    hooks: [{ type: 'command', command: forwarderAbsPath, timeout: HOOK_TIMEOUT_SECONDS }],
    [SENTINEL_KEY]: true,
  };
}

function isEffectivelyEmpty(s: SettingsShape): boolean {
  return Object.keys(s).length === 0;
}
