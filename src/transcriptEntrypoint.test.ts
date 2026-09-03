import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  entrypointToken, rewriteEntrypointLine, buildTransferMarker, readTranscriptEntrypoint,
  rewriteTranscriptEntrypoint, SERAC_TRANSFER_RECORD_TYPE, VSCODE_ENTRYPOINT,
} from './transcriptEntrypoint.js';

const SID = 'b6ad54a8-804d-55a1-a232-066390a18787';
const QUEUE = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-03T02:52:21.562Z', sessionId: SID, content: 'Hello world' });
const USER = JSON.stringify({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/Users/me/claudecode', sessionId: SID, version: '2.1.258', gitBranch: 'main', entrypoint: 'sdk-cli', type: 'user', message: { role: 'user', content: 'Hello world' }, uuid: 'u1', timestamp: '2026-09-03T02:52:21.600Z' });
const ASSISTANT = JSON.stringify({ parentUuid: 'u1', isSidechain: false, cwd: '/Users/me/claudecode', sessionId: SID, entrypoint: 'sdk-cli', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Text mentioning "entrypoint":"sdk-cli" is escaped by JSON' }] }, uuid: 'a1' });
const LAST_PROMPT = JSON.stringify({ type: 'last-prompt', lastPrompt: 'Hello world', leafUuid: 'a1', sessionId: SID });

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tep-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(name: string, content: string, mode = 0o600): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { mode });
  return p;
}

describe('entrypointToken / rewriteEntrypointLine', () => {
  it('matches the exact serialisation Claude Code writes', () => {
    expect(entrypointToken('sdk-cli')).toBe('"entrypoint":"sdk-cli"');
  });
  it('rewrites the bare token and reports the change', () => {
    const r = rewriteEntrypointLine(USER, 'sdk-cli', VSCODE_ENTRYPOINT);
    expect(r.changed).toBe(true);
    expect(r.line).toContain('"entrypoint":"claude-vscode"');
    expect(r.line).not.toContain('"entrypoint":"sdk-cli"');
    expect(JSON.parse(r.line).entrypoint).toBe('claude-vscode');
  });
  it('leaves a line without the token byte-identical', () => {
    expect(rewriteEntrypointLine(QUEUE, 'sdk-cli', VSCODE_ENTRYPOINT)).toEqual({ line: QUEUE, changed: false });
  });
  it('does not touch the token when it appears inside a string value (escaped quotes)', () => {
    const r = rewriteEntrypointLine(ASSISTANT, 'sdk-cli', VSCODE_ENTRYPOINT);
    const parsed = JSON.parse(r.line);
    expect(parsed.entrypoint).toBe('claude-vscode');
    expect(parsed.message.content[0].text).toContain('"entrypoint":"sdk-cli"');
  });
});

describe('buildTransferMarker', () => {
  it('is one JSON line carrying type, session, both values, and an ISO time', () => {
    const at = new Date('2026-09-03T03:40:00.000Z');
    const m = JSON.parse(buildTransferMarker(SID, 'sdk-cli', VSCODE_ENTRYPOINT, at));
    expect(m).toEqual({ type: SERAC_TRANSFER_RECORD_TYPE, sessionId: SID, fromEntrypoint: 'sdk-cli', toEntrypoint: 'claude-vscode', at: '2026-09-03T03:40:00.000Z' });
  });
});

describe('readTranscriptEntrypoint', () => {
  it('skips leading token-less records and returns the first value seen', async () => {
    const p = write('a.jsonl', [QUEUE, QUEUE, USER, ASSISTANT].join('\n') + '\n');
    expect(await readTranscriptEntrypoint(p)).toBe('sdk-cli');
  });
  it('null when no record carries an entrypoint', async () => {
    const p = write('b.jsonl', [QUEUE, LAST_PROMPT].join('\n') + '\n');
    expect(await readTranscriptEntrypoint(p)).toBeNull();
  });
  it('respects maxBytes', async () => {
    const p = write('c.jsonl', [QUEUE, QUEUE, USER].join('\n') + '\n');
    expect(await readTranscriptEntrypoint(p, { maxBytes: QUEUE.length + 2 })).toBeNull();
  });
  it('reads a token on a final line with no trailing newline', async () => {
    const p = write('d.jsonl', USER);
    expect(await readTranscriptEntrypoint(p)).toBe('sdk-cli');
  });
});

describe('rewriteTranscriptEntrypoint', () => {
  it('rewrites every token, counts changed lines, appends one marker, keeps other lines byte-identical', async () => {
    const p = write('s.jsonl', [QUEUE, USER, ASSISTANT, LAST_PROMPT].join('\n') + '\n');
    const at = new Date('2026-09-03T03:40:00.000Z');
    const r = await rewriteTranscriptEntrypoint(p, { sessionId: SID, now: () => at });
    expect(r).toEqual({ changed: 2, skipped: false });
    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    expect(lines.at(-1)).toBe(''); // trailing newline
    expect(lines[0]).toBe(QUEUE);
    expect(lines[3]).toBe(LAST_PROMPT);
    expect(JSON.parse(lines[1]!).entrypoint).toBe('claude-vscode');
    expect(JSON.parse(lines[2]!).entrypoint).toBe('claude-vscode');
    expect(JSON.parse(lines[4]!)).toMatchObject({ type: SERAC_TRANSFER_RECORD_TYPE, fromEntrypoint: 'sdk-cli', toEntrypoint: 'claude-vscode', at: at.toISOString() });
    expect(fs.readFileSync(p, 'utf-8')).not.toContain('"entrypoint":"sdk-cli"');
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('adds a trailing newline to a torn tail before the marker', async () => {
    const p = write('t.jsonl', [QUEUE, USER].join('\n')); // no trailing \n
    await rewriteTranscriptEntrypoint(p, { sessionId: SID });
    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    expect(lines).toHaveLength(4); // QUEUE, USER, marker, ''
    expect(JSON.parse(lines[2]!).type).toBe(SERAC_TRANSFER_RECORD_TYPE);
  });

  it('is idempotent: a file already reading claude-vscode is skipped, no second marker', async () => {
    const p = write('i.jsonl', [QUEUE, USER].join('\n') + '\n');
    await rewriteTranscriptEntrypoint(p, { sessionId: SID });
    const once = fs.readFileSync(p, 'utf-8');
    const r = await rewriteTranscriptEntrypoint(p, { sessionId: SID });
    expect(r).toEqual({ changed: 0, skipped: true });
    expect(fs.readFileSync(p, 'utf-8')).toBe(once);
  });

  it('preserves the file mode', async () => {
    const p = write('m.jsonl', USER + '\n', 0o600);
    await rewriteTranscriptEntrypoint(p, { sessionId: SID });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('round-trips a multi-megabyte transcript', async () => {
    const big = Array.from({ length: 8000 }, (_, i) => (i % 3 === 0 ? QUEUE : USER)).join('\n') + '\n';
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
    const p = write('big.jsonl', big);
    const r = await rewriteTranscriptEntrypoint(p, { sessionId: SID });
    expect(r.changed).toBe(8000 - Math.ceil(8000 / 3));
    const out = fs.readFileSync(p, 'utf-8');
    expect(out.split('\n')).toHaveLength(8002);
    expect(out).not.toContain('"entrypoint":"sdk-cli"');
  });

  it('leaves the original untouched and no temp file behind when the write fails', async () => {
    const p = write('ro.jsonl', USER + '\n');
    fs.chmodSync(dir, 0o500); // no create permission in the dir → 'wx' open fails
    try {
      await expect(rewriteTranscriptEntrypoint(p, { sessionId: SID })).rejects.toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(fs.readFileSync(p, 'utf-8')).toBe(USER + '\n');
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects a missing file without creating anything', async () => {
    const p = path.join(dir, 'nope.jsonl');
    await expect(rewriteTranscriptEntrypoint(p, { sessionId: SID })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
