/**
 * Host-computed mismatch detection: cross-checks an agent's own final prose
 * against the tool-call evidence extracted by evidenceExtractor.ts, so a
 * confident-but-wrong summary can't hide behind the Result strip
 * (DESIGN-DETAIL-PANE-V2.md Phase 3 — the anti-fabrication device the JTBD
 * judges called out as the single most portable idea in the design set).
 *
 * Pure: no fs, no vscode imports — takes an already-computed Evidence and
 * returns Mismatch[]. Called host-side only (detailPanel.ts); the webview
 * NEVER computes mismatches itself, it only displays what the host sends
 * (see DESIGN-DETAIL-PANE-V2.md's own risk #2: a mismatch flag that's easy
 * to fake or bypass defeats the point).
 *
 * ## Conservatism (read before adding a heuristic)
 *
 * A false MISMATCH teaches the user to ignore the flag — the worst outcome
 * for a device whose entire value is "trust this warning". Every heuristic
 * here is deliberately precision-over-recall: it would rather stay silent on
 * a genuine mismatch than fire on an innocent one. Two heuristics ship in
 * this phase:
 *
 * 1. **tests-claimed-not-run** — the final message claims the tests pass
 *    (matched against TEST_CLAIM_PATTERNS, a closed phrase list rather than a
 *    bare /test/ substring scan, which would fire on "I wrote a test
 *    helper" or "testing this against prod") while evidence.testsRun is
 *    false (no command in the trace matched evidenceExtractor.ts's
 *    TEST_RUNNER_PATTERNS). The message names what DID run instead
 *    (typecheck/build/lint, or a bare count) so the flag reads as
 *    informative, not just alarmist.
 *
 * 2. **failed-commands-glossed** — the final message claims success
 *    (SUCCESS_CLAIM_PATTERNS) with NO failure-acknowledgement phrase
 *    (FAILURE_ACK_PATTERNS) anywhere in it, AND a command among the LAST
 *    THREE commands run has exitOk === false. Two extra guards keep this
 *    from over-firing:
 *      - Only the last three commands count. An early failure the agent
 *        fixed five commands ago is normal, unremarkable agent behaviour —
 *        flagging it would just be noise the user learns to dismiss.
 *      - A failed command is excused if a LATER command sharing its leading
 *        token (e.g. both start with "npm") succeeded — that is a retry,
 *        not a glossed failure. "Leading token" is a coarse but cheap proxy
 *        for "the same command, tried again"; it does not diff full command
 *        strings (Bash invocations vary too much for that to be reliable).
 *      - A failed command whose leading token is in BENIGN_NONZERO_COMMANDS
 *        is skipped entirely: for match/compare/predicate commands a
 *        nonzero exit is a normal RESULT, not a failure — grep/rg/egrep/
 *        fgrep exit 1 on "no match", diff/cmp exit 1 on "files differ",
 *        `test`/`[` exit 1 as their ordinary false answer. Claude Code
 *        records those as is_error: true on the tool_result, so
 *        evidenceExtractor maps them to exitOk: false, and without this
 *        skip a trailing benign `grep -c foo src/` with no matches would
 *        flag an honest "done". We'd rather miss a genuinely failed grep
 *        than flag a benign one. Leading-token matching only: a benign
 *        token embedded in a compound command ("bash -c 'grep …'") is NOT
 *        excused — its leading token is bash — so that rare shape can
 *        still fire; accepted, since the compound wrapper makes intent
 *        ambiguous and the cheap token check cannot resolve it. Deliberate
 *        asymmetry: the set applies ONLY here — describeCommandsRun and
 *        tests-claimed-not-run don't key off exitOk at all, so they
 *        neither need nor use it.
 *
 * Both heuristics require a non-null finalMessage — an agent that said
 * nothing made no claim to check, so silence beats a fabricated mismatch
 * against empty prose.
 */

import type { CommandRun, Evidence } from './evidenceExtractor.js';

/** One detected mismatch between an agent's prose and its own tool
 *  evidence. `message` is heuristic-specific (see detectMismatches); the
 *  fixed disclaimer suffix ("Computed from tool calls, not the agent's
 *  prose.") is rendered by the webview alongside it, not baked in here. */
