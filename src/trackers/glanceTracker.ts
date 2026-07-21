/**
 * GlanceTracker — owns the display-only "glance pack" slice: topic, git
 * branch, tracked files, tool-error count, and the last-assistant-text
 * preview. Everything here enriches the card; nothing here affects status.
 *
 *   - `topic` is sticky — extracted once from the first user message with
 *     usable text, then preserved across truncation resets (compaction
 *     rewrites the JSONL; clearing topic made the display name fall back
 *     to the compacted summary text).
 *   - `gitBranch` mirrors the latest `gitBranch` from any JSONL record.
 *   - `trackedFiles` is latest-wins from `file-history-snapshot` records
 *     (feeds the cross-session same-file collision badge).
 *   - `toolErrorCount` counts `tool_result` blocks with `is_error`.
 *   - `lastAssistantText` is the done-card preview (see
 *     extractAssistantPreview below).
 *
 * No host needs: derives entirely from the JSONL stream. All fields except
 * topic clear on reset() — glance enrichment rebuilds from the replayed
 * records, so stale values must not survive a truncation they may no longer
 * be true of.
 */

import type { JsonlRecord, SessionSnapshot } from '../types.js';
import { getContentBlocks } from '../jsonlValidator.js';

/** Cap on tracked-file paths kept from a file-history-snapshot record. */
const MAX_TRACKED_FILES = 200;

/** Topic extraction patterns [A3]:
 *  HANDOFF_PATTERN — matches "HANDOFF-PROMPT: <title>" or "HANDOFF-PROMPT <title>"
 *  CONTINUE_PATTERN — matches "Continuing: /path/to/project" from /continue prompts */
const HANDOFF_PATTERN = /^HANDOFF-PROMPT[:\s]*(.+)/m;
const CONTINUE_PATTERN = /^Continuing:\s*\/.*$/;

/** Extract a coherent one-line preview from an assistant text block for the
 *  done/stale card. Takes the first non-empty prose line — skipping markdown
 *  headings, bold-only "heading" lines, and horizontal rules — then trims to
 *  the first genuine sentence boundary if one sits comfortably under the cap.
 *  Faithful: it only selects a boundary, never rewrites or summarises.
 *
 *  Fixes the blind-slice bug where `text.slice(0, 200)` ran the opening prose
 *  straight into a trailing "Status" / "**Done this session**" heading, so the
 *  card read as running and done at once. Returns '' for an all-headings/rules
 *  message so the caller keeps the prior preview instead of clobbering it. */
export function extractAssistantPreview(text: string, cap = 200): string {
  const isSkippable = (line: string): boolean =>
    /^#{1,6}\s/.test(line)                        // markdown heading
    || /^(\*\*.+\*\*|__.+__):?\s*$/.test(line)    // bold-only "heading" line
    || /^[-*_]{3,}$/.test(line);                  // horizontal rule
  let chosen = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || isSkippable(line)) { continue; }
    chosen = line;
    break;
  }
  if (!chosen) { return ''; }
  // Strip a leading list marker so a bulleted reply reads cleanly.
  chosen = chosen.replace(/^([-*+]|\d+[.)])\s+/, '');
  // Stop at the first real sentence end — punctuation followed by a space and
  // a capital, or end of line — but only past a small floor, so "e.g." and
  // "config.json" don't truncate the thought mid-sentence.
  const m = chosen.match(/[.!?](?=\s+[A-Z]|\s*$)/);
  if (m && m.index !== undefined && m.index >= 40 && m.index + 1 <= cap) {
    chosen = chosen.slice(0, m.index + 1);
  }
  return chosen.slice(0, cap).trim();
}

/** The glance pack's contribution to a SessionSnapshot. Empty values are
 *  omitted (undefined) so the webview renders nothing rather than blanks. */
export type GlanceSnapshotFields = Pick<
  SessionSnapshot,
  'gitBranch' | 'toolErrorCount' | 'lastAssistantText' | 'trackedFiles'
>;

