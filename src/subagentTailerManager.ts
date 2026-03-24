/**
 * Manages targeted JSONL tailers for silent subagents.
 *
 * Owns: silence timers, tailer lifecycle, file scanning, I/O polling.
 * Does NOT own: state mutations, permission timers, status transitions.
 *
 * SessionManager calls poll() each cycle and processes the returned records
 * using its existing record-processing logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import { JsonlTailer } from './jsonlTailer.js';
import type { SubagentInfo, JsonlRecord } from './types.js';

/** Silence threshold before opening a subagent tailer. If no agent_progress
 *  records arrive for a running subagent within this window, start tailing
 *  the subagent's own JSONL file directly. */
const SUBAGENT_SILENCE_MS = 8_000;
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
}

export class SubagentTailerManager {
  private activeTailerCount = 0;
  private readonly ctx: TailerContext;

  constructor(ctx: TailerContext) {
    this.ctx = ctx;
  }

  /** Number of active tailers (subagents being directly tailed). */
  getActiveTailerCount(): number {
    return this.activeTailerCount;
  }

  /** Start a silence timer for a subagent. If no agent_progress arrives
   *  within SUBAGENT_SILENCE_MS, open a targeted tailer for its JSONL. */
  startSilenceTimer(subagent: SubagentInfo): void {
    this.cancelSilenceTimer(subagent);
    subagent.silenceTimerId = setTimeout(() => {
      if (this.ctx.isDisposed()) { return; }
      subagent.silenceTimerId = undefined;
      if (!subagent.running) { return; }
      void this.openTailer(subagent);
    }, SUBAGENT_SILENCE_MS);
  }

  /** Cancel a subagent's silence timer. */
  cancelSilenceTimer(subagent: SubagentInfo): void {
    if (subagent.silenceTimerId) {
      clearTimeout(subagent.silenceTimerId);
      subagent.silenceTimerId = undefined;
    }
  }

  /** Cancel silence timer AND dispose tailer. Called when agent_progress
   *  arrives (subagent is no longer silent — progress relay is working). */
  cancelProgressSilence(subagent: SubagentInfo): void {
    this.cancelSilenceTimer(subagent);
    this.disposeTailer(subagent);
  }

  /** Poll all active subagent tailers and return their records grouped by subagent.
   *  Disposes tailers for subagents that are no longer running. */
  async poll(subagents: SubagentInfo[]): Promise<SubagentRecordBatch[]> {
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

  /** Dispose a single subagent's tailer (not the silence timer). */
  private disposeTailer(subagent: SubagentInfo): void {
    if (subagent.tailer) {
      subagent.tailer = null;
      this.activeTailerCount--;
    }
  }

  /** Dispose a subagent's tailer AND silence timer. */
  disposeTailerAndTimer(subagent: SubagentInfo): void {
    this.disposeTailer(subagent);
    this.cancelSilenceTimer(subagent);
  }

  /** Dispose all tailer resources for a subagent (tailer + silence timer + agentId).
   *  Called when a subagent completes or the session is disposed. */
  disposeSubagent(subagent: SubagentInfo): void {
    // Permission timer is owned by SessionManager — don't touch it here
    this.disposeTailer(subagent);
    this.cancelSilenceTimer(subagent);
    subagent.agentId = null;
  }

  /** Dispose all subagent tailers and timers. */
  disposeAll(subagents: SubagentInfo[]): void {
    for (const subagent of subagents) {
      this.disposeSubagent(subagent);
    }
    this.activeTailerCount = 0;
  }

  // ── Tailer lifecycle (file discovery) ──────────────────────────────

  /** Open a targeted tailer for a silent subagent's JSONL file.
   *  Locates the file via subagent.agentId or directory scan. */
  private async openTailer(subagent: SubagentInfo): Promise<void> {
    if (subagent.tailer) { return; }
    if (this.activeTailerCount >= MAX_SUBAGENT_TAILERS) { return; }

    const sessionDir = this.ctx.getSessionFilePath().replace(/\.jsonl$/, '');
    const subagentsDir = path.join(sessionDir, 'subagents');

    if (subagent.agentId) {
      const subagentFile = path.join(subagentsDir, `agent-${subagent.agentId}.jsonl`);
      try {
        await fs.promises.access(subagentFile);
        subagent.tailer = new JsonlTailer(subagentFile);
        this.activeTailerCount++;
      } catch {
        await this.scanForFile(subagent, subagentsDir);
      }
    } else {
      await this.scanForFile(subagent, subagentsDir);
    }
  }

  /** Scan subagents directory for JSONL files and try to match to a subagent.
   *  Falls back to opening the most recently modified file if only one unmatched.
   *  @param allSubagents All subagents in the session (for tailed-file dedup). */
  private async scanForFile(
    subagent: SubagentInfo,
    subagentsDir: string,
    allSubagents?: SubagentInfo[],
  ): Promise<void> {
    try {
      const allFiles = await fs.promises.readdir(subagentsDir);
      const files = allFiles.filter(f => f.endsWith('.jsonl') && f.startsWith('agent-'));

      // Filter out files already tailed by other subagents
      const tailedAgentIds = new Set<string>();
      const siblings = allSubagents ?? [subagent]; // fallback: only self (no dedup)
      for (const s of siblings) {
        if (s !== subagent && s.tailer) {
          const match = path.basename(s.tailer.getFilePath()).match(/^agent-(.+)\.jsonl$/);
          if (match) { tailedAgentIds.add(match[1]); }
        }
      }

      const unmatched = files.filter(f => {
        const match = f.match(/^agent-(.+)\.jsonl$/);
        return match && !tailedAgentIds.has(match[1]);
      });

      if (unmatched.length === 1) {
        const filePath = path.join(subagentsDir, unmatched[0]);
        subagent.tailer = new JsonlTailer(filePath);
        this.activeTailerCount++;
        const match = unmatched[0].match(/^agent-(.+)\.jsonl$/);
        if (match) { subagent.agentId = match[1]; }
      }
    } catch {
      // Directory doesn't exist or isn't readable
    }
  }
}
