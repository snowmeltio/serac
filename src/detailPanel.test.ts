import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode before importing the module under test
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

// Mock crypto for the CSP nonce
vi.mock('crypto', () => ({
  randomBytes: () => ({ toString: () => 'dGVzdG5vbmNlMTIzNDU2Nzg=' }),
}));

import { DetailPanel, rollupSummary, type DetailPanelDeps } from './detailPanel.js';
import { JsonlTailer } from './jsonlTailer.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Uri,
  createMockWebview,
  createMockWebviewPanel,
  window,
  commands,
  type MockWebview,
  type MockWebviewPanel,
} from './__mocks__/vscode.js';
import type { WorkflowSnapshot, TeamSnapshot, SessionSnapshot } from './types.js';

// ── Fixtures ─────────────────────────────────────────────────────────

/** Real on-disk JSONL for the viewAgent tests — the incremental reader tails
 *  bytes, so transcript content lives in temp files rather than a parser mock. */
let transcriptDir: string;
function writeAgentJsonl(name: string, records: Array<Record<string, unknown>>): string {
  if (!transcriptDir) { transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-detail-')); }
  const file = path.join(transcriptDir, name);
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return file;
}
function userRecord(text: string, ts = '2026-06-13T00:00:00Z'): Record<string, unknown> {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}
/** Phase 3 evidence-wiring fixtures — a Bash tool_use/tool_result pair and a
 *  plain assistant text turn, matching the record shapes evidenceExtractor.ts
 *  (and its own test suite) verify against real ~/.claude/projects/ data. */
function assistantToolUseRecord(name: string, id: string, input: Record<string, unknown>, ts = '2026-06-13T00:00:01Z'): Record<string, unknown> {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}
function toolResultRecord(toolUseId: string, content: string, isError: boolean, ts = '2026-06-13T00:00:02Z'): Record<string, unknown> {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } };
}
function assistantTextRecord(text: string, ts = '2026-06-13T00:00:03Z'): Record<string, unknown> {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function makeWorkflow(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    runId: 'wf_abc',
    sessionId: 'sess-1',
    taskId: 'task-1',
    name: 'consistency-audit',
    summary: 'Audit then synthesise',
    status: 'completed',
    source: 'sidecar',
    startTime: 1000,
    durationMs: 95_000,
    defaultModel: 'opus',
    agentCount: 3,
    totalTokens: 12_345,
    totalToolCalls: 18,
    phases: [
      { index: 1, title: 'Audit', detail: '' },
      { index: 2, title: 'Synthesise', detail: '' },
    ],
    agents: [
      { agentId: 'a1', label: 'audit:bugs', phaseIndex: 1, phaseTitle: 'Audit', model: 'opus', agentType: null, status: 'done', startedAt: 1000, durationMs: 4000, tokens: 100, toolCalls: 3, attempt: 1, promptPreview: 'find bugs', resultPreview: 'none', lastToolName: null, lastToolSummary: null },
      { agentId: 'a2', label: 'audit:perf', phaseIndex: 1, phaseTitle: 'Audit', model: 'opus', agentType: null, status: 'done', startedAt: 1000, durationMs: 4000, tokens: 100, toolCalls: 3, attempt: 1, promptPreview: 'find perf', resultPreview: 'ok', lastToolName: null, lastToolSummary: null },
      { agentId: 'a3', label: 'synth', phaseIndex: 2, phaseTitle: 'Synthesise', model: 'opus', agentType: null, status: 'done', startedAt: 2000, durationMs: 5000, tokens: 200, toolCalls: 12, attempt: 1, promptPreview: 'synthesise', resultPreview: 'done', lastToolName: null, lastToolSummary: null },
    ],
    counts: { done: 3 },
    logs: [],
    dismissed: false,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    teamId: 'orch-1',
    name: 'scope-demo',
    orchestrator: {
      sessionId: 'orch-1',
      status: 'done',
      activity: '',
      confidence: 'high',
      contextTokens: 5000,
      modelLabel: 'Opus',
    },
    agents: [
      { sessionId: null, name: 'defender', cwd: '/x', parentSessionId: 'orch-1', depth: 1, spawnedAt: 1000, status: 'done', activity: '', confidence: 'high', subagents: [], contextTokens: 1000 },
      { sessionId: 'sk-1', name: 'skeptic', cwd: '/x', parentSessionId: 'orch-1', depth: 1, spawnedAt: 1000, status: 'running', activity: '', confidence: 'high', subagents: [], contextTokens: 2000 },
    ],
    inProcessMembers: [],
    counts: { done: 1, running: 1 },
    updatedAt: 1000,
    dismissed: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'sess-1',
    slug: 'test',
    cwd: '/x',
    workspaceKey: 'x',
    status: 'running',
    activity: '',
    activeTools: {},
    subagents: [
      { parentToolUseId: 't1', agentId: 'sa1', description: 'explore auth', running: false, waitingOnPermission: false, startedAt: 1000, resultPreview: 'found it', toolsCompleted: 4, blocking: false },
      { parentToolUseId: 't2', agentId: 'sa2', description: 'explore db', running: true, waitingOnPermission: false, startedAt: 1000, resultPreview: null, toolsCompleted: 2, blocking: false },
      // agentless subagent — must be filtered out of the model
      { parentToolUseId: 't3', agentId: null, description: 'pending', running: true, waitingOnPermission: false, startedAt: 1000, resultPreview: null, toolsCompleted: 0, blocking: false },
    ],
    lastActivity: 1000,
    contextTokens: 0,
    ...overrides,
  } as SessionSnapshot;
}

// ── Harness ──────────────────────────────────────────────────────────

interface Harness {
  panel: DetailPanel;
  webview: MockWebview;
  mockPanel: MockWebviewPanel;
  deps: {
    getWorkflows: ReturnType<typeof vi.fn>;
    getTeams: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    listSubagents: ReturnType<typeof vi.fn>;
    resolveAgentFile: ReturnType<typeof vi.fn>;
    openConversation: ReturnType<typeof vi.fn>;
  };
  /** Last `render` model posted to the webview. */
  lastModel(): any;
  /** All messages posted to the webview. */
  posted(): any[];
}

