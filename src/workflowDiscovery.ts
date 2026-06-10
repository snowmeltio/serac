import * as fs from 'fs';
import * as path from 'path';
import type { SessionMeta, WorkflowAgentSnapshot, WorkflowRunStatus, WorkflowSnapshot } from './types.js';
import type { Logger } from './sessionDiscovery.js';
import { parseWorkflowSidecar } from './workflowSidecar.js';
import { extractWorkflowMeta, extractAgentCalls, expandIndirectCalls, matchAgentCall, recoverInterpolatedLabel, type WorkflowAgentCall } from './workflowScript.js';
import { readSettings, ageGateDaysFor } from './settings.js';
import { isValidSessionId } from './validation.js';

/** Periodic full rescan cadence (every Nth poll cycle) when nothing is live. */
const WORKFLOW_SCAN_INTERVAL = 10;

/** The slice of ProcessRegistry the live tier needs to confirm a parent session
 *  has died (so an abandoned run can be downgraded from 'running' to
 *  'incomplete'). Structural so ProcessRegistry satisfies it without an import,
 *  and tests can pass a stub. */
export interface WorkflowLivenessProbe {
  isActive(): boolean;
  isScanClean(): boolean;
  isSessionLive(sessionId: string): boolean;
}

/** Resolve the active workflow age gate: `serac.discovery.workflowsAgeGateDays`
 *  when set, else the shared `serac.discovery.ageGateDays` base. */
function ageGateMs(): number {
  return ageGateDaysFor('workflows') * 24 * 60 * 60 * 1000;
}

/** The live-tier display label for a matched `agent()` call: a plain literal
 *  label as-is, an interpolated label recovered from the agent's prompt, or null
 *  when there's no label / the interpolation can't be recovered (caller picks a
 *  fallback). Guarantees the returned string never contains a raw `${…}`. */
function resolveLiveLabel(call: WorkflowAgentCall, prompt: string): string | null {
  if (!call.label) { return null; }
  if (!call.label.includes('${')) { return call.label; } // plain literal label
  return recoverInterpolatedLabel(call, prompt);          // interpolated → recover or null
}

/**
 * Discovers Claude Code Workflow runs for the current workspace by reading the
 * per-session completion sidecars at
 *   <projectsDir>/<workspaceKey>/<sessionId>/workflows/wf_<runId>.json   (Tier 1)
 * and minimally reconstructing in-progress runs (no sidecar yet) from
 *   <projectsDir>/<workspaceKey>/<sessionId>/subagents/workflows/<runId>/  (Tier 2).
 *
 * Mirrors TeamDiscovery's public surface so SessionDiscovery can own it the
 * same way, but it holds plain snapshots (no SessionManagers) because a sidecar
 * is render-ready static data written once at completion.
 */
export class WorkflowDiscovery {
  private readonly wsDir: string;
  /** runId -> parsed snapshot (dismiss state applied per getWorkflowSnapshots call). */
  private snapshots: Map<string, WorkflowSnapshot> = new Map();
  /** runId -> last-seen sidecar mtime (ms), to skip re-parsing unchanged files. */
  private mtimes: Map<string, number> = new Map();
  /** Set by scan() when the snapshot set changes; read + cleared by poll(). */
  private changedSincePoll = false;
  private scanCounter = 0;

  constructor(
    private readonly projectsDir: string,
    private readonly workspaceKey: string,
    private readonly log: Logger,
    /** Optional liveness probe. When present and in use, a live run whose parent
     *  session is confirmed dead is marked 'incomplete' instead of 'running'. */
    private readonly liveness?: WorkflowLivenessProbe,
  ) {
    this.wsDir = path.join(this.projectsDir, this.workspaceKey);
  }

  /** True every cycle while a run is live (so completion shows fast), else
   *  every WORKFLOW_SCAN_INTERVAL cycles. */
  shouldRescan(): boolean {
    if (this.hasActiveRuns()) { return true; }
    this.scanCounter++;
    if (this.scanCounter >= WORKFLOW_SCAN_INTERVAL) {
      this.scanCounter = 0;
      return true;
    }
    return false;
  }

