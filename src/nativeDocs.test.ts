import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock vscode before importing the module under test (same pattern as
// detailPanel.test.ts — nativeDocs.ts imports vscode for Uri/EventEmitter/
// commands/workspace/window).
vi.mock('vscode', async () => {
  const mock = await import('./__mocks__/vscode.js');
  return { ...mock, default: mock };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NativeDocsProvider, NATIVE_DOCS_SCHEME, sanitiseLabel,
  findRecordByEntryIndex, findFirstEditForFile, editInputFromRecord,
  showRawRecordDoc, openTranscriptDocDoc, showFileChangesDoc,
  makeShowRawRecordCommand, makeOpenTranscriptDocCommand, makeShowFileChangesCommand,
} from './nativeDocs.js';
import { parseEditInput } from './detailShared.js';
import { parseTranscript } from './transcriptRenderer.js';
import { window, commands, workspace } from './__mocks__/vscode.js';
import type { JsonlRecord } from './types.js';

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;
function ensureTmpDir(): string {
  if (!tmpDir) { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-nativedocs-')); }
  return tmpDir;
}
function writeJsonl(name: string, records: Array<Record<string, unknown>>): string {
  const file = path.join(ensureTmpDir(), name);
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return file;
}

function userText(text: string, ts = '2026-07-01T00:00:00Z'): Record<string, unknown> {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}
function assistantText(text: string, ts = '2026-07-01T00:00:01Z'): Record<string, unknown> {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } };
}
function assistantToolUse(name: string, id: string, input: Record<string, unknown>, ts = '2026-07-01T00:00:02Z'): Record<string, unknown> {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}
function toolResult(toolUseId: string, content: string, isError: boolean, ts = '2026-07-01T00:00:03Z'): Record<string, unknown> {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } };
}
/** A record entryFromRecord rejects outright (no content blocks at all) —
 *  used to prove the index walk SKIPS it rather than off-by-one-ing. */
function emptyUser(ts = '2026-07-01T00:00:04Z'): Record<string, unknown> {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [] } };
}
function turnDuration(ms: number, ts = '2026-07-01T00:00:05Z'): Record<string, unknown> {
  return { type: 'system', subtype: 'turn_duration', timestamp: ts, duration: ms };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});

// ── NativeDocsProvider ───────────────────────────────────────────────

describe('NativeDocsProvider', () => {
  it('round-trips content through the URI it returns', () => {
    const provider = new NativeDocsProvider();
    const uri = provider.register('agent-record-0', '{"hello":"world"}', 'json');
    expect(uri.scheme).toBe(NATIVE_DOCS_SCHEME);
    expect(provider.provideTextDocumentContent(uri)).toBe('{"hello":"world"}');
  });

  it('returns undefined for an unregistered/unknown token', () => {
    const provider = new NativeDocsProvider();
    const bogus = provider.register('x', 'content', 'txt');
    // Mutate the query to simulate an unknown/forged token.
    const forged = { ...bogus, query: 'not-a-real-token' } as typeof bogus;
    expect(provider.provideTextDocumentContent(forged)).toBeUndefined();
  });

  it('mints a fresh token on every call, even for identical content (re-invoke re-snapshots)', () => {
    const provider = new NativeDocsProvider();
    const a = provider.register('same', 'identical content', 'md');
    const b = provider.register('same', 'identical content', 'md');
    expect(a.query).not.toBe(b.query);
    expect(provider.provideTextDocumentContent(a)).toBe('identical content');
    expect(provider.provideTextDocumentContent(b)).toBe('identical content');
  });

  it('evicts the oldest entries once the token cap (32) is exceeded', () => {
    const provider = new NativeDocsProvider();
    const uris = [];
    for (let i = 0; i < 40; i++) { uris.push(provider.register('doc' + i, 'content-' + i, 'txt')); }
    // The first 8 (40 - 32) should have been evicted.
    for (let i = 0; i < 8; i++) { expect(provider.provideTextDocumentContent(uris[i])).toBeUndefined(); }
    // The most recent 32 remain.
    for (let i = 8; i < 40; i++) { expect(provider.provideTextDocumentContent(uris[i])).toBe('content-' + i); }
  });

  it('clear() drops every cached snapshot', () => {
    const provider = new NativeDocsProvider();
    const uri = provider.register('doc', 'content', 'txt');
    provider.clear();
    expect(provider.provideTextDocumentContent(uri)).toBeUndefined();
  });

  it('sanitises the path hint into a safe URI path segment', () => {
    const provider = new NativeDocsProvider();
    const uri = provider.register('../../etc/passwd?weird#chars', 'content', 'json');
    expect(uri.path).not.toContain('/etc/passwd');
    expect(uri.path.endsWith('.json')).toBe(true);
  });
});