function setup(over: Partial<DetailPanelDeps> = {}): Harness {
  const webview = createMockWebview();
  const mockPanel = createMockWebviewPanel(webview);
  vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel as any);

  const deps = {
    getWorkflows: vi.fn(() => [makeWorkflow()]),
    getTeams: vi.fn(() => [makeTeam()]),
    getSession: vi.fn(() => makeSession()),
    listSubagents: vi.fn(() => [] as { agentId: string; agentType: string | null; description: string | null; model: string | null }[]),
    resolveAgentFile: vi.fn(() => '/path/agent.jsonl'),
    openConversation: vi.fn(),
  };

  const panel = new DetailPanel(Uri.file('/ext') as any, { ...deps, ...over } as DetailPanelDeps);
  return {
    panel,
    webview,
    mockPanel,
    deps,
    posted: () => vi.mocked(webview.postMessage).mock.calls.map(c => c[0]),
    lastModel: () => {
      const renders = vi.mocked(webview.postMessage).mock.calls.map(c => c[0] as any).filter(m => m.type === 'render');
      return renders[renders.length - 1]?.model;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(window.createWebviewPanel).mockReset();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('DetailPanel', () => {
  describe('show + model building', () => {
    it('creates the panel once and reveals on subsequent show()', () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
      h.panel.show('team', 'orch-1', 'orch-1');
      expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
      expect(h.mockPanel.reveal).toHaveBeenCalled();
    });

    it('sets the panel title from the built model', () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      expect(h.mockPanel.title).toBe('consistency-audit');
    });

    it('builds a phase-grouped workflow model', () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const m = h.lastModel();
      expect(m.source).toBe('workflow');
      expect(m.containerId).toBe('sess-1');
      expect(m.groups).toHaveLength(2);
      expect(m.groups[0].title).toContain('Audit');
      expect(m.groups[0].agents.map((a: any) => a.agentId)).toEqual(['a1', 'a2']);
      expect(m.groups[1].agents.map((a: any) => a.agentId)).toEqual(['a3']);
      expect(m.views?.[0]).toMatchObject({ kind: 'workflow', status: 'completed' });
      expect(m.metrics).toContain('3 agents');
    });

    it('computes elapsed-so-far and passes the live tool for a running agent (UX-1)', () => {
      const h = setup();
      const wf = makeWorkflow({ status: 'running' });
      wf.agents[2] = {
        ...wf.agents[2],
        status: 'running', durationMs: null, startedAt: Date.now() - 5000,
        lastToolName: 'Bash', lastToolSummary: 'npm run test',
      };
      h.deps.getWorkflows.mockReturnValue([wf]);
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const live = h.lastModel().groups[1].agents[0];
      expect(live.durationMs).toBeGreaterThanOrEqual(5000);
      expect(live.durationMs).toBeLessThan(60_000);
      expect(live.lastToolName).toBe('Bash');
      expect(live.lastToolSummary).toBe('npm run test');
      // Completed agents never carry a live tool line.
      const done = h.lastModel().groups[0].agents[0];
      expect(done.lastToolName).toBeNull();
      expect(done.durationMs).toBe(4000);
    });

    it('deep-links to a target agent on show() via a one-shot select hint', () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1', { groupKey: 'wf_abc', agentId: 'a2' });
      const render = h.posted().find(m => m.type === 'render');
      expect(render.select).toEqual({ groupKey: 'wf_abc', agentId: 'a2' });
      // The workflow target's groupKey selects that run.
      expect(h.lastModel().groups.every((g: any) => g.key === 'wf_abc')).toBe(true);
    });

    it('does not re-send the select hint on a later refresh tick', () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1', { groupKey: 'wf_abc', agentId: 'a2' });
      vi.mocked(h.webview.postMessage).mockClear();
      h.panel.refresh(); // unchanged model dedupes; if it posts, it carries no select
      for (const r of h.posted().filter(m => m.type === 'render')) {
        expect(r.select).toBeUndefined();
      }
    });

    it('builds a flat subagents model and filters out agentless entries', () => {
      const h = setup();
      h.panel.show('subagents', 'sess-1', 'sess-1');
      const m = h.lastModel();
      expect(m.source).toBe('subagents');
      expect(m.groups).toHaveLength(1);
      expect(m.groups[0].title).toBeNull();
      // sa1 + sa2 included; the agentless one dropped
      expect(m.groups[0].agents.map((a: any) => a.agentId)).toEqual(['sa1', 'sa2']);
      expect(m.metrics).toContain('2 subagents');
      expect(m.metrics).toContain('1 running');
    });

    it('builds a team roster model keyed by member name', () => {
      const h = setup();
      h.panel.show('team', 'orch-1', 'orch-1');
      const m = h.lastModel();
      expect(m.source).toBe('team');
      expect(m.title).toBe('scope-demo');
      expect(m.groups[0].agents.map((a: any) => a.agentId)).toEqual(['defender', 'skeptic']);
      expect(m.metrics).toContain('2 members');
      expect(m.metrics).toContain('1/2 done');
    });

    it('renders in-process members as roster rows (an all-in-process team is not "0 members")', () => {
      const h = setup({
        getTeams: vi.fn(() => [makeTeam({ teamId: 'at:aviary', agents: [], counts: {}, inProcessMembers: ['lyrebird', 'boobook'] })]),
        getSession: vi.fn(() => makeSession({ subagents: [] })),
      });
      h.panel.show('team', 'at:aviary', 'orch-1');
      const m = h.lastModel();
      expect(m.groups[0].agents.map((a: any) => a.agentId)).toEqual(['lyrebird', 'boobook']);
      expect(m.groups[0].agents.every((a: any) => a.teammate === true && a.alive === true)).toBe(true);
      expect(m.metrics).toContain('2 members');
    });

    it('borrows live tracking for an in-process roster row status', () => {
      const h = setup({
        getTeams: vi.fn(() => [makeTeam({ teamId: 'at:aviary', agents: [], counts: {}, inProcessMembers: ['lyrebird', 'boobook'] })]),
        // sa2 is running in makeSession; map it to lyrebird via the disk meta.
        listSubagents: vi.fn(() => [{ agentId: 'sa2', agentType: 'lyrebird', description: null, model: 'claude-sonnet-5' }]),
      });
      h.panel.show('team', 'at:aviary', 'orch-1');
      const rows = h.lastModel().groups[0].agents;
      expect(rows.find((a: any) => a.agentId === 'lyrebird').status).toBe('running');
      expect(rows.find((a: any) => a.agentId === 'boobook').status).toBe('done');
      // The roster row also borrows the member's model from the disk scan.
      expect(rows.find((a: any) => a.agentId === 'lyrebird').model).toBe('claude-sonnet-5');
      expect(rows.find((a: any) => a.agentId === 'boobook').model).toBe('');
    });

    it('builds the model from a live-tier run with its running status', () => {
      const h = setup({ getWorkflows: vi.fn(() => [makeWorkflow({ source: 'live', status: 'running' })]) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      expect(h.lastModel().views?.[0]).toMatchObject({ kind: 'workflow', status: 'running' });
    });
  });

  describe('refresh dedup', () => {
    it('does not re-post an unchanged model', () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const before = h.posted().filter(m => m.type === 'render').length;
      h.panel.refresh();
      const after = h.posted().filter(m => m.type === 'render').length;
      expect(after).toBe(before);
    });

    it('re-posts when the underlying snapshot changes', () => {
      const wf = makeWorkflow();
      const getWorkflows = vi.fn(() => [wf]);
      const h = setup({ getWorkflows });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const before = h.posted().filter(m => m.type === 'render').length;
      // Mutate status — next refresh should detect the diff and re-post.
      getWorkflows.mockReturnValue([makeWorkflow({ status: 'failed' })]);
      h.panel.refresh();
      const after = h.posted().filter(m => m.type === 'render').length;
      expect(after).toBe(before + 1);
    });

    it('refresh is a no-op when the panel is closed', () => {
      const h = setup();
      h.panel.refresh();
      expect(h.posted()).toHaveLength(0);
    });
  });

  describe('viewAgent message', () => {
    /** The transcript queue's file I/O spans several event-loop turns. */
    const settleIo = async () => { for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 0)); } };

    it('resolves the transcript and posts agentTranscript', async () => {
      const file = writeAgentJsonl('a1.jsonl', [userRecord('hi')]);
      const resolveAgentFile = vi.fn(() => file);
      const h = setup({ resolveAgentFile });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      await settleIo();
      expect(resolveAgentFile).toHaveBeenCalledWith('workflow', 'sess-1', 'wf_abc', 'a1');
      const msg = h.posted().find(m => m.type === 'agentTranscript');
      expect(msg).toBeTruthy();
      expect(msg.key).toBe('workflow:sess-1|wf_abc|a1');
      expect(msg.entries).toHaveLength(1);
      expect(msg.entries[0].content).toBe('hi');
      // Phase 3 (DESIGN-DETAIL-PANE-V2.md): every transcript post carries
      // host-computed evidence + mismatches alongside entries, even when
      // (as here) the transcript is just a brief with no tool activity yet.
      expect(msg.evidence).toEqual({ filesTouched: [], commandsRun: [], testsRun: false, finalMessage: null });
      expect(msg.mismatches).toEqual([]);
    });

    it('posts host-computed evidence and a mismatch alongside a full transcript snapshot', async () => {
      const file = writeAgentJsonl('evidence-full.jsonl', [
        userRecord('brief'),
        assistantToolUseRecord('Bash', 'toolu_1', { command: 'npm run build' }),
        toolResultRecord('toolu_1', 'built ok', false),
        assistantTextRecord('All done, tests pass, ready for review.'),
      ]);
      const h = setup({ resolveAgentFile: vi.fn(() => file) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      await settleIo();
      const msg = h.posted().find(m => m.type === 'agentTranscript');
      expect(msg.evidence.commandsRun).toEqual([{ command: 'npm run build', exitOk: true }]);
      expect(msg.evidence.testsRun).toBe(false);
      expect(msg.evidence.finalMessage).toContain('tests pass');
      expect(msg.mismatches).toHaveLength(1);
      expect(msg.mismatches[0].kind).toBe('tests-claimed-not-run');
    });

    it('agentTranscriptAppend also carries recomputed evidence/mismatches for the delta', async () => {
      const file = writeAgentJsonl('evidence-append.jsonl', [userRecord('brief')]);
      const h = setup({ resolveAgentFile: vi.fn(() => file) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const req = { type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' };
      await h.webview._fireMessage(req);
      await settleIo();

      fs.appendFileSync(
        file,
        [assistantToolUseRecord('Bash', 'toolu_2', { command: 'npm run lint' }), toolResultRecord('toolu_2', 'lint failed', true)]
          .map(r => JSON.stringify(r)).join('\n') + '\n',
      );
      await h.webview._fireMessage(req);
      await settleIo();
      const append = h.posted().find(m => m.type === 'agentTranscriptAppend');
      expect(append).toBeTruthy();
      expect(append.evidence.commandsRun).toEqual([{ command: 'npm run lint', exitOk: false }]);
      expect(append.mismatches).toEqual([]); // no final-message claim yet — nothing to flag
    });

    it('correlates a Bash tool_use and its tool_result across separate append ticks (straddling boundary)', async () => {
      // detailPanel.ts recomputes evidence from the WHOLE accumulated record
      // set on every post rather than incrementally — this is the case that
      // choice exists for: the tool_use and its tool_result can land on
      // different reads of the tailer.
      const file = writeAgentJsonl('evidence-straddle.jsonl', [userRecord('brief')]);
      const h = setup({ resolveAgentFile: vi.fn(() => file) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const req = { type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' };
      await h.webview._fireMessage(req);
      await settleIo();

      fs.appendFileSync(file, JSON.stringify(assistantToolUseRecord('Bash', 'toolu_3', { command: 'npm test' })) + '\n');
      await h.webview._fireMessage(req);
      await settleIo();
      const firstAppend = h.posted().filter(m => m.type === 'agentTranscriptAppend').pop();
      expect(firstAppend.evidence.commandsRun).toEqual([{ command: 'npm test', exitOk: null }]);
      expect(firstAppend.evidence.testsRun).toBe(true); // command recognised as a test runner regardless of outcome

      fs.appendFileSync(file, JSON.stringify(toolResultRecord('toolu_3', 'ok', false)) + '\n');
      await h.webview._fireMessage(req);
      await settleIo();
      const secondAppend = h.posted().filter(m => m.type === 'agentTranscriptAppend').pop();
      expect(secondAppend.evidence.commandsRun).toEqual([{ command: 'npm test', exitOk: true }]);
    });

    it('steady re-request posts nothing when the file is unchanged, a delta when it grows', async () => {
      const file = writeAgentJsonl('a1-grow.jsonl', [userRecord('hi')]);
      const h = setup({ resolveAgentFile: vi.fn(() => file) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const req = { type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' };
      await h.webview._fireMessage(req);
      await settleIo();
      const baseline = h.posted().filter(m => m.type === 'agentTranscript' || m.type === 'agentTranscriptAppend').length;

      // Unchanged file → no transcript message at all (audit perf-io-4).
      await h.webview._fireMessage(req);
      await settleIo();
      expect(h.posted().filter(m => m.type === 'agentTranscript' || m.type === 'agentTranscriptAppend')).toHaveLength(baseline);

      // Appended record → an append delta carrying ONLY the new entry.
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }) + '\n');
      await h.webview._fireMessage(req);
      await settleIo();
      const append = h.posted().find(m => m.type === 'agentTranscriptAppend');
      expect(append).toBeTruthy();
      expect(append.entries).toHaveLength(1);
      expect(append.entries[0].content).toBe('reply');
    });

    it('truncation resets the slot and re-posts a full snapshot', async () => {
      const file = writeAgentJsonl('a1-trunc.jsonl', [userRecord('one'), userRecord('two')]);
      const h = setup({ resolveAgentFile: vi.fn(() => file) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const req = { type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' };
      await h.webview._fireMessage(req);
      await settleIo();

      fs.writeFileSync(file, JSON.stringify(userRecord('rewritten')) + '\n');
      await h.webview._fireMessage(req);
      await settleIo();
      const fulls = h.posted().filter(m => m.type === 'agentTranscript');
      expect(fulls).toHaveLength(2);
      expect(fulls[1].entries.map((e: any) => e.content)).toEqual(['rewritten']);
    });

    it('full:true re-serves the cached entries as a full snapshot (webview reload)', async () => {
      const file = writeAgentJsonl('a1-full.jsonl', [userRecord('hi')]);
      const h = setup({ resolveAgentFile: vi.fn(() => file) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const req = { type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' };
      await h.webview._fireMessage(req);
      await settleIo();

      // Same key, unchanged file, but the webview asks for a full snapshot.
      await h.webview._fireMessage({ ...req, full: true });
      await settleIo();
      const fulls = h.posted().filter(m => m.type === 'agentTranscript');
      expect(fulls).toHaveLength(2);
      expect(fulls[1].entries).toHaveLength(1);
    });

    it('posts agentTranscriptError when the file cannot be resolved', async () => {
      const h = setup({ resolveAgentFile: vi.fn(() => null) });
      h.panel.show('subagents', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'subagents', containerId: 'sess-1', groupKey: '', agentId: 'sa1' });
      await settleIo();
      const msg = h.posted().find(m => m.type === 'agentTranscriptError');
      expect(msg).toBeTruthy();
      expect(msg.key).toBe('subagents:sess-1||sa1');
    });

    it('posts agentTranscriptError when the transcript read throws', async () => {
      const spy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords').mockRejectedValue(new Error('boom'));
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      await settleIo();
      const msg = h.posted().find(m => m.type === 'agentTranscriptError');
      expect(msg).toBeTruthy();
      expect(String(msg.message)).toContain('boom');
      spy.mockRestore();
    });

    it('ships queued inbox messages as a separate suffix on a team-roster member transcript', async () => {
      const file = writeAgentJsonl('lyrebird.jsonl', [userRecord('brief')]);
      const peek = vi.fn(() => [{ from: 'murray', text: 'hello bird', timestamp: 'ts1' }]);
      const h = setup({
        resolveAgentFile: vi.fn(() => file),
        getTeams: vi.fn(() => [makeTeam({ teamId: 'at:my-team', agents: [], counts: {}, inProcessMembers: ['lyrebird'] })]),
        getMessagingSettings: vi.fn(() => ({ enabled: true, operatorName: 'murray' })),
        peekTeammateInbox: peek,
      });
      h.panel.show('team', 'at:my-team', 'orch-1');
      const req = { type: 'viewAgent', source: 'team', containerId: 'at:my-team', groupKey: '', agentId: 'lyrebird' };
      await h.webview._fireMessage(req);
      await settleIo();
      const msg = h.posted().find(m => m.type === 'agentTranscript');
      // Inbox turns are a suffix, never folded into the append-only entries.
      expect(msg.entries.some((e: any) => e.content.includes('hello bird'))).toBe(false);
      expect(msg.suffix.some((e: any) => e.role === 'system' && e.content.includes('hello bird'))).toBe(true);

      // Drain the inbox: the JSONL is unchanged, but the suffix change alone
      // must produce an append post with the (now empty) suffix.
      peek.mockReturnValue([]);
      await h.webview._fireMessage(req);
      await settleIo();
      const append = h.posted().find(m => m.type === 'agentTranscriptAppend');
      expect(append).toBeTruthy();
      expect(append.entries).toHaveLength(0);
      expect(append.suffix).toHaveLength(0);
    });

    it('does not peek an inbox for an off-roster team row', async () => {
      const peek = vi.fn(() => []);
      const h = setup({
        resolveAgentFile: vi.fn(() => writeAgentJsonl('off-roster.jsonl', [])),
        getTeams: vi.fn(() => [makeTeam({ teamId: 'at:my-team', agents: [], counts: {}, inProcessMembers: ['lyrebird'] })]),
        getMessagingSettings: vi.fn(() => ({ enabled: true, operatorName: 'murray' })),
        peekTeammateInbox: peek,
      });
      h.panel.show('team', 'at:my-team', 'orch-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'team', containerId: 'at:my-team', groupKey: '', agentId: 'not-a-member' });
      await settleIo();
      expect(peek).not.toHaveBeenCalled();
    });

    it('ignores a malformed viewAgent message', async () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'nope', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      await settleIo();
      expect(h.deps.resolveAgentFile).not.toHaveBeenCalled();
    });

    it('does not post a transcript to a panel disposed mid-read', async () => {
      let resolveRead!: (v: never[]) => void;
      const spy = vi.spyOn(JsonlTailer.prototype, 'readNewRecords')
        .mockReturnValue(new Promise<never[]>(r => { resolveRead = r; }) as unknown as ReturnType<JsonlTailer['readNewRecords']>);
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      // Dispose the panel before the read resolves, then resolve.
      h.mockPanel._fireDispose();
      resolveRead([]);
      await settleIo();
      expect(h.posted().find(m => m.type === 'agentTranscript')).toBeUndefined();
      spy.mockRestore();
    });
  });

  describe('openConversation message', () => {
    it('routes a valid sessionId to the dep', async () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'openConversation', sessionId: 'sess-1' });
      expect(h.deps.openConversation).toHaveBeenCalledWith('sess-1');
    });

    it('rejects a path-traversal sessionId', async () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'openConversation', sessionId: '../../etc/passwd' });
      expect(h.deps.openConversation).not.toHaveBeenCalled();
    });
  });

  describe('native doc messages (Phase 4, DESIGN-DETAIL-PANE-V2.md)', () => {
    const VALID_RAW: Record<string, unknown> = {
      type: 'showRawRecord', source: 'workflow', containerId: 'sess-1',
      groupKey: 'wf_abc', agentId: 'a1', entryIndex: 2, label: 'audit:bugs',
    };
    const VALID_TRANSCRIPT: Record<string, unknown> = {
      type: 'openTranscriptDoc', source: 'workflow', containerId: 'sess-1',
      groupKey: 'wf_abc', agentId: 'a1', label: 'audit:bugs',
    };
    const VALID_FILE_CHANGES_INDEX: Record<string, unknown> = {
      type: 'showFileChanges', source: 'workflow', containerId: 'sess-1',
      groupKey: 'wf_abc', agentId: 'a1', entryIndex: 1, label: 'audit:bugs',
    };
    const VALID_FILE_CHANGES_PATH: Record<string, unknown> = {
      type: 'showFileChanges', source: 'workflow', containerId: 'sess-1',
      groupKey: 'wf_abc', agentId: 'a1', filePath: '/repo/src/foo.ts', label: 'audit:bugs',
    };

    describe('showRawRecord', () => {
      it('resolves the file and invokes the registered command with the resolved path', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage(VALID_RAW);
        expect(h.deps.resolveAgentFile).toHaveBeenCalledWith('workflow', 'sess-1', 'wf_abc', 'a1');
        expect(commands.executeCommand).toHaveBeenCalledWith(
          'serac.detail.showRawRecord',
          { filePath: '/path/agent.jsonl', entryIndex: 2, label: 'audit:bugs' },
        );
      });

      it('refuses a message naming a DIFFERENT container than the panel is showing', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_RAW, containerId: 'sess-OTHER' });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('refuses a message naming a DIFFERENT source than the panel is showing', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_RAW, source: 'subagents' });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('refuses a negative entryIndex', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_RAW, entryIndex: -1 });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('refuses a non-integer entryIndex', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_RAW, entryIndex: 1.5 });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('refuses a non-numeric entryIndex', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_RAW, entryIndex: '2' });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('refuses a path-traversal agentId', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_RAW, agentId: '../../etc/passwd' });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('shows a warning and never invokes the command when the file cannot be resolved', async () => {
        const h = setup({ resolveAgentFile: vi.fn(() => null) });
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage(VALID_RAW);
        expect(window.showWarningMessage).toHaveBeenCalled();
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('swallows a rejection from an unregistered command (feature cut) without throwing', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        vi.mocked(commands.executeCommand).mockRejectedValueOnce(new Error('command not found'));
        // _fireMessage itself is synchronous/void — reaching the assertion below
        // (rather than an uncaught rejection failing the test run) IS the proof
        // the rejection was swallowed inside runNativeDocCommand's try/catch.
        await h.webview._fireMessage(VALID_RAW);
        expect(commands.executeCommand).toHaveBeenCalledTimes(1);
      });

      it('falls back to agentId as the label when none is supplied', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        const { label: _drop, ...noLabel } = VALID_RAW;
        await h.webview._fireMessage(noLabel);
        expect(commands.executeCommand).toHaveBeenCalledWith(
          'serac.detail.showRawRecord',
          { filePath: '/path/agent.jsonl', entryIndex: 2, label: 'a1' },
        );
      });
    });

    describe('openTranscriptDoc', () => {
      it('invokes the registered command with the resolved path and agentId', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage(VALID_TRANSCRIPT);
        expect(commands.executeCommand).toHaveBeenCalledWith(
          'serac.detail.openTranscriptDoc',
          { filePath: '/path/agent.jsonl', agentId: 'a1', label: 'audit:bugs' },
        );
      });

      it('refuses a message naming a different container', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_TRANSCRIPT, containerId: 'sess-OTHER' });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });
    });

    describe('showFileChanges', () => {
      it('invokes the command with an entryIndex target', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage(VALID_FILE_CHANGES_INDEX);
        expect(commands.executeCommand).toHaveBeenCalledWith(
          'serac.detail.showFileChanges',
          { filePath: '/path/agent.jsonl', target: { entryIndex: 1 }, label: 'audit:bugs' },
        );
      });

      it('invokes the command with a targetPath, for the Result-strip file-chip flow', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage(VALID_FILE_CHANGES_PATH);
        expect(commands.executeCommand).toHaveBeenCalledWith(
          'serac.detail.showFileChanges',
          { filePath: '/path/agent.jsonl', target: { targetPath: '/repo/src/foo.ts' }, label: 'audit:bugs' },
        );
      });

      it('refuses when NEITHER entryIndex nor filePath is present', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        const { entryIndex: _drop, ...noIndex } = VALID_FILE_CHANGES_INDEX;
        await h.webview._fireMessage(noIndex);
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });

      it('refuses an overlong filePath', async () => {
        const h = setup();
        h.panel.show('workflow', 'sess-1', 'sess-1');
        await h.webview._fireMessage({ ...VALID_FILE_CHANGES_PATH, filePath: 'x'.repeat(4097) });
        expect(commands.executeCommand).not.toHaveBeenCalled();
      });
    });
  });

  describe('sendTeammateMessage handler (the only write into ~/.claude/)', () => {
    /** Wire the messaging deps with sensible defaults; override per-test. */
    function messagingSetup(over: Partial<DetailPanelDeps> = {}) {
      const append = vi.fn(async () => { /* ok */ });
      const resolve = vi.fn(() => ({ teamDir: 'my-team', member: 'defender' }));
      const getSettings = vi.fn(() => ({ enabled: true, operatorName: 'murray' }));
      const logMessaging = vi.fn();
      const h = setup({
        getMessagingSettings: getSettings,
        resolveInboxTarget: resolve,
        appendTeammateMessage: append,
        logMessaging,
        ...over,
      });
      return { h, append, resolve, getSettings, logMessaging };
    }
    const VALID = { type: 'sendTeammateMessage', source: 'subagents', containerId: 'lead-001', agentId: 'deadbeef', text: 'ping' };
    const reply = (h: Harness) => h.posted().find(m => m.type === 'teammateMessageSent');
    const settle = () => new Promise(r => setTimeout(r, 0));

    it('writes and replies ok on a valid send', async () => {
      const { h, append } = messagingSetup();
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage(VALID);
      await settle();
      expect(append).toHaveBeenCalledWith('my-team', 'defender', 'murray', 'ping');
      expect(reply(h)).toMatchObject({ type: 'teammateMessageSent', ok: true });
    });

    it('refuses (and never writes) when the flag is off — re-checked server-side', async () => {
      const { h, append } = messagingSetup({ getMessagingSettings: vi.fn(() => ({ enabled: false, operatorName: 'murray' })) });
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage(VALID);
      await settle();
      expect(append).not.toHaveBeenCalled();
      expect(reply(h)).toMatchObject({ ok: false });
    });

    it('synthesizes `from` from settings, ignoring a webview-supplied from', async () => {
      const { h, append } = messagingSetup();
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage({ ...VALID, from: 'team-lead' });
      await settle();
      expect(append).toHaveBeenCalledWith('my-team', 'defender', 'murray', 'ping');
    });

    it('rejects an invalid command (wrong source) without writing', async () => {
      const { h, append } = messagingSetup();
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage({ ...VALID, source: 'workflow' });
      await settle();
      expect(append).not.toHaveBeenCalled();
      expect(reply(h)).toMatchObject({ ok: false });
    });

    it('rejects an invalid operatorName without writing', async () => {
      const { h, append } = messagingSetup({ getMessagingSettings: vi.fn(() => ({ enabled: true, operatorName: 'bad name!' })) });
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage(VALID);
      await settle();
      expect(append).not.toHaveBeenCalled();
      expect(reply(h)).toMatchObject({ ok: false });
    });

    it('rejects an over-long operatorName without writing', async () => {
      const { h, append } = messagingSetup({ getMessagingSettings: vi.fn(() => ({ enabled: true, operatorName: 'a'.repeat(101) })) });
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage(VALID);
      await settle();
      expect(append).not.toHaveBeenCalled();
      expect(reply(h)).toMatchObject({ ok: false });
    });

    it('refuses when the target cannot be resolved', async () => {
      const { h, append } = messagingSetup({ resolveInboxTarget: vi.fn(() => null) });
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage(VALID);
      await settle();
      expect(append).not.toHaveBeenCalled();
      expect(reply(h)).toMatchObject({ ok: false });
    });

    it('surfaces a write error in-webview and logs metadata only (never the message text)', async () => {
      const { h, logMessaging } = messagingSetup({ appendTeammateMessage: vi.fn(async () => { throw new Error('inbox file is a symlink'); }) });
      h.panel.show('subagents', 'lead-001', 'lead-001');
      await h.webview._fireMessage({ ...VALID, text: 'SECRET-token-xyz' });
      await settle();
      expect(reply(h)).toMatchObject({ ok: false, error: 'inbox file is a symlink' });
      // No toast (focus theft); and no log line carries the message body.
      expect(window.showErrorMessage).not.toHaveBeenCalled();
      for (const call of logMessaging.mock.calls) {
        expect(String(call[0])).not.toContain('SECRET-token-xyz');
      }
    });

    it('is inert when the messaging deps are not wired', async () => {
      const h = setup(); // no messaging deps
      h.panel.show('subagents', 'sess-1', 'sess-1');
      await h.webview._fireMessage(VALID);
      await settle();
      expect(reply(h)).toMatchObject({ ok: false });
    });
  });

  describe('sendSettings', () => {
    it('posts the experimental settings to the webview on show', () => {
      const h = setup({ getMessagingSettings: vi.fn(() => ({ enabled: true, operatorName: 'murray' })) });
      h.panel.show('subagents', 'sess-1', 'sess-1');
      const msg = h.posted().find(m => m.type === 'settings');
      expect(msg).toMatchObject({ type: 'settings', experimental: { teammateMessaging: true, operatorName: 'murray' } });
    });

    it('reports the feature disabled when no deps are wired', () => {
      const h = setup();
      h.panel.show('subagents', 'sess-1', 'sess-1');
      const msg = h.posted().find(m => m.type === 'settings');
      expect(msg).toMatchObject({ experimental: { teammateMessaging: false } });
    });
  });

  describe('subagents dir-scan fallback', () => {
    it('recovers on-disk subagents the tracker never resolved (empty tracked list)', () => {
      // A session whose subagents never relayed agent_progress: all agentId null.
      const session = makeSession({
        subagents: [
          { parentToolUseId: 't1', agentId: null, description: 'pending a', running: false, waitingOnPermission: false, startedAt: 1000, resultPreview: null, toolsCompleted: 0, blocking: false },
        ] as any,
      });
      const h = setup({
        getSession: vi.fn(() => session),
        listSubagents: vi.fn(() => [
          { agentId: 'd1', agentType: 'general-purpose', description: 'review types', model: 'claude-sonnet-5' },
          { agentId: 'd2', agentType: 'Explore', description: null, model: null },
        ]),
      });
      h.panel.show('subagents', 'sess-1', 'sess-1');
      const m = h.lastModel();
      expect(m.groups[0].agents.map((a: any) => a.agentId)).toEqual(['d1', 'd2']);
      // label prefers description, then agentType, then a short agentId.
      expect(m.groups[0].agents[0].label).toBe('review types');
      expect(m.groups[0].agents[1].label).toBe('Explore');
      // model rides along from the transcript head; unknown stays ''.
      expect(m.groups[0].agents[0].model).toBe('claude-sonnet-5');
      expect(m.groups[0].agents[1].model).toBe('');
      expect(m.groups[0].agents.every((a: any) => a.status === 'done')).toBe(true);
      expect(m.metrics).toContain('2 subagents');
    });

    it('unions tracked subagents with disk-only ones, without duplicating', () => {
      const h = setup({
        // makeSession default: sa1 (done), sa2 (running), and an agentless entry.
        listSubagents: vi.fn(() => [
          { agentId: 'sa1', agentType: 'x', description: 'dup of tracked', model: 'claude-opus-4-8' }, // already tracked → skip
          { agentId: 'd9', agentType: null, description: 'disk only', model: null },                    // new → appended
        ]),
      });
      h.panel.show('subagents', 'sess-1', 'sess-1');
      const m = h.lastModel();
      const ids = m.groups[0].agents.map((a: any) => a.agentId);
      expect(ids).toEqual(['sa1', 'sa2', 'd9']);
      // tracked sa1 keeps its rich label, not the disk one.
      expect(m.groups[0].agents.find((a: any) => a.agentId === 'sa1').label).toBe('explore auth');
      // ...but borrows the disk-recovered model (live tracking never sees one).
      expect(m.groups[0].agents.find((a: any) => a.agentId === 'sa1').model).toBe('claude-opus-4-8');
      expect(m.metrics).toContain('3 subagents');
      expect(m.metrics).toContain('1 running'); // running count from tracked only
    });

    it('maps a running-but-waiting-on-permission subagent to status "waiting" (Phase 2 permission row)', () => {
      // The log view's pinned permission row (DESIGN-DETAIL-PANE-V2.md) is
      // driven purely off DetailAgentView.status — a plain subagent blocked
      // on a permission prompt must surface as 'waiting', not 'running',
      // same mapping panelRender.ts already uses for the sidebar.
      const session = makeSession({
        subagents: [
          { parentToolUseId: 't2', agentId: 'sa2', description: 'explore db', running: true, waitingOnPermission: true, startedAt: 1000, resultPreview: null, toolsCompleted: 2, blocking: false },
        ] as any,
      });
      const h = setup({ getSession: vi.fn(() => session) });
      h.panel.show('subagents', 'sess-1', 'sess-1');
      const m = h.lastModel();
      expect(m.groups[0].agents.find((a: any) => a.agentId === 'sa2')).toMatchObject({ status: 'waiting' });
    });
  });

  describe('teammate framing + liveness (composer gate inputs)', () => {
    /** An orchestrator whose only member is IN-PROCESS (the aviary shape):
     *  parsed roster `agents` is empty; the name lives in inProcessMembers. */
    const inProcessTeam = () => makeTeam({ agents: [], inProcessMembers: ['lyrebird'], counts: {} });
    /** One disk-only subagent whose meta agentType is the member name. */
    const lyrebirdOnDisk = () => vi.fn(() => [{ agentId: 'd1', agentType: 'lyrebird', description: 'lyrebird', model: null }]);

    it('roster-matches an in-process member and marks it alive even when its status reads done', () => {
      // The aviary regression: an idle teammate is disk-only (status 'done',
      // no live tracking) yet alive — on the roster, listening on its inbox.
      const h = setup({
        getTeams: vi.fn(() => [inProcessTeam()]),
        getSession: vi.fn(() => makeSession({ subagents: [] })),
        listSubagents: lyrebirdOnDisk(),
      });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const a = h.lastModel().groups[0].agents[0];
      expect(a).toMatchObject({ agentId: 'd1', status: 'done', teammate: true, alive: true });
    });

    it('does not badge (or enliven) a plain Task subagent of a team lead', () => {
      const h = setup({
        getTeams: vi.fn(() => [inProcessTeam()]),
        getSession: vi.fn(() => makeSession({ subagents: [] })),
        listSubagents: vi.fn(() => [{ agentId: 'd2', agentType: 'Explore', description: 'scout', model: null }]),
      });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const a = h.lastModel().groups[0].agents[0];
      expect(a.teammate).toBeUndefined(); // plain row — composer gate (=== true) stays closed
      expect(a.alive).toBeUndefined();
    });

    it('dedupes re-spawn duplicates to one row per member, labelled by member name', () => {
      const h = setup({
        getTeams: vi.fn(() => [inProcessTeam()]),
        getSession: vi.fn(() => makeSession({ subagents: [] })),
        // Three spawn rounds of the same bird, listed in spawn order.
        listSubagents: vi.fn(() => [
          { agentId: 'd1', agentType: 'lyrebird', description: 'round 1', model: null },
          { agentId: 'd2', agentType: 'lyrebird', description: 'round 2', model: null },
          { agentId: 'd3', agentType: 'lyrebird', description: 'round 3', model: 'claude-sonnet-5' },
        ]),
      });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const rows = h.lastModel().groups[0].agents;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentId: 'd3', label: 'lyrebird', teammate: true });
      expect(h.lastModel().metrics).toContain('1 teammate');
    });

    it('a running duplicate beats a newer finished one', () => {
      const h = setup({
        getTeams: vi.fn(() => [inProcessTeam()]),
        // sa2 is the live-tracked running row (makeSession default); d9 is a
        // newer-on-disk finished duplicate of the same member.
        listSubagents: vi.fn(() => [
          { agentId: 'sa2', agentType: 'lyrebird', description: null, model: null },
          { agentId: 'd9', agentType: 'lyrebird', description: null, model: null },
        ]),
      });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const rows = h.lastModel().groups[0].agents.filter((a: any) => a.teammate);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentId: 'sa2', status: 'running' });
    });

    it('splits teammates and other subagents into titled groups when both exist', () => {
      const h = setup({
        getTeams: vi.fn(() => [inProcessTeam()]),
        getSession: vi.fn(() => makeSession({ subagents: [] })),
        listSubagents: vi.fn(() => [
          { agentId: 'd1', agentType: 'lyrebird', description: null, model: null },
          { agentId: 'd2', agentType: 'card-engine', description: 'old flashcard agent', model: null },
        ]),
      });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const m = h.lastModel();
      expect(m.groups.map((g: any) => g.title)).toEqual(['Teammates', 'Other subagents']);
      // Both groups keep the '' key so card deep-links still resolve.
      expect(m.groups.every((g: any) => g.key === '')).toBe(true);
      expect(m.groups[0].agents[0].label).toBe('lyrebird');
      expect(m.groups[1].agents[0].teammate).toBeUndefined();
      expect(m.metrics).toContain('1 teammate');
      expect(m.metrics).toContain('1 other subagent');
    });

    it('marks a teammate not alive once the lead process is registry-confirmed dead', () => {
      const h = setup({
        getTeams: vi.fn(() => [inProcessTeam()]),
        getSession: vi.fn(() => makeSession({ subagents: [], processLive: false })),
        listSubagents: lyrebirdOnDisk(),
      });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const a = h.lastModel().groups[0].agents[0];
      expect(a).toMatchObject({ teammate: true, alive: false });
    });

    it('still roster-matches tmux members via the agents list', () => {
      const h = setup({
        getSession: vi.fn(() => makeSession({ subagents: [] })),
        listSubagents: vi.fn(() => [{ agentId: 'd3', agentType: 'defender', description: 'defender', model: null }]),
      });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      expect(h.lastModel().groups[0].agents[0]).toMatchObject({ teammate: true, alive: true });
    });

    it('adds no teammate/alive fields when the session orchestrates no team', () => {
      const h = setup({ getTeams: vi.fn(() => []) });
      h.panel.show('subagents', 'sess-1', 'sess-1');
      const a = h.lastModel().groups[0].agents[0];
      expect(a.teammate).toBeUndefined();
      expect(a.alive).toBeUndefined();
    });
  });

  describe('view switcher', () => {
    // No plain subagents → the switcher reflects workflow runs alone.
    const noSubs = () => ({
      getSession: vi.fn(() => makeSession({ subagents: [] })),
      listSubagents: vi.fn(() => []),
    });
    function twoRuns() {
      return [
        makeWorkflow({ runId: 'wf_new', name: 'review', startTime: 5000, status: 'running', source: 'live' }),
        makeWorkflow({ runId: 'wf_old', name: 'review', startTime: 1000, status: 'completed' }),
      ];
    }

    it('shows only the most recent run by default, with a view switcher', () => {
      const h = setup({ getWorkflows: vi.fn(() => twoRuns()), ...noSubs() });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const m = h.lastModel();
      // groups belong to the newest run only (key = wf_new)
      expect(m.groups.every((g: any) => g.key === 'wf_new')).toBe(true);
      expect(m.views).toHaveLength(2);
      // most-recent-first, ordinal-disambiguated (same name)
      expect(m.views[0]).toMatchObject({ id: 'wf_new', kind: 'workflow', label: 'review #1', active: true });
      expect(m.views[1]).toMatchObject({ id: 'wf_old', kind: 'workflow', label: 'review #2', active: false });
      expect(m.views[0].status).toBe('running'); // newest run is the live tier
    });

    it('still surfaces a single view in the switcher (it doubles as the scope heading)', () => {
      const h = setup({ ...noSubs() }); // single run, no subagents
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const views = h.lastModel().views;
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ kind: 'workflow', active: true });
    });

    it('selectDetailView switches the visible run', async () => {
      const h = setup({ getWorkflows: vi.fn(() => twoRuns()), ...noSubs() });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'selectDetailView', id: 'wf_old', kind: 'workflow' });
      const m = h.lastModel();
      expect(m.groups.every((g: any) => g.key === 'wf_old')).toBe(true);
      expect(m.views.find((v: any) => v.id === 'wf_old').active).toBe(true);
      expect(m.views.find((v: any) => v.id === 'wf_old').status).toBe('completed');
    });

    it('adds a Subagents view when the session also has plain subagents', () => {
      // default getSession has subagents sa1 (done) + sa2 (running); single run.
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      const m = h.lastModel();
      expect(m.views).toHaveLength(2);
      expect(m.views[0]).toMatchObject({ kind: 'workflow', active: true });
      expect(m.views[1]).toMatchObject({ id: 'subagents', kind: 'subagents', label: 'Subagents', status: 'running', active: false });
    });

    it('selectDetailView flips the source to the subagents view', async () => {
      const h = setup(); // default: one workflow run + subagents
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'selectDetailView', id: 'subagents', kind: 'subagents' });
      const m = h.lastModel();
      expect(m.source).toBe('subagents');
      expect(m.groups[0].agents.map((a: any) => a.agentId)).toEqual(['sa1', 'sa2']);
      expect(m.views.find((v: any) => v.id === 'subagents').active).toBe(true);
    });

    it('offers a Roster view for an orchestrator with tmux members', () => {
      const h = setup(); // makeTeam: orchestrator orch-1, two roster members
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const roster = h.lastModel().views.find((v: any) => v.kind === 'team');
      expect(roster).toMatchObject({ id: 'orch-1', label: 'Roster · scope-demo', active: false });
    });

    it('suppresses the Roster view for a memberless team (no tmux, no in-process)', () => {
      const h = setup({ getTeams: vi.fn(() => [makeTeam({ agents: [], counts: {} })]) });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const m = h.lastModel();
      expect(m.views.some((v: any) => v.kind === 'team')).toBe(false);
      // The teammate framing survives — only the dead-end chip goes.
      expect(m.title).toBe('Teammates');
    });

    it('suppresses the Roster view for an all-in-process team (Teammates is a superset with the composer)', () => {
      const h = setup({ getTeams: vi.fn(() => [makeTeam({ agents: [], counts: {}, inProcessMembers: ['lyrebird'] })]) });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      expect(h.lastModel().views.some((v: any) => v.kind === 'team')).toBe(false);
    });

    it('counts in-process members in a mixed team\'s roster chip summary', () => {
      const h = setup({ getTeams: vi.fn(() => [makeTeam({ inProcessMembers: ['lyrebird'] })]) });
      h.panel.show('subagents', 'orch-1', 'orch-1');
      const roster = h.lastModel().views.find((v: any) => v.kind === 'team');
      expect(roster.summary).toContain('3 members');
    });

    it('keeps the Roster view while it is the active source, even with an empty roster', () => {
      const h = setup({ getTeams: vi.fn(() => [makeTeam({ agents: [], counts: {} })]) });
      h.panel.show('team', 'orch-1', 'orch-1');
      const roster = h.lastModel().views.find((v: any) => v.kind === 'team');
      expect(roster).toMatchObject({ kind: 'team', active: true });
    });
  });

  describe('dispose', () => {
    it('clears state so a closed panel can be reopened fresh', () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      h.mockPanel._fireDispose();
      // After dispose, showing again must create a new panel.
      const webview2 = createMockWebview();
      const mockPanel2 = createMockWebviewPanel(webview2);
      vi.mocked(window.createWebviewPanel).mockReturnValue(mockPanel2 as any);
      h.panel.show('team', 'orch-1', 'orch-1');
      expect(window.createWebviewPanel).toHaveBeenCalledTimes(2);
    });
  });
});

