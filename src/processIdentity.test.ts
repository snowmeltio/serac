import { describe, it, expect } from 'vitest';
import { verifyClaudeProcess, looksLikeClaudeCommand, parseLstart, splitPsLine, START_TOLERANCE_MS } from './processIdentity.js';

const CMD = '/Users/me/.local/share/claude/versions/2.1.258 --print --sdk-url https://api.anthropic.com/v1/code/sessions/cse_01GJ';
const START = new Date('2026-09-03T02:52:16'); // local time, like ps lstart
const lstart = (d: Date) => d.toString().replace(/ GMT.*$/, '').replace(/^(\w{3}) (\w{3}) (\d{2}) (\d{4}) (\d\d:\d\d:\d\d)$/, '$1 $2 $3 $5 $4');
const psLine = (d: Date, cmd: string) => `${lstart(d)} ${cmd}\n`;

describe('looksLikeClaudeCommand', () => {
  it('accepts the native binary path, a bare claude, and an --sdk-url child', () => {
    expect(looksLikeClaudeCommand(CMD)).toBe(true);
    expect(looksLikeClaudeCommand('claude rc')).toBe(true);
    expect(looksLikeClaudeCommand('/Users/me/.local/bin/claude --resume x')).toBe(true);
    expect(looksLikeClaudeCommand('node something --sdk-url https://x')).toBe(true);
  });
  it('rejects shells, editors, and near-misses', () => {
    expect(looksLikeClaudeCommand('-zsh')).toBe(false);
    expect(looksLikeClaudeCommand('/Applications/Visual Studio Code.app/Contents/MacOS/Electron')).toBe(false);
    expect(looksLikeClaudeCommand('/usr/bin/claudette')).toBe(false);
    expect(looksLikeClaudeCommand('')).toBe(false);
  });
});

describe('parseLstart / splitPsLine', () => {
  it('parses the five-field lstart and splits the command off it', () => {
    const s = splitPsLine(psLine(START, CMD))!;
    expect(s.command).toBe(CMD);
    expect(parseLstart(s.lstart)).toBe(START.getTime());
  });
  it('null on a short line', () => {
    expect(splitPsLine('')).toBeNull();
    expect(splitPsLine('Thu Sep 3')).toBeNull();
  });
});

describe('verifyClaudeProcess', () => {
  const at = START.getTime() + 724; // registry stamps ms
  it('verified: claude command and start within tolerance', async () => {
    const r = await verifyClaudeProcess(63717, at, async () => psLine(START, CMD));
    expect(r).toEqual({ kind: 'verified' });
  });
  it('not-claude: the pid now belongs to something else', async () => {
    const r = await verifyClaudeProcess(63717, at, async () => psLine(START, '-zsh'));
    expect(r).toMatchObject({ kind: 'not-claude', command: '-zsh' });
  });
  it('start-mismatch: a claude process, but not the one the registry described', async () => {
    const later = new Date(START.getTime() + START_TOLERANCE_MS + 60_000);
    const r = await verifyClaudeProcess(63717, at, async () => psLine(later, CMD));
    expect(r.kind).toBe('start-mismatch');
  });
  it('no-started-at: refuses without a registry start time, without even asking ps', async () => {
    let asked = false;
    const r = await verifyClaudeProcess(1, null, async () => { asked = true; return psLine(START, CMD); });
    expect(r).toEqual({ kind: 'no-started-at' });
    expect(asked).toBe(false);
  });
  it('unknown: ps failed or returned nothing', async () => {
    expect(await verifyClaudeProcess(1, at, async () => null)).toEqual({ kind: 'unknown' });
    expect(await verifyClaudeProcess(1, at, async () => '\n')).toEqual({ kind: 'unknown' });
  });
});
