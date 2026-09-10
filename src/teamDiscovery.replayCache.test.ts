/**
 * Replay-cache wiring for TeamDiscovery — the team-lead counterpart to the
 * "replay-cache hydration" describe blocks in foreignWorkspaceManager.test.ts
 * and siblingWorktreeManager.test.ts. See ARCHITECTURE.md "Replay cache" →
 * Wiring.
 *
 * A SEPARATE file from teamDiscovery.test.ts on purpose: that file mocks
 * `./sessionManager.js` wholesale (fine for its own status-machine-agnostic
 * scan/poll/snapshot tests), but hydration and offer-to-cache are properties
 * of the REAL SessionManager + JsonlTailer, so this file uses real fs
 * fixtures and the real modules throughout — no mocking beyond `vscode`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Required because TeamDiscovery transitively imports settings.ts → 'vscode'.
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TeamDiscovery } from './teamDiscovery.js';
import { JsonlTailer } from './jsonlTailer.js';
import type { ReplayCacheEntry, ReplayCacheStore } from './replayCache.js';
import type { CachedSessionState, SessionMeta } from './types.js';

const silentLog = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, trace: () => {} };

let tmpDir: string;
let teamsDir: string;
let projectsDir: string;
const PROJECT_CWD = '/Users/test/repos/project';

function sanitiseKey(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Build a TeamDiscovery scoped to the temp teamsDir (mirrors teamDiscovery.test.ts's makeDiscovery). */
function makeDiscovery(localWorkspaceKey: string = sanitiseKey(PROJECT_CWD)): TeamDiscovery {
  const td = new TeamDiscovery(projectsDir, localWorkspaceKey, silentLog);
  (td as unknown as Record<string, unknown>)['teamsDir'] = teamsDir;
  return td;
}

/** Write a minimal Agent Teams config: one lead, no tmux members. */
function writeTeamConfig(teamName: string, leadSessionId: string, leadCwd: string): void {
  const dir = path.join(teamsDir, teamName);
  fs.mkdirSync(dir, { recursive: true });
  const config = {
    name: teamName,
    description: 'Test team',
    createdAt: Date.now(),
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId,
    members: [
      {
        agentId: `team-lead@${teamName}`, name: 'team-lead', agentType: 'team-lead',
        model: 'opus', joinedAt: Date.now(), tmuxPaneId: '', cwd: leadCwd, subscriptions: [],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

/** Write a trivial (never-processed) JSONL for the lead — enough for the
 *  existence stat and a hydration test, which never reads its content. */
function writeTrivialJsonl(sessionId: string, cwd: string): string {
  const workspaceKey = sanitiseKey(cwd);
  const dir = path.join(projectsDir, workspaceKey);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const record = JSON.stringify({
    type: 'user',
    cwd,
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text: 'Hello' }] },
  });
  fs.writeFileSync(filePath, record + '\n');
  return filePath;
}

function fakeStore(entries: Map<string, ReplayCacheEntry> = new Map()): ReplayCacheStore & { putSpy: ReturnType<typeof vi.fn> } {
  const putSpy = vi.fn();
  return {
    load: async () => ({ entries: entries.size, droppedKeys: 0 }),
    get: (p: string) => entries.get(p),
    put: (p: string, entry: ReplayCacheEntry) => { putSpy(p, entry); entries.set(p, entry); },
    flush: async () => {},
    putSpy,
  };
}

function emptyMeta(): Map<string, SessionMeta> {
  return new Map();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-replay-'));
  teamsDir = path.join(tmpDir, 'teams');
  projectsDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks(); // JsonlTailer.prototype spy below
  vi.useRealTimers();
});

