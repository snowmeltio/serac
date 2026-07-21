import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkflowSidecar } from './workflowSidecar.js';

function loadFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '__fixtures__', 'workflows', name), 'utf8');
}

const SID = 'sess-0001';

describe('parseWorkflowSidecar', () => {
  it('parses a real completed run (consistency audit)', () => {
    const snap = parseWorkflowSidecar(loadFixture('wf_889eb23a-c48.json'), SID);
    expect(snap).not.toBeNull();
    expect(snap!.runId).toBe('wf_889eb23a-c48');
    expect(snap!.sessionId).toBe(SID);
    expect(snap!.name).toBe('serac-plan-consistency-audit');
    expect(snap!.status).toBe('completed');
    expect(snap!.source).toBe('sidecar');
    expect(snap!.phases.map(p => p.title)).toEqual(['Audit', 'Synthesise']);
    expect(snap!.phases.map(p => p.index)).toEqual([1, 2]);
    expect(snap!.agents).toHaveLength(4);
    expect(snap!.counts.done).toBe(4);
    expect(snap!.agentCount).toBe(4);
    expect(snap!.dismissed).toBe(false);
    // every agent ties back to a phase
    for (const a of snap!.agents) {
      expect(a.phaseIndex).not.toBeNull();
      expect(a.phaseTitle).not.toBeNull();
      expect(a.agentId.length).toBeGreaterThan(0);
    }
  });

  it('handles edge cases: failed status, zero-agent phase, retries, mixed states', () => {
    const snap = parseWorkflowSidecar(loadFixture('wf_synthetic-edge.json'), SID);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('failed');
    expect(snap!.phases.map(p => p.title)).toEqual(['Find', 'Verify', 'Report']);
    // Phase 3 (Report) has no agents — a legitimately empty phase.
    const reportAgents = snap!.agents.filter(a => a.phaseIndex === 3);
    expect(reportAgents).toHaveLength(0);
    // A retried agent is preserved with attempt > 1.
    expect(snap!.agents.some(a => a.attempt === 2)).toBe(true);
    // A failed agent keeps its own status — the detail panel sorts failed
    // agents first and rolls them up; flattening to 'done' hid failures.
    expect(snap!.agents.find(a => a.label === 'verify:candidate-1')!.status).toBe('failed');
    // resultPreview/lastToolName tolerate null.
    expect(snap!.agents.find(a => a.label === 'verify:candidate-1')!.resultPreview).toBeNull();
    // log() narrator lines are carried through.
    expect(snap!.logs.length).toBeGreaterThan(0);
  });

  it('returns null for malformed input', () => {
    expect(parseWorkflowSidecar('not json', SID)).toBeNull();
    expect(parseWorkflowSidecar('[]', SID)).toBeNull();
    expect(parseWorkflowSidecar('"a string"', SID)).toBeNull();
    expect(parseWorkflowSidecar('123', SID)).toBeNull();
    expect(parseWorkflowSidecar('{}', SID)).toBeNull(); // no runId
  });

  it('synthesises a placeholder id for an agent entry missing agentId (errored before registering)', () => {
    // The runtime writes agentId:null for an agent that errored before it
    // registered. Skipping the entry made every roll-up undercount (the
    // header said "6 agents" while 5 rows rendered — the wf_c8900737 case).
    const obj = {
      runId: 'wf_partial-001',
      workflowName: 'partial',
      status: 'completed',
      phases: [{ title: 'Only', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, phaseIndex: 1, state: 'error', label: 'apply-fix' }, // no agentId
        { type: 'workflow_agent', index: 2, agentId: 'akeep01', phaseIndex: 1, state: 'done', label: 'kept' },
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap).not.toBeNull();
    expect(snap!.agents).toHaveLength(2);
    expect(snap!.agents[0].agentId).toBe('missing-0');
    expect(snap!.agents[0].label).toBe('apply-fix');
    expect(snap!.agents[0].status).toBe('failed');
    expect(snap!.counts.failed).toBe(1);
    expect(snap!.agents[1].label).toBe('kept');
  });

  it('maps an "incomplete" run status through (killed/abandoned run)', () => {
    const obj = {
      runId: 'wf_incomplete-001',
      workflowName: 'killed',
      status: 'incomplete',
      phases: [{ title: 'Only', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, agentId: 'a01', phaseIndex: 1, state: 'running' },
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap!.status).toBe('incomplete');
  });

  it('maps a "killed" run status to incomplete (a killed run still writes a sidecar)', () => {
    const obj = {
      runId: 'wf_killed-001',
      workflowName: 'killed-run',
      status: 'killed',
      phases: [{ title: 'Only', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, agentId: 'a01', phaseIndex: 1, state: 'progress' },
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap!.status).toBe('incomplete');
  });

  it('maps the live-tier agent states (progress/start/queued/completed) onto DisplayStatus', () => {
    // A killed/in-flight sidecar carries transient states the completion path
    // never uses: progress/start are in-flight (→ running), queued is pending
    // (→ waiting), completed is terminal (→ done). Pinning these was the fix for
    // the "all-done card showing agents as running" bug.
    const obj = {
      runId: 'wf_livestates-001',
      workflowName: 'live-states',
      status: 'killed',
      phases: [{ title: 'Only', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, agentId: 'aprog', phaseIndex: 1, state: 'progress' },
        { type: 'workflow_agent', index: 2, agentId: 'astart', phaseIndex: 1, state: 'start' },
        { type: 'workflow_agent', index: 3, agentId: 'aqueue', phaseIndex: 1, state: 'queued' },
        { type: 'workflow_agent', index: 4, agentId: 'adone', phaseIndex: 1, state: 'completed' },
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap!.agents.find(a => a.agentId === 'aprog')!.status).toBe('running');
    expect(snap!.agents.find(a => a.agentId === 'astart')!.status).toBe('running');
    expect(snap!.agents.find(a => a.agentId === 'aqueue')!.status).toBe('waiting');
    expect(snap!.agents.find(a => a.agentId === 'adone')!.status).toBe('done');
  });

  it('maps agent "waiting" through; unknown/absent states degrade to terminal "done", never "running"', () => {
    // Regression pin for the v1.16.21 ghost-count bug: a defaulted-running
    // agent in a completion sidecar feeds the card's "agents — N running"
    // chip forever. Unknown states must degrade terminal (quiet), not live.
    const obj = {
      runId: 'wf_states-001',
      workflowName: 'states',
      status: 'running',
      phases: [{ title: 'Only', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, agentId: 'awa01', phaseIndex: 1, state: 'waiting' },
        { type: 'workflow_agent', index: 2, agentId: 'aspawn', phaseIndex: 1, state: 'spawning' }, // unknown → done
        { type: 'workflow_agent', index: 3, agentId: 'anone', phaseIndex: 1 },                     // absent → done
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap!.agents.find(a => a.agentId === 'awa01')!.status).toBe('waiting');
    expect(snap!.counts.waiting).toBe(1);
    expect(snap!.agents.find(a => a.agentId === 'aspawn')!.status).toBe('done');
    expect(snap!.agents.find(a => a.agentId === 'anone')!.status).toBe('done');
    expect(snap!.counts.done).toBe(2);
    expect(snap!.counts.running).toBeUndefined();
  });

  it('maps agent "error" state to failed and parses the run-level error field (the ghost-5 sidecars)', () => {
    // Mirrors the real wf_1f43de65 failure: status:'failed', agents in state
    // 'error', durationMs 5, error carrying the crash message + stack.
    const obj = {
      runId: 'wf_error-001',
      workflowName: 'dealflow-import',
      status: 'failed',
      durationMs: 5,
      error: "Error: undefined is not an object (evaluating 'args.list.length')\n  at <anonymous>",
      phases: [{ title: 'Import', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Import' },
        { type: 'workflow_agent', index: 1, agentId: 'aerr1', phaseIndex: 1, state: 'error' },
        { type: 'workflow_agent', index: 2, agentId: 'aerr2', phaseIndex: 1, state: 'error' },
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap!.status).toBe('failed');
    expect(snap!.agents.every(a => a.status === 'failed')).toBe(true);
    expect(snap!.counts.failed).toBe(2);
    expect(snap!.counts.running).toBeUndefined();
    expect(snap!.error).toContain('args.list.length');
  });

  it('tolerates error as an object with message, and reports null when absent', () => {
    const base = {
      runId: 'wf_error-002',
      workflowName: 'e',
      status: 'failed',
      workflowProgress: [],
    };
    const objErr = parseWorkflowSidecar(JSON.stringify({ ...base, error: { message: 'boom' } }), SID);
    expect(objErr!.error).toBe('boom');
    const noErr = parseWorkflowSidecar(JSON.stringify(base), SID);
    expect(noErr!.error).toBeNull();
    const junkErr = parseWorkflowSidecar(JSON.stringify({ ...base, error: 42 }), SID);
    expect(junkErr!.error).toBeNull();
  });

  it('reconstructs phases from workflowProgress when phases[] is absent', () => {
    const obj = {
      runId: 'wf_noPhases-001',
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Recovered' },
        { type: 'workflow_agent', index: 1, agentId: 'a01', phaseIndex: 1, state: 'running' },
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap!.phases).toEqual([{ index: 1, title: 'Recovered', detail: '' }]);
    expect(snap!.agents[0].phaseTitle).toBe('Recovered');
    expect(snap!.counts.running).toBe(1);
  });
});
