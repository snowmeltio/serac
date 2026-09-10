import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { splitCompleteLines, findInLines, readJsonlHeadLines, peekCwd } from './jsonlPeek.js';

describe('splitCompleteLines (pure)', () => {
  it('drops a trailing partial line when the read did not reach EOF', () => {
    expect(splitCompleteLines('line1\nline2\npartial', false)).toEqual(['line1', 'line2']);
  });

  it('keeps a trailing line with no terminator when the read reached EOF', () => {
    expect(splitCompleteLines('line1\nline2\nlast-no-newline', true)).toEqual(['line1', 'line2', 'last-no-newline']);
  });

  it('drops nothing when the chunk ends exactly on a newline', () => {
    expect(splitCompleteLines('line1\nline2\n', false)).toEqual(['line1', 'line2']);
    expect(splitCompleteLines('line1\nline2\n', true)).toEqual(['line1', 'line2']);
  });

  it('returns an empty array for an empty chunk', () => {
    expect(splitCompleteLines('', true)).toEqual([]);
    expect(splitCompleteLines('', false)).toEqual([]);
  });
});

describe('findInLines (pure)', () => {
  it('skips lines that fail the substring pre-filter', () => {
    const lines = ['{"type":"user"}', '{"type":"assistant"}'];
    const result = findInLines(lines, '"cwd"', (rec) => (rec as { cwd?: string }).cwd);
    expect(result).toBeUndefined();
  });

  it('skips a malformed line and finds the value on a later line', () => {
    const lines = ['{not json', '{"cwd":"/repo/a"}'];
    const result = findInLines(lines, '"cwd"', (rec) => (rec as { cwd?: string }).cwd);
    expect(result).toBe('/repo/a');
  });

  it('returns undefined when pick() never returns a defined value', () => {
    const lines = ['{"cwd":123}']; // wrong type — pick() should reject it
    const result = findInLines(lines, '"cwd"', (rec) => {
      const r = rec as { cwd?: unknown };
      return typeof r.cwd === 'string' ? r.cwd : undefined;
    });
    expect(result).toBeUndefined();
  });
});

describe('readJsonlHeadLines / peekCwd (real fs)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-peek-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('finds cwd on line 1 even behind a large message field, with a single bounded (<=1MB) read', async () => {
    // Real transcripts serialise `cwd` AFTER `message`, and the first user
    // record commonly carries a large injected CLAUDE.md/system-reminder
    // payload ahead of the real prompt text (measured up to ~184KB on one
    // real transcript) — well past a naive 64KB window. peekCwd's 1MB
    // default (matching the old full-replay's MAX_LINE_BUFFER tolerance) is
    // required for this to resolve, not just generous.
    const bigMessage = 'x'.repeat(200 * 1024);
    const line1 = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: bigMessage }] }, cwd: '/repo/worktree-a' });
    // Filler pushes the file past the 1MB window, proving the read stays bounded.
    const filler = JSON.stringify({ type: 'user', pad: 'y'.repeat(900 * 1024) });
    const filePath = writeFile('session.jsonl', [line1, filler].join('\n') + '\n');
    expect(fs.statSync(filePath).size).toBeGreaterThan(1024 * 1024);

    // Wrap fs.promises.open so we can capture the byte length of every read()
    // issued against the returned handle — proves the peek window is bounded.
    const realOpen = fs.promises.open.bind(fs.promises);
    const readLengths: number[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const fh = await realOpen(...args) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const originalRead = fh.read.bind(fh);
      fh.read = (...readArgs: unknown[]) => {
        readLengths.push(readArgs[2] as number);
        return originalRead(...readArgs);
      };
      return fh as unknown as fs.promises.FileHandle;
    });

    const cwd = await peekCwd(filePath);
    expect(cwd).toBe('/repo/worktree-a');
    expect(readLengths).toHaveLength(1);
    expect(readLengths[0]).toBeLessThanOrEqual(1024 * 1024);
  });

  it('returns the FIRST cwd seen, not a later one (the launch cwd, not a mid-session cd)', async () => {
    const filePath = writeFile('multi-cwd.jsonl', [
      JSON.stringify({ type: 'user', cwd: '/repo/worktree-a' }),
      JSON.stringify({ type: 'user', cwd: '/repo/worktree-a/subdir-after-cd' }),
    ].join('\n') + '\n');
    expect(await peekCwd(filePath)).toBe('/repo/worktree-a');
  });

  it('rejects a typeless line even when it carries a cwd, matching validateRecord', async () => {
    const filePath = writeFile('typeless.jsonl', [
      JSON.stringify({ cwd: '/repo/typeless' }), // no `type` — validateRecord() rejects this
      JSON.stringify({ type: 'user', cwd: '/repo/valid' }),
    ].join('\n') + '\n');
    expect(await peekCwd(filePath)).toBe('/repo/valid');
  });

  it('a file shorter than the window without a trailing newline keeps its last line', async () => {
    const content = JSON.stringify({ type: 'user', cwd: '/repo/short' }); // no trailing \n
    const filePath = writeFile('short.jsonl', content);
    const lines = await readJsonlHeadLines(filePath);
    expect(lines).toEqual([content]);
    expect(await peekCwd(filePath)).toBe('/repo/short');
  });

  it('skips a malformed first line and finds cwd on line 2', async () => {
    const filePath = writeFile('malformed.jsonl', ['{not valid json', JSON.stringify({ type: 'user', cwd: '/repo/b' })].join('\n') + '\n');
    expect(await peekCwd(filePath)).toBe('/repo/b');
  });

  it('returns null for a missing file', async () => {
    expect(await peekCwd(path.join(tmpDir, 'does-not-exist.jsonl'))).toBeNull();
  });

  it('returns null when no record in the head carries a cwd', async () => {
    const filePath = writeFile('no-cwd.jsonl', [JSON.stringify({ type: 'user' }), JSON.stringify({ type: 'assistant' })].join('\n') + '\n');
    expect(await peekCwd(filePath)).toBeNull();
  });

  it('drops a trailing partial line beyond the read window rather than misparsing it', async () => {
    // A small complete marker line, followed by a line so large it extends
    // well past the 64KB window — the window closes mid-line, and that
    // truncated fragment must not appear in the result.
    const marker = JSON.stringify({ type: 'marker' });
    const bigTail = JSON.stringify({ type: 'user', cwd: '/repo/tail', pad: 'y'.repeat(200 * 1024) });
    const filePath = writeFile('boundary.jsonl', marker + '\n' + bigTail);
    const lines = await readJsonlHeadLines(filePath, 64 * 1024);
    expect(lines).toEqual([marker]);
  });
});
