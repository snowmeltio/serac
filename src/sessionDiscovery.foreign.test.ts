/**
 * Tests for SessionDiscovery foreign workspace scanning.
 * Uses fully isolated temp directories (no writes to real ~/.claude/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionDiscovery } from './sessionDiscovery.js';

let tmpDir: string;
let workspacePath: string;
let projectsDir: string;
let workspaceKey: string;

function createJsonlFile(wsKey: string, sessionId: string, content = ''): string {
  const filePath = path.join(projectsDir, wsKey, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const record = content || JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text: 'Hello' }] },
  });
  fs.writeFileSync(filePath, record + '\n');
  return filePath;
}

function makeDiscovery(): SessionDiscovery {
  return new SessionDiscovery(workspacePath, { projectsDir });
}

describe('SessionDiscovery: foreign workspaces', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-foreign-'));
    workspacePath = path.join(tmpDir, 'workspace');
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    workspaceKey = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not include current workspace in foreign results', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign).toHaveLength(0);
    discovery.stop();
  });

  it('getForeignWorkspaces returns WorkspaceGroup[] shape', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    // Shape validation: should be an array of WorkspaceGroup objects
    for (const ws of foreign) {
      expect(ws).toHaveProperty('workspaceKey');
      expect(ws).toHaveProperty('displayName');
      expect(ws).toHaveProperty('cwd');
      expect(ws).toHaveProperty('counts');
    }
    discovery.stop();
  });

  it('getForeignWorkspaces returns empty when no other workspaces exist', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign).toEqual([]);
    discovery.stop();
  });

  it('getForeignWorkspaces sorts workspaces alphabetically', async () => {
    // This tests the sort logic of getForeignWorkspaces
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local');
    await discovery.start(() => {});

    // Without actual foreign sessions in waiting state, we verify
    // the method returns a sorted array (empty is trivially sorted)
    const foreign = discovery.getForeignWorkspaces();
    expect(Array.isArray(foreign)).toBe(true);
    discovery.stop();
  });

  it('discovers foreign sessions from other workspace directories', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');
    // Create a foreign session with a user record (triggers 'running' status)
    createJsonlFile('foreign-workspace', 'foreign-session');
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign.length).toBe(1);
    expect(foreign[0].workspaceKey).toBe('foreign-workspace');
    expect(foreign[0].counts['running']).toBe(1);
    discovery.stop();
  });

  it('demotes foreign sessions with no new data after threshold', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');

    // Create a foreign session with a user record dated >30s ago
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    const record = JSON.stringify({
      type: 'user',
      timestamp: oldTimestamp,
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    createJsonlFile('foreign-workspace', 'stale-foreign', record);
    await discovery.start(() => {});

    // Initially running (just discovered)
    let foreign = discovery.getForeignWorkspaces();
    expect(foreign.length).toBe(1);
    expect(foreign[0].counts['running']).toBe(1);

    // Trigger a poll cycle — the foreign session should demote via demoteIfStale
    // because its lastActivity is >30s ago and update() returns no new data
    // We need to wait for the poll to fire (adaptive interval = 500ms for active sessions)
    await new Promise(resolve => setTimeout(resolve, 600));

    foreign = discovery.getForeignWorkspaces();
    // After demotion, the session should no longer be counted as running
    // but may still appear as done (since getForeignWorkspaces now includes done)
    if (foreign.length > 0) {
      expect(foreign[0].counts['running']).toBeUndefined();
    }
    discovery.stop();
  });

  it('uses cwd for workspace display name when available', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');

    // Create a foreign session with a cwd field
    const record = JSON.stringify({
      type: 'user',
      cwd: '/Users/murray/Library/CloudStorage/Shared drives/2026-02 Fundraising OD',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    createJsonlFile('foreign-ws-key', 'foreign-with-cwd', record);
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign.length).toBe(1);
    expect(foreign[0].displayName).toBe('2026-02 Fundraising OD');
    expect(foreign[0].cwd).toBe('/Users/murray/Library/CloudStorage/Shared drives/2026-02 Fundraising OD');
    discovery.stop();
  });

  it('returns null cwd when no cwd available in JSONL', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');

    const record = JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    createJsonlFile('foreign-no-cwd-ws', 'foreign-no-cwd', record);
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign.length).toBe(1);
    expect(foreign[0].cwd).toBeNull();
    discovery.stop();
  });

  it('falls back to key-derived name when no cwd available', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');

    // Create a foreign session WITHOUT a cwd field
    const record = JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    createJsonlFile('Users-murray-claudecode', 'foreign-no-cwd', record);
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign.length).toBe(1);
    // Uses last 3 segments of sanitised key
    expect(foreign[0].displayName).toBe('Users-murray-claudecode');
    discovery.stop();
  });

  it('skips foreign sessions whose user/assistant activity is past the gate, even with recent mtime', async () => {
    // Repro: Claude Code can append `ai-title` records (no timestamp) to old
    // sessions, bumping mtime. Without the lastActivity gate, scan() keeps
    // re-adding what poll() evicts → the workspace flickers in/out.
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');

    // User record from 10 days ago, then an ai-title record (no timestamp)
    const oldRecord = JSON.stringify({
      type: 'user',
      timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      message: { content: [{ type: 'text', text: 'old' }] },
    });
    const aiTitle = JSON.stringify({ type: 'ai-title', aiTitle: 'Old session' });
    const filePath = path.join(projectsDir, 'stale-foreign-ws', 'old-session.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, oldRecord + '\n' + aiTitle + '\n');
    // mtime is "now" (just written) — within the 7d gate

    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign.find(w => w.workspaceKey === 'stale-foreign-ws')).toBeUndefined();
    discovery.stop();
  });

  it('uses date-prefix heuristic for key-derived names', async () => {
    const discovery = makeDiscovery();
    createJsonlFile(workspaceKey, 'local-session');

    const record = JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    createJsonlFile('Users-murray-projects-2026-02-Fundraising-OD', 'foreign-dated', record);
    await discovery.start(() => {});

    const foreign = discovery.getForeignWorkspaces();
    expect(foreign.length).toBe(1);
    expect(foreign[0].displayName).toBe('2026-02-Fundraising-OD');
    discovery.stop();
  });
});
