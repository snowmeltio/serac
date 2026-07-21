/**
 * Workflow-domain types (Claude Code Workflow runs). A "workflow" is one
 * invocation of the built-in Workflow tool inside a session. Claude Code
 * writes a render-ready sidecar at <sessionDir>/workflows/wf_<runId>.json
 * once the run completes; Serac reads it (Tier 1). A run observed before
 * completion has no sidecar and is reconstructed minimally from its journal
 * (Tier 2, source:'live').
 *
 * Part of the domain-split type modules — import from './types.js' (the
 * central re-export) unless you are inside another type module.
 */

import type { DisplayStatus } from './sessionTypes.js';

/** Normalised run status (sidecar `status` mapped onto a closed union). */
export type WorkflowRunStatus = 'completed' | 'running' | 'failed' | 'incomplete';

/** Per-agent status. Workflow agents extend DisplayStatus with 'failed' —
 *  the completion sidecar records which agents errored, and the detail panel
 *  sorts those first and rolls them up ("2 failed"). Sessions/teammates never
 *  carry 'failed'; their unions stay DisplayStatus. */
export type WorkflowAgentStatus = DisplayStatus | 'failed';

/** A phase declared in the workflow script's `meta.phases` (1-based index). */
export interface WorkflowPhase {
  index: number;
  title: string;
  detail: string;
}

/** Snapshot of one workflow agent (from a `workflow_agent` progress entry). */
export interface WorkflowAgentSnapshot {
  /** Maps 1:1 to subagents/workflows/<runId>/agent-<agentId>.jsonl */
  agentId: string;
  label: string;
  /** 1-based phase this agent belongs to; null when grouping is unavailable. */
  phaseIndex: number | null;
  phaseTitle: string | null;
  model: string;
  agentType: string | null;
  status: WorkflowAgentStatus;
  startedAt: number;            // epoch ms
  durationMs: number | null;
  tokens: number;
  toolCalls: number;
  attempt: number;
  promptPreview: string;
  resultPreview: string | null;
  lastToolName: string | null;
  lastToolSummary: string | null;
}

/** Full workflow-run snapshot sent to the webview. */
export interface WorkflowSnapshot {
  runId: string;                // wf_<hash>; webview key + dismiss key
  /** Parent session that owns the run (the dir the sidecar lives under). */
  sessionId: string;
  taskId: string | null;
  name: string;                 // workflowName
  summary: string;
  status: WorkflowRunStatus;
  /** Which tier produced this snapshot. */
  source: 'sidecar' | 'live';
  startTime: number;            // epoch ms
  durationMs: number | null;
  defaultModel: string;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  phases: WorkflowPhase[];
  agents: WorkflowAgentSnapshot[];
  /** Aggregated agent status counts. */
  counts: Record<string, number>;
  /** log() narrator lines (sidecar only; empty for live runs). */
  logs: string[];
  /** Failure detail (message + stack) from a failed sidecar; null elsewhere
   *  (live runs have no error record). Required, not optional: a failed run
   *  whose error is silently absent is exactly the blank-panel bug this
   *  field exists to fix. */
  error: string | null;
  dismissed: boolean;
}
