/**
 * Parses and validates team manifest files from two sources:
 *
 * 1. **Cornice sidecar** — `~/.claude/teams/<orchestrator-session-id>.json`
 *    Schema: { version: 1, orchestrator, agents[], updatedAt }
 *    Source of truth: snowmeltio/cornice/schemas/team-manifest-schema.json
 *    Vendored copy: schemas/team-manifest-schema.json (documentation only, not a runtime dependency)
 *
 * 2. **Agent Teams config** — `~/.claude/teams/<team-name>/config.json`
 *    Schema: { name, leadSessionId, members[], createdAt }
 *
 * Both are normalised into the same TeamManifest interface for downstream use.
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

/** Parse a single agent entry from a Cornice manifest, or return null if malformed. */
function parseAgentEntry(entry: unknown): TeamAgentEntry | null {
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

  return {
    sessionId: a.sessionId as string,
    name: a.name as string,
    cwd: a.cwd as string,
    parentSessionId: a.parentSessionId as string,
    depth: a.depth,
    spawnedAt,
    completedAt,
    exitStatus,
    isActive: null,
  };
}

/**
 * Parse a Cornice sidecar manifest JSON string into a validated TeamManifest, or null.
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
    const parsed = parseAgentEntry(entry);
    if (parsed === null) {
      // Skip malformed agent entries rather than rejecting the entire manifest.
      // This prevents one bad agent from hiding all the others.
      continue;
    }
    agents.push(parsed);
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


// ── Agent Teams config parser ────────────────────────────────────────

/** Validate an Agent Teams member name (non-empty, no path-traversal chars). */
function isValidMemberName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) { return false; }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) { return false; }
  return true;
}

/**
 * Parse a Claude Code Agent Teams config.json into a TeamManifest, or null.
 *
 * Agent Teams config structure:
 * ```json
 * {
 *   "name": "team-name",
 *   "description": "...",
 *   "createdAt": 1774873638749,
 *   "leadAgentId": "team-lead@team-name",
 *   "leadSessionId": "uuid-string",
 *   "members": [
 *     { "agentId": "team-lead@team-name", "name": "team-lead", "cwd": "/...", "joinedAt": epoch, ... },
 *     { "agentId": "worker@team-name", "name": "worker", "cwd": "/...", "joinedAt": epoch, "isActive": true, ... }
 *   ]
 * }
 * ```
 */
export function parseAgentTeamsConfig(content: string, teamDirName: string): TeamManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
  const obj = raw as Record<string, unknown>;

  // Must NOT have a version field (distinguishes from Cornice sidecar)
  if ('version' in obj) { return null; }

  // Required fields
  if (typeof obj.name !== 'string' || obj.name.length === 0) { return null; }
  if (typeof obj.createdAt !== 'number' || obj.createdAt <= 0) { return null; }
  if (!isValidSessionId(obj.leadSessionId)) { return null; }

  // Members array
  if (!Array.isArray(obj.members)) { return null; }
  if (obj.members.length === 0) { return null; } // need at least a lead
  if (obj.members.length > MAX_AGENTS) { return null; }

  // Find lead member
  const leadAgentId = typeof obj.leadAgentId === 'string' ? obj.leadAgentId : null;
  let leadMember: Record<string, unknown> | null = null;
  const nonLeadMembers: Record<string, unknown>[] = [];

  for (const m of obj.members) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) { return null; }
    const member = m as Record<string, unknown>;

    if (!isValidMemberName(member.name)) { return null; }

    if (member.agentId === leadAgentId) {
      leadMember = member;
    } else {
      nonLeadMembers.push(member);
    }
  }

  // Fall back to first member as lead if leadAgentId didn't match
  if (!leadMember) {
    leadMember = obj.members[0] as Record<string, unknown>;
    // Remove it from nonLeadMembers if it ended up there
    const idx = nonLeadMembers.indexOf(leadMember);
    if (idx >= 0) { nonLeadMembers.splice(idx, 1); }
  }

  // Orchestrator (lead member)
  const leadCwd = isValidCwd(leadMember.cwd) ? leadMember.cwd : null;
  if (!leadCwd) { return null; }

  // Build agent entries from non-lead members.
  // Members are dynamic: removed from config on completion, so all present members are active.
  // In-process members (tmuxPaneId === "in-process") are subagents in the lead's JSONL
  // and already tracked by Serac's subagent detection. Only include tmux members.
  const agents: TeamAgentEntry[] = [];
  for (const member of nonLeadMembers) {
    // Skip in-process members — they're subagents in the lead's JSONL
    if (member.backendType === 'in-process' || member.tmuxPaneId === 'in-process') { continue; }

    const memberCwd = isValidCwd(member.cwd) ? member.cwd : leadCwd;
    const joinedAt = typeof member.joinedAt === 'number' ? member.joinedAt : obj.createdAt as number;
    const isActive = typeof member.isActive === 'boolean' ? member.isActive : null;

    agents.push({
      sessionId: null, // Agent Teams members don't expose session IDs in config
      name: member.name as string,
      cwd: memberCwd,
      parentSessionId: obj.leadSessionId as string,
      depth: 1,
      spawnedAt: joinedAt,
      completedAt: null, // present in config = still active (removed on completion)
      exitStatus: null,
      isActive,
    });
  }

  // Use the most recent joinedAt across all members as updatedAt
  let updatedAt = obj.createdAt as number;
  for (const m of obj.members as Record<string, unknown>[]) {
    const joined = typeof (m as Record<string, unknown>).joinedAt === 'number'
      ? (m as Record<string, unknown>).joinedAt as number : 0;
    if (joined > updatedAt) { updatedAt = joined; }
  }

  return {
    version: 0, // Distinguishes Agent Teams config from Cornice sidecar (version: 1)
    orchestrator: {
      sessionId: obj.leadSessionId as string,
      name: obj.name as string,
      startedAt: obj.createdAt as number,
      cwd: leadCwd,
    },
    agents,
    updatedAt,
  };
}
