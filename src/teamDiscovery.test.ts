import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Required because TeamDiscovery transitively imports settings.ts → 'vscode'.
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionMeta } from './types.js';

// ── Mock SessionManager ─────────────────────────────────────────────

/** Fake SessionManager instances tracked for assertions */
const mockManagers = new Map<string, {
  sessionId: string;
  status: 'running' | 'waiting' | 'done';
  updated: number;
  disposed: boolean;
  mtimeChanged: boolean;
  staleResult: boolean;
  filePath: string;
  snapshot: Record<string, unknown> | null;
}>();

vi.mock('./sessionManager.js', () => ({
  SessionManager: class MockSessionManager {
    private _id: string;
    constructor(sessionId: string, filePath: string, _workspaceKey: string) {
      this._id = sessionId;
      mockManagers.set(sessionId, {
        sessionId,
        status: 'done',
        updated: 0,
        disposed: false,
        mtimeChanged: false,
        staleResult: false,
        filePath,
        snapshot: null,
      });
    }
    async update(): Promise<boolean> {
      const m = mockManagers.get(this._id)!;
      m.updated++;
      return true;
    }
    getStatus() { return mockManagers.get(this._id)!.status; }
    getSnapshot() { return mockManagers.get(this._id)!.snapshot; }
    async checkMtime(): Promise<boolean> { return mockManagers.get(this._id)!.mtimeChanged; }
    demoteIfStale(_ms: number): boolean { return mockManagers.get(this._id)!.staleResult; }
    dispose() { mockManagers.get(this._id)!.disposed = true; }
    getFilePath() { return mockManagers.get(this._id)!.filePath; }
  },
}));

// Import AFTER mock registration
const { TeamDiscovery } = await import('./teamDiscovery.js');

// ── Helpers ─────────────────────────────────────────────────────────
//
// Serac now reads ONLY native Agent Teams configs (the Cornice sidecar parser
// was removed). Agent Teams shape: a `<team-name>/config.json` with a lead
// member (its leadSessionId is the orchestrator session) and tmux members that
// carry NO own session id. So a scanned team produces exactly ONE
// SessionManager — the lead's; member status comes from the config, not a
// session. teamId is `at:<dir>`.

let tmpDir: string;
let teamsDir: string;
let projectsDir: string;
const PROJECT_CWD = '/Users/test/repos/project';

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

/** The workspace key the discovery is scoped to (matches PROJECT_CWD). */
const LOCAL_WS_KEY = PROJECT_CWD.replace(/[^a-zA-Z0-9]/g, '-');

function makeDiscovery(localWorkspaceKey: string = LOCAL_WS_KEY): InstanceType<typeof TeamDiscovery> {
  const td = new TeamDiscovery(projectsDir, localWorkspaceKey, log);
  // Override teamsDir to our temp location
  (td as Record<string, unknown>)['teamsDir'] = teamsDir;
  return td;
}

/** A member spec for teamConfig(): name + optional isActive (omit = "starting"). */
interface MemberSpec { name: string; isActive?: boolean; }

/** Build an Agent Teams config. The lead's leadSessionId is the orchestrator
 *  session; tmux members are the roster (sessionId always null on disk). */
function teamConfig(opts: {
  name?: string;
  leadSessionId?: string;
  leadCwd?: string;
  members?: MemberSpec[];
} = {}) {
  const name = opts.name ?? 'test-team';
  const leadCwd = opts.leadCwd ?? PROJECT_CWD;
  const lead = {
    agentId: `team-lead@${name}`, name: 'team-lead', agentType: 'team-lead',
    model: 'opus', joinedAt: Date.now(), tmuxPaneId: '', cwd: leadCwd, subscriptions: [],
  };
  const members = (opts.members ?? [{ name: 'worker', isActive: true }]).map(m => ({
    agentId: `${m.name}@${name}`, name: m.name, agentType: m.name, model: 'opus',
    joinedAt: Date.now(), tmuxPaneId: '%1', cwd: leadCwd, subscriptions: [], backendType: 'tmux',
    ...(m.isActive !== undefined ? { isActive: m.isActive } : {}),
  }));
  return {
    name,
    description: 'Test team',
    createdAt: Date.now(),
    leadAgentId: `team-lead@${name}`,
    leadSessionId: opts.leadSessionId ?? 'lead-001',
    members: [lead, ...members],
  };
}