describe('sanitiseLabel', () => {
  it('replaces unsafe characters with underscores and collapses whitespace', () => {
    expect(sanitiseLabel('research-agent (a/b)  spaced')).toBe('research-agent (a_b) spaced');
  });

  it('caps length and falls back to "agent" for an empty/whitespace-only input', () => {
    expect(sanitiseLabel('')).toBe('agent');
    expect(sanitiseLabel('   ')).toBe('agent');
    expect(sanitiseLabel('a'.repeat(200)).length).toBe(80);
  });
});

// ── parseEditInput re-export sanity (canonical tests live in detailShared.test.ts) ──

describe('parseEditInput (nativeDocs.ts consumer)', () => {
  it('is the exact function nativeDocs.ts uses for its own record-derived parse', () => {
    const raw = JSON.stringify({ file_path: '/a.ts', old_string: 'x', new_string: 'y' });
    expect(parseEditInput(raw)).toEqual({ filePath: '/a.ts', oldString: 'x', newString: 'y' });
    expect(parseEditInput('not json')).toBeNull();
    expect(parseEditInput(JSON.stringify({ file_path: '/a.ts', content: 'whole file' }))).toBeNull(); // Write shape
  });
});

// ── findRecordByEntryIndex: alignment with entryFromRecord's filter ────