export interface GlanceTracker {
  /** Capture the branch stamped on any JSONL record. Suppresses the literal
   *  "HEAD" (non-git workspaces and detached HEAD — differentiates nothing);
   *  a real branch name overwrites as usual. */
  onGitBranch(branch: unknown): void;
  /** Extract the sticky topic from a main-thread user record (first record
   *  with usable text wins). No-op once a topic is set. */
  onUserRecord(record: JsonlRecord): void;
  /** Count an errored tool_result block. */
  onToolError(): void;
  /** Update the done-card preview from an assistant text block. Keeps the
   *  prior preview when the block is all headings/rules. */
  onAssistantText(text: string): void;
  /** Latest-wins capture of the tracked file set from a
   *  file-history-snapshot record (written by Claude Code as it backs up
   *  files it edits; keys are paths). Returns true when the set changed. */
  onFileHistorySnapshot(record: JsonlRecord): boolean;
  /** The sticky topic ('' until extracted). */
  getTopic(): string;
  /** Snapshot contribution; empty values omitted. */
  snapshotFields(): GlanceSnapshotFields;
  /** Truncation reset: clears everything EXCEPT topic (see module doc). */
  reset(): void;
  /** Stop the tracker. Idempotent. */
  dispose(): void;
}

class JsonlDerivedGlanceTracker implements GlanceTracker {
  private topic = '';
  private gitBranch = '';
  private trackedFiles: string[] = [];
  private toolErrorCount = 0;
  private lastAssistantText = '';

  onGitBranch(branch: unknown): void {
    if (typeof branch === 'string' && branch && branch !== 'HEAD') {
      this.gitBranch = branch;
    }
  }

  onUserRecord(record: JsonlRecord): void {
    if (this.topic) { return; }
    for (const block of getContentBlocks(record)) {
      if (block.type === 'text' && block.text) {
        // Skip system injections and path-style prompts
        const text = block.text.trim();
        if (text.startsWith('<') || text.startsWith('HANDOFF-PROMPT')) {
          // Use first line after any prefix for HANDOFF-PROMPT
          if (text.startsWith('HANDOFF-PROMPT')) {
            const match = text.match(HANDOFF_PATTERN);
            if (match) {
              this.topic = match[1].trim().slice(0, 60);
              break;
            }
          }
          continue;
        }
        // Take first line, up to 60 chars
        const firstLine = text.split('\n')[0].trim();
        if (firstLine.length > 0) {
          // Strip leading "Continuing: " prefix from /continue prompts
          let topic = firstLine;
          const continueMatch = topic.match(CONTINUE_PATTERN);
          if (continueMatch) {
            // Extract just the project folder name from the path
            const pathParts = topic.split('/').filter(Boolean);
            const folder = pathParts[pathParts.length - 1] || '';
            topic = folder ? `Continuing: ${folder}` : 'Continuing session';
          }
          this.topic = topic.slice(0, 60);
          break;
        }
      }
    }
  }

  onToolError(): void {
    this.toolErrorCount++;
  }

  onAssistantText(text: string): void {
    const preview = extractAssistantPreview(text);
    if (preview) { this.lastAssistantText = preview; }
  }

  onFileHistorySnapshot(record: JsonlRecord): boolean {
    const snap = (record as { snapshot?: { trackedFileBackups?: unknown } }).snapshot;
    const backups = snap?.trackedFileBackups;
    if (!backups || typeof backups !== 'object' || Array.isArray(backups)) { return false; }
    const files = Object.keys(backups).filter(k => k.length > 0).slice(0, MAX_TRACKED_FILES);
    const changed = files.length !== this.trackedFiles.length
      || files.some((f, i) => f !== this.trackedFiles[i]);
    this.trackedFiles = files;
    return changed;
  }

  getTopic(): string {
    return this.topic;
  }

  snapshotFields(): GlanceSnapshotFields {
    return {
      gitBranch: this.gitBranch || undefined,
      toolErrorCount: this.toolErrorCount || undefined,
      lastAssistantText: this.lastAssistantText || undefined,
      trackedFiles: this.trackedFiles.length > 0 ? this.trackedFiles : undefined,
    };
  }

  reset(): void {
    // topic survives — see module doc (compaction lands as a truncation)
    this.gitBranch = '';
    this.trackedFiles = [];
    this.toolErrorCount = 0;
    this.lastAssistantText = '';
  }

  dispose(): void { /* no resources */ }
}

/** Factory. Today's variant is JSONL-derived only; a hook variant would
 *  compose the same way as HookCwdTracker (see cwdTracker.ts). */
export function makeGlanceTracker(): GlanceTracker {
  return new JsonlDerivedGlanceTracker();
}
