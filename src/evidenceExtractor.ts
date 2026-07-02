/**
 * Pure extraction of host-computed "evidence" from an already-parsed JSONL
 * record stream: files touched, commands run, whether a test runner was
 * invoked, and the agent's own final message. Feeds Phase 3's Result strip
 * (DESIGN-DETAIL-PANE-V2.md), the anti-fabrication device that cross-checks
 * an agent's prose against its actual tool calls rather than trusting it.
 *
 * No fs, no vscode imports: operates entirely over `JsonlRecord[]` that the
 * caller has already read and validated (jsonlValidator.ts). Never throws:
 * a malformed or partial record is skipped, not fatal to the whole extract.
 *
 * ## Bash exit-status representation on disk (verified against real
 * transcripts under ~/.claude/projects/, not guessed)
 *
 * A Bash `tool_use` block pairs with a later `tool_result` block in a
 * `user`-role record, matched by `tool_use_id` === the tool_use's `id`.
 * There is no separate "exit code" field on the tool_result block; Claude
 * Code represents success/failure two ways, both observed:
 *
 *   1. `is_error: boolean` on the tool_result content block itself. This is
 *      the reliable, structured signal (`false` on success, `true` on
 *      failure), and is what this module keys off.
 *   2. On failure, the result's free-text `content` commonly (not always)
 *      *starts* with a human-readable `"Exit code N\n..."` line, e.g.:
 *      `{"type":"tool_result","tool_use_id":"toolu_...","content":"Exit code 1\nfatal: not a git repository (or any of the parent directories): .git","is_error":true}`
 *      This is prose, not a structured field, and isn't parsed here; it's
 *      exactly the kind of confident-looking text the mismatch flag this
 *      module feeds is meant to check *against* structured evidence, not
 *      trust directly.
 *
 * `exitOk` is therefore derived solely from `is_error`: `true` when
 * `is_error === false`, `false` when `is_error === true`, and `null` when
 * the tool_result is missing (denied, transcript truncated, run abandoned)
 * or its `is_error` field isn't a boolean (ambiguous).
 */

import { getToolUseBlocks, getToolResultBlocks, getTextBlocks } from './jsonlValidator.js';
import type { JsonlRecord } from './types.js';

/** One file touched by an Edit/Write/NotebookEdit tool call, deduped by
 *  path across the whole record stream. `kind` reflects the most recent
 *  touch to that path; `approxAdded`/`approxRemoved` sum across all touches. */
export interface FileTouch {
  path: string;
  kind: 'edit' | 'write' | 'notebook';
  /** Approximate lines added, or null when it can't be estimated (e.g. a
   *  NotebookEdit delete with no new_source). Not a real diff; see the
   *  per-kind estimation notes on {@link fileTouchFromToolUse}. */
  approxAdded: number | null;
  /** Approximate lines removed, or null when the tool call carries no prior
   *  content to compare against (Write, NotebookEdit). */
  approxRemoved: number | null;
}

/** One Bash invocation paired with its result, in first-seen order. */
export interface CommandRun {
  command: string;
  /** true = is_error:false, false = is_error:true, null = no matching
   *  tool_result was found, or its is_error field was missing/non-boolean. */
  exitOk: boolean | null;
}

export interface Evidence {
  filesTouched: FileTouch[];
  commandsRun: CommandRun[];
  /** True when any command in commandsRun matches a known test-runner
   *  pattern (see {@link TEST_RUNNER_PATTERNS}), regardless of exitOk. */
  testsRun: boolean;
  /** Last assistant text in the record stream, untruncated (64KB cap).
   *  Null when the stream has no assistant text at all. */
  finalMessage: string | null;
}

/** Sanity cap (UTF-16 code units, not byte-exact) for finalMessage, guarding
 *  against a pathological single message dominating the payload. Mirrors
 *  transcriptRenderer.ts's MAX_RAW_FIELD_CHARS; kept as its own constant
 *  since this module must stay independent (no shared import surface with
 *  the webview-bundled transcriptRenderer.ts). */
const MAX_FINAL_MESSAGE_CHARS = 65536;

/** Known test-runner invocations, matched against a Bash command string.
 *  Exported so Phase 3's Result strip can show which runner was recognised
 *  (or offer this list as the "known runners" reference when none matched). */
export const TEST_RUNNER_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'npm test', pattern: /\bnpm\s+(run\s+)?test\b/i },
  { label: 'vitest', pattern: /\bvitest\b/i },
  { label: 'jest', pattern: /\bjest\b/i },
  { label: 'pytest', pattern: /\bpytest\b/i },
  { label: 'go test', pattern: /\bgo\s+test\b/i },
  { label: 'cargo test', pattern: /\bcargo\s+test\b/i },
];

function isTestCommand(command: string): boolean {
  return TEST_RUNNER_PATTERNS.some(p => p.pattern.test(command));
}

function capFinalMessage(s: string): string {
  return s.length > MAX_FINAL_MESSAGE_CHARS ? s.slice(0, MAX_FINAL_MESSAGE_CHARS) : s;
}

