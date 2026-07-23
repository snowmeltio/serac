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
      JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'live01' }) + '\n', 'utf-8');
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
    ].join('\n') + '\n', 'utf-8');
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

  it('sums per-agent live tokens/tools into the run-level header totals (no sidecar)', async () => {
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', 'wf_live-agg');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'live01' }),
      JSON.stringify({ type: 'started', key: 'v2:b', agentId: 'live02' }),
    ].join('\n') + '\n', 'utf-8');
    // live01 → 100 tokens, 1 tool_use
    fs.writeFileSync(path.join(runDir, 'agent-live01.jsonl'), [
      JSON.stringify({ message: { model: 'claude-sonnet-5', usage: { output_tokens: 100 }, content: [{ type: 'tool_use', name: 'Bash' }] } }),
    ].join('\n') + '\n', 'utf-8');
    // live02 → 50 tokens, 2 tool_use (no model on any record yet)
    fs.writeFileSync(path.join(runDir, 'agent-live02.jsonl'), [
      JSON.stringify({ message: { usage: { output_tokens: 50 }, content: [{ type: 'tool_use' }, { type: 'text', text: 'x' }, { type: 'tool_use' }] } }),
    ].join('\n') + '\n', 'utf-8');
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snap = d.getWorkflowSnapshots(emptyMeta())[0];
    // Header totals must equal the sum of the per-agent rows, not the old 0/0.
    expect(snap.totalTokens).toBe(150);
    expect(snap.totalToolCalls).toBe(3);
    expect(snap.totalTokens).toBe(snap.agents.reduce((n, a) => n + a.tokens, 0));
    expect(snap.totalToolCalls).toBe(snap.agents.reduce((n, a) => n + a.toolCalls, 0));
    // The live tier reads the model off the transcript's assistant records —
    // previously hardcoded '' until the sidecar materialised it.
    expect(snap.agents.find(a => a.agentId === 'live01')?.model).toBe('claude-sonnet-5');
    expect(snap.agents.find(a => a.agentId === 'live02')?.model).toBe('');
    d.dispose();
  });

  describe('abandoned live run → incomplete (liveness probe)', () => {
    function writeLiveRun(runId: string): void {
      const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'liveaaa1' }) + '\n', 'utf-8');
    }

    // Real-world repro (2026-07-23, BCT deck-build session): a lead session
    // idles between JSONL turns while its own background Workflow keeps
    // running. The registry rescans on a relaxed cadence (every 4th poll,
    // see processRegistry.ts), so a session that is genuinely alive can read
    // as absent from a single snapshot — exactly while its own turn is
    // quiet. Without a latch this misfired 'incomplete' on a healthy run,
    // which fed applyWorkflowLiveStatus's `status === 'running'` filter and
    // left the card stuck on 'done' with a live workflow still under it.
    it('does NOT mark incomplete on a session never yet confirmed live, even if currently absent', async () => {
      writeLiveRun('wf_neverlive-001');
      const neverSeenLiveProbe = { isActive: () => true, isScanClean: () => true, isSessionLive: () => false };
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log, neverSeenLiveProbe);
      await d.scan();
      const snaps = d.getWorkflowSnapshots(emptyMeta());
      expect(snaps[0].status).toBe('running');
      expect(d.hasActiveRuns()).toBe(true);
      d.dispose();
    });

    it('marks the run incomplete once the parent session, previously confirmed live, is later absent', async () => {
      writeLiveRun('wf_dead-001');
      let live = true;
      const flakyProbe = { isActive: () => true, isScanClean: () => true, isSessionLive: (id: string) => live && id === SID };
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log, flakyProbe);
      await d.scan(); // seen live once — latches
      expect(d.getWorkflowSnapshots(emptyMeta())[0].status).toBe('running');

      live = false; // now confirmed gone
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

    // Companion backstop to the latch above: without a registry that can ever
    // vouch for this run's parent, an abandoned run would otherwise ride
    // 'running' all the way to the 7-day age gate.
    it('marks the run incomplete after prolonged inactivity when the registry can never vouch for it', async () => {
      vi.useFakeTimers();
      try {
        writeLiveRun('wf_ceiling-001');
        const d = new WorkflowDiscovery(projectsDir, WS_KEY, log); // no liveness probe at all
        await d.scan();
        expect(d.getWorkflowSnapshots(emptyMeta())[0].status).toBe('running');

        vi.setSystemTime(Date.now() + 31 * 60 * 1000); // past UNCONFIRMED_LIVENESS_CEILING_MS, no new activity
        await d.scan();
        expect(d.getWorkflowSnapshots(emptyMeta())[0].status).toBe('incomplete');
        d.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not apply the inactivity ceiling while the registry positively confirms the parent live', async () => {
      vi.useFakeTimers();
      try {
        writeLiveRun('wf_ceiling-002');
        const liveProbe = { isActive: () => true, isScanClean: () => true, isSessionLive: (id: string) => id === SID };
        const d = new WorkflowDiscovery(projectsDir, WS_KEY, log, liveProbe);
        await d.scan(); // latches everSeenLive

        vi.setSystemTime(Date.now() + 31 * 60 * 1000);
        await d.scan();
        expect(d.getWorkflowSnapshots(emptyMeta())[0].status).toBe('running');
        d.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('live-tier run directory mtime pitfalls', () => {
    // Real repro reasoning (2026-07-23, same audit as the liveness latch
    // above): a run directory's own mtime only advances when an entry is
    // added/removed (a new sibling agent file appearing) — never when an
    // EXISTING journal/transcript keeps growing. Two separate places in
    // buildLiveSnapshot/scanLiveRuns used to read that mtime as if it meant
    // "recent activity", the exact pitfall the parentDead check's own comment
    // warns against.
    it('does not prune a live run whose journal is recent even when the run directory mtime reads old', async () => {
      const runId = 'wf_dirmtime-001';
      const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'liveaaa1' }) + '\n', 'utf-8');
      // The directory's own mtime is frozen from whenever its last sibling
      // agent file was created — well past the 7-day age gate — even though
      // the journal itself (written just above) is genuinely current.
      const eightDaysAgoSec = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(runDir, eightDaysAgoSec, eightDaysAgoSec);

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      const snaps = d.getWorkflowSnapshots(emptyMeta());
      expect(snaps).toHaveLength(1);
      expect(snaps[0].status).toBe('running');
      d.dispose();
    });

    it("derives startTime from the run directory's birthtime, not its mtime", async () => {
      const runId = 'wf_birthtime-001';
      const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'liveaaa1' }) + '\n', 'utf-8');
      const birthtimeMs = fs.statSync(runDir).birthtimeMs;

      // Simulate a new sibling agent file bumping the directory's mtime
      // forward, well past its true birth — mtime is settable, birthtime isn't.
      const futureSec = (Date.now() + 20 * 60 * 1000) / 1000;
      fs.utimesSync(runDir, futureSec, futureSec);

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      const snap = d.getWorkflowSnapshots(emptyMeta())[0];
      expect(Math.abs(snap.startTime - birthtimeMs)).toBeLessThan(5000);
      expect(snap.startTime).toBeLessThan(futureSec * 1000 - 60_000);
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
    ].join('\n') + '\n', 'utf-8');
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

  it('finds a live run\'s script under a different workspace key (cwd-drift fallback)', async () => {
    const runId = 'wf_drift-001';
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
      JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'driftagt' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(runDir, 'agent-driftagt.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'Discover the best energy plan for this address.' } }) + '\n', 'utf-8');
    // The script sidecar lands under a wholly different workspace key — e.g.
    // the Workflow tool call's cwd had drifted to a scratchpad dir when it was
    // written — instead of this run's own session dir under WS_KEY.
    const driftedScriptsDir = path.join(projectsDir, '-private-tmp-scratchpad', SID, 'workflows', 'scripts');
    fs.mkdirSync(driftedScriptsDir, { recursive: true });
    const script = [
      "export const meta = { name: 'energy-deal-discover', description: 'd', phases: [{ title: 'Discover' }] }",
      "phase('Discover')",
      "await agent('Discover the best energy plan for this address.', { phase: 'Discover' })",
    ].join('\n');
    fs.writeFileSync(path.join(driftedScriptsDir, `energy-deal-discover-${runId}.js`), script, 'utf-8');

    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snap = d.getWorkflowSnapshots(emptyMeta())[0];
    expect(snap.source).toBe('live');
    expect(snap.name).toBe('energy-deal-discover');
    expect(snap.phases).toHaveLength(1);
    const agt = snap.agents.find(a => a.agentId === 'driftagt')!;
    expect(agt.phaseIndex).toBe(1);
    expect(agt.phaseTitle).toBe('Discover');
    d.dispose();
  });

  it('expands the canonical pipeline(ARR, d => agent(d.prompt)) shape into per-element phase + label', async () => {
    const runId = 'wf_expand-01';
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), [
      JSON.stringify({ type: 'started', key: 'v2:x', agentId: 'aaaaaa1' }),
      JSON.stringify({ type: 'started', key: 'v2:y', agentId: 'bbbbbb2' }),
    ].join('\n') + '\n', 'utf-8');
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
    ].join('\n') + '\n', 'utf-8');
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

  describe('live-tier caching (perf-io-1)', () => {
    function mkLiveRun(runId: string, journalLines: Record<string, unknown>[]): string {
      const runDir = path.join(sessionDir(), 'subagents', 'workflows', runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        journalLines.map(l => JSON.stringify(l) + '\n').join(''), 'utf-8');
      return runDir;
    }

    function writeSidecarIn(sessionId: string, runId: string): void {
      const dir = path.join(projectsDir, WS_KEY, sessionId, 'workflows');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(validSidecar(runId)), 'utf-8');
    }

    it('tails the journal instead of re-reading it (consumed bytes are never re-folded)', async () => {
      const line1 = { type: 'started', key: 'v2:a', agentId: 'agaaaaaa' };
      const runDir = mkLiveRun('wf_tail-001', [line1]);
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      expect(d.getWorkflowSnapshots(emptyMeta())[0].agents.map(a => a.agentId)).toEqual(['agaaaaaa']);

      // Rewrite the already-consumed first line in place (same byte length,
      // different agentId) and append a genuinely new record. A tailer must
      // pick up only the appended record; a from-scratch re-reader would
      // surface the rewritten id instead.
      const rewritten = { type: 'started', key: 'v2:a', agentId: 'agcccccc' };
      expect(JSON.stringify(rewritten).length).toBe(JSON.stringify(line1).length);
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify(rewritten) + '\n' + JSON.stringify({ type: 'started', key: 'v2:b', agentId: 'agbbbbbb' }) + '\n',
        'utf-8');
      await d.scan();
      const ids = d.getWorkflowSnapshots(emptyMeta())[0].agents.map(a => a.agentId).sort();
      expect(ids).toEqual(['agaaaaaa', 'agbbbbbb']);
      d.dispose();
    });

    it('folds an appended result record and reports the change via the snapshot signature', async () => {
      const runDir = mkLiveRun('wf_fold-001', [
        { type: 'started', key: 'v2:a', agentId: 'agaaaaaa' },
        { type: 'started', key: 'v2:b', agentId: 'agbbbbbb' },
      ]);
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      expect(await d.poll()).toBe(true);
      await d.scan();
      expect(await d.poll()).toBe(false); // idle cycle → no churn

      fs.appendFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'result', key: 'v2:a', agentId: 'agaaaaaa', result: 'ok' }) + '\n', 'utf-8');
      await d.scan();
      expect(await d.poll()).toBe(true); // status flip detected
      const snap = d.getWorkflowSnapshots(emptyMeta())[0];
      expect(snap.counts.done).toBe(1);
      expect(snap.counts.running).toBe(1);
      d.dispose();
    });

    it('clears the accumulators and replays on journal truncation', async () => {
      const runDir = mkLiveRun('wf_trunc-001', [
        { type: 'started', key: 'v2:a', agentId: 'agaaaaaa' },
        { type: 'started', key: 'v2:b', agentId: 'agbbbbbb' },
      ]);
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      expect(d.getWorkflowSnapshots(emptyMeta())[0].agents).toHaveLength(2);

      // The journal shrinks to different content — stale agents must not linger.
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:z', agentId: 'agzzzzzz' }) + '\n', 'utf-8');
      await d.scan();
      const agents = d.getWorkflowSnapshots(emptyMeta())[0].agents;
      expect(agents.map(a => a.agentId)).toEqual(['agzzzzzz']);
      d.dispose();
    });

    it('caches the record-0 prompt correlation (no per-cycle head re-read)', async () => {
      const runDir = mkLiveRun('wf_corrcache-01', [{ type: 'started', key: 'v2:a', agentId: 'revaaa1' }]);
      fs.writeFileSync(path.join(runDir, 'agent-revaaa1.jsonl'),
        JSON.stringify({ type: 'user', message: { content: 'Carefully review the authentication module for security bugs.' } }) + '\n', 'utf-8');
      const scriptsDir = path.join(sessionDir(), 'workflows', 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, 'cc-wf_corrcache-01.js'), [
        "export const meta = { name: 'cc', description: 'd', phases: [{ title: 'Review' }] }",
        "agent('Carefully review the authentication module for security bugs.', { label: 'review:auth', phase: 'Review' })",
      ].join('\n'), 'utf-8');

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      expect(d.getWorkflowSnapshots(emptyMeta())[0].agents[0].label).toBe('review:auth');

      const openSpy = vi.spyOn(fs.promises, 'open');
      await d.scan();
      await d.scan();
      const headReads = openSpy.mock.calls.filter(c => String(c[0]).endsWith('agent-revaaa1.jsonl'));
      expect(headReads).toHaveLength(0);
      openSpy.mockRestore();
      // The cached correlation still renders.
      const a = d.getWorkflowSnapshots(emptyMeta())[0].agents[0];
      expect(a.label).toBe('review:auth');
      expect(a.phaseTitle).toBe('Review');
      d.dispose();
    });

    it('recomputes a cached correlation when the script appears after the agent started', async () => {
      const runDir = mkLiveRun('wf_latescript-1', [{ type: 'started', key: 'v2:a', agentId: 'revaaa1' }]);
      fs.writeFileSync(path.join(runDir, 'agent-revaaa1.jsonl'),
        JSON.stringify({ type: 'user', message: { content: 'Carefully review the authentication module for security bugs.' } }) + '\n', 'utf-8');

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      // No script yet → fallback label, no phase (correlation cached at scriptV -1).
      expect(d.getWorkflowSnapshots(emptyMeta())[0].agents[0].label).toBe('Agent · revaaa1');
      await d.poll(); // drain

      const scriptsDir = path.join(sessionDir(), 'workflows', 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, 'ls-wf_latescript-1.js'), [
        "export const meta = { name: 'ls', description: 'd', phases: [{ title: 'Review' }] }",
        "agent('Carefully review the authentication module for security bugs.', { label: 'review:auth', phase: 'Review' })",
      ].join('\n'), 'utf-8');
      await d.scan();
      const a = d.getWorkflowSnapshots(emptyMeta())[0].agents[0];
      expect(a.label).toBe('review:auth');
      expect(a.phaseTitle).toBe('Review');
      expect(await d.poll()).toBe(true); // the improved correlation is a reported change
      d.dispose();
    });

    it('scopes fast rescans to sessions owning live runs, with a full walk every 10th scan', async () => {
      const SID2 = '22222222-3333-4444-5555-666666666666';
      const SID3 = '33333333-4444-5555-6666-777777777777';
      writeSidecarIn(SID2, 'wf_other-001');
      mkLiveRun('wf_scoped-001', [{ type: 'started', key: 'v2:a', agentId: 'agaaaaaa' }]);

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan(); // #1: full walk — sees both sessions
      expect(d.getWorkflowSnapshots(emptyMeta()).map(s => s.runId).sort())
        .toEqual(['wf_other-001', 'wf_scoped-001']);
      expect(d.hasActiveRuns()).toBe(true);

      // Lands in a session with no live run — invisible to scoped scans.
      writeSidecarIn(SID3, 'wf_new-001');
      await d.scan(); // #2: scoped to SID
      const ids = d.getWorkflowSnapshots(emptyMeta()).map(s => s.runId);
      expect(ids).not.toContain('wf_new-001');
      // And the scoped scan must not prune the unvisited SID2 run.
      expect(ids).toContain('wf_other-001');

      for (let i = 0; i < 8; i++) { await d.scan(); } // #3–#10: still scoped
      expect(d.getWorkflowSnapshots(emptyMeta()).map(s => s.runId)).not.toContain('wf_new-001');

      await d.scan(); // #11: full walk again
      expect(d.getWorkflowSnapshots(emptyMeta()).map(s => s.runId)).toContain('wf_new-001');
      d.dispose();
    });

    it('a scoped rescan still sees the owning session complete (live → sidecar)', async () => {
      mkLiveRun('wf_finish-001', [{ type: 'started', key: 'v2:a', agentId: 'agaaaaaa' }]);
      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan(); // #1: full — live run discovered
      expect(d.getWorkflowSnapshots(emptyMeta())[0].status).toBe('running');

      writeSidecar('wf_finish-001', validSidecar('wf_finish-001'));
      await d.scan(); // #2: scoped to SID, which owns the run — completion lands
      const snap = d.getWorkflowSnapshots(emptyMeta())[0];
      expect(snap.source).toBe('sidecar');
      expect(snap.status).toBe('completed');
      expect(d.hasActiveRuns()).toBe(false);
      d.dispose();
    });
  });

  it('prefers the sidecar over the live dir once a run completes', async () => {
    // Both a sidecar AND a run dir exist (the normal completed case).
    writeSidecar('wf_done-001', validSidecar('wf_done-001'));
    const runDir = path.join(sessionDir(), 'subagents', 'workflows', 'wf_done-001');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), JSON.stringify({ type: 'started', agentId: 'x' }) + '\n', 'utf-8');
    const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
    await d.scan();
    const snaps = d.getWorkflowSnapshots(emptyMeta());
    expect(snaps).toHaveLength(1);
    expect(snaps[0].source).toBe('sidecar');
    expect(snaps[0].status).toBe('completed');
    d.dispose();
  });

  describe('resumed run liveness (resumeFromRunId)', () => {
    // Real repro (2026-07-23, session 0d045c02-…): Claude Code's Workflow
    // tool supports relaunching an already-COMPLETED run under the SAME
    // runId (resumeFromRunId), replaying cached agents and running new ones.
    // The completion sidecar is written once more only when the resumed run
    // itself finishes — until then it sits stale while journal.jsonl and the
    // per-agent transcripts keep growing. The old code treated sidecar-exists
    // as terminal, so a resumed run's new agents (dozens, in the real repro)
    // were invisible: the card kept showing the original, now-stale,
    // completed tree.

    function liveRunDir(runId: string): string {
      const dir = path.join(sessionDir(), 'subagents', 'workflows', runId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }

    function setMtimeMs(file: string, ms: number): void {
      fs.utimesSync(file, ms / 1000, ms / 1000);
    }

    it("re-enters the live tier when a completed run's journal is written to after the sidecar", async () => {
      const runId = 'wf_resume-live-001';
      const sidecarFile = writeSidecar(runId, validSidecar(runId));
      const now = Date.now();
      setMtimeMs(sidecarFile, now - 20_000); // sidecar written 20s ago

      const runDir = liveRunDir(runId);
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:r', agentId: 'resumedagt' }) + '\n', 'utf-8');
      setMtimeMs(path.join(runDir, 'journal.jsonl'), now); // journal fresh — well past tolerance

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      const snap = d.getWorkflowSnapshots(emptyMeta())[0];
      expect(snap.source).toBe('live');
      expect(snap.status).toBe('running');
      expect(snap.agents.map(a => a.agentId)).toContain('resumedagt');
      d.dispose();
    });

    it('stays on the completed sidecar tier when the journal is no newer than the sidecar (no regression)', async () => {
      const runId = 'wf_resume-equal-001';
      const sidecarFile = writeSidecar(runId, validSidecar(runId));
      const now = Date.now();
      setMtimeMs(sidecarFile, now);

      const runDir = liveRunDir(runId);
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:r', agentId: 'resumedagt' }) + '\n', 'utf-8');
      setMtimeMs(path.join(runDir, 'journal.jsonl'), now); // exactly equal — must NOT read as resumed

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      const snap = d.getWorkflowSnapshots(emptyMeta())[0];
      expect(snap.source).toBe('sidecar');
      expect(snap.status).toBe('completed');
      expect(snap.agents.map(a => a.agentId)).toEqual(['aaa111']);
      d.dispose();
    });

    it('settles back to the rewritten (larger) sidecar tree once the resumed run itself completes', async () => {
      const runId = 'wf_resume-settle-001';
      const sidecarFile = writeSidecar(runId, validSidecar(runId, { agentCount: 1 }));
      const now = Date.now();
      setMtimeMs(sidecarFile, now - 20_000);

      const runDir = liveRunDir(runId);
      fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
        JSON.stringify({ type: 'started', key: 'v2:r', agentId: 'resumedagt' }) + '\n', 'utf-8');
      setMtimeMs(path.join(runDir, 'journal.jsonl'), now - 10_000); // resumed, still live

      const d = new WorkflowDiscovery(projectsDir, WS_KEY, log);
      await d.scan();
      expect(d.getWorkflowSnapshots(emptyMeta())[0].source).toBe('live'); // re-engaged

      // The resumed run completes: Claude Code rewrites the sidecar with a
      // larger tree and a newer mtime than the (now-quiet) journal.
      fs.writeFileSync(sidecarFile, JSON.stringify(validSidecar(runId, {
        agentCount: 2,
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Only' },
          { type: 'workflow_agent', index: 1, agentId: 'aaa111', phaseIndex: 1, phaseTitle: 'Only', state: 'done', label: 'lab' },
          { type: 'workflow_agent', index: 2, agentId: 'resumedagt', phaseIndex: 1, phaseTitle: 'Only', state: 'done', label: 'lab2' },
        ],
      })), 'utf-8');
      setMtimeMs(sidecarFile, now); // newer than the journal again

      await d.scan();
      const snap = d.getWorkflowSnapshots(emptyMeta())[0];
      expect(snap.source).toBe('sidecar');
      expect(snap.status).toBe('completed');
      expect(snap.agentCount).toBe(2);
      expect(snap.agents.map(a => a.agentId).sort()).toEqual(['aaa111', 'resumedagt']);
      d.dispose();
    });

    it('falls back to the last completed sidecar tree when a resumed run goes quiet and is never confirmed live (abandoned resume)', async () => {
      vi.useFakeTimers();
      try {
        const runId = 'wf_resume-abandon-001';
        const sidecarFile = writeSidecar(runId, validSidecar(runId));
        const t0 = Date.now();
        setMtimeMs(sidecarFile, t0);

        const runDir = liveRunDir(runId);
        fs.writeFileSync(path.join(runDir, 'journal.jsonl'),
          JSON.stringify({ type: 'started', key: 'v2:r', agentId: 'resumedagt' }) + '\n', 'utf-8');
        setMtimeMs(path.join(runDir, 'journal.jsonl'), t0 + 10_000); // resumed

        const d = new WorkflowDiscovery(projectsDir, WS_KEY, log); // no liveness probe
        await d.scan();
        expect(d.getWorkflowSnapshots(emptyMeta())[0].source).toBe('live'); // re-engaged

        // Gone quiet past UNCONFIRMED_LIVENESS_CEILING_MS with no registry to
        // vouch for it — the same abandonment classification a never-completed
        // live run gets.
        vi.setSystemTime(t0 + 31 * 60 * 1000);
        await d.scan();
        const snap = d.getWorkflowSnapshots(emptyMeta())[0];
        expect(snap.source).toBe('sidecar');
        expect(snap.status).toBe('completed');
        expect(snap.agents.map(a => a.agentId)).toEqual(['aaa111']); // sidecar's tree, not the abandoned live one
        d.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
