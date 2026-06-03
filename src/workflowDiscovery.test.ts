import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Required because WorkflowDiscovery transitively imports settings.ts → 'vscode'.
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionMeta } from './types.js';
import { _setConfigValues, _resetConfig } from './__mocks__/vscode.js';

const { WorkflowDiscovery } = await import('./workflowDiscovery.js');

const WS_KEY = '-Users-test-repo';
const SID = '11111111-2222-3333-4444-555555555555';

let projectsDir: string;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };

function sessionDir(): string {
  return path.join(projectsDir, WS_KEY, SID);
}

/** Write a completion sidecar for a run owned by SID. */
function writeSidecar(runId: string, body: Record<string, unknown>): string {
  const dir = path.join(sessionDir(), 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(body), 'utf-8');
  return file;
}

function validSidecar(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId,
    workflowName: 'demo',
    summary: 'a demo run',
    status: 'completed',
    startTime: 1780000000000,
    durationMs: 1000,
    defaultModel: 'claude-opus-4-8[1m]',
    agentCount: 1,
    totalTokens: 100,
    totalToolCalls: 2,
    logs: [],
    phases: [{ title: 'Only', detail: 'd' }],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Only' },
      { type: 'workflow_agent', index: 1, agentId: 'aaa111', phaseIndex: 1, phaseTitle: 'Only', state: 'done', label: 'lab' },
    ],
    ...overrides,
  };
}

function emptyMeta(): Map<string, SessionMeta> {
  return new Map();
}

beforeEach(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-disc-'));
  log.warn.mockClear();
});

afterEach(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
  _resetConfig();
});

