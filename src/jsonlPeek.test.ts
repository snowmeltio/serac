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

  it('finds cwd on line 1 of a ~200KB file with a single bounded (<=64KB) read', async () => {
    // A large padding field pushes the file well past the 64KB peek window,
    // proving the cwd on line 1 is found without reading the whole file.
    const padding = 'x'.repeat(200 * 1024);
    const line1 = JSON.stringify({ type: 'user', cwd: '/repo/worktree-a', pad: padding.slice(0, 100) });
    const filler = JSON.stringify({ type: 'user', pad: padding });
    const filePath = writeFile('session.jsonl', [line1, filler, filler].join('\n') + '\n');
    expect(fs.statSync(filePath).size).toBeGreaterThan(200 * 1024);

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
    expect(readLengths[0]).toBeLessThanOrEqual(64 * 1024);
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
