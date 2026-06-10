import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractWorkflowMeta, extractAgentCalls, matchAgentCall, recoverInterpolatedLabel, _matchStringFieldForTest, type WorkflowAgentCall } from './workflowScript.js';

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

  it('does not let a "phases: [" inside the description string steal the real phases', () => {
    // A naive /phases\s*:\s*\[/ scan matches the literal inside the description
    // first, then balances against the wrong bracket and drops the real phases.
    const src = [
      "export const meta = {",
      "  name: 'x',",
      "  description: 'we run phases: [discover, verify] across teams',",
      "  phases: [{ title: 'Real' }],",
      "}",
    ].join('\n');
    const meta = extractWorkflowMeta(src);
    expect(meta!.phases).toEqual([{ title: 'Real' }]);
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

  it('stays linear on a backslash run with no closing quote (ReDoS regression)', () => {
    // The old `(?:\\.|(?!\1).)*` body alternation was ambiguous over backslash
    // runs — each pair doubled the backtracking (exponential; ~10ms at 28,
    // host-freezing by ~60). The disjoint form must stay flat at any length.
    // Tested via the private matcher: public callers pre-balance their text,
    // so the no-close failure path can't be reached through extractAgentCalls.
    const evil = 'label: `' + '\\'.repeat(5000);
    const t0 = Date.now();
    expect(_matchStringFieldForTest(evil, 'label')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
    // And the success paths still decode as before.
    expect(_matchStringFieldForTest("label: 'it\\'s'", 'label')).toBe("it's");
    expect(_matchStringFieldForTest('label: `audit:${d.key}`', 'label')).toBe('audit:${d.key}');
  });

  it('ignores a phantom agent( written inside a string/template literal', () => {
    // A decoy `agent(...)` embedded in another prompt's text must not register
    // as its own call site (the /\bagent\s*\(/ scan would otherwise match it).
    const src = "const SPEC = `... agent('decoy long literal here now', { phase: 'Decoy' }) ...`;\nawait agent(`real distinctive head segment`, { label: 'r' })";
    const calls = extractAgentCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0].label).toBe('r');
  });
});

describe('matchAgentCall', () => {
  const calls: WorkflowAgentCall[] = [
    { label: 'review', phase: 'Review', staticSegments: ['Carefully review the authentication module for bugs'], promptTemplate: null, labelTemplate: null },
    { label: 'verify', phase: 'Verify', staticSegments: ['Verify the populated list and report any discrepancies'], promptTemplate: null, labelTemplate: null },
  ];

  it('matches the call whose static segment appears in the expanded prompt', () => {
    const prompt = 'CONTEXT...\n\nCarefully review the authentication module for bugs\n\n(more)';
    expect(matchAgentCall(prompt, calls)!.phase).toBe('Review');
  });

  it('returns null when no segment matches', () => {
    expect(matchAgentCall('a wholly unrelated dynamic prompt', calls)).toBeNull();
  });

  it('prefers the call with the longest matched segment when several match', () => {
    const ambiguous: WorkflowAgentCall[] = [
      { label: 'short', phase: 'A', staticSegments: ['shared distinctive prefix'], promptTemplate: null, labelTemplate: null },
      { label: 'long', phase: 'B', staticSegments: ['shared distinctive prefix that continues much further'], promptTemplate: null, labelTemplate: null },
    ];
    const prompt = 'x: shared distinctive prefix that continues much further — y';
    expect(matchAgentCall(prompt, ambiguous)!.label).toBe('long');
  });
});

describe('extractAgentCalls — template parts for interpolation recovery', () => {
  it('captures the prompt template parts and an interpolated label template', () => {
    const src = "agent(`=== YOUR DIMENSION: ${d.key} ===\\n\\nAudit it thoroughly here.`, { label: `audit:${d.key}`, phase: 'Audit' })";
    const [call] = extractAgentCalls(src);
    // The label keeps its raw template (resolved later, not at extraction time).
    expect(call.label).toBe('audit:${d.key}');
    expect(call.labelTemplate).toEqual({ statics: ['audit:', ''], exprs: ['d.key'] });
    // The prompt template exposes the same expr, bracketed by static anchors.
    expect(call.promptTemplate!.exprs).toEqual(['d.key']);
    expect(call.promptTemplate!.statics[0]).toBe('=== YOUR DIMENSION: ');
    expect(call.promptTemplate!.statics[1].startsWith(' ===')).toBe(true);
  });

  it('leaves labelTemplate null for a plain literal label', () => {
    const [call] = extractAgentCalls("agent('a distinctive plain prompt here', { label: 'review:auth' })");
    expect(call.label).toBe('review:auth');
    expect(call.labelTemplate).toBeNull();
  });
});

describe('recoverInterpolatedLabel', () => {
  // Mirrors the real fan-out shape: one agent() call site, distinct ${d.key}
  // per agent. Build the call once, recover per expanded prompt.
  const [call] = extractAgentCalls(
    "agent(`=== YOUR DIMENSION: ${d.key} ===\\n\\nAudit this dimension in depth.`, { label: `audit:${d.key}`, phase: 'Audit' })",
  );

  it('recovers the per-agent interpolated value from the expanded prompt', () => {
    const prompt = 'CONTEXT…\n\n=== YOUR DIMENSION: privacy ===\n\nAudit this dimension in depth.';
    expect(recoverInterpolatedLabel(call, prompt)).toBe('audit:privacy');
  });

  it('yields distinct labels for distinct fan-out agents from one call site', () => {
    const mk = (k: string) => `=== YOUR DIMENSION: ${k} ===\n\nAudit this dimension in depth.`;
    expect(recoverInterpolatedLabel(call, mk('security'))).toBe('audit:security');
    expect(recoverInterpolatedLabel(call, mk('performance'))).toBe('audit:performance');
  });

  it('returns null for a plain (non-interpolated) label', () => {
    const [plain] = extractAgentCalls("agent('a distinctive plain prompt here', { label: 'audit:plan' })");
    expect(recoverInterpolatedLabel(plain, 'a distinctive plain prompt here')).toBeNull();
  });

  it('returns null when the static anchors cannot be aligned to the prompt', () => {
    expect(recoverInterpolatedLabel(call, 'a wholly unrelated prompt with no dimension marker')).toBeNull();
  });

  it('returns null when the label uses an expr the prompt never exposes', () => {
    // Label interpolates ${d.name}; the prompt only ever exposes ${d.key}.
    const [c] = extractAgentCalls(
      "agent(`=== YOUR DIMENSION: ${d.key} ===\\n\\ndistinctive body text here`, { label: `audit:${d.name}` })",
    );
    expect(recoverInterpolatedLabel(c, '=== YOUR DIMENSION: privacy ===\n\ndistinctive body text here')).toBeNull();
  });

  it('never emits a raw ${…} even when recovery partially fails', () => {
    const out = recoverInterpolatedLabel(call, 'no anchors at all');
    expect(out === null || !out.includes('${')).toBe(true);
  });
});