describe('rollupSummary — chip tooltip roll-up', () => {
  it('returns undefined for an empty roster', () => {
    expect(rollupSummary([], 'agent')).toBeUndefined();
  });

  it('counts buckets in triage order, failed first', () => {
    expect(rollupSummary(['done', 'failed', 'running', 'done', 'running', 'done'], 'agent'))
      .toBe('6 agents · 1 failed · 2 running · 3 done');
  });

  it('collapses an all-done roster to just the total (the dot already says done)', () => {
    expect(rollupSummary(['done', 'done', 'done'], 'agent')).toBe('3 agents');
    expect(rollupSummary(['completed'], 'member')).toBe('1 member');
  });

  it('still itemises a uniform non-terminal roster', () => {
    expect(rollupSummary(['running', 'running'], 'subagent')).toBe('2 subagents · 2 running');
  });

  it('keeps unknown statuses visible under their own name', () => {
    expect(rollupSummary(['done', 'mystery'], 'agent')).toBe('2 agents · 1 done · 1 mystery');
  });
});

describe('per-build memoisation (audit refactor-detail-1/perf-render-3)', () => {
  it('one team-orchestrator model build hits getSession and listSubagents once each', () => {
    const h = setup({
      getTeams: vi.fn(() => [makeTeam({ teamId: 'at:my-team', inProcessMembers: ['lyrebird'] })]),
      getWorkflows: vi.fn(() => []),
    });
    h.panel.show('subagents', 'sess-1', 'sess-1');
    // The team path used to reach these deps up to four times per build —
    // each a sync dir scan / full snapshot rebuild at refresh cadence.
    expect(vi.mocked(h.deps.getSession).mock.calls.length).toBe(1);
    expect(vi.mocked(h.deps.listSubagents).mock.calls.length).toBe(1);
  });

  it('the memo does not leak across builds (a later refresh sees fresh data)', () => {
    const h = setup({ getWorkflows: vi.fn(() => []) });
    h.panel.show('subagents', 'sess-1', 'sess-1');
    const first = vi.mocked(h.deps.getSession).mock.calls.length;
    h.panel.refresh(); // dedupe may skip the post, but the model is rebuilt
    expect(vi.mocked(h.deps.getSession).mock.calls.length).toBeGreaterThan(first);
  });
});
