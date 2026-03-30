/**
 * Parses and validates Cornice team manifest files.
 *
 * Manifests live at ~/.claude/teams/<orchestrator-session-id>.json and
 * provide topology (parent-child links, names, cwds) for agent teams.
 * Serac derives live status from JSONL; the manifest is discovery-only.
 */

import { isValidSessionId } from './validation.js';
import type { TeamManifest, TeamAgentEntry, AgentExitStatus } from './types.js';

/** Maximum manifest schema version this build understands */
const MAX_SUPPORTED_VERSION = 1;

/** Maximum number of agents per manifest (safety cap) */
const MAX_AGENTS = 200;

const VALID_EXIT_STATUSES = new Set<AgentExitStatus>(['success', 'failed', 'cancelled']);

/** Parse an ISO 8601 date string to epoch ms, or return null on failure. */
function parseIsoDate(value: unknown): number | null {
  if (typeof value !== 'string') { return null; }
  const ms = Date.parse(value);
  if (isNaN(ms)) { return null; }
  return ms;
}

/** Validate a CWD path: must be a non-empty absolute path, no null bytes. */
function isValidCwd(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) { return false; }
  if (value.includes('\0')) { return false; }
  if (!value.startsWith('/')) { return false; }
  return true;
}

/**
 * Parse a team manifest JSON string into a validated TeamManifest, or null.
 * Returns null (never throws) for any malformed input.
 */
export function parseTeamManifest(content: string): TeamManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
  const obj = raw as Record<string, unknown>;

  // Version check
  if (typeof obj.version !== 'number' || obj.version < 1) { return null; }
  if (obj.version > MAX_SUPPORTED_VERSION) { return null; }

  // Orchestrator block
  const orch = obj.orchestrator;
  if (!orch || typeof orch !== 'object' || Array.isArray(orch)) { return null; }
  const o = orch as Record<string, unknown>;

  if (!isValidSessionId(o.sessionId)) { return null; }
  if (typeof o.name !== 'string' || o.name.length === 0) { return null; }
  if (!isValidCwd(o.cwd)) { return null; }

  const orchStartedAt = parseIsoDate(o.startedAt);
  if (orchStartedAt === null) { return null; }

  // Agents array
  if (!Array.isArray(obj.agents)) { return null; }
  if (obj.agents.length > MAX_AGENTS) { return null; }

  const agents: TeamAgentEntry[] = [];
  for (const entry of obj.agents) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return null; }
    const a = entry as Record<string, unknown>;

    if (!isValidSessionId(a.sessionId)) { return null; }
    if (typeof a.name !== 'string' || a.name.length === 0) { return null; }
    if (!isValidCwd(a.cwd)) { return null; }
    if (!isValidSessionId(a.parentSessionId)) { return null; }
    if (typeof a.depth !== 'number' || a.depth < 1 || !Number.isInteger(a.depth)) { return null; }

    const spawnedAt = parseIsoDate(a.spawnedAt);
    if (spawnedAt === null) { return null; }

    let completedAt: number | null = null;
    if (a.completedAt !== null && a.completedAt !== undefined) {
      completedAt = parseIsoDate(a.completedAt);
      if (completedAt === null) { return null; }
    }

    let exitStatus: AgentExitStatus | null = null;
    if (a.exitStatus !== null && a.exitStatus !== undefined) {
      if (typeof a.exitStatus !== 'string' || !VALID_EXIT_STATUSES.has(a.exitStatus as AgentExitStatus)) {
        return null;
      }
      exitStatus = a.exitStatus as AgentExitStatus;
    }

    agents.push({
      sessionId: a.sessionId as string,
      name: a.name as string,
      cwd: a.cwd as string,
      parentSessionId: a.parentSessionId as string,
      depth: a.depth,
      spawnedAt,
      completedAt,
      exitStatus,
    });
  }

  // updatedAt
  const updatedAt = parseIsoDate(obj.updatedAt);
  if (updatedAt === null) { return null; }

  return {
    version: obj.version as number,
    orchestrator: {
      sessionId: o.sessionId as string,
      name: o.name as string,
      startedAt: orchStartedAt,
      cwd: o.cwd as string,
    },
    agents,
    updatedAt,
  };
}
