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

  describe('abandoned live run → incomplete (liveness probe)', () => {
    function writeLiveRun(runId: string): void {
      const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'liveaaa1' }), 'utf-8');
    }

    it('marks the run incomplete when the parent session is dead in a clean, active registry', async () => {
      writeLiveRun('wf_dead-001');
      const deadProbe = { isActive: () => true, isScanClean: () => true, isSessionLive: () => false };
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log, deadProbe);
      await d.scan();
      const snaps = d.getWorkflowSnapshots(emptyMeta());
      expect(snaps[0].status).toBe('incomplete');
      expect(d.hasActiveRuns()).toBe(false); // 'incomplete' is not 'running' → poll cadence relaxes
      d.dispose();
    });

    it('keeps the run running while the parent session IS live', async () => {
      writeLiveRun('wf_live-003');
      const liveProbe = { isActive: () => true, isScanClean: () => true, isSessionLive: (id: string) => id === SID };
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log, liveProbe);
      await d.scan();
      expect(d.getWorkflowSnapshots(emptyMeta())[0].status).toBe('running');
      d.dispose();
    });

    it('stays running (conservative) when the registry is empty or its scan is degraded', async () => {
      writeLiveRun('wf_live-004');
      const idleProbe = { isActive: () => false, isScanClean: () => false, isSessionLive: () => false };
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log, idleProbe);
      await d.scan();
      expect(d.getWorkflowSnapshots(emptyMeta())[0].status).toBe('running');
      d.dispose();
    });
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
    // Loop-var prompt over an array the script never declares → unmatchable →
    // flat fallback (no phase) with an agent-distinct label. The journal key
    // (`v2:b`) must NEVER surface as a label, and the prompt rides as preview.
    expect(ver.phaseIndex).toBeNull();
    expect(ver.phaseTitle).toBeNull();
    expect(ver.label).toBe('Agent · verbbb2');
    expect(ver.promptPreview).toContain('a wholly dynamic per-item payload');
    d.dispose();
  });

  it('expands the canonical pipeline(ARR, d => agent(d.prompt)) shape into per-element phase + label', async () => {
    const runId = 'wf_expand-01';
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'v2:x', agentId: 'aaaaaa1' }),
      JSON.stringify({ type: 'started', key: 'v2:y', agentId: 'bbbbbb2' }),
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(runDir, 'agent-aaaaaa1.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'SHARED HEAD. Audit the security posture of the entire system end to end.' } }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(runDir, 'agent-bbbbbb2.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'SHARED HEAD. Audit the performance characteristics under sustained load.' } }) + '\n', 'utf-8');
    const scriptsDir = path.join(sessionDir(), 'workflows', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = [
      "export const meta = { name: 'exp', description: 'd', phases: [{ title: 'Audit' }] }",
      'const COMMON = `SHARED HEAD.`',
      'const DIMENSIONS = [',
      "  { key: 'security', prompt: `${COMMON} Audit the security posture of the entire system end to end.` },",
      "  { key: 'perf', prompt: `${COMMON} Audit the performance characteristics under sustained load.` },",
      ']',
      'await pipeline(DIMENSIONS, (d) => agent(d.prompt, { label: `audit:${d.key}`, phase: \'Audit\' }))',
    ].join('\n');
    fs.writeFileSync(path.join(scriptsDir, `exp-${runId}.js`), script, 'utf-8');

    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snap = d.getWorkflowSnapshots(emptyMeta())[0];
    const sec = snap.agents.find(a => a.agentId === 'aaaaaa1')!;
    const perf = snap.agents.find(a => a.agentId === 'bbbbbb2')!;
    // Each fan-out agent resolves to ITS element: right phase, exact label
    // (statically resolved from the element's `key` — no runtime alignment).
    expect(sec.phaseTitle).toBe('Audit');
    expect(sec.label).toBe('audit:security');
    expect(perf.phaseTitle).toBe('Audit');
    expect(perf.label).toBe('audit:perf');
    d.dispose();
  });

  it('recovers distinct interpolated labels per fan-out agent (audit:${d.key} bug)', async () => {
    // The reported regression: every fan-out agent rendered the raw template
    // `audit:${d.key}`. They must now read as audit:privacy / audit:security /…
    const runId = 'wf_interp-001';
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'v2:p', agentId: 'agprivacy' }),
      JSON.stringify({ type: 'started', key: 'v2:s', agentId: 'agsecurit' }),
    ].join('\n'), 'utf-8');
    const mkPrompt = (dim: string) =>
      `=== YOUR DIMENSION: ${dim} ===\n\nAudit the claude profile system for this dimension.`;
    fs.writeFileSync(path.join(runDir, 'agent-agprivacy.jsonl'),
      JSON.stringify({ type: 'user', message: { content: mkPrompt('privacy') } }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(runDir, 'agent-agsecurit.jsonl'),
      JSON.stringify({ type: 'user', message: { content: mkPrompt('security') } }) + '\n', 'utf-8');
    const scriptsDir = path.join(sessionDir(), 'workflows', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = [
      "export const meta = { name: 'audit-claude-profile-system', description: 'd', phases: [{ title: 'Audit' }] }",
      "phase('Audit')",
      "await parallel(DIMENSIONS.map(d => () => agent(`=== YOUR DIMENSION: ${d.key} ===\\n\\nAudit the claude profile system for this dimension.`, { label: `audit:${d.key}`, phase: 'Audit' })))",
    ].join('\n');
    fs.writeFileSync(path.join(scriptsDir, `audit-claude-profile-system-${runId}.js`), script, 'utf-8');

    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snap = d.getWorkflowSnapshots(emptyMeta())[0];
    const labels = snap.agents.map(a => a.label).sort();
    expect(labels).toEqual(['audit:privacy', 'audit:security']);
    // And no row leaks the raw template source.
    expect(snap.agents.every(a => !a.label.includes('${'))).toBe(true);
    d.dispose();
  });

  it('falls back to a phase-scoped, agent-distinct label when interpolation cannot be recovered', async () => {
    // Matched call (shares the static head) but the prompt never exposes the
    // label's interpolation value, so recovery fails → no raw ${…}, no clones.
    const runId = 'wf_interp-002';
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
      JSON.stringify({ type: 'started', key: 'v2:x', agentId: 'agonexyz' }) + '\n', 'utf-8');
    // Prompt matches the call's distinctive static head, but carries no value
    // in the ${name} slot the label needs.
    fs.writeFileSync(path.join(runDir, 'agent-agonexyz.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'Run the distinctive synthesis stage now please.' } }) + '\n', 'utf-8');
    const scriptsDir = path.join(sessionDir(), 'workflows', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = [
      "export const meta = { name: 'fb', description: 'd', phases: [{ title: 'Synthesise' }] }",
      "agent('Run the distinctive synthesis stage now please.', { label: `synth:${d.name}`, phase: 'Synthesise' })",
    ].join('\n');
    fs.writeFileSync(path.join(scriptsDir, `fb-${runId}.js`), script, 'utf-8');

    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const agent = d.getWorkflowSnapshots(emptyMeta())[0].agents[0];
    expect(agent.label).toBe('Synthesise · agonexyz');
    expect(agent.label.includes('${')).toBe(false);
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
