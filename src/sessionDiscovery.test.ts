import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Required because SessionDiscovery transitively imports settings.ts → 'vscode'.
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionDiscovery } from './sessionDiscovery.js';
import type { SessionSnapshot } from './types.js';
import { EXTERNAL_WRITER_QUIET_MS } from './writerActivity.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { _setConfigValues, _resetConfig } from './__mocks__/vscode.js';

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
  // defaultModelGuess pinned to '' — isolates this suite from the real
  // machine's ~/.claude/settings.json (see [F10] above).
  return new SessionDiscovery(workspacePath, { projectsDir, defaultModelGuess: '' });
}

/**
 * Spawns a real child process, has THAT child spawn its own child in turn,
 * and resolves with the grandchild's pid — a real, deterministic "confirmed
 * different window" fixture for WriterOwnership's `ps`-based ppid check
 * (a grandchild's ppid is the middle child's pid, never this test process's
 * own pid), with no execFile mocking required. A fixed well-known pid (e.g.
 * pid 1/launchd) would be simpler but isn't reliably inspectable via `ps`
 * from every sandboxed test-runner environment this suite runs under; a real
 * descendant process always is.
 */
async function spawnExternalProcess(): Promise<{ pid: number; cleanup: () => void }> {
  const { spawn } = await import('child_process');
  const outer = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const inner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    console.log('INNER_PID:' + inner.pid);
    setTimeout(() => {}, 30000);
  `]);
  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for grandchild pid')), 5000);
    outer.stdout.on('data', (data: Buffer) => {
      const match = data.toString().match(/INNER_PID:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(parseInt(match[1], 10));
      }
    });
  });
  return {
    pid,
    cleanup: () => {
      outer.kill();
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    },
  };
}

/** Writes a live-process registry entry (~/.claude/sessions/<pid>.json
 *  equivalent) under the test's isolated sessions dir. Unlike the two
 *  `writeRegistryEntry` helpers scoped to individual describe blocks above,
 *  this one accepts an explicit `cwd` — needed to simulate a process rooted
 *  at a workspace OTHER than the local one (team-lead orchestrator, foreign
 *  workspace, sibling worktree). */
function writeRegistryEntryWithCwd(
  pid: number,
  sessionId: string,
  opts: { startedAt?: number; cwd?: string } = {},
): void {
  const sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd: opts.cwd ?? workspacePath, startedAt: opts.startedAt ?? Date.now(),
    kind: 'interactive', entrypoint: 'claude-vscode', version: 'test',
  }));
}

/** Build a minimal SessionSnapshot for tests that inject feed entries directly
 *  (e.g. stubbing sibling-worktree snapshots). */
function makeSnapshot(
  sessionId: string,
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    sessionId,
    slug: sessionId,
    cwd: workspacePath,
    workspaceKey,
    topic: '',
    status: 'done',
    activity: '',
    subagents: [],
    lastActivity: 0,
    firstActivity: 0,
    dismissed: false,
    contextTokens: 0,
    searchText: '',
    modelLabel: 'Opus',
    title: null,
    customTitle: '',
    aiTitle: '',
    confidence: 'high',
    ...overrides,
  };
}

describe('SessionDiscovery', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-test-'));
    workspacePath = path.join(tmpDir, 'workspace');
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    workspaceKey = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
    // externalWriter is gated behind serac.experimental.externalWriterBlock,
    // default OFF in production. Most of this file's externalWriter/
    // isRecentlyActiveElsewhere/recencyCache tests below predate the gate and
    // assume the feature is active, so turn it on ambiently for the whole
    // suite — the "externalWriterBlock gate" describe block near the bottom
    // explicitly overrides this to prove the real (off) default.
    _setConfigValues({ 'serac.experimental.externalWriterBlock': true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetConfig();
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

  it('round-trips workflow dismiss/undismiss through getWorkflowSnapshots and persists the flag', async () => {
    // A completed run owned by session-wf. dismissWorkflow archives just the run
    // (keyed workflow:<runId> in session-meta, distinct from the session key).
    const discovery = makeDiscovery();
    createJsonlFile('session-wf');
    const runId = 'wf_round-001';
    const wfDir = path.join(projectsDir, workspaceKey, 'session-wf', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, `${runId}.json`), JSON.stringify({
      runId,
      workflowName: 'demo',
      summary: 's',
      status: 'completed',
      startTime: 1780000000000,
      durationMs: 1000,
      defaultModel: 'claude-opus-4-8[1m]',
      agentCount: 1,
      totalTokens: 10,
      totalToolCalls: 1,
      logs: [],
      phases: [{ title: 'Only', detail: 'd' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, agentId: 'aaa111', phaseIndex: 1, phaseTitle: 'Only', state: 'done', label: 'l' },
      ],
    }), 'utf-8');
    await discovery.start(() => {});

    // Initially visible and not dismissed.
    const before = discovery.getWorkflowSnapshots().find(w => w.runId === runId);
    expect(before?.dismissed).toBe(false);

    // Dismiss → snapshot reflects it; the session card key is untouched.
    discovery.dismissWorkflow(runId);
    expect(discovery.getWorkflowSnapshots().find(w => w.runId === runId)?.dismissed).toBe(true);
    expect(discovery.getSnapshots().find(s => s.sessionId === 'session-wf')?.dismissed).toBe(false);

    // Persisted under the workflow: key (fire-and-forget save).
    await new Promise(resolve => setTimeout(resolve, 100));
    const metaPath = path.join(projectsDir, workspaceKey, 'session-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.sessions[`workflow:${runId}`].dismissed).toBe(true);

    // Undismiss → back to visible.
    discovery.undismissWorkflow(runId);
    expect(discovery.getWorkflowSnapshots().find(w => w.runId === runId)?.dismissed).toBe(false);
    discovery.stop();
  });

  it('honours the local dismiss overlay for sibling-worktree sessions', async () => {
    // Sibling sessions are merged into the feed but source their state from the
    // sibling's own meta. Dismissal is a local view-state overlay, so clicking ×
    // on a sibling card must move it to the archive even though we never touch
    // the sibling's session-meta.json. Regression: previously a no-op. [worktree]
    const discovery = makeDiscovery();
    await discovery.start(() => {});

    const sibSnapshot = makeSnapshot('sib-session', {
      status: 'done',
      worktreeRoot: '/repos/serac-hook-monitoring',
      worktreeLabel: 'serac-hook-monitoring',
    });
    // Inject a sibling snapshot via the internal manager (no real worktree on disk).
    (discovery as unknown as {
      siblingManager: { getSnapshots: () => unknown[] };
    }).siblingManager.getSnapshots = () => [{ ...sibSnapshot }];

    // Before: visible and not dismissed.
    const before = discovery.getSnapshots().find(s => s.sessionId === 'sib-session');
    expect(before?.dismissed).toBe(false);

    // Dismiss writes only to local meta — the sibling's meta is never touched.
    discovery.dismissSession('sib-session');

    const after = discovery.getSnapshots().find(s => s.sessionId === 'sib-session');
    expect(after?.dismissed).toBe(true);
    discovery.stop();
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

  // ── Audit perf-io-3: knownOld stat-skip + readdir-based prune ──

  it('age gate: does not re-stat a known-old file on subsequent scans, count stays correct', async () => {
    const discovery = makeDiscovery();
    const oldPath = createJsonlFile('old-session');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);
    await discovery.start(() => {});
    expect(discovery.getOlderSessionCount()).toBe(1);

    const statSpy = vi.spyOn(fs.promises, 'stat');
    const priv = discovery as unknown as { scan: () => Promise<void> };
    await priv.scan();
    await priv.scan();

    expect(statSpy.mock.calls.filter(c => String(c[0]) === oldPath)).toHaveLength(0);
    expect(discovery.getOlderSessionCount()).toBe(1);
    statSpy.mockRestore();
    discovery.stop();
  });

  it('age gate: picks up a resumed old session once the knownOld TTL lapses', async () => {
    const discovery = makeDiscovery();
    const oldPath = createJsonlFile('revived-session');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);
    await discovery.start(() => {});
    expect(discovery.getSnapshots().map(s => s.sessionId)).not.toContain('revived-session');

    // Session resumes: mtime freshens. Within the TTL the old classification holds…
    fs.utimesSync(oldPath, new Date(), new Date());
    const priv = discovery as unknown as { scan: () => Promise<void>; knownOldClearedAt: number };
    await priv.scan();
    expect(discovery.getSnapshots().map(s => s.sessionId)).not.toContain('revived-session');

    // …and once the TTL clears the set, the next scan re-stats and picks it up.
    priv.knownOldClearedAt = 0;
    await priv.scan();
    expect(discovery.getSnapshots().map(s => s.sessionId)).toContain('revived-session');
    discovery.stop();
  });

  it('prunes all sessions when the workspace directory itself is removed', async () => {
    const discovery = makeDiscovery();
    createJsonlFile('session-1');
    await discovery.start(() => {});
    expect(discovery.getSnapshots().map(s => s.sessionId)).toContain('session-1');

    fs.rmSync(path.join(projectsDir, workspaceKey), { recursive: true, force: true });
    await (discovery as unknown as { pollInner: (t: number) => Promise<void> }).pollInner(Date.now());

    expect(discovery.getSnapshots().map(s => s.sessionId)).not.toContain('session-1');
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

  // ── Archived-session title backfill ───────────────────────────

  it('backfills aiTitle from JSONL when an archived session lacks meta title', async () => {
    const sessionId = 'old-with-title';
    const lines = [
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'ai-title', sessionId, aiTitle: 'Refactor worktree grouping' }),
    ];
    const filePath = path.join(projectsDir, workspaceKey, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    const discovery = makeDiscovery();
    await discovery.start(() => {});
    await discovery.setArchiveRange(0);

    const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
    expect(snap?.aiTitle).toBe('Refactor worktree grouping');

    // Persisted to session-meta.json so subsequent scans don't re-read the JSONL
    await new Promise(r => setTimeout(r, 100));
    const metaPath = path.join(projectsDir, workspaceKey, 'session-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    expect(meta.sessions[sessionId].aiTitle).toBe('Refactor worktree grouping');

    discovery.stop();
  });

  it('prefers the last ai-title record when multiple are present', async () => {
    const sessionId = 'old-multiple-titles';
    const lines = [
      JSON.stringify({ type: 'ai-title', sessionId, aiTitle: 'First guess' }),
      JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'more' }] } }),
      JSON.stringify({ type: 'ai-title', sessionId, aiTitle: 'Better title' }),
    ];
    const filePath = path.join(projectsDir, workspaceKey, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    const discovery = makeDiscovery();
    await discovery.start(() => {});
    await discovery.setArchiveRange(0);

    const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
    expect(snap?.aiTitle).toBe('Better title');

    discovery.stop();
  });

  it('uses meta.aiTitle on archived snapshots without re-reading JSONL', async () => {
    const sessionId = 'old-cached';
    const filePath = path.join(projectsDir, workspaceKey, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Intentionally no ai-title in the file — meta should still win
    fs.writeFileSync(filePath, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    // Pre-seed meta with a cached title
    const metaPath = path.join(projectsDir, workspaceKey, 'session-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      sessions: {
        [sessionId]: { title: null, dismissed: true, acknowledged: false, acknowledgedAt: null, firstSeen: eightDaysAgo, aiTitle: 'Previously cached' },
      },
    }));

    const discovery = makeDiscovery();
    await discovery.start(() => {});
    await discovery.setArchiveRange(0);

    const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
    expect(snap?.aiTitle).toBe('Previously cached');

    discovery.stop();
  });

  it('marks archived sessions with no ai-title record as scanned to avoid re-scanning', async () => {
    const sessionId = 'old-no-title';
    const filePath = path.join(projectsDir, workspaceKey, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const eightDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    const discovery = makeDiscovery();
    await discovery.start(() => {});
    await discovery.setArchiveRange(0);

    await new Promise(r => setTimeout(r, 100));
    const metaPath = path.join(projectsDir, workspaceKey, 'session-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    // Scanned marker: empty string, not undefined
    expect(meta.sessions[sessionId].aiTitle).toBe('');
    expect(meta.sessions[sessionId].customTitle).toBe('');

    discovery.stop();
  });

  // ── Subagent transcript resolution (detail panel) ─────────────
  describe('getSubagentFilePath()', () => {
    it('resolves an existing subagent transcript under the session dir', async () => {
      const sessionId = 'sess-sub';
      createJsonlFile(sessionId);
      const subDir = path.join(projectsDir, workspaceKey, sessionId, 'subagents');
      fs.mkdirSync(subDir, { recursive: true });
      const expected = path.join(subDir, 'agent-abc123.jsonl');
      fs.writeFileSync(expected, '');

      const discovery = makeDiscovery();
      await discovery.start(() => {});
      expect(discovery.getSubagentFilePath(sessionId, 'abc123')).toBe(expected);
      discovery.stop();
    });

    it('returns null when the transcript file does not exist', async () => {
      const sessionId = 'sess-sub';
      createJsonlFile(sessionId);

      const discovery = makeDiscovery();
      await discovery.start(() => {});
      expect(discovery.getSubagentFilePath(sessionId, 'missing')).toBeNull();
      discovery.stop();
    });

    it('returns null for an unknown session', async () => {
      const discovery = makeDiscovery();
      await discovery.start(() => {});
      expect(discovery.getSubagentFilePath('no-such-session', 'abc123')).toBeNull();
      discovery.stop();
    });

    it('rejects a path-traversal agentId', async () => {
      const sessionId = 'sess-sub';
      createJsonlFile(sessionId);

      const discovery = makeDiscovery();
      await discovery.start(() => {});
      expect(discovery.getSubagentFilePath(sessionId, '../../etc/passwd')).toBeNull();
      discovery.stop();
    });
  });

  describe('listSubagentFiles()', () => {
    function writeSubagent(sessionId: string, agentId: string, meta?: Record<string, unknown>, jsonl = ''): void {
      const subDir = path.join(projectsDir, workspaceKey, sessionId, 'subagents');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`), jsonl);
      if (meta) {
        fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
      }
    }

    it('lists on-disk subagents with agentType/description from meta', async () => {
      const sessionId = 'sess-list';
      createJsonlFile(sessionId);
      writeSubagent(sessionId, 'aaa111', { agentType: 'general-purpose', description: 'review types' });
      writeSubagent(sessionId, 'bbb222'); // no meta

      const discovery = makeDiscovery();
      await discovery.start(() => {});
      const list = discovery.listSubagentFiles(sessionId);
      discovery.stop();

      const byId = Object.fromEntries(list.map(e => [e.agentId, e]));
      expect(Object.keys(byId).sort()).toEqual(['aaa111', 'bbb222']);
      expect(byId['aaa111']).toMatchObject({ agentType: 'general-purpose', description: 'review types' });
      expect(byId['bbb222']).toMatchObject({ agentType: null, description: null });
    });

    it('recovers the model from the transcript head (meta.json never carries it)', async () => {
      const sessionId = 'sess-model';
      createJsonlFile(sessionId);
      const jsonl = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'find the bug in model.ts' } }),
        'not json {{{',
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } }),
      ].join('\n') + '\n';
      writeSubagent(sessionId, 'aaa111', { agentType: 'Explore' }, jsonl);
      writeSubagent(sessionId, 'bbb222'); // empty transcript — no assistant record yet

      const discovery = makeDiscovery();
      await discovery.start(() => {});
      const byId = Object.fromEntries(discovery.listSubagentFiles(sessionId).map(e => [e.agentId, e]));
      expect(byId['aaa111'].model).toBe('claude-sonnet-5');
      expect(byId['bbb222'].model).toBeNull();

      // A hit is memoised (the model never changes mid-run) — a rewrite is not
      // re-read. A miss is NOT cached: the just-spawned agent resolves later.
      writeSubagent(sessionId, 'aaa111', undefined, jsonl.replace('claude-sonnet-5', 'claude-opus-4-8'));
      writeSubagent(sessionId, 'bbb222', undefined,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [] } }) + '\n');
      const again = Object.fromEntries(discovery.listSubagentFiles(sessionId).map(e => [e.agentId, e]));
      expect(again['aaa111'].model).toBe('claude-sonnet-5');
      expect(again['bbb222'].model).toBe('claude-haiku-4-5');
      discovery.stop();
    });

    it('skips a leading synthetic sentinel record and keeps scanning for the real model', async () => {
      const sessionId = 'sess-model-synthetic';
      createJsonlFile(sessionId);
      const jsonl = [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [] } }),
      ].join('\n') + '\n';
      writeSubagent(sessionId, 'aaa111', { agentType: 'Explore' }, jsonl);

      const discovery = makeDiscovery();
      await discovery.start(() => {});
      const byId = Object.fromEntries(discovery.listSubagentFiles(sessionId).map(e => [e.agentId, e]));
      discovery.stop();
      expect(byId['aaa111'].model).toBe('claude-opus-4-8');
    });

    it('ignores the workflows/ subdir and non-agent files', async () => {
      const sessionId = 'sess-list2';
      createJsonlFile(sessionId);
      writeSubagent(sessionId, 'aaa111', { agentType: 'x', description: 'y' });
      const subDir = path.join(projectsDir, workspaceKey, sessionId, 'subagents');
      // a workflow run dir (must NOT be picked up as a plain subagent)
      fs.mkdirSync(path.join(subDir, 'workflows', 'wf_x'), { recursive: true });
      fs.writeFileSync(path.join(subDir, 'workflows', 'wf_x', 'agent-zzz999.jsonl'), '');
      // a stray non-matching file
      fs.writeFileSync(path.join(subDir, 'journal.jsonl'), '');

      const discovery = makeDiscovery();
      await discovery.start(() => {});
      const ids = discovery.listSubagentFiles(sessionId).map(e => e.agentId);
      discovery.stop();
      expect(ids).toEqual(['aaa111']);
    });

    it('returns [] for an unknown session and a session with no subagents dir', async () => {
      const sessionId = 'sess-empty';
      createJsonlFile(sessionId);
      const discovery = makeDiscovery();
      await discovery.start(() => {});
      expect(discovery.listSubagentFiles('no-such-session')).toEqual([]);
      expect(discovery.listSubagentFiles(sessionId)).toEqual([]);
      discovery.stop();
    });
  });

  describe('getWaitingCount()', () => {
    // A trailing, unanswered AskUserQuestion tool_use infers 'waiting' on parse
    // (userInput tool, no matching tool_result) — no permission timer needed.
    function waitingJsonl(): string {
      const ts = new Date().toISOString();
      const user = JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text: 'hi' }] } });
      const asst = JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: {} }] } });
      return user + '\n' + asst;
    }

    it('counts a waiting session but excludes it once dismissed', async () => {
      createJsonlFile('w1', waitingJsonl());
      const discovery = makeDiscovery();
      await discovery.start(() => {});
      expect(discovery.getWaitingCount()).toBe(1);
      discovery.dismissSession('w1');
      expect(discovery.getWaitingCount()).toBe(0);
      discovery.stop();
    });
  });

  describe('isExternalWriterFresh()', () => {
    /** Writes a live-process registry entry (~/.claude/sessions/<pid>.json
     *  equivalent) under the test's isolated sessions dir. */
    function writeRegistryEntry(pid: number, sessionId: string, startedAt: number = Date.now()): void {
      const sessionsDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
        pid, sessionId, cwd: workspacePath, startedAt,
        kind: 'interactive', entrypoint: 'claude-vscode', version: 'test',
      }));
    }

    it('is false with no live registered process for the session', async () => {
      const discovery = makeDiscovery();
      await discovery.start(() => {});
      const spy = vi.spyOn(discovery as unknown as { isRecentlyActiveElsewhere: () => boolean }, 'isRecentlyActiveElsewhere');
      await expect(discovery.isExternalWriterFresh('no-such-session')).resolves.toBe(false);
      // Unresolved (no live process at all) must short-circuit before ever
      // touching disk for a recency check.
      expect(spy).not.toHaveBeenCalled();
      discovery.stop();
    });

    it('is false for a real child process of this test (same window, by construction)', async () => {
      // A spawned child's parent pid is this test process itself, exactly the
      // "own window" condition WriterOwnership checks for — no execFile mocking
      // needed, this exercises the real `ps` shell-out end to end.
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
      try {
        writeRegistryEntry(child.pid!, 'own-window-sess');
        const discovery = makeDiscovery();
        const spy = vi.spyOn(discovery as unknown as { isRecentlyActiveElsewhere: () => boolean }, 'isRecentlyActiveElsewhere');
        // Deliberately does NOT wait on discovery.start()'s poll cadence —
        // isExternalWriterFresh() must resolve correctly on demand, doing its
        // own scan+refresh, independent of the ambient poll loop.
        await expect(discovery.isExternalWriterFresh('own-window-sess')).resolves.toBe(false);
        // Confirmed own-window must never pay the fs-touching recency cost.
        expect(spy).not.toHaveBeenCalled();
      } finally {
        child.kill();
      }
    });

    it('resolves fresh even when called before the process was ever polled', async () => {
      // Same real-child-process setup as above, but the registry entry is
      // written AFTER the discovery instance is constructed and started —
      // proving the check isn't dependent on a prior scan having already seen
      // this pid (the exact staleness gap the adversarial review flagged).
      const discovery = makeDiscovery();
      await discovery.start(() => {});
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
      try {
        writeRegistryEntry(child.pid!, 'just-appeared-sess');
        await expect(discovery.isExternalWriterFresh('just-appeared-sess')).resolves.toBe(false);
      } finally {
        child.kill();
        discovery.stop();
      }
    });

    it('is true when confirmed external AND recently active (main JSONL just written)', async () => {
      const sessionId = 'ext-fresh-active';
      createJsonlFile(sessionId); // fresh mtime, "now"
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntry(ext.pid, sessionId);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(true);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });

    it('is false when confirmed external but quiet past EXTERNAL_WRITER_QUIET_MS, even though the process is still alive', async () => {
      const sessionId = 'ext-fresh-quiet';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      fs.utimesSync(filePath, new Date(old), new Date(old));
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntry(ext.pid, sessionId, old);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(false);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });

    it('is true when the main JSONL is quiet but a subagent file under subagents/ is recent (actively orchestrating)', async () => {
      const sessionId = 'ext-fresh-subagent-active';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      fs.utimesSync(filePath, new Date(old), new Date(old));
      const subagentFile = path.join(projectsDir, workspaceKey, sessionId, 'subagents', 'agent-aaa111.jsonl');
      fs.mkdirSync(path.dirname(subagentFile), { recursive: true });
      fs.writeFileSync(subagentFile, ''); // fresh mtime, "now"
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntry(ext.pid, sessionId, old);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(true);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });
  });

  describe('resolveWriterOwnership() gating on recent activity (via getSnapshots().externalWriter)', () => {
    function writeRegistryEntry(pid: number, sessionId: string, startedAt: number = Date.now()): void {
      const sessionsDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
        pid, sessionId, cwd: workspacePath, startedAt,
        kind: 'interactive', entrypoint: 'claude-vscode', version: 'test',
      }));
    }

    it('confirmed external + recent activity -> externalWriter is true', async () => {
      const sessionId = 'gate-active';
      createJsonlFile(sessionId); // fresh mtime, "now"
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntry(ext.pid, sessionId);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
        expect(snap?.externalWriter).toBe(true);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });

    it('confirmed external + quiet past the threshold -> externalWriter flips to false', async () => {
      const sessionId = 'gate-quiet';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      fs.utimesSync(filePath, new Date(old), new Date(old));
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntry(ext.pid, sessionId, old);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
        expect(snap?.externalWriter).toBe(false);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });

    it('confirmed own-window -> unchanged (false), and the fs-touching recency check is never invoked', async () => {
      const sessionId = 'gate-own-window';
      createJsonlFile(sessionId);
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
      try {
        writeRegistryEntry(child.pid!, sessionId);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        const spy = vi.spyOn(discovery as unknown as { isRecentlyActiveElsewhere: () => boolean }, 'isRecentlyActiveElsewhere');
        const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
        expect(snap?.externalWriter).toBe(false);
        expect(spy).not.toHaveBeenCalled();
        discovery.stop();
      } finally {
        child.kill();
      }
    });

    it('no live process (unresolved) -> unchanged (undefined), and the fs-touching recency check is never invoked', async () => {
      const sessionId = 'gate-unresolved';
      createJsonlFile(sessionId);
      const discovery = makeDiscovery();
      await discovery.start(() => {});
      const spy = vi.spyOn(discovery as unknown as { isRecentlyActiveElsewhere: () => boolean }, 'isRecentlyActiveElsewhere');
      const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
      expect(snap?.externalWriter).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      discovery.stop();
    });

    it('caches the recency verdict briefly so a flagged session does not re-walk its subagents dir on every tick', async () => {
      const sessionId = 'gate-cache';
      createJsonlFile(sessionId); // fresh -> within the activity window
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntry(ext.pid, sessionId);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        const spy = vi.spyOn(discovery as unknown as { isRecentlyActiveElsewhere: () => boolean }, 'isRecentlyActiveElsewhere');
        expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBe(true);
        expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBe(true);
        expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBe(true);
        // Three snapshot builds, one fs-touching recency resolution — the rest
        // were served from the TTL cache.
        expect(spy).toHaveBeenCalledTimes(1);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });
  });

  describe('isRecentlyActiveElsewhere() with two confirmed-external processes under one sessionId', () => {
    // ProcessRegistry.getProcessesForSession documents (and is tested for)
    // returning more than one live process for a single sessionId — a race,
    // or the terminal-spawned-process gap noted in writerOwnership.ts. Pins
    // down the any-positive-signal-is-enough posture so a future refactor
    // that narrows `.some()` to `.every()` or `procs[0]` would fail here.
    it('locks (true) when one of two confirmed-external processes is fresh even though the other is quiet', async () => {
      const sessionId = 'two-external-procs-active';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      fs.utimesSync(filePath, new Date(old), new Date(old));
      const extA = await spawnExternalProcess();
      const extB = await spawnExternalProcess();
      try {
        // A is quiet (old startedAt, and the session's only write is the old
        // main JSONL); B has just attached (recent startedAt). Any positive
        // signal across the set must still lock the session.
        writeRegistryEntryWithCwd(extA.pid, sessionId, { startedAt: old });
        writeRegistryEntryWithCwd(extB.pid, sessionId, { startedAt: Date.now() });
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(true);
        discovery.stop();
      } finally {
        extA.cleanup();
        extB.cleanup();
      }
    });

    it('unlocks (false) only when BOTH confirmed-external processes are quiet', async () => {
      const sessionId = 'two-external-procs-quiet';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      fs.utimesSync(filePath, new Date(old), new Date(old));
      const extA = await spawnExternalProcess();
      const extB = await spawnExternalProcess();
      try {
        writeRegistryEntryWithCwd(extA.pid, sessionId, { startedAt: old });
        writeRegistryEntryWithCwd(extB.pid, sessionId, { startedAt: old });
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(false);
        discovery.stop();
      } finally {
        extA.cleanup();
        extB.cleanup();
      }
    });
  });

  describe('isRecentlyActiveElsewhere() derives paths from proc.cwd, not the local workspace', () => {
    it('resolves activity from a DIFFERENT workspace than the local one, matching a team-lead/foreign-workspace cwd', async () => {
      const sessionId = 'cross-cwd-sess';
      const otherCwd = path.join(tmpDir, 'other-workspace');
      fs.mkdirSync(otherCwd, { recursive: true });
      const otherWorkspaceKey = sanitiseWorkspaceKey(otherCwd);
      // The session's JSONL lives under the OTHER workspace's projects dir,
      // fresh — nothing is created under the local workspace for this id at
      // all.
      const otherFilePath = path.join(projectsDir, otherWorkspaceKey, `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(otherFilePath), { recursive: true });
      fs.writeFileSync(otherFilePath, '');

      const ext = await spawnExternalProcess();
      try {
        // startedAt is deliberately OLD, so only a correct read of the fresh
        // file under proc.cwd's own workspace dir can produce `true` — a
        // regression back to `this.workspaceKey` would find nothing (the
        // local workspace has no file for this session at all) and report
        // `false`.
        const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
        writeRegistryEntryWithCwd(ext.pid, sessionId, { startedAt: old, cwd: otherCwd });
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(true);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });
  });

  describe('isRecentlyActiveElsewhere() excludes own-window processes from the recency floor', () => {
    it('does not let a fresh own-window process keep a session locked when the confirmed-external process is actually quiet', async () => {
      const sessionId = 'own-window-plus-quiet-external';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      fs.utimesSync(filePath, new Date(old), new Date(old));

      const ext = await spawnExternalProcess(); // confirmed different window, quiet
      const { spawn } = await import('child_process');
      const ownChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']); // confirmed own window, fresh
      try {
        writeRegistryEntryWithCwd(ext.pid, sessionId, { startedAt: old });
        writeRegistryEntryWithCwd(ownChild.pid!, sessionId, { startedAt: Date.now() });
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        // Ownership still resolves confirmed-external (the external pid
        // alone is enough — aggregateWriterOwnership's any-true rule), but
        // the recency check must be scoped to the external pid only: its own
        // activity (old file, old startedAt) is quiet, so this must unlock,
        // NOT stay locked off the own-window process's fresh startedAt.
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(false);
        discovery.stop();
      } finally {
        ext.cleanup();
        ownChild.kill();
      }
    });
  });

  describe('grace period: a freshly-attached process on an old, otherwise-quiet session', () => {
    it('is true end-to-end through isExternalWriterFresh() and getSnapshots().externalWriter', async () => {
      const sessionId = 'grace-period-fresh-attach';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      // Old file, no subagent activity at all — only startedAt is recent.
      fs.utimesSync(filePath, new Date(old), new Date(old));
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntryWithCwd(ext.pid, sessionId, { startedAt: Date.now() });
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(true);
        const snap = discovery.getSnapshots().find(s => s.sessionId === sessionId);
        expect(snap?.externalWriter).toBe(true);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });
  });

  describe('externalWriter transitions from true to false purely as quiet time elapses', () => {
    it('flips false once EXTERNAL_WRITER_QUIET_MS and the recency cache TTL have both elapsed, with ownership unchanged', async () => {
      const sessionId = 'quiet-transition';
      const t0 = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(t0);
        const filePath = createJsonlFile(sessionId); // real fs mtime ~ t0
        const ext = await spawnExternalProcess();
        try {
          writeRegistryEntryWithCwd(ext.pid, sessionId, { startedAt: t0 });
          const discovery = makeDiscovery();
          await discovery.start(() => {});

          expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBe(true);

          // Jump well past both the quiet threshold and the recency cache
          // TTL, with NO change to ownership (same registry entry, same pid
          // still alive) — proves the cache actually re-evaluates rather
          // than sticking on its first verdict forever.
          vi.setSystemTime(t0 + EXTERNAL_WRITER_QUIET_MS + 60_000);
          expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBe(false);
          discovery.stop();
        } finally {
          ext.cleanup();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('isExternalWriterFresh() recognises nested workflows/<runId>/ activity, not just flat subagent files', () => {
    it('is true when the main JSONL is quiet but a nested workflow-run file is recent', async () => {
      const sessionId = 'ext-fresh-workflow-nested';
      const filePath = createJsonlFile(sessionId);
      const old = Date.now() - EXTERNAL_WRITER_QUIET_MS - 60_000;
      fs.utimesSync(filePath, new Date(old), new Date(old));
      const nestedFile = path.join(projectsDir, workspaceKey, sessionId, 'subagents', 'workflows', 'wf_1', 'journal.jsonl');
      fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
      fs.writeFileSync(nestedFile, ''); // fresh mtime, "now"
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntryWithCwd(ext.pid, sessionId, { startedAt: old });
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(true);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });
  });

  describe('recencyCache pruning', () => {
    it('removes the recency cache entry when a session is pruned (JSONL deleted)', async () => {
      const sessionId = 'prune-recency-cache';
      const filePath = createJsonlFile(sessionId);
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntryWithCwd(ext.pid, sessionId);
        const discovery = makeDiscovery();
        await discovery.start(() => {});
        // Populate the cache via a confirmed-external, fresh resolution.
        expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBe(true);
        const cache = (discovery as unknown as { recencyCache: Map<string, unknown> }).recencyCache;
        expect(cache.has(sessionId)).toBe(true);

        // Delete the JSONL and run a poll cycle so the prune pass (which
        // scans lastScanSessionIds from THIS cycle's readdir) evicts the
        // session.
        fs.rmSync(filePath);
        await (discovery as unknown as { poll: () => Promise<void> }).poll();

        expect(cache.has(sessionId)).toBe(false);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });

    it('removes the recency cache entry for a foreign/sibling/team-lead id (never in this.sessions) once its process dies', async () => {
      // This id is deliberately never created via createJsonlFile, so it can
      // never appear in `this.sessions` / `lastScanSessionIds` — simulating
      // a session only ever reached via the shared writerOwnershipProbeFactory
      // (ForeignWorkspaceManager / SiblingWorktreeManager / TeamDiscovery),
      // which is exactly the category the local-scan prune loop above cannot
      // see. Eviction here must come from the processRegistry-driven sweep.
      const sessionId = 'foreign-recency-prune';
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntryWithCwd(ext.pid, sessionId, { cwd: '/some/other/foreign/workspace' });
        const discovery = makeDiscovery();
        await discovery.start(() => {});

        // Populate the cache the same way the foreign/sibling/team probe
        // factory would, without ever touching `this.sessions`.
        const resolve = (discovery as unknown as { resolveWriterOwnership: (id: string) => boolean | undefined }).resolveWriterOwnership.bind(discovery);
        expect(resolve(sessionId)).toBe(true);
        const cache = (discovery as unknown as { recencyCache: Map<string, unknown> }).recencyCache;
        expect(cache.has(sessionId)).toBe(true);

        ext.cleanup();
        // kill(pid, 0) can still report a just-SIGKILL'd pid as alive for a
        // few ms until the OS finishes tearing it down (same allowance the
        // other process-death tests in this file give — see the 100ms waits
        // above); without it, isPidAlive() below races the kernel and flakes.
        await new Promise(r => setTimeout(r, 100));
        // processRegistry.shouldRescan() only fires every REGISTRY_SCAN_INTERVAL
        // (4) poll cycles — drive enough cycles to force it.
        const poll = (discovery as unknown as { poll: () => Promise<void> }).poll.bind(discovery);
        for (let i = 0; i < 4; i++) { await poll(); }

        expect(cache.has(sessionId)).toBe(false);
        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });
  });

  describe('externalWriter gated behind serac.experimental.externalWriterBlock (default off)', () => {
    it('off (the real default) — never touches the process registry or blocks, even for a genuinely confirmed-external, actively-writing process', async () => {
      // Clears the ambient "on" the outer beforeEach sets for the rest of
      // this file's (pre-existing) externalWriter tests — this test alone
      // proves the real production default.
      _resetConfig();
      const sessionId = 'gate-off-default';
      const filePath = createJsonlFile(sessionId);
      fs.utimesSync(filePath, new Date(), new Date()); // as block-worthy as it gets
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntryWithCwd(ext.pid, sessionId);
        const discovery = makeDiscovery();
        await discovery.start(() => {});

        // getProcessesForSession is only ever called by resolveWriterOwnership
        // and isExternalWriterFresh — never invoked proves the gate returns
        // before either function does any work at all, not just before blocking.
        const registrySpy = vi.spyOn(
          (discovery as unknown as { processRegistry: { getProcessesForSession: (id: string) => unknown } }).processRegistry,
          'getProcessesForSession',
        );

        expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBeUndefined();
        expect(registrySpy).not.toHaveBeenCalled();

        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(false);
        expect(registrySpy).not.toHaveBeenCalled();

        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });

    it('on — restores the exact current behaviour (confirmed-external + recent activity blocks)', async () => {
      _setConfigValues({ 'serac.experimental.externalWriterBlock': true });
      const sessionId = 'gate-on-restores';
      const filePath = createJsonlFile(sessionId);
      fs.utimesSync(filePath, new Date(), new Date());
      const ext = await spawnExternalProcess();
      try {
        writeRegistryEntryWithCwd(ext.pid, sessionId);
        const discovery = makeDiscovery();
        await discovery.start(() => {});

        expect(discovery.getSnapshots().find(s => s.sessionId === sessionId)?.externalWriter).toBe(true);
        await expect(discovery.isExternalWriterFresh(sessionId)).resolves.toBe(true);

        discovery.stop();
      } finally {
        ext.cleanup();
      }
    });
  });
});