/** Back-compat alias used by the getTeamAgentFilePath helpers below. */
function validAgentTeamsConfig(overrides: Record<string, unknown> = {}) {
  return { ...teamConfig(), ...overrides };
}

/** Write an Agent Teams config at ~/.claude/teams/<teamName>/config.json. */
function writeAgentTeamsConfig(teamName: string, config: Record<string, unknown>): void {
  const dir = path.join(teamsDir, teamName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

/** Create a dummy JSONL file so ensureSessionManager finds it */
function createJsonl(sessionId: string, cwd: string): void {
  const workspaceKey = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(projectsDir, workspaceKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '');
}

function emptyMeta(): Map<string, SessionMeta> {
  return new Map();
}

function dismissedMeta(teamId: string): Map<string, SessionMeta> {
  const meta = new Map<string, SessionMeta>();
  meta.set(`team:${teamId}`, {
    title: null, dismissed: true, acknowledged: false, acknowledgedAt: null, firstSeen: Date.now(),
  });
  return meta;
}

// ── Setup / Teardown ────────────────────────────────────────────────

beforeEach(() => {
  mockManagers.clear();
  log.info.mockClear();
  log.warn.mockClear();
  log.debug.mockClear();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-test-'));
  teamsDir = path.join(tmpDir, 'teams');
  projectsDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────

describe('TeamDiscovery', () => {
  describe('scan()', () => {
    it('discovers a config and creates a SessionManager for the lead', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      // Only the lead gets a SessionManager; tmux members carry no session id.
      expect(mockManagers.has('lead-001')).toBe(true);
      expect(mockManagers.get('lead-001')!.updated).toBe(1);
      // The roster member 'worker' has no session and therefore no manager.
      expect(mockManagers.size).toBe(1);

      td.dispose();
    });

    it('tolerates missing teams directory', async () => {
      fs.rmSync(teamsDir, { recursive: true });

      const td = makeDiscovery();
      await td.scan(); // Should not throw

      expect(mockManagers.size).toBe(0);
      td.dispose();
    });

    it('skips a config with malformed JSON', async () => {
      const dir = path.join(teamsDir, 'broken');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), '{ broken json');

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.size).toBe(0);
      expect(log.warn).toHaveBeenCalled();
      td.dispose();
    });

    it('skips flat (non-directory) files in the teams dir', async () => {
      // Flat .json files were the removed Cornice sidecars; they are now ignored.
      fs.writeFileSync(path.join(teamsDir, 'leftover.json'), JSON.stringify(teamConfig()));
      fs.writeFileSync(path.join(teamsDir, 'readme.txt'), 'ignore me');
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      // Only the directory-format team is discovered.
      expect(mockManagers.has('lead-001')).toBe(true);
      expect(mockManagers.size).toBe(1);
      td.dispose();
    });

    it('skips configs older than the age gate', async () => {
      writeAgentTeamsConfig('old-team', teamConfig());
      const filePath = path.join(teamsDir, 'old-team', 'config.json');
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(filePath, eightDaysAgo, eightDaysAgo);

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.size).toBe(0);
      td.dispose();
    });

    it('skips a team whose lead JSONL does not exist yet', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      // No lead JSONL created — the lead is "starting".

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.has('lead-001')).toBe(false);
      td.dispose();
    });

    it('does not re-parse an unchanged config on second scan', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();
      const firstUpdateCount = mockManagers.get('lead-001')!.updated;

      await td.scan();

      expect(mockManagers.get('lead-001')!.updated).toBe(firstUpdateCount);
      td.dispose();
    });

    it('handles multiple teams', async () => {
      writeAgentTeamsConfig('team-a', teamConfig({ name: 'team-a', leadSessionId: 'lead-001' }));
      writeAgentTeamsConfig('team-b', teamConfig({ name: 'team-b', leadSessionId: 'lead-002', leadCwd: '/Users/test/repos/other' }));
      createJsonl('lead-001', PROJECT_CWD);
      createJsonl('lead-002', '/Users/test/repos/other');

      const td = makeDiscovery();
      await td.scan();

      // One SessionManager per lead.
      expect(mockManagers.size).toBe(2);
      expect(mockManagers.has('lead-001')).toBe(true);
      expect(mockManagers.has('lead-002')).toBe(true);
      td.dispose();
    });

    it('discovers Agent Teams configs in subdirectories', async () => {
      writeAgentTeamsConfig('test-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.has('lead-001')).toBe(true);
      td.dispose();
    });

    it('uses at: prefix for Agent Teams teamIds', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].teamId).toBe('at:my-team');
      td.dispose();
    });

    it('skips subdirectories without config.json', async () => {
      const dir = path.join(teamsDir, 'empty-dir');
      fs.mkdirSync(dir, { recursive: true });

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.size).toBe(0);
      td.dispose();
    });

    it('prunes Agent Teams configs when the directory is removed', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();
      expect(mockManagers.has('lead-001')).toBe(true);

      fs.rmSync(path.join(teamsDir, 'my-team'), { recursive: true });
      await td.scan();

      expect(mockManagers.get('lead-001')!.disposed).toBe(true);
      td.dispose();
    });
  });

  describe('shouldRescan()', () => {
    it('returns true every 10th call', () => {
      const td = makeDiscovery();

      for (let i = 0; i < 9; i++) {
        expect(td.shouldRescan()).toBe(false);
      }
      expect(td.shouldRescan()).toBe(true);

      for (let i = 0; i < 9; i++) {
        expect(td.shouldRescan()).toBe(false);
      }
      expect(td.shouldRescan()).toBe(true);

      td.dispose();
    });
  });

  describe('hasActiveAgents()', () => {
    it('returns false when no teams exist', () => {
      const td = makeDiscovery();
      expect(td.hasActiveAgents()).toBe(false);
      td.dispose();
    });

    it('returns true when the lead is running', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('lead-001')!.status = 'running';

      expect(td.hasActiveAgents()).toBe(true);
      td.dispose();
    });

    it('returns true when the lead is waiting', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('lead-001')!.status = 'waiting';

      expect(td.hasActiveAgents()).toBe(true);
      td.dispose();
    });

    it('returns false when the lead is done', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      // Lead defaults to 'done' in the mock.
      expect(td.hasActiveAgents()).toBe(false);
      td.dispose();
    });
  });

  describe('poll()', () => {
    it('updates active sessions', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('lead-001')!.updated = 0;
      mockManagers.get('lead-001')!.status = 'running';

      const changed = await td.poll();

      expect(mockManagers.get('lead-001')!.updated).toBeGreaterThan(0);
      expect(changed).toBe(true);
      td.dispose();
    });

    it('stat-checks dormant sessions and updates woken ones', async () => {
      // Two teams (two leads), both dormant; only lead-002 has a changed mtime.
      writeAgentTeamsConfig('team-a', teamConfig({ name: 'team-a', leadSessionId: 'lead-001' }));
      writeAgentTeamsConfig('team-b', teamConfig({ name: 'team-b', leadSessionId: 'lead-002', leadCwd: '/Users/test/repos/other' }));
      createJsonl('lead-001', PROJECT_CWD);
      createJsonl('lead-002', '/Users/test/repos/other');

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('lead-001')!.updated = 0;
      mockManagers.get('lead-002')!.updated = 0;
      mockManagers.get('lead-002')!.mtimeChanged = true;

      const changed = await td.poll();

      expect(mockManagers.get('lead-002')!.updated).toBeGreaterThan(0);
      expect(mockManagers.get('lead-001')!.updated).toBe(0);
      expect(changed).toBe(true);
      td.dispose();
    });

    it('picks up the lead JSONL when it appears after the initial scan', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      // lead JSONL not yet created

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.has('lead-001')).toBe(false);

      createJsonl('lead-001', PROJECT_CWD);

      const changed = await td.poll();

      expect(mockManagers.has('lead-001')).toBe(true);
      expect(changed).toBe(true);
      td.dispose();
    });

    it('returns false when nothing changed', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('lead-001')!.updated = 0;

      const changed = await td.poll();

      expect(changed).toBe(false);
      td.dispose();
    });
  });

  describe('getTeamSnapshots()', () => {
    it('builds snapshots from config + lead session data', async () => {
      writeAgentTeamsConfig('my-team', teamConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('lead-001')!.snapshot = {
        status: 'running',
        activity: 'Planning tasks',
        confidence: 'high',
        contextTokens: 50000,
        modelLabel: 'Opus',
      };

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots).toHaveLength(1);
      const team = snapshots[0];
      expect(team.teamId).toBe('at:my-team');
      expect(team.name).toBe('test-team');
      expect(team.orchestrator.sessionId).toBe('lead-001');
      expect(team.orchestrator.status).toBe('running');
      expect(team.orchestrator.activity).toBe('Planning tasks');
      expect(team.orchestrator.modelLabel).toBe('Opus');
      // Roster: the single tmux member, status inferred from isActive (no session).
      expect(team.agents).toHaveLength(1);
      expect(team.agents[0].sessionId).toBeNull();
      expect(team.agents[0].name).toBe('worker');
      expect(team.agents[0].status).toBe('running');
      expect(team.dismissed).toBe(false);

      td.dispose();
    });

    it('infers running status for a member with no isActive flag (starting)', async () => {
      writeAgentTeamsConfig('my-team', teamConfig({ members: [{ name: 'worker' }] }));

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].agents[0].status).toBe('running');

      td.dispose();
    });

    it('marks a member done when isActive is false', async () => {
      writeAgentTeamsConfig('my-team', teamConfig({ members: [{ name: 'worker', isActive: false }] }));

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots[0].agents[0].status).toBe('done');
      // Agent Teams configs never carry an exit status.
      expect(snapshots[0].agents[0].exitStatus).toBeNull();

      td.dispose();
    });

    it('respects dismiss state from sessionMeta', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(dismissedMeta('at:my-team'));
      expect(snapshots[0].dismissed).toBe(true);

      td.dispose();
    });

    it('aggregates status counts', async () => {
      writeAgentTeamsConfig('my-team', teamConfig({
        members: [
          { name: 'worker-a', isActive: true },
          { name: 'worker-b', isActive: false },
        ],
      }));

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots[0].counts).toEqual({ running: 1, done: 1 });

      td.dispose();
    });

    it('sorts active teams before inactive teams', async () => {
      // Both teams are local (same workspace) so both pass the scoping filter.
      writeAgentTeamsConfig('team-done', teamConfig({
        name: 'team-done', leadSessionId: 'lead-001', members: [{ name: 'worker', isActive: false }],
      }));
      writeAgentTeamsConfig('team-active', teamConfig({
        name: 'team-active', leadSessionId: 'lead-002', members: [{ name: 'worker', isActive: true }],
      }));
      createJsonl('lead-001', PROJECT_CWD);
      createJsonl('lead-002', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      // The done team's lead is also done, so it has no active orchestrator either.
      mockManagers.get('lead-001')!.snapshot = {
        status: 'done', activity: '', confidence: 'high', contextTokens: 0, modelLabel: 'Opus',
      };

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots[0].name).toBe('team-active');
      expect(snapshots[1].name).toBe('team-done');

      td.dispose();
    });
  });

  describe('getClaimedSessionIds()', () => {
    it('returns the lead session id from non-dismissed teams', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());

      const td = makeDiscovery();
      await td.scan();

      const claimed = td.getClaimedSessionIds(emptyMeta());

      // Only the lead session is claimable; tmux members carry no session id.
      expect(claimed.has('lead-001')).toBe(true);
      expect(claimed.size).toBe(1);

      td.dispose();
    });

    it('excludes session IDs from dismissed teams', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());

      const td = makeDiscovery();
      await td.scan();

      const claimed = td.getClaimedSessionIds(dismissedMeta('at:my-team'));

      expect(claimed.size).toBe(0);

      td.dispose();
    });
  });

  describe('workspace scoping', () => {
    it('omits a team whose orchestrator runs in another workspace', async () => {
      // Local team (PROJECT_CWD) + foreign team (/other). Discovery is scoped to PROJECT_CWD.
      writeAgentTeamsConfig('local-team', teamConfig({ name: 'local-team', leadSessionId: 'lead-001' }));
      writeAgentTeamsConfig('foreign-team', teamConfig({ name: 'foreign-team', leadSessionId: 'lead-002', leadCwd: '/Users/test/repos/other' }));
      createJsonl('lead-001', PROJECT_CWD);
      createJsonl('lead-002', '/Users/test/repos/other');

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].teamId).toBe('at:local-team');

      // The foreign team must not claim sessions in this workspace either.
      const claimed = td.getClaimedSessionIds(emptyMeta());
      expect(claimed.has('lead-001')).toBe(true);
      expect(claimed.has('lead-002')).toBe(false);

      td.dispose();
    });

    it('surfaces a team in the workspace its orchestrator runs in', async () => {
      writeAgentTeamsConfig('foreign-team', teamConfig({ name: 'foreign-team', leadSessionId: 'lead-002', leadCwd: '/Users/test/repos/other' }));
      createJsonl('lead-002', '/Users/test/repos/other');

      // Scope this discovery to the /other workspace.
      const otherKey = '/Users/test/repos/other'.replace(/[^a-zA-Z0-9]/g, '-');
      const td = makeDiscovery(otherKey);
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].teamId).toBe('at:foreign-team');

      td.dispose();
    });
  });

  describe('getSessionFilePath()', () => {
    it('returns the JSONL path for the lead session', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      const filePath = td.getSessionFilePath('lead-001');
      expect(filePath).toContain('lead-001.jsonl');

      td.dispose();
    });

    it('returns null for unknown sessions', () => {
      const td = makeDiscovery();
      expect(td.getSessionFilePath('unknown')).toBeNull();
      td.dispose();
    });
  });

  describe('getTeamAgentFilePath()', () => {
    /** Write a transcript pair under the lead's subagents dir, the way an
     *  in-process member surfaces on disk: agent-<hash>.meta.json (carrying
     *  agentType) + sibling agent-<hash>.jsonl. Returns the jsonl path. */
    function writeLeadSubagent(leadSessionId: string, leadCwd: string, hash: string, agentType: string): string {
      const workspaceKey = leadCwd.replace(/[^a-zA-Z0-9]/g, '-');
      const subagentsDir = path.join(projectsDir, workspaceKey, leadSessionId, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, `agent-${hash}.meta.json`), JSON.stringify({ agentType }));
      const jsonl = path.join(subagentsDir, `agent-${hash}.jsonl`);
      fs.writeFileSync(jsonl, '');
      return jsonl;
    }

    it('resolves a null-sessionId member via the lead subagents meta.json agentType', async () => {
      writeAgentTeamsConfig('my-team', teamConfig({ members: [{ name: 'defender', isActive: true }] }));
      createJsonl('lead-001', PROJECT_CWD);
      const expected = writeLeadSubagent('lead-001', PROJECT_CWD, 'deadbeef', 'defender');

      const td = makeDiscovery();
      await td.scan();

      expect(td.getTeamAgentFilePath('at:my-team', 'defender')).toBe(expected);
      td.dispose();
    });

    it('picks the newest transcript when a member has duplicate meta files', async () => {
      writeAgentTeamsConfig('my-team', teamConfig({ members: [{ name: 'defender', isActive: true }] }));
      createJsonl('lead-001', PROJECT_CWD);
      const older = writeLeadSubagent('lead-001', PROJECT_CWD, 'aaa111', 'defender');
      const newer = writeLeadSubagent('lead-001', PROJECT_CWD, 'bbb222', 'defender');
      // Force a stale mtime on the older transcript so 'newer' wins.
      fs.utimesSync(older, new Date(2000, 0, 1), new Date(2000, 0, 1));

      const td = makeDiscovery();
      await td.scan();

      expect(td.getTeamAgentFilePath('at:my-team', 'defender')).toBe(newer);
      td.dispose();
    });

    it('does not collide with a plain Task subagent whose agentType is off-roster', async () => {
      writeAgentTeamsConfig('my-team', teamConfig({ members: [{ name: 'defender', isActive: true }] }));
      createJsonl('lead-001', PROJECT_CWD);
      // A non-roster agentType must never be returned for 'defender'.
      writeLeadSubagent('lead-001', PROJECT_CWD, 'cafe01', 'Explore');

      const td = makeDiscovery();
      await td.scan();

      expect(td.getTeamAgentFilePath('at:my-team', 'defender')).toBeNull();
      td.dispose();
    });

    it('returns null when the lead has no subagents dir yet', async () => {
      writeAgentTeamsConfig('my-team', teamConfig({ members: [{ name: 'defender', isActive: true }] }));
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      expect(td.getTeamAgentFilePath('at:my-team', 'defender')).toBeNull();
      td.dispose();
    });

    it('returns null for an unknown team or member', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      expect(td.getTeamAgentFilePath('no-such-team', 'worker')).toBeNull();
      expect(td.getTeamAgentFilePath('at:my-team', 'no-such-member')).toBeNull();
      td.dispose();
    });
  });

  describe('isSessionRunning()', () => {
    it('returns true for running sessions', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('lead-001')!.status = 'running';

      expect(td.isSessionRunning('lead-001')).toBe(true);

      td.dispose();
    });

    it('returns false for non-running sessions', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      expect(td.isSessionRunning('lead-001')).toBe(false);

      td.dispose();
    });

    it('returns false for unknown sessions', () => {
      const td = makeDiscovery();
      expect(td.isSessionRunning('unknown')).toBe(false);
      td.dispose();
    });
  });

  describe('dispose()', () => {
    it('disposes all SessionManagers and clears state', async () => {
      writeAgentTeamsConfig('my-team', validAgentTeamsConfig());
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();

      td.dispose();

      expect(mockManagers.get('lead-001')!.disposed).toBe(true);
    });
  });

  describe('shared sessions across teams', () => {
    it('does not dispose a lead session shared between two teams when one is removed', async () => {
      // Two team configs that (synthetically) share the same leadSessionId.
      writeAgentTeamsConfig('team-1', teamConfig({ name: 'team-1', leadSessionId: 'lead-001' }));
      writeAgentTeamsConfig('team-2', teamConfig({ name: 'team-2', leadSessionId: 'lead-001' }));
      createJsonl('lead-001', PROJECT_CWD);

      const td = makeDiscovery();
      await td.scan();
      expect(mockManagers.has('lead-001')).toBe(true);

      // Remove team-1; lead-001 is still claimed by team-2, so it must survive.
      fs.rmSync(path.join(teamsDir, 'team-1'), { recursive: true });
      await td.scan();

      expect(mockManagers.get('lead-001')!.disposed).toBe(false);

      td.dispose();
    });
  });
});
