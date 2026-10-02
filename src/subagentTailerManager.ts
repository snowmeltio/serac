/**
 * Manages targeted JSONL tailers for subagents' own transcripts.
 *
 * Owns: tailer lifecycle, file pairing, I/O polling.
 * Does NOT own: state mutations, permission timers, status transitions.
 *
 * SessionManager calls poll() each cycle: it opens a tailer for any running
 * subagent that lacks one (no delay — the agent_progress relay this used to
 * wait 8 s for has not appeared in a parent JSONL since mid-2026), then reads
 * every open tailer. The returned records go through SessionManager's
 * existing record-processing logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sessionDirFromJsonl, subagentsDirFor, subagentJsonlPath, subagentMetaPath } from './paths.js';
import { JsonlTailer } from './jsonlTailer.js';
import type { SubagentInfo, JsonlRecord } from './types.js';

/** Maximum concurrent subagent tailers to limit file descriptor usage. */
const MAX_SUBAGENT_TAILERS = 10;

/** Records read from a subagent's JSONL file, grouped by subagent. */
export interface SubagentRecordBatch {
  subagent: SubagentInfo;
  records: JsonlRecord[];
}

/** Read-only context needed from the parent session. */
export interface TailerContext {
  /** Whether the parent session has been disposed. */
  isDisposed(): boolean;
  /** Path to the parent session's JSONL file (used to derive subagents directory). */
  getSessionFilePath(): string;
  /** All subagents currently tracked on the parent session.
   *  Used by scanForFile dedup to avoid attaching the same JSONL to two subagents
   *  when multiple are silent simultaneously. */
  getAllSubagents(): SubagentInfo[];
}

export class SubagentTailerManager {
  private activeTailerCount = 0;
  private readonly ctx: TailerContext;
  /** Subagents with an open in flight, so an overlapping poll can't open a
   *  second tailer for the same one. */
  private readonly opening = new Set<SubagentInfo>();
  /** Positive meta.json reads only (file name → spawning toolUseId). A miss
   *  isn't cached: the CLI may write the meta a moment after the transcript. */
  private readonly metaToolUseIds = new Map<string, string>();

  constructor(ctx: TailerContext) {
    this.ctx = ctx;
  }

  /** Number of active tailers (subagents being directly tailed). */
  getActiveTailerCount(): number {
    return this.activeTailerCount;
  }

  /** agent_progress arrived: the legacy relay feeds this subagent's records,
   *  so stop tailing its file (both would count the same tools). */
  suppressForProgressRelay(subagent: SubagentInfo): void {
    subagent.progressRelayed = true;
    this.disposeTailer(subagent);
  }

  /** Whether poll() has work: an open tailer to read, or a running subagent
   *  still waiting for its tailer. */
  needsPoll(subagents: SubagentInfo[]): boolean {
    return this.activeTailerCount > 0 || subagents.some(s => this.wantsTailer(s));
  }

  private wantsTailer(subagent: SubagentInfo): boolean {
    return subagent.running && !subagent.tailer && !subagent.progressRelayed;
  }

  /** Open a tailer for each running subagent that lacks one (in spawn order,
   *  so the birthtime fallback in scanForFile pairs parallel spawns stably),
   *  then poll every open tailer and return the records grouped by subagent.
   *  Disposes tailers for subagents that are no longer running. */
  async poll(subagents: SubagentInfo[]): Promise<SubagentRecordBatch[]> {
    for (const subagent of subagents) {
      if (this.activeTailerCount >= MAX_SUBAGENT_TAILERS) { break; }
      if (!this.wantsTailer(subagent) || this.opening.has(subagent)) { continue; }
      this.opening.add(subagent);
      try {
        await this.openTailer(subagent);
      } finally {
        this.opening.delete(subagent);
      }
      if (this.ctx.isDisposed()) { return []; }
    }

    const batches: SubagentRecordBatch[] = [];

    for (const subagent of subagents) {
      if (!subagent.tailer) { continue; }
      if (!subagent.running) {
        this.disposeTailer(subagent);
        continue;
      }

      const records = await subagent.tailer.readNewRecords();
      if (records.length > 0) {
        batches.push({ subagent, records });
      }
    }

    return batches;
  }

