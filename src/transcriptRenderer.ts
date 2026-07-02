import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { validateRecord, getContentBlocks, getToolUseBlocks, getToolResultBlocks } from './jsonlValidator.js';
import type { JsonlRecord, JsonlContentBlock } from './types.js';

import type { TranscriptEntry } from './detailShared.js';
export type { TranscriptEntry };

/**
 * Renders a JSONL session file into a readable markdown transcript.
 * Writes to .claude/transcripts/{sessionId}.md within the workspace.
 */
export async function renderTranscript(
  jsonlPath: string,
  sessionId: string,
  workspacePath: string,
): Promise<string> {
  const entries = await parseTranscript(jsonlPath);
  const markdown = formatMarkdown(entries, sessionId);

  const transcriptsDir = path.join(workspacePath, '.claude', 'transcripts');
  await fs.promises.mkdir(transcriptsDir, { recursive: true });

  const outputPath = path.join(transcriptsDir, `${sessionId}.md`);
  await fs.promises.writeFile(outputPath, markdown, 'utf-8');
  return outputPath;
}

/** Parse a JSONL session/agent transcript into renderable entries.
 *  Shared by the markdown writer ({@link renderTranscript}) and the workflow
 *  detail-panel reader (which formats the entries as webview HTML). */
export async function parseTranscript(filePath: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  // Per-file tool_use id → name correlation (Phase 2.1): records are read in
  // order, so an assistant tool_use always precedes its tool_result — the map
  // fills as the loop advances and names the results after it. File-scoped.
  const toolNames = new Map<string, string>();
  let raw: string;
  const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50MB cap [H4]

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      // Read only the last 50MB of very large transcripts
      const fh = await fs.promises.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
        await fh.read(buf, 0, MAX_TRANSCRIPT_BYTES, stat.size - MAX_TRANSCRIPT_BYTES);
        raw = buf.toString('utf-8');
        // Drop the first (likely partial) line
        const firstNewline = raw.indexOf('\n');
        if (firstNewline > 0) { raw = raw.slice(firstNewline + 1); }
      } finally {
        await fh.close();
      }
    } else {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    }
  } catch {
    return entries;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) { continue; }

    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const record = validateRecord(parsed);
    if (!record) { continue; }

    const entry = entryFromRecord(record, toolNames);
    if (entry) { entries.push(entry); }
  }

  return entries;
}

/** Sanity cap for the new Phase-1 raw fields (rawInput/rawOutput): 64KB,
 *  measured in UTF-16 code units (not a byte-exact limit). Guards against a
 *  pathological single tool input/output blob bloating the transcript
 *  payload sent to the webview; ordinary tool calls are far below this. */
const MAX_RAW_FIELD_CHARS = 65536;

function capRawField(s: string): string {
  return s.length > MAX_RAW_FIELD_CHARS ? s.slice(0, MAX_RAW_FIELD_CHARS) : s;
}

/** Map one validated JSONL record to a renderable entry (or null for record
 *  types the transcript doesn't show). Shared by the whole-file parser above
 *  and the incremental live-viewer path (detailPanel + JsonlTailer), so the
 *  two can never drift on what a turn looks like.
 *
 *  Populates the Phase-1 log-view fields (kind/toolName/rawInput/rawOutput/
 *  isError, see detailShared.ts) alongside the untouched `content`/`role`
 *  the v1 chat renderer and markdown exporter depend on. This stays a
 *  one-entry-per-record function exactly as before; a record carrying more
 *  than one tool_use/tool_result block (rare, parallel tool calls) has its
 *  raw fields populated from the first such block only, documented on the
 *  type itself.
 *
 *  `toolNameById` (Phase 2.1, optional) is the cross-record correlation this
 *  function BOTH feeds and reads: an assistant record registers every
 *  tool_use block's id → name, and a tool_result record looks its
 *  `tool_use_id` up to set `entry.toolName` — the log view then names the
 *  result instead of showing a bare toolu_ id. Callers own the map and its
 *  lifetime (parseTranscript: per file; detailPanel: on the live slot, reset
 *  with it on truncation). A miss (result whose use fell outside the read
 *  window, or no map passed) leaves toolName unset — exactly the pre-2.1
 *  shape. `content` is never affected. */
