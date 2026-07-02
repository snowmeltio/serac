import { describe, it, expect } from 'vitest';
import { detectMismatches } from './mismatch.js';
import type { Evidence, CommandRun, FileTouch } from './evidenceExtractor.js';

// ── Fixtures ─────────────────────────────────────────────────────────

function cmd(command: string, exitOk: boolean | null = true): CommandRun {
  return { command, exitOk };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    filesTouched: [] as FileTouch[],
    commandsRun: [] as CommandRun[],
    testsRun: false,
    finalMessage: null,
    ...overrides,
  };
}

describe('detectMismatches — tests-claimed-not-run', () => {
  it('fires when the final message claims tests pass but no test command ran', () => {
    const ev = evidence({
      finalMessage: 'All checks green, tests pass, ready for review.',
      commandsRun: [cmd('npm run typecheck'), cmd('npm run build')],
      testsRun: false,
    });
    const mismatches = detectMismatches(ev);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].kind).toBe('tests-claimed-not-run');
    expect(mismatches[0].message).toContain('typecheck and build ran');
  });

  it('names a bare count when no known non-test command is recognised', () => {
    const ev = evidence({
      finalMessage: 'All tests pass.',
      commandsRun: [cmd('echo hi'), cmd('ls -la')],
      testsRun: false,
    });
    const mismatches = detectMismatches(ev);
    expect(mismatches[0].message).toContain('2 commands ran');
  });

  it('names "no commands ran" when the trace has none', () => {
    const ev = evidence({ finalMessage: 'All tests pass.', commandsRun: [], testsRun: false });
    const mismatches = detectMismatches(ev);
    expect(mismatches[0].message).toContain('no commands ran');
  });

  it('matches every documented claim phrase', () => {
    const phrases = [
      'The tests pass now.',
      'All tests were updated and pass.',
      'The test suite passes cleanly.',
      'Build is all green.',
      '42 tests passing.',
    ];
    for (const finalMessage of phrases) {
      const mismatches = detectMismatches(evidence({ finalMessage, commandsRun: [cmd('npm run build')], testsRun: false }));
      expect(mismatches.some(m => m.kind === 'tests-claimed-not-run')).toBe(true);
    }
  });

  it('stays silent when a real test command ran (testsRun true)', () => {
    const ev = evidence({
      finalMessage: 'All tests pass.',
      commandsRun: [cmd('npm test')],
      testsRun: true,
    });
    expect(detectMismatches(ev).some(m => m.kind === 'tests-claimed-not-run')).toBe(false);
  });

  it('stays silent when the final message never claims tests pass', () => {
    const ev = evidence({
      finalMessage: 'Refactored the CSS and shipped the build.',
      commandsRun: [cmd('npm run build')],
      testsRun: false,
    });
    expect(detectMismatches(ev)).toHaveLength(0);
  });

  it('stays silent on a bare "test" mention that is not a pass claim', () => {
    const ev = evidence({
      finalMessage: 'I wrote a test helper for the new module.',
      commandsRun: [],
      testsRun: false,
    });
    expect(detectMismatches(ev)).toHaveLength(0);
  });

  it('stays silent on empty evidence (no final message at all)', () => {
    expect(detectMismatches(evidence())).toHaveLength(0);
  });
});

