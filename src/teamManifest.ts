/**
 * Parses and validates Claude Code **Agent Teams** config files
 * (`~/.claude/teams/<team-name>/config.json`,
 * schema `{ name, leadSessionId, members[], createdAt }`) into a normalised
 * `TeamManifest` for downstream use.
 *
 * Note: Serac previously also read a Cornice sidecar format (`version: 1`,
 * flat `~/.claude/teams/<id>.json`). That parser was removed once native Agent
 * Teams + Workflows covered the need; the `TeamManifest`/`TeamAgentEntry` shape
 * it shared with this parser is retained in `types.ts`.
 */

import { isValidSessionId } from './validation.js';
import type { TeamManifest, TeamAgentEntry } from './types.js';

/** Maximum number of members per config (safety cap) */
const MAX_AGENTS = 200;

/** Validate a CWD path: must be a non-empty absolute path, no null bytes. */
function isValidCwd(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) { return false; }
  if (value.includes('\0')) { return false; }
  if (!value.startsWith('/')) { return false; }
  return true;
}

// ── Agent Teams config parser ────────────────────────────────────────

/** Validate an Agent Teams member name. A member name is later used as a path
 *  component when resolving its inbox file (`inboxes/<member>.json`), so it must
 *  not be a path-traversal candidate: no separators/null, and never `.`/`..`,
 *  a `..` substring, or a leading dot (hidden file). This is the parse-time half
 *  of the inbox-path confinement (the write path also realpath-confines). */
function isValidMemberName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) { return false; }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) { return false; }
  if (value === '.' || value === '..' || value.includes('..') || value.startsWith('.')) { return false; }
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
  // and already tracked by Serac's subagent detection. Only include tmux members
  // in `agents` — but keep the in-process NAMES: roster matching (teammate badge,
  // inbox resolution, transcript lookup) keys on them, and presence in the config
  // is the teammate-liveness signal.
  const agents: TeamAgentEntry[] = [];
  const inProcessMembers: string[] = [];
  for (const member of nonLeadMembers) {
    // In-process members — they're subagents in the lead's JSONL
    if (member.backendType === 'in-process' || member.tmuxPaneId === 'in-process') {
      inProcessMembers.push(member.name as string);
      continue;
    }

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
    orchestrator: {
      sessionId: obj.leadSessionId as string,
      name: obj.name as string,
      startedAt: obj.createdAt as number,
      cwd: leadCwd,
    },
    agents,
    inProcessMembers,
    updatedAt,
  };
}
