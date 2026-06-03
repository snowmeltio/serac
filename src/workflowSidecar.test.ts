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
    // A failed agent state maps to the terminal DisplayStatus 'done'.
    expect(snap!.agents.find(a => a.label === 'verify:candidate-1')!.status).toBe('done');
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

  it('skips one malformed agent entry but keeps the valid ones', () => {
    const obj = {
      runId: 'wf_partial-001',
      workflowName: 'partial',
      status: 'completed',
      phases: [{ title: 'Only', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, phaseIndex: 1, state: 'done' }, // no agentId → skipped
        { type: 'workflow_agent', index: 2, agentId: 'akeep01', phaseIndex: 1, state: 'done', label: 'kept' },
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap).not.toBeNull();
    expect(snap!.agents).toHaveLength(1);
    expect(snap!.agents[0].label).toBe('kept');
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

  it('maps agent "waiting" state through and falls unknown/absent states back to "running"', () => {
    const obj = {
      runId: 'wf_states-001',
      workflowName: 'states',
      status: 'running',
      phases: [{ title: 'Only', detail: '' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Only' },
        { type: 'workflow_agent', index: 1, agentId: 'awa01', phaseIndex: 1, state: 'waiting' },
        { type: 'workflow_agent', index: 2, agentId: 'aspawn', phaseIndex: 1, state: 'spawning' }, // unknown → running
        { type: 'workflow_agent', index: 3, agentId: 'anone', phaseIndex: 1 },                     // absent → running
      ],
    };
    const snap = parseWorkflowSidecar(JSON.stringify(obj), SID);
    expect(snap!.agents.find(a => a.agentId === 'awa01')!.status).toBe('waiting');
    expect(snap!.counts.waiting).toBe(1);
    expect(snap!.agents.find(a => a.agentId === 'aspawn')!.status).toBe('running');
    expect(snap!.agents.find(a => a.agentId === 'anone')!.status).toBe('running');
    expect(snap!.counts.running).toBe(2);
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
