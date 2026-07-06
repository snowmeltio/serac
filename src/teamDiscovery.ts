/**
 * Discovers and manages native Claude Code Agent Teams.
 *
 * Scans ~/.claude/teams/ for `<team-name>/config.json` files. Each config
 * describes a lead (orchestrator) and its members; TeamDiscovery creates a
 * SessionManager for the lead's JSONL (members carry no own session) and
 * produces TeamSnapshot[] for the webview.
 *
 * Modelled after ForeignWorkspaceManager: periodic scan + active/dormant polling.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { parseAgentTeamsConfig } from './teamManifest.js';
import { claudeStateDir } from './paths.js';
import { isValidSessionId } from './validation.js';
import type {
  TeamManifest, TeamSnapshot, TeamAgentSnapshot,
  SessionMeta, StatusConfidence, DisplayStatus,
} from './types.js';
import type { Logger } from './sessionDiscovery.js';
import { ageGateMsFor } from './settings.js';
import { makeRescanGate } from './sessionPolling.js';

/** A strict identifier used as a single on-disk path component for the inbox
 *  write path — no traversal, no separators, no leading dot. Stricter than
 *  isValidMemberName (which only has to be traversal-safe for discovery): the
 *  write path fails closed on anything outside this allowlist. */
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9_-]+$/;

/** Batch size for concurrent session updates (shared FD budget) */
const UPDATE_BATCH_SIZE = 50;

export class TeamDiscovery {
  private readonly teamsDir: string;
  private readonly projectsDir: string;
  /** Workspace key this discovery is scoped to. Teams whose orchestrator runs
   *  in a different workspace are read off disk but filtered out of the panel
   *  read paths, so a team only appears in its originating workspace's window. */
  private readonly localWorkspaceKey: string;
  private manifests: Map<string, TeamManifest> = new Map();
  /** All SessionManagers for team agents + orchestrators, keyed by sessionId */
  private agents: Map<string, SessionManager> = new Map();
  /** Last known mtime per manifest file (ms), for change detection */
  private manifestMtimes: Map<string, number> = new Map();

  /** Per-session registry liveness probe factory, injected by SessionDiscovery
   *  (freshness parity: team orchestrator sessions get the same death gate). */
  private probeFactory?: (sessionId: string) => () => boolean | null;
  /** Per-session writer-ownership probe factory, injected by SessionDiscovery —
   *  reports whether a *different* VS Code window is confirmed to be a
   *  session's live writer right now. Account-agnostic; see WriterOwnership. */
  private writerOwnershipProbeFactory?: (sessionId: string) => () => boolean | undefined;

  setLivenessProbeFactory(factory: (sessionId: string) => () => boolean | null): void {
    this.probeFactory = factory;
  }

  setWriterOwnershipProbeFactory(factory: (sessionId: string) => () => boolean | undefined): void {
    this.writerOwnershipProbeFactory = factory;
  }

  constructor(
    projectsDir: string,
    localWorkspaceKey: string,
    private readonly log: Logger,
  ) {
    this.projectsDir = projectsDir;
    this.localWorkspaceKey = localWorkspaceKey;
    this.teamsDir = path.join(claudeStateDir(), 'teams');
  }

  /** Whether a team's orchestrator runs in this discovery's workspace. Native
   *  Agent Teams are single-workspace (the lead runs in one cwd), so a simple
   *  equality on the sanitised lead cwd is exact. */
  private isLocalTeam(manifest: TeamManifest): boolean {
    return sanitiseWorkspaceKey(manifest.orchestrator.cwd) === this.localWorkspaceKey;
  }

  /** Whether it's time for a full rescan: every cycle when agents are active
   *  (pick up new spawns quickly), every Nth cycle when dormant. */
  private readonly rescanGate = makeRescanGate(() => this.hasActiveAgents());
  shouldRescan(): boolean {
    return this.rescanGate();
  }

  /** Whether any team agents are currently active (running/waiting). */
  hasActiveAgents(): boolean {
    for (const agent of this.agents.values()) {
      const status = agent.getStatus();
      if (status === 'running' || status === 'waiting') { return true; }
    }
    return false;
  }