/** Count "lines" in a tool-call string field the same rough way an editor
 *  status bar would: empty string is 0 lines, otherwise split-on-newline
 *  length. This is an approximation (no real diff/LCS), which is why the
 *  FileTouch fields are named approxAdded/approxRemoved. */
function countLines(s: string): number {
  return s === '' ? 0 : s.split('\n').length;
}

/** Derive one FileTouch from a single Edit/Write/NotebookEdit tool_use
 *  block's input, or null when the input doesn't carry a usable path.
 *
 *  - Edit: approxRemoved/approxAdded are the gross line counts of
 *    old_string/new_string, a whole-block estimate, not a line-level diff.
 *  - Write: the whole file content is new from this tool's point of view
 *    (it may be overwriting an existing file, but the tool_use input alone
 *    doesn't carry the prior content), so approxAdded counts content's
 *    lines and approxRemoved is null (genuinely unknown here).
 *  - NotebookEdit: same reasoning as Write for the cell's new_source; a
 *    delete edit_mode has no new_source to count, so approxAdded is null
 *    too in that case. approxRemoved is always null (no prior cell content
 *    available in the tool_use input). */
function fileTouchFromToolUse(name: string, input: Record<string, unknown> | undefined): FileTouch | null {
  if (!input) return null;

  if (name === 'Edit') {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    if (!path) return null;
    const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
    const newStr = typeof input.new_string === 'string' ? input.new_string : '';
    return { path, kind: 'edit', approxAdded: countLines(newStr), approxRemoved: countLines(oldStr) };
  }

  if (name === 'Write') {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    if (!path) return null;
    const content = typeof input.content === 'string' ? input.content : '';
    return { path, kind: 'write', approxAdded: countLines(content), approxRemoved: null };
  }

  if (name === 'NotebookEdit') {
    const path = typeof input.notebook_path === 'string' ? input.notebook_path : '';
    if (!path) return null;
    const newSource = typeof input.new_source === 'string' ? input.new_source : null;
    return {
      path,
      kind: 'notebook',
      approxAdded: newSource !== null ? countLines(newSource) : null,
      approxRemoved: null,
    };
  }

  return null;
}

/** Extract Evidence from an ordered record stream (record-0 first). Never
 *  throws: any per-record failure is caught and that record is skipped,
 *  the rest of the extract still runs. */
export function extractEvidence(records: JsonlRecord[]): Evidence {
  const filesByPath = new Map<string, FileTouch>();
  const commandsRun: CommandRun[] = [];
  const bashIndexByToolUseId = new Map<string, number>();
  let finalMessage: string | null = null;

  if (!Array.isArray(records)) {
    return { filesTouched: [], commandsRun: [], testsRun: false, finalMessage: null };
  }

  for (const record of records) {
    if (!record || typeof record !== 'object') { continue; }

    try {
      if (record.type === 'assistant') {
        for (const block of getToolUseBlocks(record)) {
          const name = block.name || '';
          const input = block.input as Record<string, unknown> | undefined;

          if (name === 'Bash') {
            const command = typeof input?.command === 'string' ? input.command : '';
            const idx = commandsRun.length;
            commandsRun.push({ command, exitOk: null });
            if (block.id) { bashIndexByToolUseId.set(block.id, idx); }
            continue;
          }

          const touch = fileTouchFromToolUse(name, input);
          if (touch) {
            const existing = filesByPath.get(touch.path);
            if (!existing) {
              filesByPath.set(touch.path, touch);
            } else {
              filesByPath.set(touch.path, {
                path: touch.path,
                kind: touch.kind, // most recent touch's kind wins
                approxAdded: sumApprox(existing.approxAdded, touch.approxAdded),
                approxRemoved: sumApprox(existing.approxRemoved, touch.approxRemoved),
              });
            }
          }
        }

        // Track the last assistant text seen anywhere in the stream. A
        // record's own text blocks are joined so a record that interleaves
        // text and tool_use (rare, parallel tool calls) still yields its
        // full prose, not just the first fragment.
        const textBlocks = getTextBlocks(record);
        if (textBlocks.length > 0) {
          const joined = textBlocks.map(b => (b.text || '').trim()).filter(Boolean).join('\n\n');
          if (joined) { finalMessage = joined; }
        }
      } else if (record.type === 'user') {
        for (const block of getToolResultBlocks(record)) {
          const toolUseId = block.tool_use_id || '';
          const idx = bashIndexByToolUseId.get(toolUseId);
          if (idx === undefined) { continue; }
          if (typeof block.is_error === 'boolean') {
            commandsRun[idx].exitOk = !block.is_error;
          }
          // Missing/non-boolean is_error: leave exitOk at its null default
          // (ambiguous, matches the doc comment on CommandRun.exitOk).
        }
      }
    } catch {
      // Malformed/partial record: skip it, keep going.
      continue;
    }
  }

  const testsRun = commandsRun.some(c => isTestCommand(c.command));
  const capped = finalMessage !== null ? capFinalMessage(finalMessage) : null;

  return {
    filesTouched: Array.from(filesByPath.values()),
    commandsRun,
    testsRun,
    finalMessage: capped,
  };
}

function sumApprox(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
