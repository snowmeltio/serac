import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode
vi.mock('vscode', () => ({
  env: { language: 'en-AU' },
}));

const { renderTranscript, parseTranscript } = await import('./transcriptRenderer.js');

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

    it('renders a string-typed message.content (workflow/agent inception brief)', async () => {
      // record-0 of a workflow agent carries the brief as a plain string, not a
      // block array. It must surface as a user turn, not be dropped or iterated
      // character-by-character.
      const md = await render([
        {
          type: 'user',
          timestamp: '2026-03-11T10:00:00Z',
          message: { content: 'Audit the codebase for security issues.' },
        },
      ]);
      expect(md).toContain('### You');
      expect(md).toContain('Audit the codebase for security issues.');
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

    it('collapses internal whitespace so a multi-line result stays one tool line', async () => {
      // WebSearch results are shaped `…query…\n\nLinks: […]`. A short query puts
      // the newline inside the 200-char window; without collapsing, the tail
      // spills into a second block in the reader. Assert the summary is a single
      // `> ` line with no embedded newline.
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '2026-06-18T10:00:00Z',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_016B6c123456789',
                content: 'Web search results for query: "EMDG tiers"\n\nLinks: [{"title":"Austrade"}]',
              },
            ],
          },
        },
      ]));
      expect(entries).toHaveLength(1);
      const body = entries[0].content;
      // Single tool line: starts with the blockquote marker, no newline within.
      expect(body.startsWith('> **Tool result**')).toBe(true);
      expect(body).not.toContain('\n');
      expect(body).toContain('Web search results for query: "EMDG tiers" Links: [{"title":"Austrade"}]');
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

    it('gives a tool_result-only user record the tool role, not user', async () => {
      // tool_result blocks ride back to the assistant inside user-role records;
      // labelling them "prompt"/"You" misreads the conversation direction.
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '2026-06-10T10:00:00Z',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_abc123456789', content: 'grep output' }] },
        },
      ]));
      expect(entries).toHaveLength(1);
      expect(entries[0].role).toBe('tool');
      expect(entries[0].content).toContain('grep output');
    });

    it('keeps the user role when a record carries genuine prompt text alongside tool results', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '2026-06-10T10:00:00Z',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_abc123456789', content: 'grep output' },
              { type: 'text', text: 'Also, please check the README.' },
            ],
          },
        },
      ]));
      expect(entries).toHaveLength(1);
      expect(entries[0].role).toBe('user');
    });

    it('renders a tool-role entry in markdown without the "### You" heading', async () => {
      const md = await render([
        {
          type: 'user',
          timestamp: '',
          message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_abc123456789', content: 'grep output' }] },
        },
      ]);
      expect(md).toContain('**Tool result**');
      expect(md).not.toContain('### You');
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

  // Phase 1 of the detail-pane v2 rework (DESIGN-DETAIL-PANE-V2.md): additive
  // structured fields on TranscriptEntry, invisible to the chat renderer above
  // (its `content`/`role` assertions are all unmodified). These exercise
  // entryFromRecord() directly via parseTranscript() so the new fields are
  // easy to assert on without scraping markdown.
  describe('Phase 1: structured fields (kind/toolName/rawInput/rawOutput/isError)', async () => {
    it('tags a genuine user prompt as kind text', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '2026-07-01T10:00:00Z',
          message: { content: [{ type: 'text', text: 'Please refactor this.' }] },
        },
      ]));
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe('text');
      expect(entries[0].toolName).toBeUndefined();
    });

    it('tags a tool_result-only user record as kind tool_result and populates rawOutput/isError', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '2026-07-01T10:00:01Z',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_ok1', content: 'build succeeded', is_error: false },
            ],
          },
        },
      ]));
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe('tool_result');
      expect(entries[0].rawOutput).toBe('build succeeded');
      expect(entries[0].isError).toBe(false);
      // A LONE tool_result has no preceding tool_use in the file, so the
      // Phase 2.1 name correlation misses and toolName stays unset — the
      // pre-2.1 shape (see the correlation describe below for the hit case).
      expect(entries[0].toolName).toBeUndefined();
    });

    it('sets isError true for a failing tool_result', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_fail1', content: 'Exit code 1\nboom', is_error: true },
            ],
          },
        },
      ]));
      expect(entries[0].isError).toBe(true);
      expect(entries[0].rawOutput).toBe('Exit code 1\nboom');
    });

    it('leaves isError unset when the tool_result carries no is_error field', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_noflag', content: 'ok' }],
          },
        },
      ]));
      expect(entries[0].isError).toBeUndefined();
    });

    it('extracts rawOutput from an array-shaped tool_result content, untruncated (unlike the 200-char content summary)', async () => {
      const longText = 'y'.repeat(500);
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_long1',
                content: [{ type: 'text', text: longText }],
              },
            ],
          },
        },
      ]));
      expect(entries[0].rawOutput).toBe(longText);
      expect(entries[0].rawOutput!.length).toBe(500);
      // The display `content` field is still truncated to 200 chars, unchanged.
      expect(entries[0].content).toContain('...');
    });

    it('tags an assistant tool_use record as kind tool_use with toolName and rawInput', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', id: 'toolu_bash1', input: { command: 'npm test' } },
            ],
          },
        },
      ]));
      expect(entries[0].kind).toBe('tool_use');
      expect(entries[0].toolName).toBe('Bash');
      expect(entries[0].rawInput).toBe(JSON.stringify({ command: 'npm test' }));
    });

    it('tags a Task/Agent tool_use record as kind task', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Task', id: 'toolu_task1', input: { description: 'Audit code' } },
            ],
          },
        },
      ]));
      expect(entries[0].kind).toBe('task');
      expect(entries[0].toolName).toBe('Task');
    });

    it('tags an assistant text-only record as kind text with no toolName', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'assistant',
          timestamp: '',
          message: { content: [{ type: 'text', text: 'Done.' }] },
        },
      ]));
      expect(entries[0].kind).toBe('text');
      expect(entries[0].toolName).toBeUndefined();
      expect(entries[0].rawInput).toBeUndefined();
    });

    it('leaves rawInput unset for a tool_use with no input', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'assistant',
          timestamp: '',
          message: { content: [{ type: 'tool_use', name: 'Read', id: 'toolu_r1' }] },
        },
      ]));
      expect(entries[0].kind).toBe('tool_use');
      expect(entries[0].toolName).toBe('Read');
      expect(entries[0].rawInput).toBeUndefined();
    });

    it('caps rawInput at 64KB (65536 chars)', async () => {
      const hugeCommand = 'z'.repeat(70000);
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', id: 'toolu_huge1', input: { command: hugeCommand } },
            ],
          },
        },
      ]));
      expect(entries[0].rawInput!.length).toBe(65536);
    });

    it('caps rawOutput at 64KB (65536 chars)', async () => {
      const hugeOutput = 'w'.repeat(70000);
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'user',
          timestamp: '',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_huge2', content: hugeOutput }],
          },
        },
      ]));
      expect(entries[0].rawOutput!.length).toBe(65536);
    });

    it('leaves kind unset for a turn_duration system record', async () => {
      const entries = await parseTranscript(writeJsonl([
        { type: 'system', subtype: 'turn_duration', timestamp: '', duration: 1200 },
      ]));
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBeUndefined();
    });
  });

  // Phase 2.1: tool_use id → name correlation. entryFromRecord's optional
  // toolNameById map is fed by assistant records and read by tool_result
  // records; parseTranscript threads a per-file map through in record order.
  describe('Phase 2.1: tool_result name correlation (toolNameById)', async () => {
    const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
      type: 'assistant',
      timestamp: '2026-07-02T10:00:00Z',
      message: { content: [{ type: 'tool_use', name, id, input }] },
    });
    const toolResult = (id: string, output: string) => ({
      type: 'user',
      timestamp: '2026-07-02T10:00:01Z',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] },
    });

    it('names a tool_result from the preceding assistant tool_use', async () => {
      const entries = await parseTranscript(writeJsonl([
        toolUse('toolu_grep1', 'Grep', { pattern: 'foo' }),
        toolResult('toolu_grep1', '878 src/detailPanel.ts'),
      ]));
      expect(entries).toHaveLength(2);
      expect(entries[1].kind).toBe('tool_result');
      expect(entries[1].toolName).toBe('Grep');
    });

    it('leaves content byte-identical — only toolName is new', async () => {
      // The markdown exporter and the classic chat renderer both consume
      // `content`; correlation must never touch it.
      const entries = await parseTranscript(writeJsonl([
        toolUse('toolu_b1', 'Bash', { command: 'ls' }),
        toolResult('toolu_b1', 'file-list output'),
      ]));
      expect(entries[1].content).toBe('> **Tool result** (toolu_b1...): file-list output');
    });

    it('names results of PARALLEL tool_use blocks (every block registered, not just the first)', async () => {
      const entries = await parseTranscript(writeJsonl([
        {
          type: 'assistant',
          timestamp: '',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', id: 'toolu_p1', input: { file_path: '/a.ts' } },
              { type: 'tool_use', name: 'Grep', id: 'toolu_p2', input: { pattern: 'x' } },
            ],
          },
        },
        toolResult('toolu_p1', 'contents of a.ts'),
        toolResult('toolu_p2', '3 matches'),
      ]));
      expect(entries[1].toolName).toBe('Read');
      expect(entries[2].toolName).toBe('Grep');
    });

    it('a result whose tool_use id is unknown stays unnamed (correlation miss)', async () => {
      const entries = await parseTranscript(writeJsonl([
        toolUse('toolu_known', 'Bash'),
        toolResult('toolu_UNKNOWN', 'orphan output'),
      ]));
      expect(entries[1].toolName).toBeUndefined();
    });

    it('entryFromRecord without a map keeps the pre-2.1 shape (param is optional)', async () => {
      const { entryFromRecord } = await import('./transcriptRenderer.js');
      const { validateRecord } = await import('./jsonlValidator.js');
      const rec = validateRecord({
        type: 'user',
        timestamp: '',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
      })!;
      const entry = entryFromRecord(rec)!;
      expect(entry.kind).toBe('tool_result');
      expect(entry.toolName).toBeUndefined();
    });
  });
});