export function entryFromRecord(record: JsonlRecord, toolNameById?: Map<string, string>): TranscriptEntry | null {
  const timestamp = (record.timestamp as string) || '';

  if (record.type === 'user') {
    const { content, hasPromptText } = extractUserContent(record);
    if (content) {
      // A user record can be a genuine prompt (text blocks) OR tool plumbing:
      // tool_result blocks ride back to the assistant inside a user-role
      // record. Labelling those "prompt" misreads the conversation — they are
      // responses TO the assistant, so they get their own role.
      const entry: TranscriptEntry = { timestamp, role: hasPromptText ? 'user' : 'tool', content };
      if (hasPromptText) {
        entry.kind = 'text';
      } else {
        entry.kind = 'tool_result';
        const resultBlocks = getToolResultBlocks(record);
        const block = resultBlocks[0];
        if (block) {
          const raw = rawToolResultText(block);
          if (raw) { entry.rawOutput = capRawField(raw); }
          if (typeof block.is_error === 'boolean') { entry.isError = block.is_error; }
          // Correlated name (first block only, same caveat as rawOutput).
          const useId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const name = useId && toolNameById ? toolNameById.get(useId) : undefined;
          if (name) { entry.toolName = name; }
        }
      }
      return entry;
    }
  } else if (record.type === 'assistant') {
    const content = extractAssistantContent(record);
    // Register EVERY tool_use block (not just the first): parallel calls all
    // produce results, and each deserves its name. Registered even when the
    // record yields no entry (empty content) — the results still arrive.
    if (toolNameById) {
      for (const b of getToolUseBlocks(record)) {
        if (typeof b.id === 'string' && b.id && b.name) { toolNameById.set(b.id, b.name); }
      }
    }
    if (content) {
      const entry: TranscriptEntry = { timestamp, role: 'assistant', content };
      const toolBlocks = getToolUseBlocks(record);
      const primary = toolBlocks[0];
      if (primary) {
        const name = primary.name || '';
        entry.kind = (name === 'Task' || name === 'Agent') ? 'task' : 'tool_use';
        entry.toolName = name;
        if (primary.input !== undefined) {
          const raw = safeStringify(primary.input);
          if (raw) { entry.rawInput = capRawField(raw); }
        }
      } else if (getTextBlocksPresent(record)) {
        entry.kind = 'text';
      }
      return entry;
    }
  } else if (record.type === 'system' && record.subtype === 'turn_duration') {
    const duration = record.duration as number | undefined;
    if (duration) {
      return { timestamp, role: 'system', content: `*Turn completed (${duration}ms)*` };
    }
  }
  return null;
}

/** Untruncated raw text of one tool_result block, preserving original
 *  formatting (unlike the collapsed single-line summary in `content`).
 *  Mirrors the string/array-of-text-blocks shapes handled in
 *  extractUserContent below. */
function rawToolResultText(block: JsonlContentBlock): string {
  const resultContent = block.content;
  if (typeof resultContent === 'string') {
    return resultContent;
  }
  if (Array.isArray(resultContent)) {
    for (const rb of resultContent as JsonlContentBlock[]) {
      if (rb.type === 'text' && rb.text) {
        return rb.text;
      }
    }
  }
  return '';
}

function getTextBlocksPresent(record: JsonlRecord): boolean {
  return getContentBlocks(record).some(b => b.type === 'text' && !!b.text);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) || '';
  } catch {
    return '';
  }
}

