import * as fs from 'fs';
import * as path from 'path';
import type { SessionMeta, WorkflowAgentSnapshot, WorkflowRunStatus, WorkflowSnapshot } from './types.js';
import type { Logger } from './sessionDiscovery.js';
import { parseWorkflowSidecar } from './workflowSidecar.js';
import { extractWorkflowMeta, extractAgentCalls, expandIndirectCalls, matchAgentCall, recoverInterpolatedLabel, type WorkflowAgentCall } from './workflowScript.js';
import { readSettings, ageGateMsFor } from './settings.js';
import { makeRescanGate } from './sessionPolling.js';
import { isValidSessionId } from './validation.js';
import { JsonlTailer } from './jsonlTailer.js';

/** The slice of ProcessRegistry the live tier needs to confirm a parent session
 *  has died (so an abandoned run can be downgraded from 'running' to
 *  'incomplete'). Structural so ProcessRegistry satisfies it without an import,
 *  and tests can pass a stub. */
export interface WorkflowLivenessProbe {
  isActive(): boolean;
  isScanClean(): boolean;
  isSessionLive(sessionId: string): boolean;
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

/** Display fields derived from an agent's (immutable) record-0 prompt and the
 *  script version it was correlated against. Cached per agent — see liveRuns. */
interface AgentCorrelation {
  scriptV: number;
  label: string;
  phaseIndex: number | null;
  phaseTitle: string | null;
  promptPreview: string;
}

/** Per-run live-tier accumulator (audit perf-io-1). The journal is append-only,
 *  so it is tailed incrementally instead of re-read from byte 0 on every fast
 *  poll cycle; started/resolved fold idempotently, so a truncation replay (the
 *  tailer resets to byte 0 and returns the whole file) is safe once the
 *  accumulators are cleared. */
interface LiveRunState {
  tailer: JsonlTailer;
  /** agentId -> first-seen journal key. */
  started: Map<string, string>;
  /** agentIds that have a result record. */
  resolved: Set<string>;
  /** agentId -> cached prompt correlation (immutable per script version). */
  corr: Map<string, AgentCorrelation>;
  /** Signature of the last snapshot emitted for this run. */
  sig: string;
}

/** Derive the live-tier display fields for one agent from its record-0
 *  prompt. Interpolated (${...}) prompt parts differ per agent, so the call
 *  match uses the longest static segment; unmatched (e.g. agent(c.prompt)) →
 *  flat fallback. The label never leaks a raw `${…}` template: a plain
 *  literal label is used as-is; an interpolated label (`audit:${d.key}`) is
 *  recovered from this agent's own prompt, so fan-out agents get distinct
 *  labels (audit:privacy, audit:security, …); when the value can't be
 *  recovered, a phase-scoped, agent-distinct label stands in. */
function correlateAgent(
  agentId: string,
  prompt: string,
  scriptV: number,
  agentCalls: WorkflowAgentCall[],
  phaseIndexByTitle: Map<string, number>,
): AgentCorrelation {
  let label = `Agent · ${agentId.slice(0, 8)}`;
  let phaseIndex: number | null = null;
  let phaseTitle: string | null = null;
  const promptPreview = prompt.slice(0, 140);
  const call = matchAgentCall(prompt, agentCalls);
  if (call) {
    if (call.phase) {
      const idx = phaseIndexByTitle.get(call.phase);
      if (idx !== undefined) { phaseIndex = idx; phaseTitle = call.phase; }
    }
    const resolved = resolveLiveLabel(call, prompt);
    if (resolved !== null) {
      label = resolved;
    } else if (phaseTitle) {
      label = `${phaseTitle} · ${agentId.slice(0, 8)}`;
    }
  }
  return { scriptV, label, phaseIndex, phaseTitle, promptPreview };
}

/** Cheap change signature for a rebuilt live snapshot, covering every field
 *  that can differ between rebuilds (the rest are live-tier constants).
 *  Replaces a JSON.stringify deep-compare of old + new snapshots per cycle
 *  (audit perf-io-1). agentCount/counts are derived from agents and need no
 *  own term; phaseTitle is derived from phaseIndex + phases. */
function liveSnapshotSig(snap: WorkflowSnapshot): string {
  const parts: string[] = [
    snap.status,
    snap.name,
    String(snap.startTime),
    snap.phases.map(p => `${p.index}\u0000${p.title}\u0000${p.detail}`).join('\u0001'),
  ];
  for (const a of snap.agents) {
    parts.push([a.agentId, a.status, a.tokens, a.toolCalls, a.label, a.phaseIndex ?? '', a.promptPreview].join('\u0000'));
  }
  return parts.join('\u0002');
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
  /** Per-run script parse, keyed on mtime — the script is immutable per run,
   *  so the 500ms live poll must not re-read and re-parse it every cycle. */
  private readonly scriptMeta = new Map<string, { mtimeMs: number; name: string; phases: WorkflowSnapshot['phases']; agentCalls: WorkflowAgentCall[] }>();
  /** runId -> scripts dir, once a fallback scan (see findScriptDirByRunId)
   *  finds a run's script under a workspace key other than this one. */
  private readonly scriptDirOverride = new Map<string, string>();
  /** runId -> last fallback-scan attempt (ms), throttling the scan below —
   *  it walks every project dir, so it must not run at the 500ms live cadence. */
  private readonly scriptFallbackAttemptedAt = new Map<string, number>();
  private static readonly SCRIPT_FALLBACK_RETRY_MS = 3000;
  /** Per-run live-tier accumulator: journal tailer + cached prompt
   *  correlations + last-emitted signature (audit perf-io-1). */
  private readonly liveRuns = new Map<string, LiveRunState>();
  /** Set by scan() when the snapshot set changes; read + cleared by poll(). */
  private changedSincePoll = false;
  /** Counts scan() invocations so the live cadence can walk the full
   *  workspace only every Nth scan — see scan(). */
  private scanCount = 0;
  private static readonly FULL_WALK_INTERVAL = 10;

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
   *  every Nth cycle. */
  private readonly rescanGate = makeRescanGate(() => this.hasActiveRuns());
  shouldRescan(): boolean {
    return this.rescanGate();
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

  /** Reset all discovery state and flag the change (settings-off / dir gone). */
  private clearAll(): void {
    if (this.snapshots.size > 0) {
      this.snapshots.clear();
      this.mtimes.clear();
      this.scriptMeta.clear();
      this.liveRuns.clear();
      this.scriptDirOverride.clear();
      this.scriptFallbackAttemptedAt.clear();
      this.agentStatsCache.clear();
      this.changedSincePoll = true;
    }
  }

  /** Walk the workspace's session dirs for workflow sidecars + live runs.
   *  While a run is live the rescan gate calls this every fast cycle, but only
   *  the sessions owning live runs need that cadence (so completion shows
   *  fast) — the full walk, one readdir per session dir, runs on every Nth
   *  scan to discover new runs in other sessions (audit perf-io-1). With no
   *  live runs the gate itself throttles scan(), so every walk is full. */
  async scan(): Promise<void> {
    if (!readSettings().show.workflows) {
      this.clearAll();
      return;
    }

    const now = Date.now();
    const liveSessions = new Set<string>();
    for (const snap of this.snapshots.values()) {
      if (snap.status === 'running') { liveSessions.add(snap.sessionId); }
    }
    const fullWalk = liveSessions.size === 0
      || this.scanCount % WorkflowDiscovery.FULL_WALK_INTERVAL === 0;
    this.scanCount++;

    let sessionIds: string[];
    if (fullWalk) {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(this.wsDir, { withFileTypes: true });
      } catch {
        // Workspace dir absent (no CC history) — clear and bail.
        this.clearAll();
        return;
      }
      sessionIds = entries
        .filter(ent => ent.isDirectory() && isValidSessionId(ent.name))
        .map(ent => ent.name);
    } else {
      sessionIds = [...liveSessions];
    }

    const seen = new Set<string>();
    for (const sessionId of sessionIds) {
      const sidecarRunIds = await this.scanSidecars(sessionId, now, seen);
      await this.scanLiveRuns(sessionId, now, seen, sidecarRunIds);
    }

    // Prune snapshots whose sidecar/run dir vanished or aged out. A scoped
    // scan never visited the other sessions, so their runs must survive it.
    for (const [runId, snap] of [...this.snapshots]) {
      if (seen.has(runId)) { continue; }
      if (!fullWalk && !liveSessions.has(snap.sessionId)) { continue; }
      this.snapshots.delete(runId);
      this.mtimes.delete(runId);
      this.scriptMeta.delete(runId);
      this.liveRuns.delete(runId);
      this.scriptDirOverride.delete(runId);
      this.scriptFallbackAttemptedAt.delete(runId);
      this.pruneAgentStats(snap.sessionId, runId);
      this.changedSincePoll = true;
    }
  }

  /** Drop cached per-agent stats for a pruned run (the cache is keyed by
   *  transcript path, which lives under the run dir). */
  private pruneAgentStats(sessionId: string, runId: string): void {
    const prefix = path.join(this.wsDir, sessionId, 'subagents', 'workflows', runId) + path.sep;
    for (const key of [...this.agentStatsCache.keys()]) {
      if (key.startsWith(prefix)) { this.agentStatsCache.delete(key); }
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
      if (now - stat.mtimeMs > ageGateMsFor('workflows')) { continue; } // stale: let pruning drop it

      runIds.add(runId);
      seen.add(runId);

      if (stat.size > WorkflowDiscovery.SIDECAR_MAX_BYTES) {
        this.log.warn(`[workflows] Sidecar exceeds size cap, skipping: ${file}`);
        continue;
      }

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
      // The sidecar supersedes the live tier — drop the run's accumulator.
      this.liveRuns.delete(runId);
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
      if (now - stat.mtimeMs > ageGateMsFor('workflows')) { continue; }

      seen.add(runId);
      // Re-derive each cycle (the journal tail + cached correlations make it
      // cheap); the live snapshot is transient and is replaced by the sidecar
      // on completion. Only flag a change when the rebuilt snapshot actually
      // differs — otherwise an idle live run would churn the whole panel every
      // poll cycle (~500ms, since a running run holds the fast cadence).
      const snap = await this.buildLiveSnapshot(sessionId, runId, runDir, stat.mtimeMs);
      if (snap) {
        const state = this.liveRuns.get(runId);
        const sig = liveSnapshotSig(snap);
        if (!state || state.sig !== sig) {
          if (state) { state.sig = sig; }
          this.snapshots.set(runId, snap);
          this.changedSincePoll = true;
        }
        this.mtimes.set(runId, stat.mtimeMs);
      }
    }
  }

  /** Resolves the directory holding a run's script file: this workspace's own
   *  session dir first, falling back to a runId scan across every project dir
   *  (see findScriptDirByRunId) when the Workflow tool wrote the sidecar under
   *  a different cwd than the parent session's own workspace key. Returns null
   *  if the script isn't found anywhere yet — phase correlation degrades to a
   *  flat (ungrouped) roster in that case. */
  private async resolveScriptsDir(sessionId: string, runId: string): Promise<string | null> {
    const primary = path.join(this.wsDir, sessionId, 'workflows', 'scripts');
    try {
      const files = await fs.promises.readdir(primary);
      if (files.some(f => f.endsWith(`-${runId}.js`))) { return primary; }
    } catch { /* no scripts dir under this workspace key — try the fallback scan */ }
    return this.findScriptDirByRunId(sessionId, runId);
  }

  /** Scans every project dir's <sessionId>/workflows/scripts/ for a run's
   *  script, for the case where it landed under a workspace key other than
   *  this run's own parent session (observed cause: the Workflow tool call's
   *  cwd had drifted to a scratchpad dir when the sidecar was written). Caches
   *  a hit for the run's lifetime and throttles retries on a miss — it walks
   *  every project dir, so it must not run at the 500ms live-poll cadence. */
  private async findScriptDirByRunId(sessionId: string, runId: string): Promise<string | null> {
    const cached = this.scriptDirOverride.get(runId);
    if (cached) { return cached; }
    const lastAttempt = this.scriptFallbackAttemptedAt.get(runId) ?? 0;
    if (Date.now() - lastAttempt < WorkflowDiscovery.SCRIPT_FALLBACK_RETRY_MS) { return null; }
    this.scriptFallbackAttemptedAt.set(runId, Date.now());
    let wsKeys: string[];
    try {
      wsKeys = await fs.promises.readdir(this.projectsDir);
    } catch {
      return null;
    }
    for (const wsKey of wsKeys) {
      if (wsKey === this.workspaceKey) { continue; } // already tried by resolveScriptsDir
      const candidate = path.join(this.projectsDir, wsKey, sessionId, 'workflows', 'scripts');
      try {
        const files = await fs.promises.readdir(candidate);
        if (files.some(f => f.endsWith(`-${runId}.js`))) {
          this.scriptDirOverride.set(runId, candidate);
          return candidate;
        }
      } catch { /* no such dir under this wsKey — keep scanning */ }
    }
    return null;
  }

  private async buildLiveSnapshot(
    sessionId: string,
    runId: string,
    runDir: string,
    startTime: number,
  ): Promise<WorkflowSnapshot | null> {
    let state = this.liveRuns.get(runId);
    if (!state) {
      state = {
        tailer: new JsonlTailer(path.join(runDir, 'journal.jsonl')),
        started: new Map(),
        resolved: new Set(),
        corr: new Map(),
        sig: '',
      };
      this.liveRuns.set(runId, state);
    }

    // Name + phase scaffold from the (never-eval'd) script meta, if present.
    // Also pull the agent() call sites so each running agent can be correlated
    // back to the phase the script assigned it (best-effort; see below).
    // scriptV identifies the script version a correlation was computed against
    // (-1 = no script parsed yet), so cached correlations recompute exactly
    // once if the script appears or changes after they were cached.
    let name = runId;
    let phases: WorkflowSnapshot['phases'] = [];
    let agentCalls: WorkflowAgentCall[] = [];
    let scriptV = -1;
    const phaseIndexByTitle = new Map<string, number>();
    try {
      const scriptsDir = await this.resolveScriptsDir(sessionId, runId);
      const scriptFiles = scriptsDir ? await fs.promises.readdir(scriptsDir) : [];
      const scriptFile = scriptsDir ? scriptFiles.find(f => f.endsWith(`-${runId}.js`)) : undefined;
      if (scriptFile && scriptsDir) {
        const scriptPath = path.join(scriptsDir, scriptFile);
        const sstat = await fs.promises.stat(scriptPath);
        const cached = this.scriptMeta.get(runId);
        if (cached && cached.mtimeMs === sstat.mtimeMs) {
          ({ name, phases, agentCalls } = cached);
          scriptV = cached.mtimeMs;
        } else if (sstat.size > WorkflowDiscovery.SCRIPT_MAX_BYTES) {
          this.log.warn(`[workflows] Script exceeds size cap, skipping parse: ${scriptFile}`);
        } else {
          const src = await fs.promises.readFile(scriptPath, 'utf-8');
          const meta = extractWorkflowMeta(src);
          if (meta) {
            name = meta.name;
            phases = meta.phases.map((p, i) => ({ index: i + 1, title: p.title, detail: p.detail ?? '' }));
          }
          // Expand indirect prompts (the canonical `pipeline(ARR, d =>
          // agent(d.prompt, …))` shape) into matchable virtual calls — without
          // this, the most idiomatic Workflow scripts rendered every agent
          // ungrouped under a raw journal key.
          agentCalls = expandIndirectCalls(src, extractAgentCalls(src));
          // The script is immutable per run — cache on mtime so the live poll
          // stops re-reading and re-parsing it at 2Hz.
          this.scriptMeta.set(runId, { mtimeMs: sstat.mtimeMs, name, phases, agentCalls });
          scriptV = sstat.mtimeMs;
        }
        for (const p of phases) { phaseIndexByTitle.set(p.title, p.index); }
      }
    } catch {
      // no script yet — fall back to runId + no phases + no correlation
    }

    // Agents from the journal: started → running, result → done. The journal
    // is append-only, so only new bytes are read each cycle; the offset cap
    // preserves the bound the old whole-file read enforced (beyond it, no
    // further journal bytes are folded). A missing journal reads as empty →
    // phase-only scaffold. On truncation the tailer replays the whole file in
    // the same call, so the accumulators are cleared before folding.
    if (state.tailer.getOffset() < WorkflowDiscovery.JOURNAL_MAX_BYTES) {
      const records = await state.tailer.readNewRecords();
      if (state.tailer.truncated) {
        state.started.clear();
        state.resolved.clear();
      }
      for (const rec of records) {
        const r = rec as unknown as Record<string, unknown>;
        const agentId = typeof r.agentId === 'string' ? r.agentId : null;
        if (!agentId) { continue; }
        if (r.type === 'started' && !state.started.has(agentId)) {
          state.started.set(agentId, typeof r.key === 'string' ? r.key : '');
        } else if (r.type === 'result') {
          state.resolved.add(agentId);
        }
      }
    }

    const agents: WorkflowAgentSnapshot[] = [];
    const counts: Record<string, number> = {};
    // Run-level roll-up for the header chip. No completion sidecar exists yet,
    // so there is no runtime total on disk — sum the per-agent live stats as we
    // build the roster (matches the sidecar tier, which shows the same sum from
    // raw.totalTokens/totalToolCalls). Without this the header read "0 tokens ·
    // 0 tools" while every per-agent row showed real usage.
    let totalTokens = 0;
    let totalToolCalls = 0;
    for (const [agentId, key] of state.started) {
      const status = state.resolved.has(agentId) ? 'done' : 'running';
      counts[status] = (counts[status] ?? 0) + 1;

      // Correlate this agent back to its agent() call via its record-0 prompt,
      // so the live tier can group it under the right phase. The prompt is
      // immutable once written and the call sites are immutable per scriptV,
      // so the correlation is computed once and cached — not re-read from a
      // 256KB head window per agent per fast cycle (audit perf-io-1). A null
      // prompt (transcript not started yet) is not cached, so it retries.
      // The journal key (`v2:<sha>`) is an implementation detail and must
      // never reach the webview as a label — agent-distinct fallback instead.
      let label = `Agent · ${agentId.slice(0, 8)}`;
      let phaseIndex: number | null = null;
      let phaseTitle: string | null = null;
      let promptPreview = '';
      void key;
      if (isValidSessionId(agentId)) {
        let corr = state.corr.get(agentId);
        if (!corr || corr.scriptV !== scriptV) {
          const prompt = await this.readFirstRecordPrompt(path.join(runDir, `agent-${agentId}.jsonl`));
          if (prompt) {
            corr = correlateAgent(agentId, prompt, scriptV, agentCalls, phaseIndexByTitle);
            state.corr.set(agentId, corr);
          }
        }
        if (corr) {
          ({ label, phaseIndex, phaseTitle, promptPreview } = corr);
        }
      }
      const stats = await this.liveAgentStats(runDir, agentId, status);
      totalTokens += stats.tokens;
      totalToolCalls += stats.toolCalls;

      agents.push({
        agentId,
        label,
        phaseIndex,
        phaseTitle,
        model: stats.model,
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
      totalTokens,
      totalToolCalls,
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
  private agentStatsCache = new Map<string, { size: number; scannedAt: number; tokens: number; toolCalls: number; model: string }>();
  private static readonly STATS_RESCAN_MS = 5_000;

  private static readonly STATS_MAX_BYTES = 8 * 1024 * 1024;
  /** Untrusted-input caps for the other per-run reads (the codebase invariant
   *  is that every on-disk read path is size-capped — see teamDiscovery). The
   *  harness caps scripts at 512KB; sidecar is JSON we parse whole. The
   *  journal cap bounds the tailer's lifetime offset, not a single read —
   *  the tailer itself caps each cycle's read. */
  private static readonly SIDECAR_MAX_BYTES = 1024 * 1024;
  private static readonly SCRIPT_MAX_BYTES = 1024 * 1024;
  private static readonly JOURNAL_MAX_BYTES = 4 * 1024 * 1024;

  private async liveAgentStats(runDir: string, agentId: string, status: string): Promise<{ tokens: number; toolCalls: number; model: string }> {
    const filePath = path.join(runDir, `agent-${agentId}.jsonl`);
    const cached = this.agentStatsCache.get(filePath);
    try {
      const stat = await fs.promises.stat(filePath);
      if (cached && (cached.size === stat.size
        || (status === 'running' && Date.now() - cached.scannedAt < WorkflowDiscovery.STATS_RESCAN_MS))) {
        return cached;
      }
      if (stat.size > WorkflowDiscovery.STATS_MAX_BYTES) { return cached ?? { tokens: 0, toolCalls: 0, model: '' }; }
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      let tokens = 0;
      let toolCalls = 0;
      let model = '';
      for (const line of raw.split('\n')) {
        if (!line) { continue; }
        // Cheap pre-filters before JSON.parse — most lines carry neither.
        const hasUsage = line.includes('"output_tokens"');
        const hasTool = line.includes('"tool_use"');
        if (!hasUsage && !hasTool) { continue; }
        try {
          const rec = JSON.parse(line) as { message?: { model?: unknown; usage?: { output_tokens?: number }; content?: unknown } };
          const u = rec.message?.usage?.output_tokens;
          if (typeof u === 'number') { tokens += u; }
          // Assistant records carry the model alongside usage — the sidecar
          // materialises this at completion; the live tier reads it here.
          if (!model && typeof rec.message?.model === 'string') { model = rec.message.model; }
          const content = rec.message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') { toolCalls++; }
            }
          }
        } catch { /* malformed line — skip */ }
      }
      const entry = { size: stat.size, scannedAt: Date.now(), tokens, toolCalls, model };
      this.agentStatsCache.set(filePath, entry);
      return entry;
    } catch {
      return cached ?? { tokens: 0, toolCalls: 0, model: '' };
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
    this.scriptMeta.clear();
    this.liveRuns.clear();
    this.scriptDirOverride.clear();
    this.scriptFallbackAttemptedAt.clear();
    this.agentStatsCache.clear();
  }
}
