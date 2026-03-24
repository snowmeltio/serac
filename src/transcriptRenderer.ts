import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { validateRecord, getContentBlocks } from './jsonlValidator.js';
import type { JsonlRecord, JsonlContentBlock } from './types.js';

interface TranscriptEntry {
  timestamp: string;
  role: string;
  content: string;
}

/**
 * Renders a JSONL session file into a readable markdown transcript.
 * Writes to .claude/transcripts/{sessionId}.md within the workspace.
 */
export async function renderTranscript(
  jsonlPath: string,
  sessionId: string,
  workspacePath: string,
): Promise<string> {
  const entries = await parseJsonl(jsonlPath);
  const markdown = formatMarkdown(entries, sessionId);

  const transcriptsDir = path.join(workspacePath, '.claude', 'transcripts');
  await fs.promises.mkdir(transcriptsDir, { recursive: true });

  const outputPath = path.join(transcriptsDir, `${sessionId}.md`);
  await fs.promises.writeFile(outputPath, markdown, 'utf-8');
  return outputPath;
}

async function parseJsonl(filePath: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
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

    const timestamp = (record.timestamp as string) || '';

    if (record.type === 'user') {
      const content = extractUserContent(record);
      if (content) {
        entries.push({ timestamp, role: 'user', content });
      }
    } else if (record.type === 'assistant') {
      const content = extractAssistantContent(record);
      if (content) {
        entries.push({ timestamp, role: 'assistant', content });
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      const duration = record.duration as number | undefined;
      if (duration) {
        entries.push({ timestamp, role: 'system', content: `*Turn completed (${duration}ms)*` });
      }
    }
  }

  return entries;
}

function extractUserContent(record: JsonlRecord): string {
  const content = getContentBlocks(record);
  const parts: string[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      const text = block.text.trim();
      // Skip system injections [A8: guard handles both complete and partial blocks]
      if (text.startsWith('<system-reminder>') || text.includes('</system-reminder>')) { continue; }
      if (text.startsWith('<ide_') || text.includes('</ide_')) { continue; }
      parts.push(text);
    } else if (block.type === 'tool_result') {
      const toolId = block.tool_use_id || '';
      const resultContent = block.content;
      let summary = '';
      if (typeof resultContent === 'string') {
        summary = resultContent.slice(0, 200);
      } else if (Array.isArray(resultContent)) {
        for (const rb of resultContent as JsonlContentBlock[]) {
          if (rb.type === 'text' && rb.text) {
            summary = rb.text.slice(0, 200);
            break;
          }
        }
      }
      if (summary) {
        parts.push(`> **Tool result** (${toolId.slice(0, 12)}...): ${summary}${summary.length >= 200 ? '...' : ''}`);
      }
    }
  }

  return parts.join('\n\n');
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
