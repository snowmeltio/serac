import { describe, it, expect } from 'vitest';
import { extractEvidence, TEST_RUNNER_PATTERNS } from './evidenceExtractor.js';
import type { JsonlRecord } from './types.js';

// Fixtures below mirror real record shapes seen under ~/.claude/projects/
// (anonymised); see evidenceExtractor.ts's doc comment for the Bash
// exit-status verification this module's pairing logic is based on.

function assistantToolUse(name: string, id: string, input?: Record<string, unknown>): JsonlRecord {
  return {
    type: 'assistant',
    timestamp: '2026-07-01T10:00:00Z',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  } as unknown as JsonlRecord;
}

function assistantText(text: string, timestamp = '2026-07-01T10:00:00Z'): JsonlRecord {
  return {
    type: 'assistant',
    timestamp,
    message: { content: [{ type: 'text', text }] },
  } as unknown as JsonlRecord;
}

function toolResult(toolUseId: string, content: string, isError?: boolean): JsonlRecord {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: toolUseId, content };
  if (isError !== undefined) { block.is_error = isError; }
  return {
    type: 'user',
    timestamp: '2026-07-01T10:00:01Z',
    message: { content: [block] },
  } as unknown as JsonlRecord;
}

describe('extractEvidence', () => {
  describe('filesTouched', () => {
    it('extracts an Edit touch with approx line deltas from old_string/new_string', () => {
      const evidence = extractEvidence([
        assistantToolUse('Edit', 'toolu_e1', {
          file_path: '/repo/src/foo.ts',
          old_string: 'line1\nline2',
          new_string: 'line1\nline2\nline3\nline4',
        }),
      ]);
      expect(evidence.filesTouched).toEqual([
        { path: '/repo/src/foo.ts', kind: 'edit', approxAdded: 4, approxRemoved: 2 },
      ]);
    });

    it('extracts a Write touch, counting content lines as added with removed null', () => {
      const evidence = extractEvidence([
        assistantToolUse('Write', 'toolu_w1', {
          file_path: '/repo/src/new.ts',
          content: 'export const a = 1;\nexport const b = 2;',
        }),
      ]);
      expect(evidence.filesTouched).toEqual([
        { path: '/repo/src/new.ts', kind: 'write', approxAdded: 2, approxRemoved: null },
      ]);
    });

    it('extracts a NotebookEdit touch from new_source', () => {
      const evidence = extractEvidence([
        assistantToolUse('NotebookEdit', 'toolu_n1', {
          notebook_path: '/repo/analysis.ipynb',
          cell_id: 'cell-3',
          new_source: 'import pandas as pd\ndf = pd.read_csv("x.csv")',
          edit_mode: 'replace',
        }),
      ]);
      expect(evidence.filesTouched).toEqual([
        { path: '/repo/analysis.ipynb', kind: 'notebook', approxAdded: 2, approxRemoved: null },
      ]);
    });

    it('leaves approxAdded null for a NotebookEdit delete with no new_source', () => {
      const evidence = extractEvidence([
        assistantToolUse('NotebookEdit', 'toolu_n2', {
          notebook_path: '/repo/analysis.ipynb',
          cell_id: 'cell-3',
          edit_mode: 'delete',
        }),
      ]);
      expect(evidence.filesTouched).toEqual([
        { path: '/repo/analysis.ipynb', kind: 'notebook', approxAdded: null, approxRemoved: null },
      ]);
    });

    it('dedupes by path, summing deltas and keeping the most recent kind', () => {
      const evidence = extractEvidence([
        assistantToolUse('Edit', 'toolu_e1', {
          file_path: '/repo/src/foo.ts',
          old_string: 'a',
          new_string: 'a\nb',
        }),
        assistantToolUse('Edit', 'toolu_e2', {
          file_path: '/repo/src/foo.ts',
          old_string: 'a\nb',
          new_string: 'a\nb\nc\nd',
        }),
      ]);
      expect(evidence.filesTouched).toHaveLength(1);
      expect(evidence.filesTouched[0].path).toBe('/repo/src/foo.ts');
      expect(evidence.filesTouched[0].kind).toBe('edit');
      // First touch: +2/-1. Second touch: +4/-2. Summed: +6/-3.
      expect(evidence.filesTouched[0].approxAdded).toBe(6);
      expect(evidence.filesTouched[0].approxRemoved).toBe(3);
    });

    it('keeps the most recent kind when a path is touched by both Write and Edit', () => {
      const evidence = extractEvidence([
        assistantToolUse('Write', 'toolu_w1', { file_path: '/repo/x.ts', content: 'a\nb' }),
        assistantToolUse('Edit', 'toolu_e1', { file_path: '/repo/x.ts', old_string: 'a', new_string: 'a\nc' }),
      ]);
      expect(evidence.filesTouched).toHaveLength(1);
      expect(evidence.filesTouched[0].kind).toBe('edit');
      expect(evidence.filesTouched[0].approxAdded).toBe(4); // 2 (write) + 2 (edit new_string)
      expect(evidence.filesTouched[0].approxRemoved).toBe(1); // 0 (write) + 1 (edit old_string)
    });

    it('ignores an Edit/Write tool_use missing file_path', () => {
      const evidence = extractEvidence([
        assistantToolUse('Edit', 'toolu_e1', { old_string: 'a', new_string: 'b' }),
        assistantToolUse('Write', 'toolu_w1', { content: 'x' }),
      ]);
      expect(evidence.filesTouched).toEqual([]);
    });

    it('ignores non-file tools (Read, Grep, Bash) for filesTouched', () => {
      const evidence = extractEvidence([
        assistantToolUse('Read', 'toolu_r1', { file_path: '/repo/README.md' }),
        assistantToolUse('Grep', 'toolu_g1', { pattern: 'TODO' }),
      ]);
      expect(evidence.filesTouched).toEqual([]);
    });
  });

  describe('commandsRun', () => {
    it('pairs a Bash tool_use with a successful tool_result (is_error: false)', () => {
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_b1', { command: 'npm run build' }),
        toolResult('toolu_b1', '(Bash completed with no output)', false),
      ]);
      expect(evidence.commandsRun).toEqual([{ command: 'npm run build', exitOk: true }]);
    });

    it('pairs a Bash tool_use with a failing tool_result (is_error: true)', () => {
      // Real shape: content commonly leads with "Exit code N" prose, but
      // exitOk is derived from is_error, not string-sniffed.
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_b2', { command: 'git commit -m "wip"' }),
        toolResult('toolu_b2', 'Exit code 128\nfatal: not a git repository (or any of the parent directories): .git', true),
      ]);
      expect(evidence.commandsRun).toEqual([{ command: 'git commit -m "wip"', exitOk: false }]);
    });

    it('leaves exitOk null when no matching tool_result exists (denied/abandoned run)', () => {
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_b3', { command: 'rm -rf build/' }),
      ]);
      expect(evidence.commandsRun).toEqual([{ command: 'rm -rf build/', exitOk: null }]);
    });

    it('leaves exitOk null when the tool_result has no is_error field (ambiguous)', () => {
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_b4', { command: 'echo hi' }),
        toolResult('toolu_b4', 'hi'),
      ]);
      expect(evidence.commandsRun).toEqual([{ command: 'echo hi', exitOk: null }]);
    });

    it('does not let an unrelated tool_result resolve a different command', () => {
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_b5', { command: 'ls' }),
        toolResult('toolu_UNRELATED', 'some other result', true),
      ]);
      expect(evidence.commandsRun).toEqual([{ command: 'ls', exitOk: null }]);
    });

    it('preserves command order across multiple Bash calls', () => {
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_b6', { command: 'first' }),
        assistantToolUse('Bash', 'toolu_b7', { command: 'second' }),
        toolResult('toolu_b6', 'ok', false),
        toolResult('toolu_b7', 'ok', false),
      ]);
      expect(evidence.commandsRun.map(c => c.command)).toEqual(['first', 'second']);
    });

    it('defaults command to empty string when the Bash input has no command field', () => {
      const evidence = extractEvidence([assistantToolUse('Bash', 'toolu_b8', {})]);
      expect(evidence.commandsRun).toEqual([{ command: '', exitOk: null }]);
    });
  });

  describe('testsRun', () => {
    it.each([
      'npm test',
      'npm run test',
      'npx vitest run',
      'yarn jest --coverage',
      'pytest tests/',
      'go test ./...',
      'cargo test --release',
    ])('flags testsRun true for %s', (command) => {
      const evidence = extractEvidence([assistantToolUse('Bash', 'toolu_t1', { command })]);
      expect(evidence.testsRun).toBe(true);
    });

    it('flags testsRun false when no command matches a test runner', () => {
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_t2', { command: 'npm run build' }),
        assistantToolUse('Bash', 'toolu_t3', { command: 'ls -la' }),
      ]);
      expect(evidence.testsRun).toBe(false);
    });

    it('flags testsRun false when no commands were run at all', () => {
      const evidence = extractEvidence([assistantText('All done.')]);
      expect(evidence.testsRun).toBe(false);
    });

    it('exports TEST_RUNNER_PATTERNS with a label per pattern', () => {
      expect(TEST_RUNNER_PATTERNS.length).toBeGreaterThanOrEqual(6);
      for (const p of TEST_RUNNER_PATTERNS) {
        expect(typeof p.label).toBe('string');
        expect(p.pattern).toBeInstanceOf(RegExp);
      }
    });
  });

  describe('finalMessage', () => {
    it('returns the last assistant text in the stream', () => {
      const evidence = extractEvidence([
        assistantText('First I will read the file.'),
        assistantToolUse('Read', 'toolu_r1', { file_path: '/repo/a.ts' }),
        assistantText('All done, tests pass.'),
      ]);
      expect(evidence.finalMessage).toBe('All done, tests pass.');
    });

    it('joins multiple text blocks within the final assistant record', () => {
      const record: JsonlRecord = {
        type: 'assistant',
        timestamp: '2026-07-01T10:00:00Z',
        message: {
          content: [
            { type: 'text', text: 'Part one.' },
            { type: 'tool_use', name: 'Read', id: 'toolu_x', input: { file_path: '/a.ts' } },
            { type: 'text', text: 'Part two.' },
          ],
        },
      } as unknown as JsonlRecord;
      const evidence = extractEvidence([record]);
      expect(evidence.finalMessage).toBe('Part one.\n\nPart two.');
    });

    it('returns null when there is no assistant text anywhere', () => {
      const evidence = extractEvidence([
        assistantToolUse('Bash', 'toolu_b1', { command: 'ls' }),
        toolResult('toolu_b1', 'file.txt', false),
      ]);
      expect(evidence.finalMessage).toBeNull();
    });

    it('caps finalMessage at 64KB (65536 chars)', () => {
      const huge = 'm'.repeat(70000);
      const evidence = extractEvidence([assistantText(huge)]);
      expect(evidence.finalMessage!.length).toBe(65536);
    });

    it('does not let a later empty-text assistant record clobber an earlier real one', () => {
      const evidence = extractEvidence([
        assistantText('Real final answer.'),
        { type: 'assistant', timestamp: '', message: { content: [] } } as unknown as JsonlRecord,
      ]);
      expect(evidence.finalMessage).toBe('Real final answer.');
    });
  });

  describe('malformed/partial records, never throw', () => {
    it('skips null and non-object entries in the records array', () => {
      const evidence = extractEvidence([
        null as unknown as JsonlRecord,
        undefined as unknown as JsonlRecord,
        'not a record' as unknown as JsonlRecord,
        assistantText('Still works.'),
      ]);
      expect(evidence.finalMessage).toBe('Still works.');
    });

    it('skips assistant records with no message', () => {
      const evidence = extractEvidence([
        { type: 'assistant', timestamp: '' } as unknown as JsonlRecord,
        assistantText('Fine.'),
      ]);
      expect(evidence.finalMessage).toBe('Fine.');
    });

    it('skips a tool_use block with a non-object input', () => {
      const record: JsonlRecord = {
        type: 'assistant',
        timestamp: '',
        message: { content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_z1', input: 'not-an-object' as unknown as Record<string, unknown> }] },
      } as unknown as JsonlRecord;
      expect(() => extractEvidence([record])).not.toThrow();
      const evidence = extractEvidence([record]);
      expect(evidence.commandsRun).toEqual([{ command: '', exitOk: null }]);
    });

    it('returns empty evidence for an empty record array', () => {
      const evidence = extractEvidence([]);
      expect(evidence).toEqual({
        filesTouched: [],
        commandsRun: [],
        testsRun: false,
        finalMessage: null,
      });
    });

    it('returns empty evidence when records is not an array', () => {
      const evidence = extractEvidence(null as unknown as JsonlRecord[]);
      expect(evidence).toEqual({
        filesTouched: [],
        commandsRun: [],
        testsRun: false,
        finalMessage: null,
      });
    });

    it('handles a record with an unknown/unhandled type gracefully', () => {
      const evidence = extractEvidence([
        { type: 'queue-operation', timestamp: '', operation: 'dequeue' } as unknown as JsonlRecord,
        assistantText('Carries on.'),
      ]);
      expect(evidence.finalMessage).toBe('Carries on.');
    });
  });

  describe('realistic combined transcript', () => {
    it('extracts a coherent Evidence object from a mixed record stream', () => {
      const records: JsonlRecord[] = [
        assistantText('Investigating the failing build.'),
        assistantToolUse('Read', 'toolu_c1', { file_path: '/repo/package.json' }),
        toolResult('toolu_c1', '{"name":"demo"}', false),
        assistantToolUse('Edit', 'toolu_c2', {
          file_path: '/repo/src/index.ts',
          old_string: 'export const VERSION = "1.0.0";',
          new_string: 'export const VERSION = "1.0.1";\nexport const BUILD = Date.now();',
        }),
        assistantToolUse('Bash', 'toolu_c3', { command: 'npm run build' }),
        toolResult('toolu_c3', 'build ok', false),
        assistantToolUse('Bash', 'toolu_c4', { command: 'npm test' }),
        toolResult('toolu_c4', 'Exit code 1\n1 failing', true),
        assistantText('Build succeeds; one test still fails, needs a follow-up.'),
      ];

      const evidence = extractEvidence(records);

      expect(evidence.filesTouched).toEqual([
        { path: '/repo/src/index.ts', kind: 'edit', approxAdded: 2, approxRemoved: 1 },
      ]);
      expect(evidence.commandsRun).toEqual([
        { command: 'npm run build', exitOk: true },
        { command: 'npm test', exitOk: false },
      ]);
      expect(evidence.testsRun).toBe(true);
      expect(evidence.finalMessage).toBe('Build succeeds; one test still fails, needs a follow-up.');
    });
  });
});