  /** Scan ~/.claude/teams/ for team subdirectories containing a config.json.
   *  Flat (non-directory) entries are skipped — the flat sidecar format was
   *  the legacy Cornice shape, removed with native Agent Teams support. */
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
      // The directory name becomes the team id and (with `at:` stripped) the
      // on-disk path component for the inbox write path. isValidSessionId guards
      // the webview-supplied containerId but never the dir name itself, so guard
      // it here at the source: a strict identifier, never a traversal candidate.
      if (!/^[A-Za-z0-9._-]+$/.test(entry) || entry === '.' || entry === '..'
          || entry.includes('..') || entry.startsWith('.')) {
        continue;
      }
      const entryPath = path.join(this.teamsDir, entry);
      let entryStat: fs.Stats;
      try {
        entryStat = await fs.promises.lstat(entryPath);
      } catch { continue; }
      // Skip a symlinked teams/ entry — a planted symlink must never surface as
      // a messageable team (defence-in-depth alongside the write-path realpath check).
      if (entryStat.isSymbolicLink()) { continue; }

      let teamId: string;
      let filePath: string;
      let fstat: fs.Stats;

      if (entryStat.isDirectory()) {
        // Agent Teams format: <team-name>/config.json
        filePath = path.join(entryPath, 'config.json');
        try {
          fstat = await fs.promises.stat(filePath);
        } catch { continue; } // No config.json in this directory
        teamId = `at:${entry}`; // 'at:' namespaces the team id (historically also kept it clear of the removed Cornice flat-sidecar ids)
      } else {
        // Only the Agent Teams directory format is supported. Flat <id>.json
        // entries were the removed Cornice sidecars — skip them.
        continue;
      }

      // Age gate
      if (now - fstat.mtimeMs > ageGateMsFor('teams')) { continue; }

      // Skip re-parse if mtime unchanged
      seenTeamIds.add(teamId);
      const lastMtime = this.manifestMtimes.get(teamId) ?? 0;
      if (fstat.mtimeMs === lastMtime && this.manifests.has(teamId)) { continue; }

      // Cap the manifest read — a planted multi-GB config.json would otherwise be
      // slurped whole on every scan (mirrors the meta.json size cap below). A
      // real Agent Teams config is a few KB.
      if (fstat.size > 1024 * 1024) {
        this.log.warn(`[teams] Manifest exceeds size cap, skipping: ${entry}`);
        continue;
      }

      let content: string;
      try {
        content = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        this.log.warn(`[teams] Failed to read manifest: ${entry}`);
        continue;
      }

      const manifest = parseAgentTeamsConfig(content, entry);
      if (!manifest) {
        this.log.warn(`[teams] Skipping malformed manifest: ${entry}`);
        // A previously-valid config that became malformed must not keep its
        // stale manifest — it would keep rendering a roster and suppressing the
        // orchestrator's plain session card. Evict it (removeTeam also clears
        // manifestMtimes so the next scan re-reads rather than short-circuiting).
        // teamId stays in seenTeamIds (line above), so the end-of-scan prune
        // won't double-handle it.
        if (this.manifests.has(teamId)) { this.removeTeam(teamId); }
        continue;
      }

      this.manifestMtimes.set(teamId, fstat.mtimeMs);
      this.manifests.set(teamId, manifest);

      // Only tail LOCAL teams' sessions. A team led from another workspace
      // renders nowhere in this window, and tailing it would both hold open
      // fds and let its activity drive every other window onto the 500ms fast
      // cadence (hasActiveAgents feeds sessionDiscovery.hasActiveSessions).
      // The manifest stays parsed so prune bookkeeping is unaffected; any
      // managers created before the team moved (or by older builds) are
      // released here.
      if (!this.isLocalTeam(manifest)) {
        this.disposeTeamManagers(teamId);
        continue;
      }

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

