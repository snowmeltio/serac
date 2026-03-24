import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonlTailer } from './jsonlTailer.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `jsonl-tailer-test-${Date.now()}.jsonl`);
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
});

describe('JsonlTailer', () => {
  it('reads complete JSONL records', async () => {
    fs.writeFileSync(tmpFile, '{"type":"user","text":"hello"}\n{"type":"assistant","text":"hi"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(2);
    expect(records[0].type).toBe('user');
    expect(records[1].type).toBe('assistant');
  });

  it('buffers incomplete lines across reads', async () => {
    fs.writeFileSync(tmpFile, '{"type":"us');
    const tailer = new JsonlTailer(tmpFile);

    // First read: incomplete line, no records
    let records = await tailer.readNewRecords();
    expect(records).toHaveLength(0);

    // Append the rest
    fs.appendFileSync(tmpFile, 'er","text":"hello"}\n');
    records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('user');
  });

  it('handles UTF-8 multibyte characters', async () => {
    const record = JSON.stringify({ type: 'user', text: 'Hello 🌍 世界' });
    fs.writeFileSync(tmpFile, record + '\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect((records[0] as Record<string, unknown>).text).toBe('Hello 🌍 世界');
  });

  it('resets offset when file shrinks (truncation)', async () => {
    fs.writeFileSync(tmpFile, '{"type":"a"}\n{"type":"b"}\n');
    const tailer = new JsonlTailer(tmpFile);
    await tailer.readNewRecords(); // consume both

    // Truncate and write new content
    fs.writeFileSync(tmpFile, '{"type":"c"}\n');
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('c');
  });

  it('skips malformed lines', async () => {
    fs.writeFileSync(tmpFile, '{"type":"ok"}\nnot json\n{"type":"also-ok"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(2);
    expect(records[0].type).toBe('ok');
    expect(records[1].type).toBe('also-ok');
  });

  it('returns empty for nonexistent file', async () => {
    const tailer = new JsonlTailer('/nonexistent/path.jsonl');
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(0);
  });

  it('returns empty when no new data', async () => {
    fs.writeFileSync(tmpFile, '{"type":"a"}\n');
    const tailer = new JsonlTailer(tmpFile);
    await tailer.readNewRecords();
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(0);
  });

  it('resets to re-read from beginning', async () => {
    fs.writeFileSync(tmpFile, '{"type":"a"}\n');
    const tailer = new JsonlTailer(tmpFile);
    await tailer.readNewRecords();
    tailer.reset();
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
  });

  it('skips valid JSON that is an array', async () => {
    fs.writeFileSync(tmpFile, '[1,2,3]\n{"type":"ok"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ok');
  });

  it('skips valid JSON that is a string', async () => {
    fs.writeFileSync(tmpFile, '"just a string"\n{"type":"ok"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ok');
  });

  it('skips valid JSON that is a number', async () => {
    fs.writeFileSync(tmpFile, '42\n{"type":"ok"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ok');
  });

  it('skips valid JSON null', async () => {
    fs.writeFileSync(tmpFile, 'null\n{"type":"ok"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ok');
  });

  it('skips records missing the type field', async () => {
    fs.writeFileSync(tmpFile, '{"text":"no type"}\n{"type":"ok"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ok');
  });

  it('skips records with non-string type field', async () => {
    fs.writeFileSync(tmpFile, '{"type":123}\n{"type":true}\n{"type":null}\n{"type":"ok"}\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ok');
  });

  it('parses very long lines (>100KB) if valid', async () => {
    const bigText = 'x'.repeat(100 * 1024);
    const record = JSON.stringify({ type: 'big', text: bigText });
    fs.writeFileSync(tmpFile, record + '\n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('big');
    expect((records[0] as Record<string, unknown>).text).toBe(bigText);
  });

  it('skips lines with only whitespace', async () => {
    fs.writeFileSync(tmpFile, '   \n\t\n{"type":"ok"}\n  \t  \n');
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('ok');
  });

  it('returns only valid records from mixed valid/invalid lines', async () => {
    const lines = [
      '{"type":"first"}',       // valid
      'not json at all',         // malformed
      '{"no_type":"here"}',      // missing type
      '[1,2]',                   // array
      '{"type":99}',             // non-string type
      '{"type":"last"}',         // valid
      '',                        // empty
    ].join('\n') + '\n';
    fs.writeFileSync(tmpFile, lines);
    const tailer = new JsonlTailer(tmpFile);
    const records = await tailer.readNewRecords();
    expect(records).toHaveLength(2);
    expect(records[0].type).toBe('first');
    expect(records[1].type).toBe('last');
  });
});