describe('detectMismatches — failed-commands-glossed', () => {
  it('fires when the final message claims success and a failure is among the last 3 commands, unacknowledged', () => {
    const ev = evidence({
      finalMessage: 'All done, ready for review.',
      commandsRun: [cmd('npm run typecheck', true), cmd('npm run build', true), cmd('npm run lint', false)],
    });
    const mismatches = detectMismatches(ev);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].kind).toBe('failed-commands-glossed');
    expect(mismatches[0].message).toContain('npm run lint');
  });

  it('truncates a long failed command in the message', () => {
    const longCmd = 'npm run something-with-a-very-long-argument-list-that-goes-on-and-on-and-on-forever';
    const ev = evidence({
      finalMessage: 'Done.',
      commandsRun: [cmd(longCmd, false)],
    });
    const mismatches = detectMismatches(ev);
    expect(mismatches[0].message).toContain('…');
    expect(mismatches[0].message).not.toContain(longCmd); // truncated, not verbatim
  });

  it('stays silent when the failed command was retried and later succeeded (same leading token)', () => {
    const ev = evidence({
      finalMessage: 'All done, working as expected.',
      commandsRun: [
        cmd('npm run build', false),
        cmd('npm run build', true), // retry, succeeded
      ],
    });
    expect(detectMismatches(ev).some(m => m.kind === 'failed-commands-glossed')).toBe(false);
  });

  it('stays silent when the failure is acknowledged in the final message', () => {
    const ev = evidence({
      finalMessage: 'Build is done, though the lint step failed and needs a follow-up.',
      commandsRun: [cmd('npm run build', true), cmd('npm run lint', false)],
    });
    expect(detectMismatches(ev).some(m => m.kind === 'failed-commands-glossed')).toBe(false);
  });

  it('recognises negated-completion acknowledgement phrasing ("not yet working")', () => {
    const ev = evidence({
      finalMessage: 'The build is not yet working, still investigating.',
      commandsRun: [cmd('npm run build', false)],
    });
    expect(detectMismatches(ev).some(m => m.kind === 'failed-commands-glossed')).toBe(false);
  });

  it('stays silent when the failed command is NOT among the last 3 (an early failure, later fixed)', () => {
    const ev = evidence({
      finalMessage: 'All done, ready for review.',
      commandsRun: [
        cmd('npm run lint', false),      // early failure, index 0
        cmd('npm run typecheck', true),
        cmd('npm run build', true),
        cmd('npm run test', true),
      ],
    });
    expect(detectMismatches(ev).some(m => m.kind === 'failed-commands-glossed')).toBe(false);
  });

  it('stays silent when no command failed', () => {
    const ev = evidence({
      finalMessage: 'All done, ready for review.',
      commandsRun: [cmd('npm run build', true), cmd('npm run test', true)],
    });
    expect(detectMismatches(ev)).toHaveLength(0);
  });

  it('stays silent when the final message does not claim success', () => {
    const ev = evidence({
      finalMessage: 'Investigated the build pipeline.',
      commandsRun: [cmd('npm run build', false)],
    });
    expect(detectMismatches(ev)).toHaveLength(0);
  });

  it('stays silent on empty evidence', () => {
    expect(detectMismatches(evidence())).toHaveLength(0);
  });

  it('treats a null exitOk (no matching tool_result) as not-failed — never flags an ambiguous command', () => {
    const ev = evidence({
      finalMessage: 'All done.',
      commandsRun: [cmd('npm run build', null)],
    });
    expect(detectMismatches(ev)).toHaveLength(0);
  });

  it('stays silent on a trailing benign-nonzero command (grep with no matches) despite a success claim', () => {
    // grep exits 1 on "no match" — a normal result Claude Code records as
    // is_error: true. BENIGN_NONZERO_COMMANDS must excuse it, or every
    // honest "done" after a no-match grep gets flagged.
    const ev = evidence({
      finalMessage: 'All done, ready for review.',
      commandsRun: [cmd('npm run build', true), cmd('grep -c TODO src/', false)],
    });
    expect(detectMismatches(ev)).toHaveLength(0);
  });

  it('excuses every documented benign-nonzero leading token', () => {
    const benign = ['grep foo src/', 'rg foo src/', 'egrep foo src/', 'fgrep foo src/', 'diff a.txt b.txt', 'cmp a.bin b.bin', 'test -f missing.txt', '[ -f missing.txt ]'];
    for (const command of benign) {
      const ev = evidence({ finalMessage: 'Done.', commandsRun: [cmd(command, false)] });
      expect(detectMismatches(ev), command).toHaveLength(0);
    }
  });

  it('still fires for a genuinely failed non-benign command in the same trailing position', () => {
    const ev = evidence({
      finalMessage: 'All done, ready for review.',
      commandsRun: [cmd('grep -c TODO src/', false), cmd('npm run build', false)],
    });
    const mismatches = detectMismatches(ev);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].kind).toBe('failed-commands-glossed');
    expect(mismatches[0].message).toContain('npm run build');
  });

  it('does NOT excuse a benign token embedded in a compound command (leading token is bash) — documented over-fire', () => {
    // "bash -c 'grep …'" leads with bash, not grep, so the benign set does
    // not apply and the flag fires. Accepted: the compound wrapper makes
    // intent ambiguous and the cheap leading-token check cannot resolve it
    // (see the module docstring's compound-command caveat).
    const ev = evidence({
      finalMessage: 'All done.',
      commandsRun: [cmd("bash -c 'grep foo src/'", false)],
    });
    const mismatches = detectMismatches(ev);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].kind).toBe('failed-commands-glossed');
  });
});

describe('detectMismatches — both heuristics together', () => {
  it('can fire both mismatches at once when both conditions hold independently', () => {
    const ev = evidence({
      finalMessage: 'All tests pass, all done, ready for review.',
      commandsRun: [cmd('npm run typecheck', true), cmd('npm run build', false)],
      testsRun: false,
    });
    const mismatches = detectMismatches(ev);
    const kinds = mismatches.map(m => m.kind).sort();
    expect(kinds).toEqual(['failed-commands-glossed', 'tests-claimed-not-run']);
  });
});