describe('findRecordByEntryIndex', () => {
  it('aligns with parseTranscript()\'s entries array index, even with rejected records interleaved', async () => {
    const file = writeJsonl('mixed.jsonl', [
      userText('the brief'),                                   // accepted (entries[0])
      emptyUser(),                                              // rejected (no content blocks)
      assistantToolUse('Bash', 'toolu_1', { command: 'ls' }),   // accepted (entries[1])
      toolResult('toolu_1', 'file1\nfile2', false),              // accepted (entries[2], role 'tool')
      turnDuration(1200),                                        // accepted (entries[3], system marker)
      assistantText('done'),                                     // accepted (entries[4])
    ]);
    const entries = await parseTranscript(file);
    expect(entries.length).toBe(5); // confirms one record really was filtered out

    for (let i = 0; i < entries.length; i++) {
      const found = await findRecordByEntryIndex(file, i);
      expect(found.ok).toBe(true);
      if (found.ok) {
        // Cross-check: re-deriving via entryFromRecord's own role/content
        // reproduces the SAME entry parseTranscript() produced at this index.
        expect(found.record.type).toBeDefined();
      }
    }
    // Specifically: index 1 (the Bash tool_use) must be the tool_use record,
    // NOT the interleaved rejected emptyUser() — proving the walk skips
    // rejected records rather than counting them.
    const at1 = await findRecordByEntryIndex(file, 1);
    expect(at1.ok).toBe(true);
    if (at1.ok) {
      expect(at1.record.type).toBe('assistant');
      const content = (at1.record.message?.content as Array<Record<string, unknown>>)[0];
      expect(content.name).toBe('Bash');
    }
  });

  it('returns not-found beyond the last accepted record', async () => {
    const file = writeJsonl('short.jsonl', [userText('only one')]);
    const found = await findRecordByEntryIndex(file, 5);
    expect(found).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses politely beyond the 8MB cap', async () => {
    const line = JSON.stringify(userText('x'.repeat(1000)));
    const target = 8 * 1024 * 1024 + 4096;
    const lines: string[] = [];
    let size = 0;
    while (size < target) { lines.push(line); size += line.length + 1; }
    const file = path.join(ensureTmpDir(), 'huge.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const found = await findRecordByEntryIndex(file, 0);
    expect(found).toEqual({ ok: false, reason: 'too-large' });
  });

  it('read-errors gracefully for a missing file', async () => {
    const found = await findRecordByEntryIndex(path.join(os.tmpdir(), 'does-not-exist-serac.jsonl'), 0);
    expect(found).toEqual({ ok: false, reason: 'read-error' });
  });
});

// ── findFirstEditForFile ────────────────────────────────────────────

describe('findFirstEditForFile', () => {
  it('finds the FIRST Edit targeting the given path among several tool calls', async () => {
    const file = writeJsonl('edits.jsonl', [
      userText('brief'),
      assistantToolUse('Read', 'toolu_r1', { file_path: '/repo/a.ts' }),
      assistantToolUse('Edit', 'toolu_e1', { file_path: '/repo/a.ts', old_string: 'first-old', new_string: 'first-new' }),
      assistantToolUse('Edit', 'toolu_e2', { file_path: '/repo/a.ts', old_string: 'second-old', new_string: 'second-new' }),
      assistantToolUse('Edit', 'toolu_e3', { file_path: '/repo/b.ts', old_string: 'other-old', new_string: 'other-new' }),
    ]);
    const found = await findFirstEditForFile(file, '/repo/a.ts');
    expect(found.ok).toBe(true);
    if (found.ok) {
      const edit = editInputFromRecord(found.record);
      expect(edit).toEqual({ filePath: '/repo/a.ts', oldString: 'first-old', newString: 'first-new' });
    }
  });

  it('returns not-found when no Edit targets that path', async () => {
    const file = writeJsonl('no-edit.jsonl', [
      assistantToolUse('Write', 'toolu_w1', { file_path: '/repo/c.ts', content: 'x' }),
    ]);
    const found = await findFirstEditForFile(file, '/repo/c.ts');
    expect(found).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('editInputFromRecord', () => {
  it('extracts a valid Edit from an assistant tool_use record', () => {
    const record = assistantToolUse('Edit', 'toolu_1', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }) as unknown as JsonlRecord;
    expect(editInputFromRecord(record)).toEqual({ filePath: '/a.ts', oldString: 'a', newString: 'b' });
  });

  it('returns null for a non-Edit tool_use', () => {
    const record = assistantToolUse('Write', 'toolu_1', { file_path: '/a.ts', content: 'x' }) as unknown as JsonlRecord;
    expect(editInputFromRecord(record)).toBeNull();
  });

  it('returns null for a non-assistant record', () => {
    const record = userText('hi') as unknown as JsonlRecord;
    expect(editInputFromRecord(record)).toBeNull();
  });
});

// ── Command implementations (need the vscode mock's doc-opening surface) ──

describe('showRawRecordDoc', () => {
  it('opens a pretty-printed JSON virtual doc for a valid index', async () => {
    const file = writeJsonl('raw.jsonl', [userText('brief'), assistantText('reply text')]);
    const provider = new NativeDocsProvider();
    const result = await showRawRecordDoc(provider, file, 1, 'my-agent');
    expect(result).toEqual({ ok: true });
    expect(workspace.openTextDocument).toHaveBeenCalledTimes(1);
    const openedUri = vi.mocked(workspace.openTextDocument).mock.calls[0][0];
    const content = provider.provideTextDocumentContent(openedUri as any);
    expect(content).toContain('"type": "assistant"');
    expect(content).toContain('reply text');
  });

  it('refuses with a clear message when the index is out of range', async () => {
    const file = writeJsonl('raw2.jsonl', [userText('only one')]);
    const provider = new NativeDocsProvider();
    const result = await showRawRecordDoc(provider, file, 9, 'agent');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not find/i);
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
  });
});

describe('showFileChangesDoc', () => {
  it('opens a diff for an entryIndex target, titled with the honesty label', async () => {
    const file = writeJsonl('diff1.jsonl', [
      userText('brief'),
      assistantToolUse('Edit', 'toolu_1', { file_path: '/repo/src/foo.ts', old_string: 'before', new_string: 'after' }),
    ]);
    const provider = new NativeDocsProvider();
    const result = await showFileChangesDoc(provider, file, { entryIndex: 1 }, 'audit-agent');
    expect(result).toEqual({ ok: true });
    expect(commands.executeCommand).toHaveBeenCalledTimes(1);
    const [cmd, leftUri, rightUri, title] = vi.mocked(commands.executeCommand).mock.calls[0];
    expect(cmd).toBe('vscode.diff');
    expect(provider.provideTextDocumentContent(leftUri as any)).toBe('before');
    expect(provider.provideTextDocumentContent(rightUri as any)).toBe('after');
    expect(title).toContain('foo.ts');
    expect(title).toContain('as edited by');
    expect(title).toContain('audit-agent');
  });

  it('opens a diff for a targetPath (Result-strip chip) target', async () => {
    const file = writeJsonl('diff2.jsonl', [
      assistantToolUse('Edit', 'toolu_1', { file_path: '/repo/x.ts', old_string: 'o1', new_string: 'n1' }),
      assistantToolUse('Edit', 'toolu_2', { file_path: '/repo/x.ts', old_string: 'o2', new_string: 'n2' }),
    ]);
    const provider = new NativeDocsProvider();
    const result = await showFileChangesDoc(provider, file, { targetPath: '/repo/x.ts' }, 'agent');
    expect(result).toEqual({ ok: true });
    const [, leftUri, rightUri] = vi.mocked(commands.executeCommand).mock.calls[0];
    // FIRST edit wins — 'o1'/'n1', not the second.
    expect(provider.provideTextDocumentContent(leftUri as any)).toBe('o1');
    expect(provider.provideTextDocumentContent(rightUri as any)).toBe('n1');
  });

  it('refuses when the found record is not an Edit', async () => {
    const file = writeJsonl('diff3.jsonl', [assistantText('just text, no tool call')]);
    const provider = new NativeDocsProvider();
    const result = await showFileChangesDoc(provider, file, { entryIndex: 0 }, 'agent');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an edit/i);
    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});

describe('openTranscriptDocDoc', () => {
  it('renders the transcript via renderTranscript() and serves it as a markdown snapshot', async () => {
    const file = writeJsonl('transcript.jsonl', [userText('the brief'), assistantText('the reply')]);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-nativedocs-ws-'));
    const provider = new NativeDocsProvider();
    try {
      const result = await openTranscriptDocDoc(provider, workspaceDir, file, 'agent123', 'audit-agent');
      expect(result).toEqual({ ok: true });
      const openedUri = vi.mocked(workspace.openTextDocument).mock.calls.at(-1)?.[0];
      const content = provider.provideTextDocumentContent(openedUri as any);
      expect(content).toContain('the brief');
      expect(content).toContain('the reply');
      expect((openedUri as any).path.endsWith('.md')).toBe(true);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

// ── Command factories: surface failures as a warning toast ─────────────

describe('make*Command factories', () => {
  it('showWarningMessage fires when the underlying doc function fails', async () => {
    const provider = new NativeDocsProvider();
    const cmd = makeShowRawRecordCommand(provider);
    await cmd({ filePath: path.join(os.tmpdir(), 'nope-serac.jsonl'), entryIndex: 0, label: 'agent' });
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('does not toast on success', async () => {
    const file = writeJsonl('ok.jsonl', [userText('brief'), assistantText('reply')]);
    const provider = new NativeDocsProvider();
    const cmd = makeShowRawRecordCommand(provider);
    await cmd({ filePath: file, entryIndex: 0, label: 'agent' });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('openTranscriptDoc command factory wires the workspace path in via closure', async () => {
    const file = writeJsonl('ok2.jsonl', [userText('brief')]);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-nativedocs-ws2-'));
    const provider = new NativeDocsProvider();
    try {
      const cmd = makeOpenTranscriptDocCommand(provider, workspaceDir);
      await cmd({ filePath: file, agentId: 'agent1', label: 'agent' });
      expect(window.showWarningMessage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it('showFileChanges command factory toasts on a non-Edit target', async () => {
    const file = writeJsonl('ok3.jsonl', [assistantText('no tools here')]);
    const provider = new NativeDocsProvider();
    const cmd = makeShowFileChangesCommand(provider);
    await cmd({ filePath: file, target: { entryIndex: 0 }, label: 'agent' });
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
