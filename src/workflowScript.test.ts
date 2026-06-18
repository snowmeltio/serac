import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractWorkflowMeta, extractAgentCalls, expandIndirectCalls, matchAgentCall, recoverInterpolatedLabel, _matchStringFieldForTest, type WorkflowAgentCall } from './workflowScript.js';

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

  it('harvests segments from a shared-preamble concatenation (COMMON + `...`)', () => {
    // The dominant multi-agent shape: every call is `agent(COMMON + `...`, opts)`.
    // The prompt's first char is `C` (not a quote), so the old extractor took
    // the bare-expression path and emitted NO segments — every agent then fell
    // into the ungrouped bucket for the whole live run. The template also
    // carries top-level commas and a ${interp}; neither may truncate the opts
    // object that follows (else label/phase would be read from the wrong brace).
    const src = "agent(COMMON + `\\nYOUR JOB (Foundation): extract the style grammar, fonts, and ${X} colours now.`, { label: 'F1 style', phase: 'Foundation' })";
    const [call] = extractAgentCalls(src);
    expect(call.label).toBe('F1 style');
    expect(call.phase).toBe('Foundation');
    expect(call.staticSegments[0]).toContain('YOUR JOB (Foundation): extract the style grammar');
    // A single embedded literal still exposes its interpolation slot.
    expect(call.promptTemplate!.exprs).toEqual(['X']);
  });

  it('harvests segments from every literal in a multi-part concatenation', () => {
    const src = "agent(PRE + `a distinctive middle segment here` + `another distinctive tail segment`, { phase: 'X' })";
    const [call] = extractAgentCalls(src);
    expect(call.phase).toBe('X');
    expect(call.staticSegments).toContain('a distinctive middle segment here');
    expect(call.staticSegments).toContain('another distinctive tail segment');
    // Several literals → alignment is ambiguous, so promptTemplate is left null.
    expect(call.promptTemplate).toBeNull();
  });

  it('leaves a bare call-expression prompt for the indirect resolver (no harvest)', () => {
    // No top-level `+` → not a concatenation; segments stay empty and promptExpr
    // is captured so expandIndirectCalls can chase `fn(args)` to its body.
    const [call] = extractAgentCalls("agent(buildPrompt(d), { phase: 'Verify' })");
    expect(call.phase).toBe('Verify');
    expect(call.staticSegments).toEqual([]);
    expect(call.promptExpr).toBe('buildPrompt(d)');
  });
});