describe('TeamDiscovery: replay-cache hydration', () => {
  it('hydrates a dormant team-lead session from the cache — no re-read', async () => {
    writeTeamConfig('my-team', 'lead-hydrate-1', PROJECT_CWD);
    const filePath = writeTrivialJsonl('lead-hydrate-1', PROJECT_CWD);
    const stat = fs.statSync(filePath);

    const state: CachedSessionState = {
      sessionId: 'lead-hydrate-1', slug: 'lead-hydrate-1', workspaceKey: sanitiseKey(PROJECT_CWD),
      cwd: PROJECT_CWD, initialCwd: PROJECT_CWD,
      topic: 'Cached lead topic', activity: 'Idle', status: 'done',
      lastActivity: Date.now() - 20 * 60_000, firstActivity: Date.now() - 20 * 60_000,
      enqueuedAt: 0, contextTokens: 10, modelId: '', modelConfirmed: false,
      customTitle: '', aiTitle: 'Cached lead title', userTurnCount: 1, subagents: [],
    };
    const entries = new Map<string, ReplayCacheEntry>([
      [filePath, { size: stat.size, mtimeMs: stat.mtimeMs, cachedAt: Date.now(), state }],
    ]);

    const td = makeDiscovery();
    td.setReplayCache(fakeStore(entries));

    const readSpy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords');
    await td.scan();

    expect(readSpy).not.toHaveBeenCalled();

    const snap = td.getTeamSnapshots(emptyMeta()).find(t => t.teamId === 'at:my-team');
    expect(snap).toBeDefined();
    // The topic came from the HYDRATED (cached) state, not a real read.
    expect(snap?.orchestrator.status).toBe('done');

    td.dispose();
  });

  it('replays when the cache entry stamp does not match the file on disk', async () => {
    writeTeamConfig('my-team', 'lead-hydrate-2', PROJECT_CWD);
    const filePath = writeTrivialJsonl('lead-hydrate-2', PROJECT_CWD);
    const stat = fs.statSync(filePath);

    const state: CachedSessionState = {
      sessionId: 'lead-hydrate-2', slug: 'lead-hydrate-2', workspaceKey: sanitiseKey(PROJECT_CWD),
      cwd: PROJECT_CWD, initialCwd: PROJECT_CWD,
      topic: 'Stale cached topic', activity: 'Idle', status: 'done',
      lastActivity: Date.now() - 20 * 60_000, firstActivity: Date.now() - 20 * 60_000,
      enqueuedAt: 0, contextTokens: 10, modelId: '', modelConfirmed: false,
      customTitle: '', aiTitle: 'Stale cached title', userTurnCount: 1, subagents: [],
    };
    // Deliberately mismatched size — the file on disk has moved on since
    // this entry was written, so isHydratable()'s exact-stamp check must fail.
    const entries = new Map<string, ReplayCacheEntry>([
      [filePath, { size: stat.size + 999, mtimeMs: stat.mtimeMs, cachedAt: Date.now(), state }],
    ]);

    const td = makeDiscovery();
    td.setReplayCache(fakeStore(entries));

    const readSpy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords');
    await td.scan();

    expect(readSpy).toHaveBeenCalled();

    const snap = td.getTeamSnapshots(emptyMeta()).find(t => t.teamId === 'at:my-team');
    // A real replay processes the actual JSONL content (one bare user
    // record: done → running), not the stale cached done status.
    expect(snap?.orchestrator.status).toBe('running');

    td.dispose();
  });

  it('does not hydrate when setReplayCache was never called — the manager defaults to NULL_REPLAY_CACHE', async () => {
    writeTeamConfig('my-team', 'lead-hydrate-3', PROJECT_CWD);
    writeTrivialJsonl('lead-hydrate-3', PROJECT_CWD);

    const td = makeDiscovery();

    const readSpy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords');
    await td.scan();

    expect(readSpy).toHaveBeenCalled();
    td.dispose();
  });
});

describe('TeamDiscovery: offering dormant leads to the replay cache', () => {
  it('offers a dormant, quiet, done team lead to the cache on poll()', async () => {
    vi.useFakeTimers();
    try {
      writeTeamConfig('my-team', 'lead-offer-1', PROJECT_CWD);

      // A minimal completed turn: user prompt + assistant text reply, no
      // tool use — done → running → (idle timer) → done, with nothing
      // outstanding (no active tools/subagents/shells/wakeups).
      const workspaceKey = sanitiseKey(PROJECT_CWD);
      const dir = path.join(projectsDir, workspaceKey);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'lead-offer-1.jsonl');
      const userRecord = JSON.stringify({
        type: 'user', cwd: PROJECT_CWD, timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'do something' }] },
      });
      const assistantRecord = JSON.stringify({
        type: 'assistant', timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'Done' }] },
      });
      fs.writeFileSync(filePath, userRecord + '\n' + assistantRecord + '\n');

      const store = fakeStore();
      const td = makeDiscovery();
      td.setReplayCache(store);

      await td.scan();
      let snap = td.getTeamSnapshots(emptyMeta()).find(t => t.teamId === 'at:my-team');
      expect(snap?.orchestrator.status).toBe('running');

      // Idle timer: drops to 5s once output has been seen.
      await vi.advanceTimersByTimeAsync(6_000);
      snap = td.getTeamSnapshots(emptyMeta()).find(t => t.teamId === 'at:my-team');
      expect(snap?.orchestrator.status).toBe('done');

      // Cross the replay-cache quiet window (EXTERNAL_WRITER_QUIET_MS, 10 min)
      // since lastActivity, with nothing else happening to the file.
      await vi.advanceTimersByTimeAsync(11 * 60_000);

      expect(store.putSpy).not.toHaveBeenCalled(); // nothing offered until poll() runs
      await td.poll();

      expect(store.putSpy).toHaveBeenCalled();
      expect(store.putSpy.mock.calls[0][0]).toBe(filePath);

      td.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not offer an active (running) team lead to the cache', async () => {
    vi.useFakeTimers();
    try {
      writeTeamConfig('my-team', 'lead-offer-2', PROJECT_CWD);
      const workspaceKey = sanitiseKey(PROJECT_CWD);
      const dir = path.join(projectsDir, workspaceKey);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'lead-offer-2.jsonl');
      const userRecord = JSON.stringify({
        type: 'user', cwd: PROJECT_CWD, timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'do something' }] },
      });
      fs.writeFileSync(filePath, userRecord + '\n');

      const store = fakeStore();
      const td = makeDiscovery();
      td.setReplayCache(store);

      await td.scan();
      const snap = td.getTeamSnapshots(emptyMeta()).find(t => t.teamId === 'at:my-team');
      expect(snap?.orchestrator.status).toBe('running'); // no idle timer fired

      await td.poll();
      expect(store.putSpy).not.toHaveBeenCalled();

      td.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