  /** Reopen a tailer for a REVIVED subagent (completed, then addressed again
   *  via SendMessage / Agent({resume}) / the growth backstop). Unlike a fresh
   *  open this is exact: the file is at its known path, and the
   *  offset is the completion watermark (`completedFileSize`), never 0 — a
   *  byte-0 reopen would replay the agent's whole history, double-counting
   *  `toolsCompleted` and repopulating long-resolved `activeTools`.
   *
   *  `preopened` (backstop path): the sweep already read the delta through
   *  its own JsonlTailer, so that instance is adopted as-is, no stat.
   *
   *  Otherwise the file is stat'ed and the tailer opened at `offset ?? size`.
   *  After the await the caller state is re-checked — disposed, no longer
   *  running, cap, AND `revivalCount` unchanged: two revivals landing in one
   *  record batch each get here, and the stale one must not assign a second
   *  tailer (it would leak `activeTailerCount` and starve the cap).
   *
   *  Cap hit: the row stays `running` with no tool counts; the next
   *  task-notification still completes it. */
  async reopenTailerAt(subagent: SubagentInfo, offset: number | null, preopened?: JsonlTailer): Promise<void> {
    this.disposeTailer(subagent);
    subagent.progressRelayed = false;
    // No agentId: nothing exact to reopen; poll() pairs and opens it.
    if (!subagent.agentId) { return; }
    if (this.activeTailerCount >= MAX_SUBAGENT_TAILERS) { return; }
    if (preopened) {
      subagent.tailer = preopened;
      this.activeTailerCount++;
      return;
    }
    const gen = subagent.revivalCount;
    const file = subagentJsonlPath(sessionDirFromJsonl(this.ctx.getSessionFilePath()), subagent.agentId);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return; // file gone — nothing to tail; the notification path still completes it
    }
    if (this.ctx.isDisposed() || !subagent.running) { return; }
    if (subagent.revivalCount !== gen) { return; } // a newer revival owns the tailer now
    if (this.activeTailerCount >= MAX_SUBAGENT_TAILERS) { return; }
    this.disposeTailer(subagent);
    const tailer = new JsonlTailer(file, offset ?? stat.size);
    tailer.lastSize = stat.size;
    tailer.lastMtimeMs = stat.mtimeMs;
    subagent.tailer = tailer;
    this.activeTailerCount++;
  }

  /** Dispose a single subagent's tailer. */
  disposeTailer(subagent: SubagentInfo): void {
    if (subagent.tailer) {
      subagent.tailer = null;
      this.activeTailerCount--;
    }
  }

  /** Dispose all tailer resources for a subagent (tailer + agentId).
   *  Called when the session is disposed. */
  disposeSubagent(subagent: SubagentInfo): void {
    // Permission timer is owned by SessionManager — don't touch it here
    this.disposeTailer(subagent);
    subagent.agentId = null;
  }

  /** Dispose all subagent tailers. */
  disposeAll(subagents: SubagentInfo[]): void {
    for (const subagent of subagents) {
      this.disposeSubagent(subagent);
    }
    this.activeTailerCount = 0;
  }

  // ── Tailer lifecycle (file discovery) ──────────────────────────────

  /** Open a targeted tailer for a subagent's own JSONL file.
   *  Locates the file via subagent.agentId or directory scan. */
  private async openTailer(subagent: SubagentInfo): Promise<void> {
    if (subagent.tailer) { return; }
    if (this.activeTailerCount >= MAX_SUBAGENT_TAILERS) { return; }

    const sessionDir = sessionDirFromJsonl(this.ctx.getSessionFilePath());
    const subagentsDir = subagentsDirFor(sessionDir);
    const siblings = this.ctx.getAllSubagents();

    if (subagent.agentId) {
      const subagentFile = subagentJsonlPath(sessionDir, subagent.agentId);
      try {
        await fs.promises.access(subagentFile);
        // Re-check after the await: the cap (an overlapping revival reopen
        // can take a slot), and that nothing else gave this subagent a tailer.
        if (this.activeTailerCount >= MAX_SUBAGENT_TAILERS || subagent.tailer) { return; }
        subagent.tailer = new JsonlTailer(subagentFile);
        this.activeTailerCount++;
      } catch {
        // Known agentId but its file isn't on disk yet. Do NOT scan —
        // scanForFile would claim an arbitrary unmatched file and overwrite the
        // known agentId, mispairing this subagent with another's transcript.
        // The file appears at its known path and is picked up on a later cycle.
      }
    } else {
      await this.scanForFile(subagent, subagentsDir, siblings);
    }
  }

  /** Pair a subagent with its transcript by scanning the subagents
   *  directory, then open a tailer on it. The CLI's `agent-<id>.meta.json`
   *  carries the spawning `toolUseId`, so the file whose meta names this
   *  subagent's `parentToolUseId` is an exact match (244/244 in the
   *  2026-10-02 census). A file whose meta names a different tool_use belongs
   *  to another agent — a sibling, or a nested agent spawned from inside one
   *  — and is never claimed. When no meta matches, a directory where any
   *  unclaimed file has a meta is from a meta-writing CLI, so this agent's
   *  file just isn't there yet: wait for a later poll. Only a wholly meta-less
   *  directory (CLIs that predate the meta) falls back to the old heuristic:
   *  the oldest file by birthtime, relying on spawn-order polling.
   *  @param allSubagents All subagents in the session (for claimed-file dedup). */
  private async scanForFile(
    subagent: SubagentInfo,
    subagentsDir: string,
    allSubagents?: SubagentInfo[],
  ): Promise<void> {
    try {
      const allFiles = await fs.promises.readdir(subagentsDir);
      const files = allFiles.filter(f => f.endsWith('.jsonl') && f.startsWith('agent-'));

      // Filter out files already claimed by other subagents — not just those
      // with an OPEN tailer: a sibling whose agentId came via agent_progress
      // relay (never needed a tailer) and a sibling completed in an earlier
      // turn (tailer disposed, file still on disk) both own their transcript.
      const tailedAgentIds = new Set<string>();
      const siblings = allSubagents ?? [subagent]; // fallback: only self (no dedup)
      for (const s of siblings) {
        if (s === subagent) { continue; }
        if (s.agentId) { tailedAgentIds.add(s.agentId); }
        if (s.tailer) {
          const match = path.basename(s.tailer.getFilePath()).match(/^agent-(.+)\.jsonl$/);
          if (match) { tailedAgentIds.add(match[1]); }
        }
      }

      const unmatched = files.filter(f => {
        const match = f.match(/^agent-(.+)\.jsonl$/);
        return match && !tailedAgentIds.has(match[1]);
      });

      if (unmatched.length === 0) { return; }

      const metas = await Promise.all(unmatched.map(async f => ({ name: f, toolUseId: await this.readMetaToolUseId(subagentsDir, f) })));
      let chosen = metas.find(m => m.toolUseId === subagent.parentToolUseId)?.name;
      if (!chosen) {
        if (metas.some(m => m.toolUseId !== null)) { return; } // own file not written yet
        const metaless = metas.map(m => m.name);
        // Oldest meta-less file by birthtime (creation), falling back to mtime.
        const stats = await Promise.all(
          metaless.map(async f => {
            try {
              const stat = await fs.promises.stat(path.join(subagentsDir, f));
              const ts = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
              return { name: f, ts };
            } catch {
              return { name: f, ts: Number.MAX_SAFE_INTEGER };
            }
          }),
        );
        stats.sort((a, b) => a.ts - b.ts);
        chosen = stats[0].name;
      }

      // Re-check after the awaits above (readdir/stat/meta reads).
      if (this.activeTailerCount >= MAX_SUBAGENT_TAILERS || subagent.tailer) { return; }
      const filePath = path.join(subagentsDir, chosen);
      subagent.tailer = new JsonlTailer(filePath);
      this.activeTailerCount++;
      const match = chosen.match(/^agent-(.+)\.jsonl$/);
      // Only adopt the scanned file's id when we don't already have one — a
      // known agentId must never be overwritten by a directory guess.
      if (match && !subagent.agentId) { subagent.agentId = match[1]; }
    } catch {
      // Directory doesn't exist or isn't readable
    }
  }

  /** The spawning toolUseId from `agent-<id>.meta.json`, or null when the
   *  meta is absent, unreadable, or carries none. */
  private async readMetaToolUseId(subagentsDir: string, jsonlName: string): Promise<string | null> {
    const cached = this.metaToolUseIds.get(jsonlName);
    if (cached) { return cached; }
    const agentId = jsonlName.match(/^agent-(.+)\.jsonl$/)?.[1];
    if (!agentId) { return null; }
    try {
      const raw = await fs.promises.readFile(subagentMetaPath(path.dirname(subagentsDir), agentId), 'utf-8');
      const toolUseId = (JSON.parse(raw) as { toolUseId?: unknown }).toolUseId;
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) { return null; }
      this.metaToolUseIds.set(jsonlName, toolUseId);
      return toolUseId;
    } catch {
      return null;
    }
  }
}