describe('matchAgentCall', () => {
  const calls: WorkflowAgentCall[] = [
    { label: 'review', phase: 'Review', staticSegments: ['Carefully review the authentication module for bugs'], promptTemplate: null, labelTemplate: null, promptExpr: null, sourceIndex: 0 },
    { label: 'verify', phase: 'Verify', staticSegments: ['Verify the populated list and report any discrepancies'], promptTemplate: null, labelTemplate: null, promptExpr: null, sourceIndex: 0 },
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
      { label: 'short', phase: 'A', staticSegments: ['shared distinctive prefix'], promptTemplate: null, labelTemplate: null, promptExpr: null, sourceIndex: 0 },
      { label: 'long', phase: 'B', staticSegments: ['shared distinctive prefix that continues much further'], promptTemplate: null, labelTemplate: null, promptExpr: null, sourceIndex: 0 },
    ];
    const prompt = 'x: shared distinctive prefix that continues much further — y';
    expect(matchAgentCall(prompt, ambiguous)!.label).toBe('long');
  });

  it('correlates a shared-preamble concatenation agent back to its phase end-to-end', () => {
    // The full live-tier path: extract the call from the script, then match a
    // running agent's expanded record-0 prompt (COMMON's text is prepended at
    // runtime, so the harvested template segment must still appear verbatim).
    const src = "agent(COMMON + `\\nRun the distinctive synthesis pass over all cases now.`, { label: 'S1', phase: 'Synthesis' })";
    const [call] = extractAgentCalls(src);
    const expandedPrompt = 'HARD CONTEXT: obey throughout.\nRun the distinctive synthesis pass over all cases now.';
    expect(matchAgentCall(expandedPrompt, [call])!.phase).toBe('Synthesis');
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

// The dominant real multi-agent shape: every prompt is an INDIRECT expression
// (s.prompt over SOURCES.map, synthPrompt('P1'), bare gapsPrompt) built from a
// shared-preamble helper. Before helper-call substitution these all landed in
// the ungrouped "other" bucket live. This mirrors the real
// rdti-fy26-reconstruction script that surfaced the bug.
describe('expandIndirectCalls — preamble-helper / indirect-prompt shapes', () => {
  const SHARED = 'You are reconstructing FY26 R&D activity.';
  // Build the script with escaped backticks/${} so it round-trips as source text.
  const SCRIPT = [
    `const SHARED_CONTEXT = '${SHARED}'`,
    `const entriesJSON = '[]'`,
    'const ev = (src, extra) => `${SHARED_CONTEXT}\\n\\n=== YOUR SOURCE: ${src} ===\\n${extra}`'.replace(/\\n/g, '\n'),
    `const SOURCES = [`,
    `  { key: 'cc', label: 'sweep:cc-workspace', prompt: ev('Claude Code workspace', \`Inventory every project directory under the workspace.\`) },`,
    `  { key: 'gran', label: 'sweep:granola', prompt: ev('Granola meeting transcripts', \`Use Granola MCP tools across the income year.\`) },`,
    `]`,
    `const NAMES = { P1: 'Complexity', P2: 'AI-First' }`,
    'const synthPrompt = (proj) => `${SHARED_CONTEXT}\\n\\n=== YOUR TASK: build the FY26 day schedule for PROJECT ${proj} ===\\n${entriesJSON}`'.replace(/\\n/g, '\n'),
    'const gapsPrompt = `${SHARED_CONTEXT}\\n\\n=== YOUR TASK: produce the what-Murray-must-supply list ===\\n${entriesJSON}`'.replace(/\\n/g, '\n'),
    'const verifyPrompt = (proj, synthObj) => `${SHARED_CONTEXT}\\n\\n=== YOUR ROLE: adversarial reviewer ===\\nChallenge the schedule for project ${proj} (${NAMES[proj]}). Return concrete challenges and a defensible day range, defaulting to skepticism throughout the entire review.\\n${JSON.stringify(synthObj)}`'.replace(/\\n/g, '\n'),
    ``,
    `phase('Evidence sweep')`,
    `const swept = await parallel(SOURCES.map(s => () => agent(s.prompt, { label: s.label, phase: 'Evidence sweep', schema: {} })))`,
    `phase('Synthesis')`,
    `const p1 = await agent(synthPrompt('P1'), { label: 'synth:P1', phase: 'Synthesis' })`,
    `const p2 = await agent(synthPrompt('P2'), { label: 'synth:P2', phase: 'Synthesis' })`,
    `const gaps = await agent(gapsPrompt, { label: 'synth:gaps', phase: 'Synthesis' })`,
    `phase('Adversarial verify')`,
    `const v1 = await agent(verifyPrompt('P1', p1), { label: 'verify:P1', phase: 'Adversarial verify' })`,
    `const v2 = await agent(verifyPrompt('P2', p2), { label: 'verify:P2', phase: 'Adversarial verify' })`,
  ].join('\n');

  const calls = expandIndirectCalls(SCRIPT, extractAgentCalls(SCRIPT));

  // Expanded record-0 prompts the runtime writes (preamble + framing + body).
  const evPrompt = (src: string, extra: string) => `${SHARED}\n\n=== YOUR SOURCE: ${src} ===\n${extra}`;
  const synthExpanded = (proj: string) => `${SHARED}\n\n=== YOUR TASK: build the FY26 day schedule for PROJECT ${proj} ===\n[]`;
  const gapsExpanded = `${SHARED}\n\n=== YOUR TASK: produce the what-Murray-must-supply list ===\n[]`;
  const verifyExpanded = (proj: string, name: string) => `${SHARED}\n\n=== YOUR ROLE: adversarial reviewer ===\nChallenge the schedule for project ${proj} (${name}). Return concrete challenges and a defensible day range, defaulting to skepticism throughout the entire review.\n{"total":1}`;

  it('expands 6 indirect call sites into 7 matchable virtual calls, grouped by phase', () => {
    expect(calls).toHaveLength(7);
    expect(calls.filter(c => c.phase === 'Evidence sweep')).toHaveLength(2);
    expect(calls.filter(c => c.phase === 'Synthesis')).toHaveLength(3);
    expect(calls.filter(c => c.phase === 'Adversarial verify')).toHaveLength(2);
  });

  it('groups every evidence-sweep agent (s.prompt over SOURCES.map) by phase, distinctly per source', () => {
    const cc = matchAgentCall(evPrompt('Claude Code workspace', 'Inventory every project directory under the workspace.'), calls);
    const gran = matchAgentCall(evPrompt('Granola meeting transcripts', 'Use Granola MCP tools across the income year.'), calls);
    expect(cc?.phase).toBe('Evidence sweep');
    expect(gran?.phase).toBe('Evidence sweep');
    expect(cc).not.toBe(gran); // src substituted → each correlates to its own element
  });

  it('correlates synthPrompt(\'P1\') and synthPrompt(\'P2\') to DISTINCT calls/labels (the substitution win)', () => {
    const p1 = matchAgentCall(synthExpanded('P1'), calls);
    const p2 = matchAgentCall(synthExpanded('P2'), calls);
    expect(p1?.label).toBe('synth:P1');
    expect(p2?.label).toBe('synth:P2');
    expect(p1?.phase).toBe('Synthesis');
    expect(p2?.phase).toBe('Synthesis');
  });

  it('resolves a bare-identifier prompt (agent(gapsPrompt, …)) to its phase + label', () => {
    const gaps = matchAgentCall(gapsExpanded, calls);
    expect(gaps?.label).toBe('synth:gaps');
    expect(gaps?.phase).toBe('Synthesis');
  });

  it('distinguishes two verifyPrompt(\'Px\') agents that share a long body, via the matched-length tiebreak', () => {
    const v1 = matchAgentCall(verifyExpanded('P1', 'Complexity'), calls);
    const v2 = matchAgentCall(verifyExpanded('P2', 'AI-First'), calls);
    expect(v1?.phase).toBe('Adversarial verify');
    expect(v2?.phase).toBe('Adversarial verify');
    expect(v1?.label).toBe('verify:P1');
    expect(v2?.label).toBe('verify:P2'); // would collide on verify:P1 without the sum tiebreak
  });
});
