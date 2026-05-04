import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeStateDir, claudeConfigFile, claudeKeychainService } from './paths.js';

const ORIG_ENV = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (ORIG_ENV === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = ORIG_ENV;
  }
  vi.restoreAllMocks();
});

describe('claudeStateDir', () => {
  it('returns ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(claudeStateDir()).toBe(path.join(os.homedir(), '.claude'));
  });

  it('returns CLAUDE_CONFIG_DIR when set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/Users/test/.claude-snowmelt';
    expect(claudeStateDir()).toBe('/Users/test/.claude-snowmelt');
  });

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty string', () => {
    process.env.CLAUDE_CONFIG_DIR = '';
    expect(claudeStateDir()).toBe(path.join(os.homedir(), '.claude'));
  });
});

describe('claudeKeychainService', () => {
  it('returns the unsuffixed name when CLAUDE_CONFIG_DIR is unset', () => {
    expect(claudeKeychainService()).toBe('Claude Code-credentials');
  });

  it('returns the unsuffixed name when CLAUDE_CONFIG_DIR points at the default dir', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude');
    expect(claudeKeychainService()).toBe('Claude Code-credentials');
  });

  it('returns sha256-prefixed name for the snowmelt profile (locks the algorithm)', () => {
    // The 9bd7b9d4 prefix was confirmed against the live keychain entry on
    // Murray's machine. This locks the hash algorithm against accidental drift.
    process.env.CLAUDE_CONFIG_DIR = '/Users/murraystubbs/.claude-snowmelt';
    expect(claudeKeychainService()).toBe('Claude Code-credentials-9bd7b9d4');
  });

  it('uses the resolved absolute path (trailing slash, dot segments collapse)', () => {
    process.env.CLAUDE_CONFIG_DIR = '/Users/murraystubbs/./.claude-snowmelt/';
    expect(claudeKeychainService()).toBe('Claude Code-credentials-9bd7b9d4');
  });
});

describe('claudeConfigFile', () => {
  // Drive tests via CLAUDE_CONFIG_DIR rather than mocking os.homedir() —
  // ESM module namespace exports cannot be spied on under vitest.
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns sibling .claude.json (default-profile layout)', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    const sibling = `${stateDir}.json`;
    fs.mkdirSync(stateDir);
    fs.writeFileSync(sibling, '{}');
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeConfigFile()).toBe(sibling);
  });

  it('returns inline .claude.json (alternate-profile layout)', () => {
    const stateDir = path.join(tmpRoot, '.claude-snowmelt');
    const inline = path.join(stateDir, '.claude.json');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(inline, '{}');
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeConfigFile()).toBe(inline);
  });

  it('prefers sibling over inline when both exist (matches claude-account)', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    const sibling = `${stateDir}.json`;
    const inline = path.join(stateDir, '.claude.json');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(sibling, '{}');
    fs.writeFileSync(inline, '{}');
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeConfigFile()).toBe(sibling);
  });

  it('returns null when neither location has the file', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(stateDir);
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeConfigFile()).toBeNull();
  });
});