export interface Mismatch {
  kind: string;
  message: string;
}

/** Phrases that count as the agent claiming its tests passed. Matched with
 *  word boundaries against the whole final message, case-insensitive. A
 *  closed list rather than a bare /test/ scan — see the module docstring's
 *  rationale for heuristic 1. Exported so the Result strip (or a future
 *  "why did this fire" affordance) can reference the same list documented
 *  here rather than re-deriving it. */
export const TEST_CLAIM_PATTERNS: { phrase: string; pattern: RegExp }[] = [
  { phrase: 'tests pass', pattern: /\btests?\s+pass(?:es|ed|ing)?\b/i },
  { phrase: 'all tests', pattern: /\ball\s+tests?\b/i },
  { phrase: 'test suite passes', pattern: /\btest\s+suite\s+pass(?:es|ed|ing)?\b/i },
  { phrase: 'all green', pattern: /\ball\s+green\b/i },
  { phrase: 'N tests passing', pattern: /\b\d+\s+tests?\s+passing\b/i },
];

/** Phrases that count as the agent claiming overall success/completion — the
 *  trigger side of failed-commands-glossed. Deliberately short, common words
 *  ("done", "working"): FAILURE_ACK_PATTERNS below is what keeps this
 *  heuristic from over-firing on those (e.g. "not done yet" contains
 *  "done", but also "not … done", which FAILURE_ACK_PATTERNS' own
 *  not-(yet)-done/working/complete/ready entry catches), not the trigger
 *  list's narrowness. Exported for the same reason as TEST_CLAIM_PATTERNS. */
export const SUCCESS_CLAIM_PATTERNS: { phrase: string; pattern: RegExp }[] = [
  { phrase: 'done', pattern: /\bdone\b/i },
  { phrase: 'complete', pattern: /\bcomplete[d]?\b/i },
  { phrase: 'working', pattern: /\bworking\b/i },
  { phrase: 'all green', pattern: /\ball\s+green\b/i },
  { phrase: 'ready for review', pattern: /\bready\s+for\s+review\b/i },
];

/** Phrases that count as the agent acknowledging a failure somewhere in its
 *  own prose. Presence of ANY of these silences failed-commands-glossed even
 *  when a command failed, because the agent already owned it — nothing is
 *  being "glossed over" if the agent said so. */
