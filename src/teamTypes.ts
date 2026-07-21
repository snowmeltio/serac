/**
 * Team-domain types (Agent Teams integration). Part of the domain-split type
 * modules — import from './types.js' (the central re-export) unless you are
 * inside another type module.
 */

import type { DisplayStatus, StatusConfidence, SubagentSnapshot } from './sessionTypes.js';

/** Agent entry in a normalised team manifest. */
export interface TeamAgentEntry {
  /** Claude Code session ID. Null for Agent Teams members without session tracking. */
  sessionId: string | null;
  name: string;
  cwd: string;
  parentSessionId: string;
  depth: number;
  spawnedAt: number;       // epoch ms
  /** Whether the agent is currently active (from Agent Teams isActive field) */
  isActive: boolean | null;
}

/** Parsed team manifest (normalised from an Agent Teams config.json). A raw
 *  config carrying a `version` field is REJECTED at parse time (that marked
 *  the legacy Cornice sidecar format) — see teamManifest.ts. */
export interface TeamManifest {
  orchestrator: {
    sessionId: string;
    name: string;
    startedAt: number;     // epoch ms
    cwd: string;
  };
  agents: TeamAgentEntry[];
  /** Names of in-process members (backendType/tmuxPaneId "in-process"). They
   *  are deliberately NOT in `agents` — they surface as the lead's subagents —
   *  but roster matching (teammate badge, inbox resolution, transcript lookup)
   *  must still recognise them. Members are removed from the config when they
   *  shut down, so presence here is the teammate-liveness signal. */
  inProcessMembers: string[];
  updatedAt: number;       // epoch ms
}

/** Snapshot of a team agent sent to webview (manifest + JSONL state merged) */
export interface TeamAgentSnapshot {
  /** Null when session ID is not available (e.g. Agent Teams members) */
  sessionId: string | null;
  name: string;
  cwd: string;
  parentSessionId: string;
  depth: number;
  spawnedAt: number;
  status: DisplayStatus;
  activity: string;
  confidence: StatusConfidence;
  /** Session-level subagents within this agent (from its JSONL) */
  subagents: SubagentSnapshot[];
  contextTokens: number;
}

/** Full team snapshot sent to webview */
export interface TeamSnapshot {
  /** Stable team id (`at:<team-name>` for Agent Teams). Not the orchestrator
   *  session id — that is `orchestrator.sessionId`. */
  teamId: string;
  name: string;
  orchestrator: {
    sessionId: string;
    status: DisplayStatus;
    activity: string;
    confidence: StatusConfidence;
    contextTokens: number;
    modelLabel: string;
  };
  agents: TeamAgentSnapshot[];
  /** Names of in-process members (mirrored from the manifest). Not rendered in
   *  the roster — they surface as the lead's subagents — but the detail panel
   *  roster-matches subagents against these names for the teammate framing. */
  inProcessMembers: string[];
  /** Aggregated status counts across all agents */
  counts: Record<string, number>;
  /** Recency timestamp (epoch ms): the orchestrator's last activity, falling
   *  back to the config's updatedAt. Used to order the archive by recency. */
  updatedAt: number;
  dismissed: boolean;
}
