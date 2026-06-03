import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractWorkflowMeta, extractAgentCalls, matchAgentCall } from './workflowScript.js';

function loadScript(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '__fixtures__', 'workflows', 'scripts', name), 'utf8');
}

describe('extractWorkflowMeta', () => {
  it('extracts name + phases from a real script (consistency audit)', () => {
    const meta = extractWorkflowMeta(loadScript('serac-plan-consistency-audit-wf_889eb23a-c48.js'));
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('serac-plan-consistency-audit');
    expect(meta!.description).toContain('Audit plan + mockup');
    expect(meta!.phases.map(p => p.title)).toEqual(['Audit', 'Synthesise']);
    expect(meta!.phases[0].detail).toContain('parallel');
  });

  it('stops at the meta literal and is not confused by later braces / template literals', () => {
    const src = [
      "export const meta = {",
      "  name: 'x',",
      "  description: 'd',",
      "  phases: [{ title: 'P1' }, { title: 'P2', detail: 'two' }],",
      "}",
      "const big = `a template with { braces } and ${'interp'}`",
      "phase('P1')",
      "await agent('do a thing', { label: 'a:b', phase: 'P1' })",
    ].join('\n');
    const meta = extractWorkflowMeta(src);
    expect(meta!.name).toBe('x');
    expect(meta!.phases).toEqual([{ title: 'P1' }, { title: 'P2', detail: 'two' }]);
  });

  it('returns null when there is no meta export', () => {
    expect(extractWorkflowMeta('const x = 1')).toBeNull();
    expect(extractWorkflowMeta('export const meta = { description: "no name" }')).toBeNull();
  });

  it('keeps phases whose title/detail contain brace characters', () => {
    // A naive /\{[^}]*\}/ object scan truncates at the first '}' inside a string,
    // dropping or corrupting the phase. The quote-aware walk must survive it.
    const src = [
      "export const meta = {",
      "  name: 'braces',",
      "  description: 'd',",
      "  phases: [",
      "    { title: 'Build {x}', detail: 'emit ${y} and } close' },",
      "    { title: 'Ship' },",
      "  ],",
      "}",
    ].join('\n');
    const meta = extractWorkflowMeta(src);
    expect(meta!.phases).toEqual([
      { title: 'Build {x}', detail: 'emit ${y} and } close' },
      { title: 'Ship' },
    ]);
  });

  it('decodes escaped quotes and whitespace escapes in string fields', () => {
    const src = [
      "export const meta = {",
      "  name: 'audit',",
      "  description: 'O\\'Brien\\'s run',",
      "  phases: [{ title: 'Line\\nbreak', detail: 'a\\ttab' }],",
      "}",
    ].join('\n');
    const meta = extractWorkflowMeta(src);
    expect(meta!.description).toBe("O'Brien's run");
    expect(meta!.phases[0]).toEqual({ title: 'Line\nbreak', detail: 'a\ttab' });
  });
});

describe('extractAgentCalls', () => {
  it('extracts label + phase + static prompt segments from a real script', () => {
    const calls = extractAgentCalls(loadScript('serac-plan-consistency-audit-wf_889eb23a-c48.js'));
    expect(calls.map(c => c.label)).toEqual(['audit:plan', 'audit:mockup', 'audit:backlog+xref', 'synthesis']);
    expect(calls.map(c => c.phase)).toEqual(['Audit', 'Audit', 'Audit', 'Synthesise']);
    // Each prompt leads with a distinctive static head before the ${SPEC} interp.
    expect(calls[0].staticSegments[0]).toContain('Audit the PLAN file ONLY');
    expect(calls[3].staticSegments[0]).toContain('Consolidate these three audit reports');
  });

  it('splits a template literal on interpolations and keeps only distinctive segments', () => {
    const src = "agent(`${CTX}\\n\\nReview the auth module for race conditions here.`, { label: 'r', phase: 'Review' })";
    const [call] = extractAgentCalls(src);
    expect(call.label).toBe('r');
    expect(call.phase).toBe('Review');
    // Leading ${CTX} yields an empty head segment (dropped); the tail survives.
    expect(call.staticSegments).toEqual(['\n\nReview the auth module for race conditions here.']);
  });

  it('returns no segments for a bare-expression prompt (unmatchable loop var)', () => {
    const [call] = extractAgentCalls("agent(c.prompt, { phase: 'Verify' })");
    expect(call.phase).toBe('Verify');
    expect(call.label).toBeNull();
    expect(call.staticSegments).toEqual([]);
  });

  it('handles a plain single-quoted prompt and an opts-less call', () => {
    const calls = extractAgentCalls("agent('do the distinctive thing now', { label: 'x' })\nagent('another distinctive task here')");
    expect(calls[0].staticSegments).toEqual(['do the distinctive thing now']);
    expect(calls[0].label).toBe('x');
    expect(calls[1].label).toBeNull();
    expect(calls[1].phase).toBeNull();
    expect(calls[1].staticSegments).toEqual(['another distinctive task here']);
  });

  it('does not pull label/phase out of the prompt body, only the opts object', () => {
    // The prompt text mentions "phase:" and "label:" — these must NOT leak in.
    const src = "agent(`Explain the label: and phase: fields in detail please`, { phase: 'Real' })";
    const [call] = extractAgentCalls(src);
    expect(call.phase).toBe('Real');
    expect(call.label).toBeNull();
  });
});

describe('matchAgentCall', () => {
  const calls = [
    { label: 'review', phase: 'Review', staticSegments: ['Carefully review the authentication module for bugs'] },
    { label: 'verify', phase: 'Verify', staticSegments: ['Verify the populated list and report any discrepancies'] },
  ];

  it('matches the call whose static segment appears in the expanded prompt', () => {
    const prompt = 'CONTEXT...\n\nCarefully review the authentication module for bugs\n\n(more)';
    expect(matchAgentCall(prompt, calls)!.phase).toBe('Review');
  });

  it('returns null when no segment matches', () => {
    expect(matchAgentCall('a wholly unrelated dynamic prompt', calls)).toBeNull();
  });

  it('prefers the call with the longest matched segment when several match', () => {
    const ambiguous = [
      { label: 'short', phase: 'A', staticSegments: ['shared distinctive prefix'] },
      { label: 'long', phase: 'B', staticSegments: ['shared distinctive prefix that continues much further'] },
    ];
    const prompt = 'x: shared distinctive prefix that continues much further — y';
    expect(matchAgentCall(prompt, ambiguous)!.label).toBe('long');
  });
});