    const manager = new SessionManager(sessionId, jsonlPath, workspaceKey, {
      livenessProbe: this.probeFactory?.(sessionId),
      writerOwnershipProbe: this.writerOwnershipProbeFactory?.(sessionId),
    });
    this.agents.set(sessionId, manager);
    try {
      await manager.update();
    } catch (err) {
      this.log.warn(`[teams] Initial update failed for ${sessionId}:`, err);
    }
  }

  /** Remove a team and dispose its SessionManagers (if not shared). */
  private removeTeam(teamId: string): void {
    if (!this.manifests.has(teamId)) { return; }
    this.disposeTeamManagers(teamId);
    this.manifests.delete(teamId);
    this.manifestMtimes.delete(teamId);
  }

  /** Dispose a team's SessionManagers, sparing any session another team still
   *  claims. Used on team removal and when a known team turns out non-local. */
  private disposeTeamManagers(teamId: string): void {
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

    // Try to pick up JSONLs for agents we don't have managers for yet
    for (const manifest of this.manifests.values()) {
      // Non-local teams are parsed but never tailed (see scan()).
      if (!this.isLocalTeam(manifest)) { continue; }
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
      // Only surface teams that originate in this workspace.
      if (!this.isLocalTeam(manifest)) { continue; }

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
        } else if (entry.isActive === false) {
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
        inProcessMembers: manifest.inProcessMembers,
        counts,
        updatedAt: orchSnapshot?.lastActivity ?? manifest.updatedAt,
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

  /** Get MEMBER session IDs claimed by active (non-dismissed) teams.
   *
   *  The orchestrator is deliberately NOT claimed. Pre-v1.11 it was, because
   *  the team section rendered its own orchestrator representation and the
   *  plain session card would have duplicated it. v1.11 removed the team
   *  section — "the team folds into the orchestrator's NORMAL card" — which
   *  makes that card the team's ONLY surface. Claiming it left active teams
   *  with no card at all (found live 2026-06-10: the serac-showcase lead was
   *  invisible in its own workspace's panel). Member sessions stay claimable:
   *  if a future config exposes their ids, they're represented by the roster
   *  and must not double-render as standalone cards. */
  getClaimedSessionIds(sessionMeta: Map<string, SessionMeta>): Set<string> {
    const claimed = new Set<string>();
    for (const [teamId, manifest] of this.manifests) {
      // Symmetric with getTeamSnapshots: a team only claims sessions in the
      // workspace it surfaces in, so a foreign team can't suppress local cards.
      if (!this.isLocalTeam(manifest)) { continue; }
      const metaKey = `team:${teamId}`;
      if (sessionMeta.get(metaKey)?.dismissed) { continue; }
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

  /** Resolve a team member's transcript JSONL by member NAME, for the detail
   *  panel's per-agent reader. Two cases:
   *   1. Member has its own sessionId → its JSONL. (Defensive: Agent Teams
   *      members carry no session id, so this branch is currently unreachable;
   *      it matches the nullable type and any future session-bearing member.)
   *   2. In-process member (sessionId null, spawned from inside the lead) → it
   *      writes to `<leadDir>/subagents/agent-<hash>.jsonl`, and the only bridge
   *      from member name to hash is the sibling `agent-<hash>.meta.json` whose
   *      `agentType` equals the member name (verified against native Agent Teams).
   *  Returns null when the team/member is unknown or no transcript exists yet. */
  getTeamAgentFilePath(teamId: string, agentName: string): string | null {
    const manifest = this.manifests.get(teamId);
    if (!manifest) { return null; }

    // The member must be on the CURRENT roster: a tmux entry in `agents`, or an
    // in-process name (those are excluded from `agents` by design — they surface
    // as the lead's subagents — but their transcripts resolve via case 2 below).
    const member = manifest.agents.find(a => a.name === agentName);
    if (!member && !manifest.inProcessMembers.includes(agentName)) { return null; }

    // Case 1: the member has its own session — resolve directly.
    if (member?.sessionId) {
      return this.getSessionFilePath(member.sessionId);
    }

    // Case 2: in-process member. Scan the lead's subagents dir for a meta.json
    // whose agentType matches a roster name; pick the one matching this member.
    // Re-runs leave stale duplicates, so prefer the newest by mtime. Match only
    // against roster names so this can't collide with a plain Task subagent.
    const leadWorkspaceKey = sanitiseWorkspaceKey(manifest.orchestrator.cwd);
    const subagentsDir = path.join(
      this.projectsDir, leadWorkspaceKey, manifest.orchestrator.sessionId, 'subagents',
    );
    const rosterNames = new Set([...manifest.agents.map(a => a.name), ...manifest.inProcessMembers]);

    let files: string[];
    try {
      files = fs.readdirSync(subagentsDir);
    } catch {
      return null; // no subagents dir yet
    }

    let best: { jsonl: string; mtime: number } | null = null;
    for (const f of files) {
      if (!f.endsWith('.meta.json')) { continue; }
      const metaPath = path.join(subagentsDir, f);
      let agentType: unknown;
      try {
        if (fs.statSync(metaPath).size > 64 * 1024) { continue; } // size cap (matches resolveInboxTarget)
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        agentType = parsed?.agentType;
      } catch {
        continue; // unreadable/corrupt meta — skip
      }
      if (typeof agentType !== 'string' || !rosterNames.has(agentType)) { continue; }
      if (agentType !== agentName) { continue; }

      const jsonl = metaPath.replace(/\.meta\.json$/, '.jsonl');
      let mtime: number;
      try {
        mtime = fs.statSync(jsonl).mtimeMs;
      } catch {
        continue; // sibling transcript missing — skip
      }
      if (!best || mtime > best.mtime) { best = { jsonl, mtime }; }
    }

    return best?.jsonl ?? null;
  }

  /**
   * Resolve the inbox write target for an in-process teammate selected in the
   * detail panel (the subagents source): map the orchestrator session + the
   * webview's subagent hash to the on-disk team directory and roster member
   * name. Reads the ONE `agent-<hash>.meta.json` directly (no full-dir scan —
   * avoids a synchronous enumeration DoS), size-caps the trusted read, and
   * accepts the member only if its `agentType` is a current roster name; both
   * the dir and member must be strict path components. Returns null (= refuse)
   * on any mismatch. The caller still realpath-confines the final path.
   */
  resolveInboxTarget(orchestratorSessionId: string, agentId: string): { teamDir: string; member: string } | null {
    if (!isValidSessionId(orchestratorSessionId) || !isValidSessionId(agentId) || agentId.length > 64) { return null; }

    let teamId: string | null = null;
    let manifest: TeamManifest | null = null;
    for (const [id, m] of this.manifests) {
      if (m.orchestrator.sessionId === orchestratorSessionId) { teamId = id; manifest = m; break; }
    }
    if (!teamId || !manifest || !teamId.startsWith('at:')) { return null; }
    const teamDir = teamId.slice(3);
    if (!SAFE_PATH_COMPONENT.test(teamDir)) { return null; }

    // hash → member name via the SPECIFIC meta file (agentId is path-safe + bounded).
    const metaPath = path.join(
      this.projectsDir, sanitiseWorkspaceKey(manifest.orchestrator.cwd),
      manifest.orchestrator.sessionId, 'subagents', `agent-${agentId}.meta.json`,
    );
    let agentType: unknown;
    try {
      if (fs.statSync(metaPath).size > 64 * 1024) { return null; } // cap the trusted meta read
      const parsed: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      agentType = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>).agentType : undefined;
    } catch {
      return null;
    }

    // Roster = tmux members + in-process member names. In-process members are
    // the composer's whole audience (they're the lead's subagents) yet they are
    // excluded from `agents` by design — without the union every send refuses.
    const rosterNames = new Set([...manifest.agents.map(a => a.name), ...manifest.inProcessMembers]);
    if (typeof agentType !== 'string' || !rosterNames.has(agentType) || !SAFE_PATH_COMPONENT.test(agentType)) {
      return null;
    }
    return { teamDir, member: agentType };
  }

  /** The absolute `~/.claude/teams` directory this discovery scans. Exposed so
   *  the teammate-inbox writer is anchored to the SAME root the scan validated
   *  (single source of truth for the write-path confinement). */
  getTeamsDir(): string {
    return this.teamsDir;
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
