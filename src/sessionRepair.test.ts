import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureSessionMetadata } from './sessionRepair.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-repair-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(sessionId: string, lines: object[]): string {
  const filePath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function readLastLine(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8').trimEnd();
  const lines = content.split('\n');
  return lines[lines.length - 1];
}

describe('ensureSessionMetadata', async () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('appends custom-title from first user text message', async () => {
    const jsonl = writeJsonl(sid, [
      { type: 'system', message: {} },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] } },
    ]);
    await ensureSessionMetadata(sid, jsonl);
    const last = JSON.parse(readLastLine(jsonl));
    expect(last.type).toBe('custom-title');
    expect(last.customTitle).toBe('Fix the login bug');
  });

  it('skips when no user text exists', async () => {
    const jsonl = writeJsonl(sid, [
      { type: 'system', message: {} },
    ]);
    const before = fs.readFileSync(jsonl, 'utf-8');
    await ensureSessionMetadata(sid, jsonl);
    expect(fs.readFileSync(jsonl, 'utf-8')).toBe(before);
  });

  it('skips when metadata already exists in tail', async () => {
    const jsonl = writeJsonl(sid, [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'custom-title', sessionId: sid, customTitle: 'Existing title' },
    ]);
    const before = fs.readFileSync(jsonl, 'utf-8');
    await ensureSessionMetadata(sid, jsonl);
    expect(fs.readFileSync(jsonl, 'utf-8')).toBe(before);
  });

  it('skips when ai-title already exists in tail', async () => {
    const jsonl = writeJsonl(sid, [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'ai-title', sessionId: sid, aiTitle: 'Auto-generated title' },
    ]);
    const before = fs.readFileSync(jsonl, 'utf-8');
    await ensureSessionMetadata(sid, jsonl);
    expect(fs.readFileSync(jsonl, 'utf-8')).toBe(before);
  });

  it('strips IDE context tags from extracted text', async () => {
    const jsonl = writeJsonl(sid, [
      { type: 'user', message: { role: 'user', content: [
        { type: 'text', text: '<ide_opened_file>foo.ts</ide_opened_file>' },
        { type: 'text', text: 'Refactor the parser' },
      ] } },
    ]);
    await ensureSessionMetadata(sid, jsonl);
    const last = JSON.parse(readLastLine(jsonl));
    expect(last.customTitle).toBe('Refactor the parser');
  });

  it('strips [Image:...] metadata placeholders', async () => {
    const jsonl = writeJsonl(sid, [
      { type: 'user', message: { role: 'user', content: [
        { type: 'text', text: '[Image: original 1866x2100, displayed at 1777x2000.]' },
        { type: 'text', text: 'Why is this broken?' },
      ] } },
    ]);
    await ensureSessionMetadata(sid, jsonl);
    const last = JSON.parse(readLastLine(jsonl));
    expect(last.customTitle).toBe('Why is this broken?');
  });

  it('truncates titles longer than 200 characters', async () => {
    const longText = 'A'.repeat(250);
    const jsonl = writeJsonl(sid, [
      { type: 'user', message: { role: 'user', content: longText } },
    ]);
    await ensureSessionMetadata(sid, jsonl);
    const last = JSON.parse(readLastLine(jsonl));
    expect(last.customTitle.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(last.customTitle).toContain('…');
  });

  it('handles empty file gracefully', async () => {
    const jsonl = path.join(tmpDir, `${sid}.jsonl`);
    fs.writeFileSync(jsonl, '');
    await ensureSessionMetadata(sid, jsonl); // should not throw
  });
});

describe('extractTextFromLargeLine (via ensureSessionMetadata)', async () => {
  const sid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

  function writeLargeUserRecord(textBlocks: Array<{ type: string; text?: string; source?: object }>, keyOrder: 'type-first' | 'text-first' = 'type-first'): string {
    // Build a user record with a large base64 image to push it over 1MB
    const fakeBase64 = 'A'.repeat(1_200_000);
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fakeBase64 } },
      ...textBlocks.map(b => {
        if (keyOrder === 'text-first' && b.type === 'text') {
          // Emit "text" key before "type" key to test key-order independence
          return Object.fromEntries([['text', b.text], ['type', 'text']]);
        }
        return b;
      }),
    ];
    const record = { type: 'user', message: { role: 'user', content }, sessionId: sid };
    const jsonl = path.join(tmpDir, `${sid}.jsonl`);
    fs.writeFileSync(jsonl, JSON.stringify(record) + '\n');
    return jsonl;
  }

  it('extracts text from large line with type-first key order', async () => {
    const jsonl = writeLargeUserRecord([{ type: 'text', text: 'Fix the bug please' }]);
    await ensureSessionMetadata(sid, jsonl);
    const last = JSON.parse(readLastLine(jsonl));
    expect(last.type).toBe('custom-title');
    expect(last.customTitle).toBe('Fix the bug please');
  });

  it('extracts text from large line with text-first key order (JSON key order independence)', async () => {
    const jsonl = writeLargeUserRecord([{ type: 'text', text: 'Reverse key order test' }], 'text-first');
    await ensureSessionMetadata(sid, jsonl);
    const last = JSON.parse(readLastLine(jsonl));
    expect(last.type).toBe('custom-title');
    expect(last.customTitle).toBe('Reverse key order test');
  });

  it('skips Image metadata in large lines', async () => {
    const jsonl = writeLargeUserRecord([
      { type: 'text', text: '[Image: original 1866x2100, displayed at 1777x2000.]' },
      { type: 'text', text: 'What is happening here?' },
    ]);
    await ensureSessionMetadata(sid, jsonl);
    const last = JSON.parse(readLastLine(jsonl));
    expect(last.customTitle).toBe('What is happening here?');
  });

  it('returns nothing when large line has only images and no text blocks', async () => {
    const fakeBase64 = 'A'.repeat(1_200_000);
    const record = {
      type: 'user',
      message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fakeBase64 } },
      ] },
      sessionId: sid,
    };
    const jsonl = path.join(tmpDir, `${sid}.jsonl`);
    fs.writeFileSync(jsonl, JSON.stringify(record) + '\n');
    const before = fs.readFileSync(jsonl, 'utf-8');
    await ensureSessionMetadata(sid, jsonl);
    expect(fs.readFileSync(jsonl, 'utf-8')).toBe(before);
  });
});
