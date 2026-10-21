/**
 * Headless `claude -p` child detection (SessionState.headless). Record shapes
 * are trimmed from the 2026-10-21 census: 30 children a lead launched to
 * publish artifacts under another account, against ~170 interactive sessions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JsonlRecord } from './types.js';

let mockRecords: JsonlRecord[] = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    private offset = 0;
    lastSize = 0;
    async readNewRecords() {
      const r = mockRecords;
      mockRecords = [];
      if (r.length > 0) { this.offset++; }
      this.lastSize = this.offset;
      return r;
    }
    getOffset() { return this.offset; }
  },
}));

const { SessionManager } = await import('./sessionManager.js');

const TS = '2026-10-21T09:55:47.315Z';
function enqueue(content?: string): JsonlRecord {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: TS, ...(content !== undefined ? { content } : {}) };
}
const dequeue: JsonlRecord = { type: 'queue-operation', operation: 'dequeue', timestamp: TS };
function prompt(text: string, extra: Partial<JsonlRecord> = {}): JsonlRecord {
  return { type: 'user', timestamp: TS, version: '2.1.292', entrypoint: 'claude-vscode', message: { content: text }, ...extra };
}
const HUMAN = { origin: { kind: 'human' } };

async function headless(records: JsonlRecord[]): Promise<boolean | undefined> {
  const mgr = new SessionManager('sid', '/tmp/sid.jsonl', 'ws');
  mockRecords = records;
  await mgr.update();
  return mgr.getSnapshot().headless;
}

beforeEach(() => { mockRecords = []; });

describe('headless claude -p children', () => {
  it('a session opened with its prompt queued and no origin is headless', async () => {
    const p = 'Use the Artifact tool action read on https://claude.ai/artifact/X';
    expect(await headless([enqueue(p), dequeue, prompt(p)])).toBe(true);
  });

  it('an interactive session (empty first enqueue, origin on the prompt) is not', async () => {
    expect(await headless([enqueue(), dequeue, prompt('Fix the build', { version: '2.1.304', ...HUMAN })])).toBe(false);
  });

  it('a queued first prompt that carries origin is not', async () => {
    expect(await headless([enqueue('hi'), dequeue, prompt('hi', HUMAN)])).toBe(false);
  });

  it('a session that opened on a local command (/clear) is judged on its first real prompt', async () => {
    // Session 48bae70c: /clear, then a typed prompt with origin.
    expect(await headless([
      prompt('<local-command-caveat>Caveat: the command below was run directly</local-command-caveat>'),
      prompt('<command-name>/clear</command-name>'),
      enqueue('Who is this?'), dequeue, prompt('Who is this?', { version: '2.1.299', ...HUMAN }),
    ])).toBe(false);
  });

  it('a transcript from before the CLI stamped origin is never judged headless', async () => {
    expect(await headless([enqueue('Hey there'), dequeue, prompt('Hey there', { version: '2.1.92', entrypoint: 'claude-desktop' })])).toBe(false);
  });

  it('stays headless across later records', async () => {
    const mgr = new SessionManager('sid', '/tmp/sid.jsonl', 'ws');
    mockRecords = [enqueue('go'), dequeue, prompt('go')];
    await mgr.update();
    mockRecords = [enqueue('more'), dequeue, prompt('more', HUMAN)];
    await mgr.update();
    expect(mgr.getSnapshot().headless).toBe(true);
  });
});
