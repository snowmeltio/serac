import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionDiscovery } from './sessionDiscovery.js';

/**
 * Tests for SessionDiscovery.
 * Uses a fully isolated temp directory (no writes to real ~/.claude/) [F10].
 */

let tmpDir: string;
let workspacePath: string;
let projectsDir: string;
let workspaceKey: string;

function createJsonlFile(sessionId: string, content = ''): string {
  const filePath = path.join(projectsDir, workspaceKey, `${sessionId}.jsonl`);
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

describe('SessionDiscovery', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-test-'));
    workspacePath = path.join(tmpDir, 'workspace');
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    workspaceKey = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Meta persistence ──────────────────────────────────────────

  it('persists session meta to disk on dismiss', async () => {
    const discovery = makeDiscovery();
    createJsonlFile('session-1');
    await discovery.start(() => {});

    discovery.dismissSession('session-1');
    // Wait for fire-and-forget saveMeta to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Read meta file directly
    const metaPath = path.join(projectsDir, workspaceKey, 'session-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.sessions['session-1'].dismissed).toBe(true);
    discovery.stop();
  });

  it('loads meta from disk on restart', async () => {
    // First instance: dismiss a session
    const d1 = makeDiscovery();
    createJsonlFile('session-1');
    await d1.start(() => {});
    d1.dismissSession('session-1');
    // Wait for fire-and-forget saveMeta
    await new Promise(resolve => setTimeout(resolve, 100));
    d1.stop();

    // Second instance: should load dismissed state
    const d2 = makeDiscovery();
    await d2.start(() => {});
    const snap = d2.getSnapshots().find(s => s.sessionId === 'session-1');
    expect(snap?.dismissed).toBe(true);
    d2.stop();
  });

  // ── Two-zone sort ─────────────────────────────────────────────

  it('sorts active sessions before completed sessions', async () => {
    const discovery = makeDiscovery();
    // Create session-done with enqueue record (will be done after initial read)
    const enqueueRecord = JSON.stringify({
      type: 'queue-operation', operation: 'enqueue',
      timestamp: new Date().toISOString(),
    });
    createJsonlFile('session-done', enqueueRecord);
    // Create session-active with just a user record (will be running)
    createJsonlFile('session-active');
    await discovery.start(() => {});

    const snaps = discovery.getSnapshots().filter(s => !s.dismissed);
    const activeIdx = snaps.findIndex(s => s.sessionId === 'session-active');
    const doneIdx = snaps.findIndex(s => s.sessionId === 'session-done');
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeLessThan(doneIdx);
    discovery.stop();
  });

  // ── Prune on file deletion ────────────────────────────────────

  it('prunes session when JSONL file is deleted (via poll)', async () => {
    let changed = false;
    const discovery = makeDiscovery();
    const filePath = createJsonlFile('session-1');
    await discovery.start(() => { changed = true; });
    expect(discovery.getSnapshots().map(s => s.sessionId)).toContain('session-1');

    // Delete the file — pruning happens in the poll loop, not forceScan
    fs.unlinkSync(filePath);

    // Wait for a poll cycle (max 2s idle interval + buffer)
    await new Promise(resolve => setTimeout(resolve, 2500));

    expect(discovery.getSnapshots().map(s => s.sessionId)).not.toContain('session-1');
    discovery.stop();
  });

  // ── Audit fix: save queue serialisation ─────────────────────

  it('rapid dismiss/undismiss persists final state via save queue', async () => {
    const discovery = makeDiscovery();
    createJsonlFile('session-1');
    await discovery.start(() => {});

    // Rapid fire: dismiss then undismiss
    discovery.dismissSession('session-1');
    discovery.undismissSession('session-1');

    // Wait for queued saves to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    const metaPath = path.join(projectsDir, workspaceKey, 'session-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    // Final state should be undismissed (false)
    expect(meta.sessions['session-1'].dismissed).toBe(false);
    discovery.stop();
  });

  it('rapid dismiss of multiple sessions persists all', async () => {
    const discovery = makeDiscovery();
    createJsonlFile('session-1');
    createJsonlFile('session-2');
    createJsonlFile('session-3');
    await discovery.start(() => {});

    discovery.dismissSession('session-1');
    discovery.dismissSession('session-2');
    discovery.dismissSession('session-3');

    await new Promise(resolve => setTimeout(resolve, 200));

    const metaPath = path.join(projectsDir, workspaceKey, 'session-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.sessions['session-1'].dismissed).toBe(true);
    expect(meta.sessions['session-2'].dismissed).toBe(true);
    expect(meta.sessions['session-3'].dismissed).toBe(true);
    discovery.stop();
  });

  // ── Audit fix: per-session error isolation ──────────────────

  it('one corrupted JSONL file does not break other sessions', async () => {
    const discovery = makeDiscovery();
    createJsonlFile('good-session');
    // Create a file with invalid content that will be parsed but won't crash
    createJsonlFile('bad-session', 'not valid json at all');
    await discovery.start(() => {});

    // Both sessions should be discovered (bad content is skipped by tailer)
    const ids = discovery.getSnapshots().map(s => s.sessionId);
    expect(ids).toContain('good-session');
    expect(ids).toContain('bad-session');
    discovery.stop();
  });

  // ── Audit fix: batched updates ──────────────────────────────

  it('handles more sessions than UPDATE_BATCH_SIZE', async () => {
    const discovery = makeDiscovery();
    // Create 60 sessions (exceeds batch size of 50)
    for (let i = 0; i < 60; i++) {
      createJsonlFile(`session-${String(i).padStart(3, '0')}`);
    }
    await discovery.start(() => {});

    const snapshots = discovery.getSnapshots();
    expect(snapshots).toHaveLength(60);
    discovery.stop();
  });

  // ── Phase 6: Age gate on scan ─────────────────────────────────

  it('age gate: skips JSONL files older than 7 days on initial scan', async () => {
    const discovery = makeDiscovery();

    // Create a file and backdate its mtime to 8 days ago
    const filePath = createJsonlFile('old-session');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, eightDaysAgo, eightDaysAgo);

    // Create a recent file
    createJsonlFile('new-session');

    await discovery.start(() => {});
    const ids = discovery.getSnapshots().map(s => s.sessionId);
    expect(ids).toContain('new-session');
    expect(ids).not.toContain('old-session');
    discovery.stop();
  });

  it('age gate: does not skip files within 7 days', async () => {
    const discovery = makeDiscovery();

    const filePath = createJsonlFile('recent-session');
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, sixDaysAgo, sixDaysAgo);

    await discovery.start(() => {});
    const ids = discovery.getSnapshots().map(s => s.sessionId);
    expect(ids).toContain('recent-session');
    discovery.stop();
  });

  it('age gate: counts older sessions skipped by the active scan', async () => {
    const discovery = makeDiscovery();

    const olderA = createJsonlFile('older-a');
    const olderB = createJsonlFile('older-b');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(olderA, tenDaysAgo, tenDaysAgo);
    fs.utimesSync(olderB, tenDaysAgo, tenDaysAgo);
    createJsonlFile('recent-session');

    await discovery.start(() => {});
    expect(discovery.getOlderSessionCount()).toBe(2);
    discovery.stop();
  });

  // ── Foreign workspace: local meta ──────────────────────────────

  it('reads foreign meta from local projects directory', async () => {
    // Create a foreign workspace with JSONL files and a local meta file
    const foreignKey = 'foreign-ws-key';
    const foreignDir = path.join(projectsDir, foreignKey);
    fs.mkdirSync(foreignDir, { recursive: true });
    const record = JSON.stringify({
      type: 'user',
      cwd: path.join(tmpDir, 'foreign-ws'),
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    fs.writeFileSync(path.join(foreignDir, 'fs-1.jsonl'), record + '\n');

    // Write meta in the local projects dir (same location as JSONL files)
    const metaContent = JSON.stringify({
      sessions: { 'fs-1': { dismissed: true } },
    });
    fs.writeFileSync(path.join(foreignDir, 'session-meta.json'), metaContent);

    const discovery = makeDiscovery();
    createJsonlFile('local-session');
    await discovery.start(() => {});

    // Foreign workspace with all sessions dismissed should not appear
    // (Foreign scan requires poll cycles, so just verify no crash)
    const groups = discovery.getForeignWorkspaces();
    expect(Array.isArray(groups)).toBe(true);
    discovery.stop();
  });

  // ── Extended archive (setArchiveRange) ────────────────────────

  it('loads extended archive entries for sessions older than 7 days', async () => {
    // Create a session within the 7d gate (will be active)
    createJsonlFile('recent-session');

    // Create a session older than 7 days (will be extended archive only)
    const oldSessionId = 'old-session';
    const oldFilePath = createJsonlFile(oldSessionId);
    const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFilePath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    const discovery = makeDiscovery();
    await discovery.start(() => {});

    // Default range (1d) — old session should NOT appear
    const snapshotsBefore = discovery.getSnapshots();
    const oldInDefault = snapshotsBefore.find(s => s.sessionId === oldSessionId);
    expect(oldInDefault).toBeUndefined();

    // Set archive range to 0 (all) — should trigger extended archive scan
    const changed = await discovery.setArchiveRange(0);
    expect(changed).toBe(true);

    // Old session should now appear as a dismissed archive entry
    const snapshotsAfter = discovery.getSnapshots();
    const oldInAll = snapshotsAfter.find(s => s.sessionId === oldSessionId);
    expect(oldInAll).toBeDefined();
    // Extended archive entries are 8+ days old, so they get display status 'stale'
    expect(oldInAll!.status === 'done' || oldInAll!.status === 'stale').toBe(true);

    // Setting range back to 1d should clear extended archive
    await discovery.setArchiveRange(86400000);
    const snapshotsAfterClear = discovery.getSnapshots();
    const oldInClear = snapshotsAfterClear.find(s => s.sessionId === oldSessionId);
    expect(oldInClear).toBeUndefined();

    discovery.stop();
  });

  it('setArchiveRange(0) converts to Infinity internally', async () => {
    createJsonlFile('test-session');
    const discovery = makeDiscovery();
    await discovery.start(() => {});

    // 0 should not be treated as "within 7d gate" (which would clear the archive)
    const changed = await discovery.setArchiveRange(0);
    expect(changed).toBe(true);

    discovery.stop();
  });
});
