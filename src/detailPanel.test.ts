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

// Mock the transcript reader so viewAgent resolution is observable
vi.mock('./transcriptRenderer.js', () => ({
  parseTranscript: vi.fn(),
}));

import { DetailPanel, type DetailPanelDeps } from './detailPanel.js';
import { parseTranscript } from './transcriptRenderer.js';
import {
  Uri,
  createMockWebview,
  createMockWebviewPanel,
  window,
  type MockWebview,
  type MockWebviewPanel,
} from './__mocks__/vscode.js';
import type { WorkflowSnapshot, TeamSnapshot, SessionSnapshot } from './types.js';

// ── Fixtures ─────────────────────────────────────────────────────────

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
      { sessionId: null, name: 'defender', cwd: '/x', parentSessionId: 'orch-1', depth: 1, spawnedAt: 1000, status: 'done', activity: '', confidence: 'high', subagents: [], contextTokens: 1000, exitStatus: 'success' },
      { sessionId: 'sk-1', name: 'skeptic', cwd: '/x', parentSessionId: 'orch-1', depth: 1, spawnedAt: 1000, status: 'running', activity: '', confidence: 'high', subagents: [], contextTokens: 2000, exitStatus: null },
    ],
    counts: { done: 1, running: 1 },
    dismissed: false,
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
    exitStatus: null,
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
      expect(m.chips).toContain('completed');
      expect(m.metrics).toContain('3 agents');
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

    it('marks a live workflow with a "live" chip', () => {
      const h = setup({ getWorkflows: vi.fn(() => [makeWorkflow({ source: 'live', status: 'running' })]) });
      h.panel.show('workflow', 'sess-1', 'sess-1');
      expect(h.lastModel().chips).toContain('live');
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
    it('resolves the transcript and posts agentTranscript', async () => {
      vi.mocked(parseTranscript).mockResolvedValue([{ timestamp: 't', role: 'user', content: 'hi' }]);
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      // allow the async handler to settle
      await new Promise(r => setTimeout(r, 0));
      expect(h.deps.resolveAgentFile).toHaveBeenCalledWith('workflow', 'sess-1', 'wf_abc', 'a1');
      const msg = h.posted().find(m => m.type === 'agentTranscript');
      expect(msg).toBeTruthy();
      expect(msg.key).toBe('wf_abc|a1');
      expect(msg.entries).toHaveLength(1);
    });

    it('posts agentTranscriptError when the file cannot be resolved', async () => {
      const h = setup({ resolveAgentFile: vi.fn(() => null) });
      h.panel.show('subagents', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'subagents', containerId: 'sess-1', groupKey: '', agentId: 'sa1' });
      await new Promise(r => setTimeout(r, 0));
      const msg = h.posted().find(m => m.type === 'agentTranscriptError');
      expect(msg).toBeTruthy();
      expect(msg.key).toBe('|sa1');
    });

    it('posts agentTranscriptError when parseTranscript throws', async () => {
      vi.mocked(parseTranscript).mockRejectedValue(new Error('boom'));
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'workflow', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      await new Promise(r => setTimeout(r, 0));
      const msg = h.posted().find(m => m.type === 'agentTranscriptError');
      expect(msg).toBeTruthy();
      expect(String(msg.message)).toContain('boom');
    });

    it('ignores a malformed viewAgent message', async () => {
      const h = setup();
      h.panel.show('workflow', 'sess-1', 'sess-1');
      await h.webview._fireMessage({ type: 'viewAgent', source: 'nope', containerId: 'sess-1', groupKey: 'wf_abc', agentId: 'a1' });
      await new Promise(r => setTimeout(r, 0));
      expect(h.deps.resolveAgentFile).not.toHaveBeenCalled();
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
