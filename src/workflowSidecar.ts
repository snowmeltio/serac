import type {
  WorkflowAgentSnapshot,
  WorkflowAgentStatus,
  WorkflowPhase,
  WorkflowRunStatus,
  WorkflowSnapshot,
} from './types.js';

// Defensive parser for the Claude Code Workflow completion sidecar
// (<sessionDir>/workflows/wf_<runId>.json). Mirrors the never-throw,
// object-guard, forward-compatible-skip idioms of teamManifest.ts:
// anything malformed returns null; one bad agent entry never hides the rest.

/** Sidecars embed the full script + result blobs; a run with absurd counts is
 *  almost certainly corrupt, so cap defensively. */
const MAX_AGENTS = 1000;
const MAX_PHASES = 200;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Map a sidecar per-agent `state` onto WorkflowAgentStatus. 'failed' is
 *  preserved as its own status: the detail panel sorts failed agents first
 *  and rolls them up in the header, and the webview tints their dots — all
 *  of which is dead weight if failures flatten to 'done'. The runtime writes
 *  'error' for an agent that threw — same terminal-failure surface.
 *
 *  In-flight states (running/progress/start/waiting/queued — seen only in
 *  killed/in-flight sidecars) are enumerated exhaustively; an UNKNOWN state
 *  degrades to 'done', never 'running'. A wrongly-done agent under-reports
 *  quietly; a wrongly-running agent feeds the card's live-agent count forever
 *  (the v1.16.21 ghost bug: 'error' fell into a default-running arm, so every
 *  errored agent ran eternally in the "agents — N running" chip). */
function mapAgentState(state: unknown): WorkflowAgentStatus {
  switch (state) {
    case 'done': return 'done';
    case 'completed': return 'done';
    case 'running': return 'running';
    case 'progress': return 'running';
    case 'start': return 'running';
    case 'waiting': return 'waiting';
    case 'queued': return 'waiting';
    case 'failed': return 'failed';
    case 'error': return 'failed';
    default: return 'done';
  }
}

/** Map the sidecar's `status` string onto the closed run-status union. The
 *  sidecar is written only at completion, so an unknown value is treated as
 *  completed (best effort) rather than running. */
function mapRunStatus(status: unknown): WorkflowRunStatus {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'running': return 'running';
    case 'incomplete': return 'incomplete';
    case 'killed': return 'incomplete';
    default: return 'completed';
  }
}

/**
 * Parse a workflow completion sidecar into a WorkflowSnapshot.
 * @param content Raw JSON file contents.
 * @param sessionId The parent session (the dir the sidecar lives under).
 * @returns A snapshot, or null when the content is missing/malformed.
 *   `dismissed` is always false here; discovery overlays dismiss state.
 */
export function parseWorkflowSidecar(content: string, sessionId: string): WorkflowSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObj(raw)) { return null; }

  const runId = str(raw.runId);
  if (!runId) { return null; }

  // Static phase list: phases[] = {title, detail}. index is 1-based position.
  const phases: WorkflowPhase[] = [];
  const phaseTitleByIndex = new Map<number, string>();
  if (Array.isArray(raw.phases)) {
    if (raw.phases.length > MAX_PHASES) { return null; }
    raw.phases.forEach((p, i) => {
      if (!isObj(p)) { return; }
      const title = str(p.title);
      if (!title) { return; }
      const index = i + 1;
      phases.push({ index, title, detail: str(p.detail) ?? '' });
      phaseTitleByIndex.set(index, title);
    });
  }

  // workflowProgress[] interleaves workflow_phase and workflow_agent entries.
  const agents: WorkflowAgentSnapshot[] = [];
  const counts: Record<string, number> = {};
  if (Array.isArray(raw.workflowProgress)) {
    if (raw.workflowProgress.length > MAX_AGENTS + MAX_PHASES) { return null; }
    for (const entry of raw.workflowProgress) {
      if (!isObj(entry)) { continue; }

      if (entry.type === 'workflow_phase') {
        // Fill any phase index the static phases[] array didn't carry.
        const idx = num(entry.index);
        const title = str(entry.title);
        if (idx !== null && title && !phaseTitleByIndex.has(idx)) {
          phaseTitleByIndex.set(idx, title);
          phases.push({ index: idx, title, detail: '' });
        }
        continue;
      }

      if (entry.type !== 'workflow_agent') { continue; }
      // The runtime writes agentId:null for an agent that errored before
      // registering. Dropping the entry undercounted every roll-up (header
      // said "6 agents" while 5 rows rendered), so synthesise a stable
      // placeholder id instead: the transcript resolver misses (rendered as
      // "Transcript not available yet.") but the row and counts survive.
      const agentId = str(entry.agentId) ?? ('missing-' + agents.length);

      const status = mapAgentState(entry.state);
      counts[status] = (counts[status] ?? 0) + 1;
      const phaseIndex = num(entry.phaseIndex);
      agents.push({
        agentId,
        label: str(entry.label) ?? '',
        phaseIndex,
        phaseTitle: str(entry.phaseTitle)
          ?? (phaseIndex !== null ? phaseTitleByIndex.get(phaseIndex) ?? null : null),
        model: str(entry.model) ?? '',
        agentType: str(entry.agentType),
        status,
        startedAt: num(entry.startedAt) ?? 0,
        durationMs: num(entry.durationMs),
        tokens: num(entry.tokens) ?? 0,
        toolCalls: num(entry.toolCalls) ?? 0,
        attempt: num(entry.attempt) ?? 1,
        promptPreview: str(entry.promptPreview) ?? '',
        resultPreview: str(entry.resultPreview),
        lastToolName: str(entry.lastToolName),
        lastToolSummary: str(entry.lastToolSummary),
      });
      if (agents.length > MAX_AGENTS) { return null; }
    }
  }

  phases.sort((a, b) => a.index - b.index);

  const logs: string[] = Array.isArray(raw.logs)
    ? raw.logs.filter((l): l is string => typeof l === 'string')
    : [];

  // The one artefact that explains a failed run (message + stack). A string
  // in every observed sidecar; tolerate an {message} object defensively.
  const error = str(raw.error) ?? (isObj(raw.error) ? str(raw.error.message) : null);

  return {
    runId,
    sessionId,
    taskId: str(raw.taskId),
    name: str(raw.workflowName) ?? runId,
    summary: str(raw.summary) ?? '',
    status: mapRunStatus(raw.status),
    source: 'sidecar',
    startTime: num(raw.startTime) ?? 0,
    durationMs: num(raw.durationMs),
    defaultModel: str(raw.defaultModel) ?? '',
    agentCount: num(raw.agentCount) ?? agents.length,
    totalTokens: num(raw.totalTokens) ?? 0,
    totalToolCalls: num(raw.totalToolCalls) ?? 0,
    phases,
    agents,
    counts,
    logs,
    error,
    dismissed: false,
  };
}
