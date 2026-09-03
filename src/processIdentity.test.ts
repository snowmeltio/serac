import { describe, it, expect } from 'vitest';
import { verifyClaudeProcess, looksLikeClaudeCommand, parseEtime, splitPsLine, registryStartMs, START_TOLERANCE_MS } from './processIdentity.js';

const CMD = '/Users/me/.local/share/claude/versions/2.1.258 --print --sdk-url https://api.anthropic.com/v1/code/sessions/cse_01GJ';
const NOW = 1_788_500_000_000;
const psLine = (etime: string, cmd: string) => `   ${etime} ${cmd}\n`;

describe('looksLikeClaudeCommand', () => {
  it('accepts the native binary path, a bare claude, and an --sdk-url child', () => {
    expect(looksLikeClaudeCommand(CMD)).toBe(true);
    expect(looksLikeClaudeCommand('claude rc')).toBe(true);
    expect(looksLikeClaudeCommand('/Users/me/.local/bin/claude --resume x')).toBe(true);
    expect(looksLikeClaudeCommand('/x/native-binary/claude')).toBe(true);
    expect(looksLikeClaudeCommand('node something --sdk-url https://x')).toBe(true);
  });
  it('rejects shells, editors, and near-misses', () => {
    expect(looksLikeClaudeCommand('-zsh')).toBe(false);
    expect(looksLikeClaudeCommand('/Applications/Visual Studio Code.app/Contents/MacOS/Electron')).toBe(false);
    expect(looksLikeClaudeCommand('/usr/bin/claudette')).toBe(false);
    expect(looksLikeClaudeCommand('')).toBe(false);
  });
});

describe('parseEtime / splitPsLine', () => {
  it('parses mm:ss, hh:mm:ss, and dd-hh:mm:ss', () => {
    expect(parseEtime('00:07')).toBe(7_000);
    expect(parseEtime('15:11')).toBe(911_000);
    expect(parseEtime('01:02:03')).toBe(3_723_000);
    expect(parseEtime('2-01:02:03')).toBe((2 * 86_400 + 3_723) * 1000);
  });
  it('null on garbage', () => {
    expect(parseEtime('')).toBeNull();
    expect(parseEtime('Thu Sep 3')).toBeNull();
  });
  it('splits etime off the command, tolerating ps padding', () => {
    const s = splitPsLine(psLine('15:11', CMD))!;
    expect(s.etime).toBe('15:11');
    expect(s.command).toBe(CMD);
    expect(splitPsLine('')).toBeNull();
  });
});

describe('registryStartMs', () => {
  it('prefers procStart, falls back to startedAt', () => {
    expect(registryStartMs({ startedAt: 10, procStartMs: 7 })).toBe(7);
    expect(registryStartMs({ startedAt: 10, procStartMs: null })).toBe(10);
    expect(registryStartMs({ startedAt: 10 })).toBe(10);
    expect(registryStartMs({ startedAt: null, procStartMs: null })).toBeNull();
  });
});

describe('verifyClaudeProcess', () => {
  const now = () => NOW;
  const started = NOW - 911_000 + 700; // registry stamps a little after the real start
  it('verified: claude command and elapsed time consistent with the registry start', async () => {
    expect(await verifyClaudeProcess(63717, started, async () => psLine('15:11', CMD), now)).toEqual({ kind: 'verified' });
  });
  it('not-claude: the pid now belongs to something else', async () => {
    expect(await verifyClaudeProcess(63717, started, async () => psLine('15:11', '-zsh'), now))
      .toMatchObject({ kind: 'not-claude', command: '-zsh' });
  });
  it('start-mismatch: a claude process, but younger than the registry entry says', async () => {
    const r = await verifyClaudeProcess(63717, started, async () => psLine('00:03', CMD), now);
    expect(r.kind).toBe('start-mismatch');
    expect(Math.abs((r as { psStartMs: number }).psStartMs - (NOW - 3_000))).toBe(0);
  });
  it('tolerance is START_TOLERANCE_MS, inclusive', async () => {
    const edge = NOW - 911_000 - START_TOLERANCE_MS;
    expect((await verifyClaudeProcess(1, edge, async () => psLine('15:11', CMD), now)).kind).toBe('verified');
    expect((await verifyClaudeProcess(1, edge - 1, async () => psLine('15:11', CMD), now)).kind).toBe('start-mismatch');
  });
  it('no-started-at: refuses without a registry start, without even asking ps', async () => {
    let asked = false;
    const r = await verifyClaudeProcess(1, null, async () => { asked = true; return psLine('15:11', CMD); }, now);
    expect(r).toEqual({ kind: 'no-started-at' });
    expect(asked).toBe(false);
  });
  it('unknown: ps failed, returned nothing, or an unparseable etime', async () => {
    expect(await verifyClaudeProcess(1, started, async () => null, now)).toEqual({ kind: 'unknown' });
    expect(await verifyClaudeProcess(1, started, async () => '\n', now)).toEqual({ kind: 'unknown' });
    expect(await verifyClaudeProcess(1, started, async () => psLine('??', CMD), now)).toEqual({ kind: 'unknown' });
  });
});