describe('WorkflowDiscovery', () => {
  it('discovers a completed sidecar and exposes a snapshot keyed to its session', async () => {
    writeSidecar('wf_run-001', validSidecar('wf_run-001'));
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snaps = d.getWorkflowSnapshots(emptyMeta());
    expect(snaps).toHaveLength(1);
    expect(snaps[0].runId).toBe('wf_run-001');
    expect(snaps[0].sessionId).toBe(SID);
    expect(snaps[0].source).toBe('sidecar');
    expect(snaps[0].agents).toHaveLength(1);
    d.dispose();
  });

  it('returns empty when the workspace dir does not exist', async () => {
    const d = new WorkflowDiscovery(path.join(projectsDir, 'nope'), WS_KEY, log);
    await d.scan();
    expect(d.getWorkflowSnapshots(emptyMeta())).toHaveLength(0);
  });

  it('does not re-parse an unchanged sidecar (mtime cache), but prunes a deleted one', async () => {
    const file = writeSidecar('wf_run-002', validSidecar('wf_run-002'));
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    expect(d.getWorkflowSnapshots(emptyMeta())).toHaveLength(1);
    expect(await d.poll()).toBe(true); // first scan added a run → change
    // Unchanged scan → still there, poll reports no change.
    await d.scan();
    expect(await d.poll()).toBe(false);
    // Delete the sidecar → next scan prunes it.
    fs.rmSync(file);
    await d.scan();
    expect(d.getWorkflowSnapshots(emptyMeta())).toHaveLength(0);
    expect(await d.poll()).toBe(true);
    d.dispose();
  });

  it('ignores sidecars older than the age gate', async () => {
    const file = writeSidecar('wf_old-001', validSidecar('wf_old-001'));
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(file, eightDaysAgo, eightDaysAgo);
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    expect(d.getWorkflowSnapshots(emptyMeta())).toHaveLength(0);
    d.dispose();
  });

  it('skips a malformed sidecar with a warning but keeps valid ones', async () => {
    writeSidecar('wf_good-001', validSidecar('wf_good-001'));
    const dir = path.join(sessionDir(), 'workflows');
    fs.writeFileSync(path.join(dir, 'wf_bad-001.json'), '{ not json', 'utf-8');
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snaps = d.getWorkflowSnapshots(emptyMeta());
    expect(snaps.map(s => s.runId)).toEqual(['wf_good-001']);
    expect(log.warn).toHaveBeenCalled();
    d.dispose();
  });

  it('overlays dismiss state keyed workflow:<runId>', async () => {
    writeSidecar('wf_run-003', validSidecar('wf_run-003'));
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const meta = new Map<string, SessionMeta>([
      ['workflow:wf_run-003', { title: null, dismissed: true, acknowledged: false, acknowledgedAt: null, firstSeen: 0 } as SessionMeta],
    ]);
    expect(d.getWorkflowSnapshots(meta)[0].dismissed).toBe(true);
    expect(d.getWorkflowSnapshots(emptyMeta())[0].dismissed).toBe(false);
    d.dispose();
  });

  it('resolves an existing agent transcript path and null for a missing one', async () => {
    writeSidecar('wf_run-004', validSidecar('wf_run-004'));
    const agentDir = path.join(sessionDir(), 'subagents', 'workflows', 'wf_run-004');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent-aaa111.jsonl'), '{}', 'utf-8');
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    expect(d.getWorkflowAgentFilePath('wf_run-004', 'aaa111')).toContain('agent-aaa111.jsonl');
    expect(d.getWorkflowAgentFilePath('wf_run-004', 'missing')).toBeNull();
    expect(d.getWorkflowAgentFilePath('wf_unknown', 'aaa111')).toBeNull();
    d.dispose();
  });

  it('rejects a traversal/invalid agentId even when the run exists (path-traversal guard)', async () => {
    writeSidecar('wf_run-005', validSidecar('wf_run-005'));
    // Plant a real file at the traversal target so only the guard — not a
    // missing-file check — can be what returns null.
    const runAgentDir = path.join(sessionDir(), 'subagents', 'workflows', 'wf_run-005');
    fs.mkdirSync(runAgentDir, { recursive: true });
    fs.writeFileSync(path.join(runAgentDir, 'agent-evil.jsonl'), '{}', 'utf-8');
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    expect(d.getWorkflowAgentFilePath('wf_run-005', '../../../etc/passwd')).toBeNull();
    expect(d.getWorkflowAgentFilePath('wf_run-005', 'x/../agent-evil')).toBeNull();
    expect(d.getWorkflowAgentFilePath('wf_run-005', 'a\\b')).toBeNull();
    expect(d.getWorkflowAgentFilePath('wf_run-005', 'a' + String.fromCharCode(0) + 'b')).toBeNull();
    d.dispose();
  });

  it('clears snapshots when show.workflows is disabled and reports the change exactly once', async () => {
    writeSidecar('wf_run-006', validSidecar('wf_run-006'));
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    expect(d.getWorkflowSnapshots(emptyMeta())).toHaveLength(1);
    expect(await d.poll()).toBe(true); // first scan added a run
    expect(await d.poll()).toBe(false); // drained

    // Disable the feature: scan() must clear and flag the change; poll() must
    // surface it once (and not get stuck), even though the setting is now off.
    _setConfigValues({ 'serac.show.workflows': false });
    await d.scan();
    expect(d.getWorkflowSnapshots(emptyMeta())).toHaveLength(0);
    expect(await d.poll()).toBe(true);  // the clear is reported once
    expect(await d.poll()).toBe(false); // flag drained, not stuck
    d.dispose();
  });

  it('does not flag a change when an unchanged live run is re-scanned (no panel churn)', async () => {
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', 'wf_live-002');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
      JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'live01' }), 'utf-8');
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    expect(d.getWorkflowSnapshots(emptyMeta())).toHaveLength(1);
    expect(await d.poll()).toBe(true);  // first sighting of the live run
    // Re-scan with nothing changed on disk → the rebuilt live snapshot is equal,
    // so poll() must report no change rather than churning every cycle.
    await d.scan();
    expect(await d.poll()).toBe(false);
    d.dispose();
  });

  it('reconstructs a minimal running snapshot for a live run with no sidecar', async () => {
    // Run dir + journal, but NO sidecar → Tier 2.
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', 'wf_live-001');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'live01' }),
      JSON.stringify({ type: 'started', key: 'v2:b', agentId: 'live02' }),
      JSON.stringify({ type: 'result', key: 'v2:a', agentId: 'live01', result: 'ok' }),
    ].join('\n'), 'utf-8');
    // A script so the live run can be named.
    const scriptsDir = path.join(sessionDir(), 'workflows', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, 'demo-live-wf_live-001.js'),
      "export const meta = { name: 'demo-live', description: 'd', phases: [{ title: 'A' }] }\n",
      'utf-8',
    );
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snaps = d.getWorkflowSnapshots(emptyMeta());
    expect(snaps).toHaveLength(1);
    expect(snaps[0].source).toBe('live');
    expect(snaps[0].status).toBe('running');
    expect(snaps[0].name).toBe('demo-live');
    expect(snaps[0].agents).toHaveLength(2);
    expect(snaps[0].counts.running).toBe(1); // live02 unresolved
    expect(snaps[0].counts.done).toBe(1);    // live01 resolved
    expect(d.hasActiveRuns()).toBe(true);
    d.dispose();
  });

  it('correlates a live agent to its phase via record-0 prompt, flat-fallback when unmatchable', async () => {
    const runId = 'wf_corr-001';
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    // Two running agents: one spawned from a static-prompt agent() call, one
    // from a loop-var prompt the script never spells out.
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'revaaa1' }),
      JSON.stringify({ type: 'started', key: 'v2:b', agentId: 'verbbb2' }),
    ].join('\n'), 'utf-8');
    // record-0 prompts: the review agent's expanded prompt contains the call's
    // static head; the verify agent's is wholly dynamic.
    fs.writeFileSync(path.join(runDir, 'agent-revaaa1.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'Carefully review the authentication module for security bugs.\n\nCONTEXT: lorem ipsum dolor sit amet' } }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(runDir, 'agent-verbbb2.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'a wholly dynamic per-item payload the script never spelled out statically' } }) + '\n', 'utf-8');
    // Script: two phases; a static review call and a loop-var verify call.
    const scriptsDir = path.join(sessionDir(), 'workflows', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = [
      "export const meta = { name: 'corr', description: 'd', phases: [{ title: 'Review' }, { title: 'Verify' }] }",
      "phase('Review')",
      "const r = await agent(`Carefully review the authentication module for security bugs.\\n\\n${CTX}`, { label: 'review:auth', phase: 'Review' })",
      "phase('Verify')",
      "await parallel(items.map(c => () => agent(c.prompt, { phase: 'Verify' })))",
    ].join('\n');
    fs.writeFileSync(path.join(scriptsDir, `corr-${runId}.js`), script, 'utf-8');

    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snap = d.getWorkflowSnapshots(emptyMeta())[0];
    expect(snap.source).toBe('live');
    const rev = snap.agents.find(a => a.agentId === 'revaaa1')!;
    const ver = snap.agents.find(a => a.agentId === 'verbbb2')!;
    // Matched → grouped under its phase, labelled from the opts.
    expect(rev.phaseIndex).toBe(1);
    expect(rev.phaseTitle).toBe('Review');
    expect(rev.label).toBe('review:auth');
    // Loop-var prompt → unmatchable → flat fallback (no phase), journal-key label.
    expect(ver.phaseIndex).toBeNull();
    expect(ver.phaseTitle).toBeNull();
    expect(ver.label).toBe('v2:b');
    d.dispose();
  });

  it('prefers the sidecar over the live dir once a run completes', async () => {
    // Both a sidecar AND a run dir exist (the normal completed case).
    writeSidecar('wf_done-001', validSidecar('wf_done-001'));
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', 'wf_done-001');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), JSON.stringify({ type: 'started', agentId: 'x' }), 'utf-8');
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snaps = d.getWorkflowSnapshots(emptyMeta());
    expect(snaps).toHaveLength(1);
    expect(snaps[0].source).toBe('sidecar');
    expect(snaps[0].status).toBe('completed');
    d.dispose();
  });
});
