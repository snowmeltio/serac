import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

let tmpDir: string;
let teamsDir: string;
let projectsDir: string;

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeDiscovery(): InstanceType<typeof TeamDiscovery> {
  const td = new TeamDiscovery(projectsDir, log);
  // Override teamsDir to our temp location
  (td as Record<string, unknown>)['teamsDir'] = teamsDir;
  return td;
}

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    orchestrator: {
      sessionId: 'orch-001',
      name: 'Test Team',
      startedAt: new Date().toISOString(),
      cwd: '/Users/test/repos/project',
    },
    agents: [
      {
        sessionId: 'agent-001',
        name: 'research-task',
        cwd: '/Users/test/repos/project',
        parentSessionId: 'orch-001',
        depth: 1,
        spawnedAt: new Date().toISOString(),
        completedAt: null,
        exitStatus: null,
      },
    ],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeManifest(teamId: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(teamsDir, `${teamId}.json`),
    JSON.stringify(manifest),
  );
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
    it('discovers manifests and creates SessionManagers for known JONLs', async () => {
      const manifest = validManifest();
      writeManifest('team-1', manifest);
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Both orchestrator and agent should have SessionManagers
      expect(mockManagers.has('orch-001')).toBe(true);
      expect(mockManagers.has('agent-001')).toBe(true);

      // Initial update() should have been called
      expect(mockManagers.get('orch-001')!.updated).toBe(1);
      expect(mockManagers.get('agent-001')!.updated).toBe(1);

      td.dispose();
    });

    it('tolerates missing teams directory', async () => {
      // Remove the teams dir
      fs.rmSync(teamsDir, { recursive: true });

      const td = makeDiscovery();
      await td.scan(); // Should not throw

      expect(mockManagers.size).toBe(0);
      td.dispose();
    });

    it('skips malformed manifests', async () => {
      fs.writeFileSync(path.join(teamsDir, 'bad.json'), '{ broken json');

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.size).toBe(0);
      expect(log.warn).toHaveBeenCalled();
      td.dispose();
    });

    it('skips non-JSON files', async () => {
      fs.writeFileSync(path.join(teamsDir, 'readme.txt'), 'ignore me');
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Only the valid manifest should be processed
      expect(mockManagers.has('orch-001')).toBe(true);
      td.dispose();
    });

    it('skips manifests older than 7 days', async () => {
      writeManifest('old-team', validManifest());

      // Backdate the file to 8 days ago
      const filePath = path.join(teamsDir, 'old-team.json');
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(filePath, eightDaysAgo, eightDaysAgo);

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.size).toBe(0);
      td.dispose();
    });

    it('skips agents whose JSONL does not exist yet', async () => {
      writeManifest('team-1', validManifest());
      // Only create orchestrator JSONL, not agent
      createJsonl('orch-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.has('orch-001')).toBe(true);
      expect(mockManagers.has('agent-001')).toBe(false);
      td.dispose();
    });

    it('does not re-parse unchanged manifest on second scan', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();
      const firstUpdateCount = mockManagers.get('orch-001')!.updated;

      // Second scan without mtime change — should not re-create managers
      await td.scan();

      // Manager should not have been recreated (still same instance with same update count)
      expect(mockManagers.get('orch-001')!.updated).toBe(firstUpdateCount);
      td.dispose();
    });

    it('prunes manifests whose files have been deleted', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.has('orch-001')).toBe(true);

      // Delete the manifest
      fs.unlinkSync(path.join(teamsDir, 'team-1.json'));
      await td.scan();

      // Managers should be disposed
      expect(mockManagers.get('orch-001')!.disposed).toBe(true);
      expect(mockManagers.get('agent-001')!.disposed).toBe(true);
      td.dispose();
    });

    it('handles multiple manifests', async () => {
      const m1 = validManifest();
      const m2 = validManifest({
        orchestrator: {
          sessionId: 'orch-002',
          name: 'Second Team',
          startedAt: new Date().toISOString(),
          cwd: '/Users/test/repos/other',
        },
        agents: [{
          sessionId: 'agent-002',
          name: 'other-task',
          cwd: '/Users/test/repos/other',
          parentSessionId: 'orch-002',
          depth: 1,
          spawnedAt: new Date().toISOString(),
          completedAt: null,
          exitStatus: null,
        }],
      });

      writeManifest('team-1', m1);
      writeManifest('team-2', m2);
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');
      createJsonl('orch-002', '/Users/test/repos/other');
      createJsonl('agent-002', '/Users/test/repos/other');

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.size).toBe(4);
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

      // Resets — next 9 are false
      for (let i = 0; i < 9; i++) {
        expect(td.shouldRescan()).toBe(false);
      }
      expect(td.shouldRescan()).toBe(true);

      td.dispose();
    });
  });

  describe('hasActiveAgents()', () => {
    it('returns false when no agents exist', () => {
      const td = makeDiscovery();
      expect(td.hasActiveAgents()).toBe(false);
      td.dispose();
    });

    it('returns true when an agent is running', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Set one agent to running
      mockManagers.get('agent-001')!.status = 'running';

      expect(td.hasActiveAgents()).toBe(true);
      td.dispose();
    });

    it('returns true when an agent is waiting', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('agent-001')!.status = 'waiting';

      expect(td.hasActiveAgents()).toBe(true);
      td.dispose();
    });

    it('returns false when all agents are done', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Both default to 'done' in our mock
      expect(td.hasActiveAgents()).toBe(false);
      td.dispose();
    });
  });

  describe('poll()', () => {
    it('updates active sessions', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Reset update counts after initial scan
      mockManagers.get('orch-001')!.updated = 0;
      mockManagers.get('agent-001')!.updated = 0;

      // Mark orchestrator as running
      mockManagers.get('orch-001')!.status = 'running';

      const changed = await td.poll();

      // Running session should have been updated
      expect(mockManagers.get('orch-001')!.updated).toBeGreaterThan(0);
      expect(changed).toBe(true);
      td.dispose();
    });

    it('stat-checks dormant sessions and updates woken ones', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Reset counts
      mockManagers.get('orch-001')!.updated = 0;
      mockManagers.get('agent-001')!.updated = 0;

      // Both are done (dormant). Agent has changed mtime.
      mockManagers.get('agent-001')!.mtimeChanged = true;

      const changed = await td.poll();

      // Woken session should get a full update
      expect(mockManagers.get('agent-001')!.updated).toBeGreaterThan(0);
      // Dormant with no mtime change should NOT get updated
      expect(mockManagers.get('orch-001')!.updated).toBe(0);
      expect(changed).toBe(true);
      td.dispose();
    });

    it('picks up JONLs for agents that appeared after initial scan', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      // agent-001 JSONL not yet created

      const td = makeDiscovery();
      await td.scan();

      expect(mockManagers.has('agent-001')).toBe(false);

      // Now create the JSONL
      createJsonl('agent-001', '/Users/test/repos/project');

      const changed = await td.poll();

      expect(mockManagers.has('agent-001')).toBe(true);
      expect(changed).toBe(true);
      td.dispose();
    });

    it('returns false when nothing changed', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Reset — all dormant, no mtime changes
      mockManagers.get('orch-001')!.updated = 0;
      mockManagers.get('agent-001')!.updated = 0;

      const changed = await td.poll();

      expect(changed).toBe(false);
      td.dispose();
    });
  });

  describe('getTeamSnapshots()', () => {
    it('builds snapshots from manifest + session data', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Set up snapshot data
      mockManagers.get('orch-001')!.snapshot = {
        status: 'running',
        activity: 'Planning tasks',
        confidence: 'high',
        contextTokens: 50000,
        modelLabel: 'Opus',
      };
      mockManagers.get('agent-001')!.snapshot = {
        status: 'running',
        activity: 'Researching competitors',
        confidence: 'high',
        subagents: [],
        contextTokens: 30000,
      };

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots).toHaveLength(1);
      const team = snapshots[0];
      expect(team.teamId).toBe('team-1');
      expect(team.name).toBe('Test Team');
      expect(team.orchestrator.sessionId).toBe('orch-001');
      expect(team.orchestrator.status).toBe('running');
      expect(team.orchestrator.activity).toBe('Planning tasks');
      expect(team.orchestrator.modelLabel).toBe('Opus');
      expect(team.agents).toHaveLength(1);
      expect(team.agents[0].sessionId).toBe('agent-001');
      expect(team.agents[0].name).toBe('research-task');
      expect(team.agents[0].status).toBe('running');
      expect(team.agents[0].activity).toBe('Researching competitors');
      expect(team.dismissed).toBe(false);

      td.dispose();
    });

    it('infers running status for agents without JSONL yet', async () => {
      writeManifest('team-1', validManifest());
      // No JONLs created — agents are "starting"

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots).toHaveLength(1);
      // Agent without JSONL and no completedAt → running (starting)
      expect(snapshots[0].agents[0].status).toBe('running');

      td.dispose();
    });

    it('uses done status for agents with completedAt in manifest', async () => {
      const manifest = validManifest();
      (manifest.agents[0] as Record<string, unknown>).completedAt = new Date().toISOString();
      (manifest.agents[0] as Record<string, unknown>).exitStatus = 'success';
      writeManifest('team-1', manifest);
      // No JSONL — but completedAt is set

      const td = makeDiscovery();
      await td.scan();

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots[0].agents[0].status).toBe('done');
      expect(snapshots[0].agents[0].exitStatus).toBe('success');

      td.dispose();
    });

    it('respects dismiss state from sessionMeta', async () => {
      writeManifest('team-1', validManifest());

      const td = makeDiscovery();
      await td.scan();

      const meta = new Map<string, SessionMeta>();
      meta.set('team:team-1', {
        title: null,
        dismissed: true,
        acknowledged: false,
        acknowledgedAt: null,
        firstSeen: Date.now(),
      });

      const snapshots = td.getTeamSnapshots(meta);
      expect(snapshots[0].dismissed).toBe(true);

      td.dispose();
    });

    it('aggregates status counts', async () => {
      const manifest = validManifest();
      manifest.agents.push({
        sessionId: 'agent-002',
        name: 'second-task',
        cwd: '/Users/test/repos/project',
        parentSessionId: 'orch-001',
        depth: 1,
        spawnedAt: new Date().toISOString(),
        completedAt: null,
        exitStatus: null,
      });
      writeManifest('team-1', manifest);
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');
      createJsonl('agent-002', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // One running, one done
      mockManagers.get('agent-001')!.snapshot = {
        status: 'running', activity: '', confidence: 'high', subagents: [], contextTokens: 0,
      };
      mockManagers.get('agent-002')!.snapshot = {
        status: 'done', activity: '', confidence: 'high', subagents: [], contextTokens: 0,
      };

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots[0].counts).toEqual({ running: 1, done: 1 });

      td.dispose();
    });

    it('sorts active teams before inactive teams', async () => {
      const m1 = validManifest();
      const m2 = validManifest({
        orchestrator: {
          sessionId: 'orch-002',
          name: 'Active Team',
          startedAt: new Date().toISOString(),
          cwd: '/Users/test/repos/other',
        },
        agents: [{
          sessionId: 'agent-002',
          name: 'active-agent',
          cwd: '/Users/test/repos/other',
          parentSessionId: 'orch-002',
          depth: 1,
          spawnedAt: new Date().toISOString(),
          completedAt: null,
          exitStatus: null,
        }],
      });

      writeManifest('team-done', m1);
      writeManifest('team-active', m2);
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');
      createJsonl('orch-002', '/Users/test/repos/other');
      createJsonl('agent-002', '/Users/test/repos/other');

      const td = makeDiscovery();
      await td.scan();

      // team-active has a running agent
      mockManagers.get('agent-002')!.snapshot = {
        status: 'running', activity: '', confidence: 'high', subagents: [], contextTokens: 0,
      };
      mockManagers.get('agent-002')!.status = 'running';

      const snapshots = td.getTeamSnapshots(emptyMeta());

      expect(snapshots[0].name).toBe('Active Team');
      expect(snapshots[1].name).toBe('Test Team');

      td.dispose();
    });
  });

  describe('getClaimedSessionIds()', () => {
    it('returns all session IDs from non-dismissed teams', async () => {
      writeManifest('team-1', validManifest());

      const td = makeDiscovery();
      await td.scan();

      const claimed = td.getClaimedSessionIds(emptyMeta());

      expect(claimed.has('orch-001')).toBe(true);
      expect(claimed.has('agent-001')).toBe(true);
      expect(claimed.size).toBe(2);

      td.dispose();
    });

    it('excludes session IDs from dismissed teams', async () => {
      writeManifest('team-1', validManifest());

      const td = makeDiscovery();
      await td.scan();

      const meta = new Map<string, SessionMeta>();
      meta.set('team:team-1', {
        title: null,
        dismissed: true,
        acknowledged: false,
        acknowledgedAt: null,
        firstSeen: Date.now(),
      });

      const claimed = td.getClaimedSessionIds(meta);

      expect(claimed.size).toBe(0);

      td.dispose();
    });
  });

  describe('getSessionFilePath()', () => {
    it('returns JSONL path for known sessions', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      const filePath = td.getSessionFilePath('orch-001');
      expect(filePath).toContain('orch-001.jsonl');

      td.dispose();
    });

    it('returns null for unknown sessions', () => {
      const td = makeDiscovery();
      expect(td.getSessionFilePath('unknown')).toBeNull();
      td.dispose();
    });
  });

  describe('isSessionRunning()', () => {
    it('returns true for running sessions', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      mockManagers.get('orch-001')!.status = 'running';

      expect(td.isSessionRunning('orch-001')).toBe(true);

      td.dispose();
    });

    it('returns false for non-running sessions', async () => {
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      expect(td.isSessionRunning('orch-001')).toBe(false);

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
      writeManifest('team-1', validManifest());
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      td.dispose();

      expect(mockManagers.get('orch-001')!.disposed).toBe(true);
      expect(mockManagers.get('agent-001')!.disposed).toBe(true);
    });
  });

  describe('shared sessions across teams', () => {
    it('does not dispose a session shared between two teams when one is removed', async () => {
      // Two teams share orch-001
      const m1 = validManifest();
      const m2 = validManifest({
        orchestrator: {
          sessionId: 'orch-002',
          name: 'Second Team',
          startedAt: new Date().toISOString(),
          cwd: '/Users/test/repos/project',
        },
        agents: [{
          sessionId: 'orch-001', // shared with team-1's orchestrator
          name: 'reuse-agent',
          cwd: '/Users/test/repos/project',
          parentSessionId: 'orch-002',
          depth: 1,
          spawnedAt: new Date().toISOString(),
          completedAt: null,
          exitStatus: null,
        }],
      });

      writeManifest('team-1', m1);
      writeManifest('team-2', m2);
      createJsonl('orch-001', '/Users/test/repos/project');
      createJsonl('agent-001', '/Users/test/repos/project');
      createJsonl('orch-002', '/Users/test/repos/project');

      const td = makeDiscovery();
      await td.scan();

      // Delete team-1
      fs.unlinkSync(path.join(teamsDir, 'team-1.json'));
      await td.scan();

      // orch-001 is shared with team-2, should NOT be disposed
      expect(mockManagers.get('orch-001')!.disposed).toBe(false);
      // agent-001 was only in team-1, should be disposed
      expect(mockManagers.get('agent-001')!.disposed).toBe(true);

      td.dispose();
    });
  });
});
