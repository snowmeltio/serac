import * as fs from 'fs';

const TAIL_SIZE = 65536; // Match Claude extension's Z1 buffer

/**
 * Ensures a session JSONL has summary metadata (custom-title, last-prompt, or summary)
 * in its tail so that the Claude extension's discoverSessions can find it.
 *
 * If metadata is missing, extracts the first user text message and appends
 * a custom-title record. This is idempotent: once metadata exists, subsequent
 * calls return immediately.
 *
 * Must NOT be called for running sessions (risk of concurrent write).
 */
export async function ensureSessionMetadata(sessionId: string, jsonlPath: string): Promise<void> {
  try {
    const stat = await fs.promises.stat(jsonlPath);
    if (stat.size === 0) { return; }

    // Read tail (last 64KB) — same buffer the Claude extension checks
    const fh = await fs.promises.open(jsonlPath, 'r');
    try {
      const tailStart = Math.max(0, stat.size - TAIL_SIZE);
      const buf = Buffer.alloc(Math.min(TAIL_SIZE, stat.size));
      await fh.read(buf, 0, buf.length, tailStart);
      const tail = buf.toString('utf-8');

      // Already has metadata — nothing to do.
      // Includes `ai-title` (Claude Code's auto-generated title, shipped post-v0.3)
      // so we don't overwrite a fresh AI-generated title with a stale first-user-text.
      if (tail.includes('"type":"custom-title"') || tail.includes('"type": "custom-title"') ||
          tail.includes('"type":"ai-title"')     || tail.includes('"type": "ai-title"')     ||
          tail.includes('"type":"last-prompt"')  || tail.includes('"type": "last-prompt"')  ||
          tail.includes('"type":"summary"')      || tail.includes('"type": "summary"')) {
        return;
      }
    } finally {
      await fh.close();
    }

    // No metadata found — extract first user text
    const title = await extractFirstUserText(jsonlPath);
    if (!title) { return; } // No user text yet — skip rather than writing a useless fallback
    const record = JSON.stringify({
      type: 'custom-title',
      sessionId,
      customTitle: title.length > 200 ? title.slice(0, 200).trimEnd() + '…' : title,
    });

    await fs.promises.appendFile(jsonlPath, record + '\n');
  } catch {
    // Non-critical — if repair fails, editor.open proceeds without it
  }
}

/** Scan the JSONL for the first user message with text content.
 *  Reads line-by-line up to 4MB total. Skips lines >1MB (image payloads)
 *  since they can't contain useful title text without also containing
 *  base64 image data that makes JSON.parse slow or the buffer truncation
 *  makes the JSON incomplete. */
async function extractFirstUserText(jsonlPath: string): Promise<string | undefined> {
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_LINE = 1024 * 1024;
  const fh = await fs.promises.open(jsonlPath, 'r');
  try {
    const chunkSize = 256 * 1024;
    const buf = Buffer.alloc(chunkSize);
    let offset = 0;
    let remainder = '';
    let totalRead = 0;

    while (totalRead < MAX_BYTES) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
      if (bytesRead === 0) { break; }
      offset += bytesRead;
      totalRead += bytesRead;

      const chunk = remainder + buf.subarray(0, bytesRead).toString('utf-8');
      const lines = chunk.split('\n');
      remainder = lines.pop() ?? '';

      for (const line of lines) {
        const result = line.length > MAX_LINE
          ? extractTextFromLargeLine(line)
          : extractTextFromUserLine(line);
        if (result) { return result; }
      }
    }
    // Check final remainder
    const lastResult = remainder.length > MAX_LINE
      ? extractTextFromLargeLine(remainder)
      : extractTextFromUserLine(remainder);
    if (lastResult) { return lastResult; }
  } finally {
    await fh.close();
  }
  return undefined;
}

function cleanTextBlock(text: string): string {
  return text
    .replace(/<ide_opened_file>[^<]*<\/ide_opened_file>/g, '')
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, '')
    .replace(/\[Image:[^\]]*\]/g, '')
    .replace(/\n/g, ' ')
    .trim();
}

function extractTextFromUserLine(line: string): string | undefined {
  if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) { return; }
  try {
    const rec = JSON.parse(line);
    if (rec.type !== 'user') { return; }
    const msg = rec.message?.content;
    if (typeof msg === 'string') {
      const trimmed = msg.replace(/\n/g, ' ').trim();
      if (trimmed) { return trimmed; }
    }
    if (Array.isArray(msg)) {
      for (const block of msg) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          const cleaned = cleanTextBlock(block.text);
          if (cleaned) { return cleaned; }
        }
      }
    }
  } catch {
    return;
  }
  return;
}

/** For lines too large to JSON.parse (e.g. containing base64 images),
 *  use a character-by-character scanner to extract text block content from user records.
 *  Key-order-independent: finds "type":"text" anchors, then extracts the "text" value
 *  from a window around each anchor using a non-backtracking JSON string parser [C4]. */
function extractTextFromLargeLine(line: string): string | undefined {
  if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) { return; }
  const anchorRe = /"type"\s*:\s*"text"/g;
  let anchor: RegExpExecArray | null;
  while ((anchor = anchorRe.exec(line)) !== null) {
    const start = Math.max(0, anchor.index - 500);
    const end = Math.min(line.length, anchor.index + anchor[0].length + 500);
    const window = line.slice(start, end);
    // Try all "text" key occurrences in the window
    for (const value of extractAllJsonStringValues(window, 'text')) {
      if (value === 'text') { continue; } // Skip type anchor self-match
      const cleaned = cleanTextBlock(value);
      if (cleaned) { return cleaned; }
    }
  }
  return;
}

/** Extract all values of a JSON key from a string fragment using character-by-character
 *  scanning. No regex on the value portion — immune to catastrophic backtracking [C4]. */
function* extractAllJsonStringValues(fragment: string, key: string): Generator<string> {
  const needle = `"${key}"`;
  let searchFrom = 0;
  while (searchFrom < fragment.length) {
    const keyIdx = fragment.indexOf(needle, searchFrom);
    if (keyIdx === -1) { return; }
    let i = keyIdx + needle.length;
    while (i < fragment.length && (fragment[i] === ' ' || fragment[i] === '\t')) { i++; }
    if (i >= fragment.length || fragment[i] !== ':') { searchFrom = keyIdx + 1; continue; }
    i++;
    while (i < fragment.length && (fragment[i] === ' ' || fragment[i] === '\t')) { i++; }
    if (i >= fragment.length || fragment[i] !== '"') { searchFrom = keyIdx + 1; continue; }
    i++;
    const chars: string[] = [];
    let escaped = false;
    let found = false;
    while (i < fragment.length && chars.length < 2000) {
      const ch = fragment[i];
      if (escaped) {
        chars.push(ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch);
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        yield chars.join('');
        found = true;
        break;
      } else {
        chars.push(ch);
      }
      i++;
    }
    searchFrom = found ? i + 1 : keyIdx + 1;
  }
}