export const FAILURE_ACK_PATTERNS: { phrase: string; pattern: RegExp }[] = [
  { phrase: 'fail/failed/failing/failure', pattern: /\bfail(?:s|ed|ing|ure)?\b/i },
  { phrase: 'error/errored', pattern: /\berror(?:s|ed)?\b/i },
  { phrase: 'broke/broken', pattern: /\bbroke(?:n)?\b/i },
  { phrase: 'issue(s)', pattern: /\bissues?\b/i },
  { phrase: 'problem(s)', pattern: /\bproblems?\b/i },
  { phrase: "did not / didn't", pattern: /\bdid(?:n't| not)\b/i },
  { phrase: "isn't/wasn't/doesn't working", pattern: /\b(?:isn't|wasn't|doesn't|is not|was not|does not)\s+working\b/i },
  { phrase: 'unable to', pattern: /\bunable to\b/i },
  { phrase: "couldn't / could not", pattern: /\bcould(?:n't| not)\b/i },
  { phrase: 'retry/retrying/retried', pattern: /\bretr(?:y|ying|ied)\b/i },
  { phrase: 'not (yet) done/working/complete/ready', pattern: /\bnot\s+(?:yet\s+)?(?:done|working|complete[d]?|ready)\b/i },
];

function matchesAny(text: string, patterns: { pattern: RegExp }[]): boolean {
  return patterns.some(p => p.pattern.test(text));
}

/** Known non-test command keywords, for naming what ran instead of tests in
 *  the tests-claimed-not-run message (mirrors the design mockup's "typecheck
 *  and build ran"). Not exhaustive — anything unrecognised falls back to a
 *  bare count so the message never claims something that didn't happen. */
const NAMED_COMMAND_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'typecheck', pattern: /\btypecheck\b|\btsc\b/i },
  { label: 'build', pattern: /\bbuild\b/i },
  { label: 'lint', pattern: /\beslint\b|\blint\b/i },
];

function describeCommandsRun(commandsRun: CommandRun[]): string {
  if (commandsRun.length === 0) { return 'no commands ran'; }
  const labels: string[] = [];
  for (const p of NAMED_COMMAND_PATTERNS) {
    if (commandsRun.some(c => p.pattern.test(c.command))) { labels.push(p.label); }
  }
  if (labels.length > 0) { return labels.join(' and ') + ' ran'; }
  return commandsRun.length + ' command' + (commandsRun.length === 1 ? '' : 's') + ' ran';
}

function detectTestsClaimedNotRun(evidence: Evidence): Mismatch | null {
  if (!evidence.finalMessage) { return null; }
  if (evidence.testsRun) { return null; }
  if (!matchesAny(evidence.finalMessage, TEST_CLAIM_PATTERNS)) { return null; }
  return {
    kind: 'tests-claimed-not-run',
    message: 'Final message claims the tests pass; ' + describeCommandsRun(evidence.commandsRun) + ', no test command found.',
  };
}

function leadingToken(command: string): string {
  return command.trim().split(/\s+/)[0] || '';
}

/** Leading tokens of commands whose nonzero exit is a normal result, not a
 *  failure — match/compare/predicate commands (see the module docstring's
 *  conservatism section for the full rationale and the compound-command
 *  caveat). failed-commands-glossed skips a failed command whose leading
 *  token is in this set; nothing else consults it. Exported so the Result
 *  strip (or a future "why didn't this fire" affordance) can reference the
 *  same list documented here. */
export const BENIGN_NONZERO_COMMANDS: ReadonlySet<string> = new Set([
  'grep', 'rg', 'egrep', 'fgrep', 'diff', 'cmp', 'test', '[',
]);

const MAX_COMMAND_LABEL_CHARS = 60;

function detectFailedCommandsGlossed(evidence: Evidence): Mismatch | null {
  const { commandsRun, finalMessage } = evidence;
  if (!finalMessage) { return null; }
  if (!matchesAny(finalMessage, SUCCESS_CLAIM_PATTERNS)) { return null; }
  if (matchesAny(finalMessage, FAILURE_ACK_PATTERNS)) { return null; }

  // Only the trailing window counts (see module docstring); walk it in
  // order so the first unresolved failure — the one closest to the claim —
  // is what the message names.
  const windowStart = Math.max(0, commandsRun.length - 3);
  for (let idx = windowStart; idx < commandsRun.length; idx++) {
    const failed = commandsRun[idx];
    if (failed.exitOk !== false) { continue; }
    const token = leadingToken(failed.command);
    // Nonzero exit ≠ failure for match/compare/predicate commands (grep's
    // "no match", diff's "files differ", test's false) — never flag them.
    if (BENIGN_NONZERO_COMMANDS.has(token)) { continue; }
    const retriedOk = commandsRun.slice(idx + 1).some(later => leadingToken(later.command) === token && later.exitOk === true);
    if (retriedOk) { continue; }
    const label = failed.command.length > MAX_COMMAND_LABEL_CHARS
      ? failed.command.slice(0, MAX_COMMAND_LABEL_CHARS) + '…'
      : failed.command;
    return {
      kind: 'failed-commands-glossed',
      message: 'Final message claims success, but "' + label + '" failed near the end of the run and was not retried successfully.',
    };
  }
  return null;
}

/** Run every mismatch heuristic over one agent's Evidence, in a fixed order
 *  (tests-claimed-not-run, then failed-commands-glossed). Both can fire —
 *  they check independent claims — so the return value is a list, not a
 *  single flag. Never throws: Evidence is already a validated, pure shape,
 *  and every regex here is a small, bounded, non-backtracking pattern. */
export function detectMismatches(evidence: Evidence): Mismatch[] {
  const out: Mismatch[] = [];
  const testsClaim = detectTestsClaimedNotRun(evidence);
  if (testsClaim) { out.push(testsClaim); }
  const failedGlossed = detectFailedCommandsGlossed(evidence);
  if (failedGlossed) { out.push(failedGlossed); }
  return out;
}
