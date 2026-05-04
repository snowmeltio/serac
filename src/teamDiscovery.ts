/**
 * Discovers and manages Cornice agent teams from sidecar manifests.
 *
 * Scans ~/.claude/teams/ for JSON manifests written by Cornice. Each manifest
 * describes an orchestrator and its spawned agents. TeamDiscovery creates
 * SessionManager instances for each agent/orchestrator JSONL and produces
 * TeamSnapshot[] for the webview.
 *
 * Modelled after ForeignWorkspaceManager: periodic scan + active/dormant polling.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { parseTeamManifest, parseAgentTeamsConfig } from './teamManifest.js';
import { claudeStateDir } from './paths.js';
import type {
  TeamManifest, TeamSnapshot, TeamAgentSnapshot,
  SessionMeta, StatusConfidence, DisplayStatus,
} from './types.js';
import type { Logger } from './sessionDiscovery.js';

/** Age gate: skip manifests older than 7 days */
const TEAM_AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Full rescan every Nth poll cycle */
const TEAM_SCAN_INTERVAL = 10;
/** Batch size for concurrent session updates (shared FD budget) */
const UPDATE_BATCH_SIZE = 50;
/** Confidence ranking for max-confidence aggregation */
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export class TeamDiscovery {
  private readonly teamsDir: string;
  private readonly projectsDir: string;
  private manifests: Map<string, TeamManifest> = new Map();
  /** All SessionManagers for team agents + orchestrators, keyed by sessionId */
  private agents: Map<string, SessionManager> = new Map();
  /** Last known mtime per manifest file (ms), for change detection */
  private manifestMtimes: Map<string, number> = new Map();
  private scanCounter = 0;

  constructor(
    projectsDir: string,
    private readonly log: Logger,
  ) {
    this.projectsDir = projectsDir;
    this.teamsDir = path.join(claudeStateDir(), 'teams');
  }

  /** Whether it's time for a full rescan (every Nth poll cycle). */
  /** Whether it's time for a full rescan.
   *  Every cycle when agents are active (pick up new spawns quickly).
   *  Every Nth cycle when dormant. */
  shouldRescan(): boolean {
    if (this.hasActiveAgents()) { return true; }
    this.scanCounter++;
    if (this.scanCounter >= TEAM_SCAN_INTERVAL) {
      this.scanCounter = 0;
      return true;
    }
    return false;
  }

  /** Whether any team agents are currently active (running/waiting). */
  hasActiveAgents(): boolean {
    for (const agent of this.agents.values()) {
      const status = agent.getStatus();
      if (status === 'running' || status === 'waiting') { return true; }
    }
    return false;
  }

  /** Scan ~/.claude/teams/ for manifests (flat .json files and subdirectory config.json). */
  async scan(): Promise<void> {
    const now = Date.now();
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.teamsDir);
    } catch {
      // Directory doesn't exist yet — not an error
      return;
    }

    const seenTeamIds = new Set<string>();

    for (const entry of entries) {
      const entryPath = path.join(this.teamsDir, entry);
      let entryStat: fs.Stats;
      try {
        entryStat = await fs.promises.stat(entryPath);
      } catch { continue; }

      let teamId: string;
      let filePath: string;
      let fstat: fs.Stats;

      if (entryStat.isDirectory()) {
        // Agent Teams format: <team-name>/config.json
        filePath = path.join(entryPath, 'config.json');
        try {
          fstat = await fs.promises.stat(filePath);
        } catch { continue; } // No config.json in this directory
        teamId = `at:${entry}`; // Prefix to avoid collision with Cornice sidecar IDs
      } else if (entry.endsWith('.json')) {
        // Cornice sidecar format: <id>.json
        filePath = entryPath;
        fstat = entryStat;
        teamId = entry.replace('.json', '');
      } else {
        continue;
      }

      // Age gate
      if (now - fstat.mtimeMs > TEAM_AGE_GATE_MS) { continue; }

      // Skip re-parse if mtime unchanged
      seenTeamIds.add(teamId);
      const lastMtime = this.manifestMtimes.get(teamId) ?? 0;
      if (fstat.mtimeMs === lastMtime && this.manifests.has(teamId)) { continue; }

      let content: string;
      try {
        content = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        this.log.warn(`[teams] Failed to read manifest: ${entry}`);
        continue;
      }

      // Try both parsers: Cornice sidecar first, then Agent Teams config
      const manifest = parseTeamManifest(content) ?? parseAgentTeamsConfig(content, entry);
      if (!manifest) {
        this.log.warn(`[teams] Skipping malformed manifest: ${entry}`);
        continue;
      }

      this.manifestMtimes.set(teamId, fstat.mtimeMs);
      this.manifests.set(teamId, manifest);

      // Create SessionManagers for orchestrator + agents with session IDs
      await this.ensureSessionManager(manifest.orchestrator.sessionId, manifest.orchestrator.cwd);
      for (const agent of manifest.agents) {
        if (agent.sessionId) {
          await this.ensureSessionManager(agent.sessionId, agent.cwd);
        }
      }
    }

    // Prune manifests for entries that no longer exist
    for (const teamId of [...this.manifests.keys()]) {
      if (!seenTeamIds.has(teamId)) {
        this.removeTeam(teamId);
      }
    }
  }

  /** Create a SessionManager for a session ID if we haven't already. */
  private async ensureSessionManager(sessionId: string, cwd: string): Promise<void> {
    if (this.agents.has(sessionId)) { return; }

    const workspaceKey = sanitiseWorkspaceKey(cwd);
    const jsonlPath = path.join(this.projectsDir, workspaceKey, `${sessionId}.jsonl`);

    try {
      await fs.promises.access(jsonlPath);
    } catch {
      // JSONL doesn't exist yet (agent still starting) — skip, will be picked up next scan
      return;
    }

    const manager = new SessionManager(sessionId, jsonlPath, workspaceKey);
    this.agents.set(sessionId, manager);
    try {
      await manager.update();
    } catch (err) {
      this.log.warn(`[teams] Initial update failed for ${sessionId}:`, err);
    }
  }

  /** Remove a team and dispose its SessionManagers (if not shared). */
  private removeTeam(teamId: string): void {
    const manifest = this.manifests.get(teamId);
    if (!manifest) { return; }

    // Collect all session IDs for this team
    const teamSessionIds = new Set<string>();
    teamSessionIds.add(manifest.orchestrator.sessionId);
    for (const agent of manifest.agents) {
      if (agent.sessionId) { teamSessionIds.add(agent.sessionId); }
    }

    // Only dispose sessions not claimed by another team
    const otherTeamSessionIds = new Set<string>();
    for (const [tid, m] of this.manifests) {
      if (tid === teamId) { continue; }
      otherTeamSessionIds.add(m.orchestrator.sessionId);
      for (const a of m.agents) { if (a.sessionId) { otherTeamSessionIds.add(a.sessionId); } }
    }

    for (const sid of teamSessionIds) {
      if (!otherTeamSessionIds.has(sid)) {
        const manager = this.agents.get(sid);
        if (manager) {
          manager.dispose();
          this.agents.delete(sid);
        }
      }
    }

    this.manifests.delete(teamId);
    this.manifestMtimes.delete(teamId);
  }

  /** Poll active team agents. Returns true if any changed. */
  async poll(): Promise<boolean> {
    let changed = false;

    // Partition into active vs dormant
    const active: SessionManager[] = [];
    const dormant: SessionManager[] = [];
    for (const agent of this.agents.values()) {
      const status = agent.getStatus();
      if (status === 'running' || status === 'waiting') {
        active.push(agent);
      } else {
        dormant.push(agent);
      }
    }

    // Stat-check dormant sessions in batches
    const woken: SessionManager[] = [];
    for (let i = 0; i < dormant.length; i += UPDATE_BATCH_SIZE) {
      const batch = dormant.slice(i, i + UPDATE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (session) => {
          try {
            return { session, mtimeChanged: await session.checkMtime() };
          } catch {
            return { session, mtimeChanged: false };
          }
        })
      );
      for (const { session, mtimeChanged } of results) {
        if (mtimeChanged) { woken.push(session); }
      }
    }

    // Full update for active + woken sessions
    const toUpdate = [...active, ...woken];
    for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + UPDATE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (session) => {
          try {
            return { hadData: await session.update() };
          } catch {
            return { hadData: false };
          }
        })
      );
      for (const { hadData } of results) {
        if (hadData) { changed = true; }
      }
    }

    // Demote stale active sessions
    for (const session of active) {
      if (session.demoteIfStale(30_000)) { changed = true; }
    }

    // Try to pick up JONLs for agents we don't have managers for yet
    for (const manifest of this.manifests.values()) {
      if (!this.agents.has(manifest.orchestrator.sessionId)) {
        await this.ensureSessionManager(manifest.orchestrator.sessionId, manifest.orchestrator.cwd);
        if (this.agents.has(manifest.orchestrator.sessionId)) { changed = true; }
      }
      for (const agent of manifest.agents) {
        if (agent.sessionId && !this.agents.has(agent.sessionId)) {
          await this.ensureSessionManager(agent.sessionId, agent.cwd);
          if (this.agents.has(agent.sessionId)) { changed = true; }
        }
      }
    }

    return changed;
  }

  /** Build team snapshots for the webview. */
  getTeamSnapshots(sessionMeta: Map<string, SessionMeta>): TeamSnapshot[] {
    const teams: TeamSnapshot[] = [];

    for (const [teamId, manifest] of this.manifests) {
      const orchManager = this.agents.get(manifest.orchestrator.sessionId);
      const orchSnapshot = orchManager?.getSnapshot();

      const orchStatus: DisplayStatus = orchSnapshot?.status ?? 'running';
      const orchActivity = orchSnapshot?.activity ?? 'Starting…';
      const orchConfidence: StatusConfidence = orchSnapshot?.confidence ?? 'low';

      const agentSnapshots: TeamAgentSnapshot[] = [];
      const counts: Record<string, number> = {};

      for (const entry of manifest.agents) {
        const manager = entry.sessionId ? this.agents.get(entry.sessionId) : undefined;
        const snapshot = manager?.getSnapshot();

        let status: DisplayStatus;
        if (snapshot) {
          status = snapshot.status;
        } else if (entry.completedAt !== null || entry.isActive === false) {
          status = 'done';
        } else if (entry.isActive === true) {
          status = 'running';
        } else {
          status = 'running'; // JSONL not yet available, agent is starting
        }

        counts[status] = (counts[status] ?? 0) + 1;

        agentSnapshots.push({
          sessionId: entry.sessionId,
          name: entry.name,
          cwd: entry.cwd,
          parentSessionId: entry.parentSessionId,
          depth: entry.depth,
          spawnedAt: entry.spawnedAt,
          status,
          activity: snapshot?.activity ?? '',
          confidence: snapshot?.confidence ?? 'low',
          subagents: snapshot?.subagents ?? [],
          contextTokens: snapshot?.contextTokens ?? 0,
          exitStatus: entry.exitStatus,
        });
      }

      // Check dismiss state (keyed as team:<teamId> in sessionMeta)
      const metaKey = `team:${teamId}`;
      const dismissed = sessionMeta.get(metaKey)?.dismissed ?? false;

      teams.push({
        teamId,
        name: manifest.orchestrator.name,
        orchestrator: {
          sessionId: manifest.orchestrator.sessionId,
          status: orchStatus,
          activity: orchActivity,
          confidence: orchConfidence,
          contextTokens: orchSnapshot?.contextTokens ?? 0,
          modelLabel: orchSnapshot?.modelLabel ?? '',
        },
        agents: agentSnapshots,
        counts,
        dismissed,
      });
    }

    // Sort: active teams first (any waiting/running agent), then by updatedAt
    teams.sort((a, b) => {
      const aActive = this.isTeamActive(a);
      const bActive = this.isTeamActive(b);
      if (aActive !== bActive) { return aActive ? -1 : 1; }
      const aUpdated = this.manifests.get(a.teamId)?.updatedAt ?? 0;
      const bUpdated = this.manifests.get(b.teamId)?.updatedAt ?? 0;
      return bUpdated - aUpdated;
    });

    return teams;
  }

  /** Whether a team has any active (running/waiting) agents or orchestrator. */
  private isTeamActive(team: TeamSnapshot): boolean {
    if (team.orchestrator.status === 'running' || team.orchestrator.status === 'waiting') {
      return true;
    }
    return team.agents.some(a => a.status === 'running' || a.status === 'waiting');
  }

  /** Get all session IDs claimed by active (non-dismissed) teams. */
  getClaimedSessionIds(sessionMeta: Map<string, SessionMeta>): Set<string> {
    const claimed = new Set<string>();
    for (const [teamId, manifest] of this.manifests) {
      const metaKey = `team:${teamId}`;
      if (sessionMeta.get(metaKey)?.dismissed) { continue; }
      claimed.add(manifest.orchestrator.sessionId);
      for (const agent of manifest.agents) {
        if (agent.sessionId) { claimed.add(agent.sessionId); }
      }
    }
    return claimed;
  }

  /** Get the file path for a team agent's JSONL (for transcript viewing). */
  getSessionFilePath(sessionId: string): string | null {
    return this.agents.get(sessionId)?.getFilePath() ?? null;
  }

  /** Whether a team agent session is currently running. */
  isSessionRunning(sessionId: string): boolean {
    const manager = this.agents.get(sessionId);
    return manager?.getStatus() === 'running';
  }

  dispose(): void {
    for (const agent of this.agents.values()) {
      agent.dispose();
    }
    this.agents.clear();
    this.manifests.clear();
    this.manifestMtimes.clear();
  }
}
