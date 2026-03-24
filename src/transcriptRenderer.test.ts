import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode
vi.mock('vscode', () => ({
  env: { language: 'en-AU' },
}));

const { renderTranscript } = await import('./transcriptRenderer.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(lines: Record<string, unknown>[]): string {
  const filePath = path.join(tmpDir, 'session.jsonl');
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

async function render(lines: Record<string, unknown>[], sessionId = 'abc12345-session'): Promise<string> {
  const jsonlPath = writeJsonl(lines);
  const workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const outputPath = await renderTranscript(jsonlPath, sessionId, workspace);
  return fs.readFileSync(outputPath, 'utf-8');
}

describe('renderTranscript', async () => {
  it('creates output file in .claude/transcripts/', async () => {
    const jsonlPath = writeJsonl([]);
    const workspace = path.join(tmpDir, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const outputPath = await renderTranscript(jsonlPath, 'sess-001', workspace);
    expect(outputPath).toBe(path.join(workspace, '.claude', 'transcripts', 'sess-001.md'));
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('renders header with truncated session ID', async () => {
    const md = await render([]);
    expect(md).toContain('# Session Transcript: abc12345');
    expect(md).toContain('0 entries');
  });

  describe('user messages', async () => {
    it('renders user text blocks', async () => {
      const md = await render([
        {
          type: 'user',
          timestamp: '2026-03-11T10:00:00Z',
          message: { content: [{ type: 'text', text: 'Hello Claude' }] },
        },
      ]);
      expect(md).toContain('### You');
      expect(md).toContain('Hello Claude');
    });

    it('skips system-reminder injections', async () => {
      const md = await render([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [
              { type: 'text', text: '<system-reminder>secret stuff</system-reminder>' },
              { type: 'text', text: 'Real question' },
            ],
          },
        },
      ]);
      expect(md).not.toContain('system-reminder');
      expect(md).toContain('Real question');
    });

    it('skips ide_ prefixed text blocks', async () => {
      const md = await render([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [
              { type: 'text', text: '<ide_context>stuff</ide_context>' },
              { type: 'text', text: 'Actual message' },
            ],
          },
        },
      ]);
      expect(md).not.toContain('ide_context');
      expect(md).toContain('Actual message');
    });
  });

  describe('tool_result in user records', async () => {
    it('renders string tool results truncated to 200 chars', async () => {
      const longResult = 'x'.repeat(300);
      const md = await render([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_abcdef123456789',
                content: longResult,
              },
            ],
          },
        },
      ]);
      expect(md).toContain('**Tool result**');
      expect(md).toContain('toolu_abcdef...');
      expect(md).toContain('...');
      // Should contain exactly 200 x's in the summary
      const match = md.match(/x+/);
      expect(match![0].length).toBe(200);
    });

    it('renders array tool results', async () => {
      const md = await render([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_abc123456789',
                content: [{ type: 'text', text: 'File contents here' }],
              },
            ],
          },
        },
      ]);
      expect(md).toContain('File contents here');
    });

    it('skips tool results with no content', async () => {
      const md = await render([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_abc', content: '' },
            ],
          },
        },
      ]);
      expect(md).not.toContain('Tool result');
    });
  });

  describe('assistant messages', async () => {
    it('renders assistant text', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '2026-03-11T10:01:00Z',
          message: { content: [{ type: 'text', text: 'Here is the answer.' }] },
        },
      ]);
      expect(md).toContain('### Claude');
      expect(md).toContain('Here is the answer.');
    });

    it('renders tool_use with Read summary', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                id: 'toolu_1',
                input: { file_path: '/home/user/project/README.md' },
              },
            ],
          },
        },
      ]);
      expect(md).toContain('**Read** `README.md`');
    });

    it('renders tool_use with Bash summary truncated to 80 chars', async () => {
      const longCmd = 'a'.repeat(100);
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', id: 'toolu_2', input: { command: longCmd } },
            ],
          },
        },
      ]);
      const match = md.match(/`(a+)`/);
      expect(match![1].length).toBe(80);
    });

    it('renders tool_use with Grep summary', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Grep', id: 'toolu_3', input: { pattern: 'TODO' } },
            ],
          },
        },
      ]);
      expect(md).toContain('pattern: `TODO`');
    });

    it('renders tool_use with WebSearch summary', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'WebSearch', id: 'toolu_4', input: { query: 'vitest mocks' } },
            ],
          },
        },
      ]);
      expect(md).toContain('"vitest mocks"');
    });

    it('renders unknown tool with key names', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'CustomTool', id: 'toolu_5', input: { foo: 1, bar: 2 } },
            ],
          },
        },
      ]);
      expect(md).toContain('**CustomTool** (foo, bar)');
    });

    it('renders TodoWrite with empty summary', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'TodoWrite', id: 'toolu_6', input: { todos: [] } },
            ],
          },
        },
      ]);
      expect(md).toContain('**TodoWrite**');
      // No key summary after TodoWrite
      expect(md).not.toContain('(todos)');
    });
  });

  describe('system records', async () => {
    it('renders turn_duration', async () => {
      const md = await render([
        { type: 'system', subtype: 'turn_duration', timestamp: '', duration: 4500 },
      ]);
      expect(md).toContain('*Turn completed (4500ms)*');
    });

    it('ignores system records without turn_duration subtype', async () => {
      const md = await render([
        { type: 'system', subtype: 'other', timestamp: '', data: 'ignored' },
      ]);
      expect(md).toContain('0 entries');
    });

    it('ignores turn_duration without a duration value', async () => {
      const md = await render([
        { type: 'system', subtype: 'turn_duration', timestamp: '' },
      ]);
      expect(md).toContain('0 entries');
    });
  });

  describe('empty and missing content', async () => {
    it('handles empty JSONL file', async () => {
      const md = await render([]);
      expect(md).toContain('0 entries');
      expect(md).toContain('# Session Transcript');
    });

    it('skips malformed JSON lines', async () => {
      const jsonlPath = path.join(tmpDir, 'bad.jsonl');
      fs.writeFileSync(jsonlPath, 'not json\n{"type":"user","timestamp":"","message":{"content":[{"type":"text","text":"ok"}]}}\n');
      const workspace = path.join(tmpDir, 'ws2');
      fs.mkdirSync(workspace, { recursive: true });
      const outputPath = await renderTranscript(jsonlPath, 'sess', workspace);
      const md = fs.readFileSync(outputPath, 'utf-8');
      expect(md).toContain('1 entries');
      expect(md).toContain('ok');
    });

    it('skips blank lines', async () => {
      const jsonlPath = path.join(tmpDir, 'blanks.jsonl');
      fs.writeFileSync(jsonlPath, '\n\n{"type":"user","timestamp":"","message":{"content":[{"type":"text","text":"hi"}]}}\n\n');
      const workspace = path.join(tmpDir, 'ws3');
      fs.mkdirSync(workspace, { recursive: true });
      const outputPath = await renderTranscript(jsonlPath, 'sess', workspace);
      const md = fs.readFileSync(outputPath, 'utf-8');
      expect(md).toContain('1 entries');
    });

    it('returns empty entries for non-existent file', async () => {
      const workspace = path.join(tmpDir, 'ws4');
      fs.mkdirSync(workspace, { recursive: true });
      const outputPath = await renderTranscript('/nonexistent/path.jsonl', 'sess', workspace);
      const md = fs.readFileSync(outputPath, 'utf-8');
      expect(md).toContain('0 entries');
    });

    it('handles user record with no message', async () => {
      const md = await render([{ type: 'user', timestamp: '' }]);
      expect(md).toContain('0 entries');
    });

    it('handles assistant record with empty content array', async () => {
      const md = await render([
        { type: 'assistant', timestamp: '', message: { content: [] } },
      ]);
      expect(md).toContain('0 entries');
    });
  });

  describe('large file handling (50MB cap)', async () => {
    it('truncates files over 50MB by reading only the tail', async () => {
      const jsonlPath = path.join(tmpDir, 'large.jsonl');
      const fd = fs.openSync(jsonlPath, 'w');

      // Write ~51MB of padding lines
      const paddingLine = JSON.stringify({
        type: 'user',
        timestamp: '',
        message: { content: [{ type: 'text', text: 'padding-' + 'x'.repeat(200) }] },
      }) + '\n';
      const targetBytes = 51 * 1024 * 1024;
      let written = 0;
      while (written < targetBytes) {
        fs.writeSync(fd, paddingLine);
        written += Buffer.byteLength(paddingLine);
      }

      // Write a sentinel line at the end
      const sentinel = JSON.stringify({
        type: 'user',
        timestamp: '',
        message: { content: [{ type: 'text', text: 'SENTINEL_MARKER' }] },
      }) + '\n';
      fs.writeSync(fd, sentinel);
      fs.closeSync(fd);

      const workspace = path.join(tmpDir, 'ws-large');
      fs.mkdirSync(workspace, { recursive: true });
      const outputPath = await renderTranscript(jsonlPath, 'sess-large', workspace);
      const md = fs.readFileSync(outputPath, 'utf-8');

      // Sentinel should be present (it's in the last 50MB)
      expect(md).toContain('SENTINEL_MARKER');
    }, 30_000);
  });

  describe('multiple entries ordering', async () => {
    it('preserves entry order in output', async () => {
      const md = await render([
        {
          type: 'user',
          timestamp: '2026-03-11T10:00:00Z',
          message: { content: [{ type: 'text', text: 'First' }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-03-11T10:00:01Z',
          message: { content: [{ type: 'text', text: 'Second' }] },
        },
        { type: 'system', subtype: 'turn_duration', timestamp: '', duration: 1000 },
        {
          type: 'user',
          timestamp: '2026-03-11T10:01:00Z',
          message: { content: [{ type: 'text', text: 'Third' }] },
        },
      ]);

      const firstIdx = md.indexOf('First');
      const secondIdx = md.indexOf('Second');
      const turnIdx = md.indexOf('Turn completed');
      const thirdIdx = md.indexOf('Third');
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(turnIdx);
      expect(turnIdx).toBeLessThan(thirdIdx);
      expect(md).toContain('4 entries');
    });
  });

  describe('tool_use edge cases', async () => {
    it('handles tool_use with no input', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [{ type: 'tool_use', name: 'Read', id: 'toolu_1' }],
          },
        },
      ]);
      expect(md).toContain('**Read**');
    });

    it('handles Edit and Write tools', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', id: 'toolu_e', input: { file_path: '/a/b/c.ts' } },
              { type: 'tool_use', name: 'Write', id: 'toolu_w', input: { file_path: '/x/y.json' } },
            ],
          },
        },
      ]);
      expect(md).toContain('**Edit** `c.ts`');
      expect(md).toContain('**Write** `y.json`');
    });

    it('handles Glob tool', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Glob', id: 'toolu_g', input: { pattern: '**/*.ts' } },
            ],
          },
        },
      ]);
      expect(md).toContain('`**/*.ts`');
    });

    it('handles Agent/Task tool', async () => {
      const md = await render([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Agent', id: 'toolu_a', input: { prompt: 'Find all tests' } },
            ],
          },
        },
      ]);
      expect(md).toContain('Find all tests');
    });
  });
});