function extractUserContent(record: JsonlRecord): { content: string; hasPromptText: boolean } {
  const content = getContentBlocks(record);
  const parts: string[] = [];
  let hasPromptText = false;

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      const text = block.text.trim();
      // Skip system injections [A8: guard handles both complete and partial blocks]
      if (text.startsWith('<system-reminder>') || text.includes('</system-reminder>')) { continue; }
      if (text.startsWith('<ide_') || text.includes('</ide_')) { continue; }
      hasPromptText = true;
      parts.push(text);
    } else if (block.type === 'tool_result') {
      const toolId = block.tool_use_id || '';
      const resultContent = block.content;
      let raw = '';
      if (typeof resultContent === 'string') {
        raw = resultContent;
      } else if (Array.isArray(resultContent)) {
        for (const rb of resultContent as JsonlContentBlock[]) {
          if (rb.type === 'text' && rb.text) {
            raw = rb.text;
            break;
          }
        }
      }
      // Collapse internal whitespace BEFORE truncating so a multi-line result
      // (e.g. WebSearch's `…query…\n\nLinks: […]`) stays a single `> ` tool
      // line. Otherwise the embedded newline splits the summary across a
      // recessed tool box AND a separate prose block in the reader, burning
      // vertical space (and breaking the `> ` blockquote in the markdown).
      const collapsed = raw.replace(/\s+/g, ' ').trim();
      if (collapsed) {
        const summary = collapsed.slice(0, 200);
        parts.push(`> **Tool result** (${toolId.slice(0, 12)}...): ${summary}${collapsed.length > 200 ? '...' : ''}`);
      }
    }
  }

  return { content: parts.join('\n\n'), hasPromptText };
}

function extractAssistantContent(record: JsonlRecord): string {
  const content = getContentBlocks(record);
  const parts: string[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text.trim());
    } else if (block.type === 'tool_use') {
      const name = block.name || 'Unknown';
      const input = block.input as Record<string, unknown> | undefined;
      const summary = summariseToolInput(name, input);
      parts.push(`> **${name}** ${summary}`);
    }
  }

  return parts.join('\n\n');
}

function summariseToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) { return ''; }

  switch (name) {
    case 'Read':
      return `\`${basename(input.file_path as string)}\``;
    case 'Write':
      return `\`${basename(input.file_path as string)}\``;
    case 'Edit':
      return `\`${basename(input.file_path as string)}\``;
    case 'Bash':
      return `\`${(input.command as string || '').slice(0, 80)}\``;
    case 'Grep':
      return `pattern: \`${input.pattern as string || ''}\``;
    case 'Glob':
      return `\`${input.pattern as string || ''}\``;
    case 'Agent':
    case 'Task': {
      const desc = (input.description as string) || (input.prompt as string) || '';
      return desc.slice(0, 80);
    }
    case 'WebSearch':
      return `"${input.query as string || ''}"`;
    case 'TodoWrite':
      return '';
    default: {
      const keys = Object.keys(input).slice(0, 3).join(', ');
      return keys ? `(${keys})` : '';
    }
  }
}

function basename(filePath: string | undefined): string {
  if (!filePath) { return 'file'; }
  return path.basename(filePath);
}

function formatMarkdown(entries: TranscriptEntry[], sessionId: string): string {
  const lines: string[] = [];
  lines.push(`# Session Transcript: ${sessionId.slice(0, 8)}`);
  lines.push('');
  lines.push(`*Generated from JSONL transcript. ${entries.length} entries.*`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const entry of entries) {
    const time = entry.timestamp ? formatTime(entry.timestamp) : '';
    const timeStr = time ? ` *(${time})*` : '';

    if (entry.role === 'user') {
      lines.push(`### You${timeStr}`);
      lines.push('');
      lines.push(entry.content);
      lines.push('');
    } else if (entry.role === 'tool') {
      // Tool results returned to the assistant — already `> `-quoted; no heading.
      lines.push(entry.content);
      lines.push('');
    } else if (entry.role === 'assistant') {
      lines.push(`### Claude${timeStr}`);
      lines.push('');
      lines.push(entry.content);
      lines.push('');
    } else if (entry.role === 'system') {
      lines.push(entry.content);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    const locale = vscode.env.language || 'en-AU';
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
