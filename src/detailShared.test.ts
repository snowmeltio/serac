import { describe, it, expect } from 'vitest';
import { fmtTokens, fmtDuration, fmtAge, formatModelLabel, transcriptKey, parseEditInput, unframeComputedTask, unframeWorkflowText } from './detailShared.js';

describe('formatModelLabel', () => {
  it('derives tier + version from modern ids, stripping [1m] and date stamps', () => {
    expect(formatModelLabel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(formatModelLabel('claude-opus-4-8[1m]')).toBe('Opus 4.8');
    expect(formatModelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('handles legacy version-first ids and unfamiliar tiers', () => {
    expect(formatModelLabel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5');
  });

  it('degrades to the bare tier for aliases, empty for no input', () => {
    expect(formatModelLabel('sonnet')).toBe('Sonnet');
    expect(formatModelLabel('opus')).toBe('Opus');
    expect(formatModelLabel('')).toBe('');
  });
});

describe('fmtTokens', () => {
  it('passes small counts through and abbreviates thousands', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(12345)).toBe('12k');
  });
});

describe('fmtAge', () => {
  it('counts up from 0s, drops seconds past the hour, and clamps negative/non-finite to 0s', () => {
    expect(fmtAge(0)).toBe('0s');
    expect(fmtAge(999)).toBe('0s');
    expect(fmtAge(14_000)).toBe('14s');
    expect(fmtAge(120_000)).toBe('2m');
    expect(fmtAge(134_000)).toBe('2m 14s');
    expect(fmtAge(3_600_000)).toBe('1h');
    expect(fmtAge(3 * 3_600_000 + 5 * 60_000 + 59_000)).toBe('3h 5m');
    expect(fmtAge(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h');
    expect(fmtAge(86_400_000)).toBe('1d');
    expect(fmtAge(-5_000)).toBe('0s');
    expect(fmtAge(NaN)).toBe('0s');
  });
});

describe('fmtDuration', () => {
  it('formats seconds and minute combinations, empty for null/zero', () => {
    expect(fmtDuration(null)).toBe('');
    expect(fmtDuration(0)).toBe('');
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(60_000)).toBe('1m');
    expect(fmtDuration(90_000)).toBe('1m 30s');
  });
});

describe('transcriptKey', () => {
  it('is owner-prefixed so identical agent ids in different containers cannot collide', () => {
    const a = transcriptKey('team', 'at:alpha', '', 'defender');
    const b = transcriptKey('team', 'at:beta', '', 'defender');
    expect(a).not.toBe(b);
    expect(a).toBe('team:at:alpha||defender');
  });
});

describe('parseEditInput', () => {
  it('parses a valid two-sided Edit input', () => {
    const raw = JSON.stringify({ file_path: '/a/b.ts', old_string: 'foo', new_string: 'bar' });
    expect(parseEditInput(raw)).toEqual({ filePath: '/a/b.ts', oldString: 'foo', newString: 'bar' });
  });

  it('rejects malformed JSON', () => {
    expect(parseEditInput('{not json')).toBeNull();
  });

  it('rejects a non-object JSON value', () => {
    expect(parseEditInput('"just a string"')).toBeNull();
    expect(parseEditInput('42')).toBeNull();
  });

  it('rejects a Write-shaped input (no old_string)', () => {
    const raw = JSON.stringify({ file_path: '/a/b.ts', content: 'whole file' });
    expect(parseEditInput(raw)).toBeNull();
  });

  it('rejects an empty file_path', () => {
    const raw = JSON.stringify({ file_path: '', old_string: 'a', new_string: 'b' });
    expect(parseEditInput(raw)).toBeNull();
  });

  it('rejects non-string old_string/new_string', () => {
    const raw = JSON.stringify({ file_path: '/a/b.ts', old_string: 1, new_string: 'b' });
    expect(parseEditInput(raw)).toBeNull();
  });
});

// Trimmed from wwa-s17-messaging-groundwork (CLI 2.1.304), 2026-10-21.
describe('workflow harness frames', () => {
  const TASK = '[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. '
    + 'The harness indents every line of the computed text. The computed task text follows:\n  \n  Context: Snowmelt is building WWA.\n  TASK (label: sources): study it.';
  const RELAY = '[Workflow harness — user request] The harness relays, verbatim and indented below, the user request.\n  (4) I want the formatting clean.\n  Also mine WhatsApp.';

  it('unframeComputedTask returns the script text without frame or indent', () => {
    expect(unframeComputedTask(TASK)).toBe('Context: Snowmelt is building WWA.\nTASK (label: sources): study it.');
    expect(unframeComputedTask(RELAY)).toBeNull();
    expect(unframeComputedTask('plain prompt')).toBeNull();
  });

  it('unframeWorkflowText names the frame and strips the boilerplate for every kind', () => {
    expect(unframeWorkflowText(TASK)).toEqual({ kind: 'computed task', body: 'Context: Snowmelt is building WWA.\nTASK (label: sources): study it.' });
    expect(unframeWorkflowText(RELAY)).toEqual({ kind: 'user request', body: '(4) I want the formatting clean.\nAlso mine WhatsApp.' });
    expect(unframeWorkflowText('plain prompt')).toBeNull();
  });
});