  /** A workflow is "active" only in the live tier (running, no sidecar yet). */
  hasActiveRuns(): boolean {
    for (const snap of this.snapshots.values()) {
      if (snap.status === 'running') { return true; }
    }
    return false;
  }

  /** Cheap signal for the poll loop: did the last scan change anything?
   *  The flag is drained unconditionally — even when workflows are disabled,
   *  scan() may have just cleared the snapshot set, and that one change must be
   *  reported (and the flag reset) rather than getting stuck until re-enabled. */
  async poll(): Promise<boolean> {
    const changed = this.changedSincePoll;
    this.changedSincePoll = false;
    return changed;
  }

  /** Full walk of the workspace's session dirs for workflow sidecars + live runs. */
  async scan(): Promise<void> {
    if (!readSettings().show.workflows) {
      if (this.snapshots.size > 0) {
        this.snapshots.clear();
        this.mtimes.clear();
        this.changedSincePoll = true;
      }
      return;
    }

    const now = Date.now();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.wsDir, { withFileTypes: true });
    } catch {
      // Workspace dir absent (no CC history) — clear and bail.
      if (this.snapshots.size > 0) {
        this.snapshots.clear();
        this.mtimes.clear();
        this.changedSincePoll = true;
      }
      return;
    }

    const seen = new Set<string>();
    for (const ent of entries) {
      if (!ent.isDirectory()) { continue; }
      const sessionId = ent.name;
      if (!isValidSessionId(sessionId)) { continue; }

      const sidecarRunIds = await this.scanSidecars(sessionId, now, seen);
      await this.scanLiveRuns(sessionId, now, seen, sidecarRunIds);
    }

    // Prune snapshots whose sidecar/run dir vanished or aged out.
    for (const runId of [...this.snapshots.keys()]) {
      if (!seen.has(runId)) {
        this.snapshots.delete(runId);
        this.mtimes.delete(runId);
        this.changedSincePoll = true;
      }
    }
  }

  /** Tier 1: completed sidecars. Returns the set of runIds that have a sidecar. */
  private async scanSidecars(sessionId: string, now: number, seen: Set<string>): Promise<Set<string>> {
    const runIds = new Set<string>();
    const dir = path.join(this.wsDir, sessionId, 'workflows');
    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      return runIds; // no workflows dir for this session
    }

    for (const file of files) {
      if (!file.startsWith('wf_') || !file.endsWith('.json')) { continue; }
      const runId = file.slice(0, -'.json'.length);
      const filePath = path.join(dir, file);

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > ageGateMs()) { continue; } // stale: let pruning drop it

      runIds.add(runId);
      seen.add(runId);

      // Skip re-parse when the sidecar is unchanged.
      if (this.mtimes.get(runId) === stat.mtimeMs && this.snapshots.has(runId)) { continue; }

      let content: string;
      try {
        content = await fs.promises.readFile(filePath, 'utf-8');
      } catch (err) {
        this.log.warn(`[workflows] Failed to read sidecar ${filePath}:`, err);
        continue;
      }
      const snap = parseWorkflowSidecar(content, sessionId);
      if (!snap) {
        this.log.warn(`[workflows] Skipping malformed sidecar: ${file}`);
        continue;
      }
      this.snapshots.set(runId, snap);
      this.mtimes.set(runId, stat.mtimeMs);
      this.changedSincePoll = true;
    }
    return runIds;
  }

  /** Tier 2: run dirs lacking a sidecar → a minimal "running" snapshot. */
  private async scanLiveRuns(
    sessionId: string,
    now: number,
    seen: Set<string>,
    sidecarRunIds: Set<string>,
  ): Promise<void> {
    const liveRoot = path.join(this.wsDir, sessionId, 'subagents', 'workflows');
    let runDirs: fs.Dirent[];
    try {
      runDirs = await fs.promises.readdir(liveRoot, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of runDirs) {
      if (!ent.isDirectory() || !ent.name.startsWith('wf_')) { continue; }
      const runId = ent.name;
      if (sidecarRunIds.has(runId)) { continue; } // completed — Tier 1 owns it

      const runDir = path.join(liveRoot, runId);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(runDir);
      } catch {
        continue;
      }
      // A run dir with no sidecar that is older than the age gate is an
      // abandoned/killed run — drop it (pruning removes any stale snapshot).
      if (now - stat.mtimeMs > ageGateMs()) { continue; }

      seen.add(runId);
      // Re-derive each cycle (cheap, journal is small); the live snapshot is
      // transient and is replaced by the sidecar on completion. Only flag a
      // change when the rebuilt snapshot actually differs — otherwise an idle
      // live run would churn the whole panel every poll cycle (~500ms, since a
      // running run holds the fast cadence). Mirrors the sidecar tier's skip.
      const snap = await this.buildLiveSnapshot(sessionId, runId, runDir, stat.mtimeMs);
      if (snap) {
        const prev = this.snapshots.get(runId);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(snap)) {
          this.snapshots.set(runId, snap);
          this.changedSincePoll = true;
        }
        this.mtimes.set(runId, stat.mtimeMs);
      }
    }
  }

  private async buildLiveSnapshot(
    sessionId: string,
    runId: string,
    runDir: string,
    startTime: number,
  ): Promise<WorkflowSnapshot | null> {
    // Name + phase scaffold from the (never-eval'd) script meta, if present.
    // Also pull the agent() call sites so each running agent can be correlated
    // back to the phase the script assigned it (best-effort; see below).
    let name = runId;
    let phases: WorkflowSnapshot['phases'] = [];
    let agentCalls: WorkflowAgentCall[] = [];
    const phaseIndexByTitle = new Map<string, number>();
    try {
      const scriptsDir = path.join(this.wsDir, sessionId, 'workflows', 'scripts');
      const scriptFiles = await fs.promises.readdir(scriptsDir);
      const scriptFile = scriptFiles.find(f => f.endsWith(`-${runId}.js`));
      if (scriptFile) {
        const src = await fs.promises.readFile(path.join(scriptsDir, scriptFile), 'utf-8');
        const meta = extractWorkflowMeta(src);
        if (meta) {
          name = meta.name;
          phases = meta.phases.map((p, i) => ({ index: i + 1, title: p.title, detail: p.detail ?? '' }));
          for (const p of phases) { phaseIndexByTitle.set(p.title, p.index); }
        }
        // Expand indirect prompts (the canonical `pipeline(ARR, d =>
        // agent(d.prompt, …))` shape) into matchable virtual calls — without
        // this, the most idiomatic Workflow scripts rendered every agent
        // ungrouped under a raw journal key.
        agentCalls = expandIndirectCalls(src, extractAgentCalls(src));
      }
    } catch {
      // no script yet — fall back to runId + no phases + no correlation
    }

    // Agents from the journal: started → running, result → done. No phase grouping.
    const agents: WorkflowAgentSnapshot[] = [];
    const counts: Record<string, number> = {};
    const resolved = new Set<string>();
    try {
      const journal = await fs.promises.readFile(path.join(runDir, 'journal.jsonl'), 'utf-8');
      const started = new Map<string, string>(); // agentId -> first-seen label/key
      for (const line of journal.split('\n')) {
        if (!line.trim()) { continue; }
        let rec: unknown;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || typeof rec !== 'object') { continue; }
        const r = rec as Record<string, unknown>;
        const agentId = typeof r.agentId === 'string' ? r.agentId : null;
        if (!agentId) { continue; }
        if (r.type === 'started' && !started.has(agentId)) {
          started.set(agentId, typeof r.key === 'string' ? r.key : '');
        } else if (r.type === 'result') {
          resolved.add(agentId);
        }
      }
      for (const [agentId, key] of started) {
        const status = resolved.has(agentId) ? 'done' : 'running';
        counts[status] = (counts[status] ?? 0) + 1;

        // Correlate this agent back to its agent() call via its record-0 prompt,
        // so the live tier can group it under the right phase. Interpolated
        // (${...}) prompt parts differ per agent, so we match on the longest
        // static segment. Unmatched (e.g. agent(c.prompt)) → flat fallback.
        // The journal key (`v2:<sha>`) is an implementation detail and must
        // never reach the webview as a label — agent-distinct fallback instead.
        let label = `Agent · ${agentId.slice(0, 8)}`;
        let phaseIndex: number | null = null;
        let phaseTitle: string | null = null;
        let promptPreview = '';
        void key;
        if (isValidSessionId(agentId)) {
          const prompt = await this.readFirstRecordPrompt(path.join(runDir, `agent-${agentId}.jsonl`));
          if (prompt) { promptPreview = prompt.slice(0, 140); }
          const call = prompt ? matchAgentCall(prompt, agentCalls) : null;
          if (call) {
            if (call.phase) {
              const idx = phaseIndexByTitle.get(call.phase);
              if (idx !== undefined) { phaseIndex = idx; phaseTitle = call.phase; }
            }
            // Resolve a display label, never letting a raw `${...}` template
            // reach the webview. A plain literal label is used as-is; an
            // interpolated label (`audit:${d.key}`) is recovered from this
            // agent's own prompt, so fan-out agents get distinct labels
            // (audit:privacy, audit:security, …) instead of identical source.
            // When the value can't be recovered, fall back to a phase-scoped,
            // agent-distinct label rather than repeat the raw template per row.
            const resolved = resolveLiveLabel(call, prompt as string);
            if (resolved !== null) {
              label = resolved;
            } else if (phaseTitle) {
              label = `${phaseTitle} · ${agentId.slice(0, 8)}`;
            }
          }
        }
        const stats = await this.liveAgentStats(runDir, agentId, status);

        agents.push({
          agentId,
          label,
          phaseIndex,
          phaseTitle,
          model: '',
          agentType: null,
          status,
          startedAt: 0,
          durationMs: null,
          tokens: stats.tokens,
          toolCalls: stats.toolCalls,
          attempt: 1,
          promptPreview,
          resultPreview: null,
          lastToolName: null,
          lastToolSummary: null,
        });
      }
    } catch {
      // journal not written yet — emit a phase-only scaffold
    }

    // A live run with no sidecar whose parent session is confirmed dead was
    // killed/abandoned — downgrade it to 'incomplete' (not 'running'), which
    // drops the fast poll cadence and matches the documented behaviour. Gate
    // conservatively: only when the registry is in use AND its last scan was
    // clean, so an absent/degraded registry never false-positives a healthy
    // long-running workflow. (Run-dir mtime is NOT used — it doesn't advance on
    // transcript/journal appends, so it would misfire on healthy runs.)
    const parentDead = !!this.liveness
      && this.liveness.isActive()
      && this.liveness.isScanClean()
      && !this.liveness.isSessionLive(sessionId);
    const runStatus: WorkflowRunStatus = parentDead ? 'incomplete' : 'running';

    return {
      runId,
      sessionId,
      taskId: null,
      name,
      summary: '',
      status: runStatus,
      source: 'live',
      startTime,
      durationMs: null,
      defaultModel: '',
      agentCount: agents.length,
      totalTokens: 0,
      totalToolCalls: 0,
      phases,
      agents,
      counts,
      logs: [],
      dismissed: false,
    };
  }

  /** Per-agent live token/tool-call stats cache. Previously the live tier
   *  hardcoded zeros ("0 tokens · 0 tools" on a run mid-flight). Cost-bounded:
   *  a full re-read happens only when the file grew AND the last scan is older
   *  than the throttle, capped at 8 MB — beyond that the last stats stick. */
  private agentStatsCache = new Map<string, { size: number; scannedAt: number; tokens: number; toolCalls: number }>();
  private static readonly STATS_RESCAN_MS = 5_000;
  private static readonly STATS_MAX_BYTES = 8 * 1024 * 1024;

  private async liveAgentStats(runDir: string, agentId: string, status: string): Promise<{ tokens: number; toolCalls: number }> {
    const filePath = path.join(runDir, `agent-${agentId}.jsonl`);
    const cached = this.agentStatsCache.get(filePath);
    try {
      const stat = await fs.promises.stat(filePath);
      if (cached && (cached.size === stat.size
        || (status === 'running' && Date.now() - cached.scannedAt < WorkflowDiscovery.STATS_RESCAN_MS))) {
        return cached;
      }
      if (stat.size > WorkflowDiscovery.STATS_MAX_BYTES) { return cached ?? { tokens: 0, toolCalls: 0 }; }
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      let tokens = 0;
      let toolCalls = 0;
      for (const line of raw.split('\n')) {
        if (!line) { continue; }
        // Cheap pre-filters before JSON.parse — most lines carry neither.
        const hasUsage = line.includes('"output_tokens"');
        const hasTool = line.includes('"tool_use"');
        if (!hasUsage && !hasTool) { continue; }
        try {
          const rec = JSON.parse(line) as { message?: { usage?: { output_tokens?: number }; content?: unknown } };
          const u = rec.message?.usage?.output_tokens;
          if (typeof u === 'number') { tokens += u; }
          const content = rec.message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') { toolCalls++; }
            }
          }
        } catch { /* malformed line — skip */ }
      }
      const entry = { size: stat.size, scannedAt: Date.now(), tokens, toolCalls };
      this.agentStatsCache.set(filePath, entry);
      return entry;
    } catch {
      return cached ?? { tokens: 0, toolCalls: 0 };
    }
  }

  /** Read the prompt text from record-0 of an agent transcript, bounded so a
   *  large in-progress transcript isn't slurped whole. The prompt is the very
   *  first record, so a single head read suffices. Returns null on any error,
   *  on a record-0 larger than the window (truncated → unparseable), or when
   *  the record carries no usable text. */
  private async readFirstRecordPrompt(filePath: string): Promise<string | null> {
    const MAX_BYTES = 256 * 1024;
    let fh: fs.promises.FileHandle | undefined;
    try {
      fh = await fs.promises.open(filePath, 'r');
      const buf = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
      const chunk = buf.toString('utf-8', 0, bytesRead);
      const nl = chunk.indexOf('\n');
      if (nl < 0 && bytesRead === MAX_BYTES) { return null; } // record-0 too big
      const line = nl >= 0 ? chunk.slice(0, nl) : chunk;
      const rec = JSON.parse(line) as { message?: { content?: unknown } };
      const content = rec.message?.content;
      if (typeof content === 'string') { return content; }
      if (Array.isArray(content)) {
        return content
          .filter((b): b is { type: string; text: string } =>
            !!b && typeof b === 'object'
            && (b as { type?: unknown }).type === 'text'
            && typeof (b as { text?: unknown }).text === 'string')
          .map(b => b.text)
          .join('\n') || null;
      }
      return null;
    } catch {
      return null;
    } finally {
      await fh?.close();
    }
  }

  /** Snapshots for the webview, dismiss state overlaid, active runs first. */
  getWorkflowSnapshots(sessionMeta: Map<string, SessionMeta>): WorkflowSnapshot[] {
    const out: WorkflowSnapshot[] = [];
    for (const snap of this.snapshots.values()) {
      const dismissed = sessionMeta.get(`workflow:${snap.runId}`)?.dismissed ?? false;
      out.push({ ...snap, dismissed });
    }
    out.sort((a, b) => {
      const aActive = a.status === 'running' ? 1 : 0;
      const bActive = b.status === 'running' ? 1 : 0;
      if (aActive !== bActive) { return bActive - aActive; }
      return b.startTime - a.startTime;
    });
    return out;
  }

  /** Resolve a workflow agent's transcript JSONL, or null if it doesn't exist. */
  getWorkflowAgentFilePath(runId: string, agentId: string): string | null {
    const snap = this.snapshots.get(runId);
    if (!snap) { return null; }
    if (!isValidSessionId(agentId)) { return null; }
    const file = path.join(
      this.wsDir, snap.sessionId, 'subagents', 'workflows', runId, `agent-${agentId}.jsonl`,
    );
    return fs.existsSync(file) ? file : null;
  }

  dispose(): void {
    this.snapshots.clear();
    this.mtimes.clear();
  }
}
