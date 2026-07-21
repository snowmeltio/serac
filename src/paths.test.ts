import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  claudeStateDir, claudeConfigFile, claudeKeychainService, claudeAccountId,
  sessionDirFromJsonl, subagentsDirFor, subagentJsonlPath, subagentMetaPath,
} from './paths.js';

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

describe('claudeAccountId', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the accountUuid from the resolved config file (sibling layout)', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(`${stateDir}.json`, JSON.stringify({
      oauthAccount: { accountUuid: 'uuid-123', emailAddress: 'a@b.c' },
    }));
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeAccountId()).toBe('uuid-123');
  });

  it('returns null when the config has no oauthAccount (migration-flags stub)', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(`${stateDir}.json`, '{}');
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeAccountId()).toBeNull();
  });

  it('returns null when no config file exists', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(stateDir);
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeAccountId()).toBeNull();
  });

  it('returns null when the config file is invalid JSON', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(`${stateDir}.json`, 'not json {{{');
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeAccountId()).toBeNull();
  });

  it('returns null when accountUuid is empty or non-string', () => {
    const stateDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(`${stateDir}.json`, JSON.stringify({ oauthAccount: { accountUuid: '' } }));
    process.env.CLAUDE_CONFIG_DIR = stateDir;
    expect(claudeAccountId()).toBeNull();
  });

  it('uses an explicit configFile argument, bypassing resolution', () => {
    const file = path.join(tmpRoot, 'explicit.json');
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: 'uuid-explicit' } }));
    expect(claudeAccountId(file)).toBe('uuid-explicit');
  });

  it('treats an explicit null configFile as no account', () => {
    expect(claudeAccountId(null)).toBeNull();
  });
});

describe('session/subagent layout helpers', () => {
  const sessionDir = '/proj/-Users-x-repo/abc123';

  it('sessionDirFromJsonl strips only a trailing .jsonl suffix', () => {
    expect(sessionDirFromJsonl('/proj/-Users-x-repo/abc123.jsonl')).toBe(sessionDir);
    // .jsonl elsewhere in the path must survive — only the suffix is the marker
    expect(sessionDirFromJsonl('/proj/a.jsonl.bak/abc.jsonl')).toBe('/proj/a.jsonl.bak/abc');
    expect(sessionDirFromJsonl('/proj/no-suffix')).toBe('/proj/no-suffix');
  });

  it('subagentsDirFor appends the subagents directory', () => {
    expect(subagentsDirFor(sessionDir)).toBe(path.join(sessionDir, 'subagents'));
  });

  it('subagentJsonlPath builds agent-<id>.jsonl under subagents/', () => {
    expect(subagentJsonlPath(sessionDir, 'a1b2')).toBe(
      path.join(sessionDir, 'subagents', 'agent-a1b2.jsonl'),
    );
  });

  it('subagentMetaPath builds agent-<id>.meta.json under subagents/', () => {
    expect(subagentMetaPath(sessionDir, 'a1b2')).toBe(
      path.join(sessionDir, 'subagents', 'agent-a1b2.meta.json'),
    );
  });

  it('jsonl and meta paths agree with subagentsDirFor (one layout, one owner)', () => {
    const dir = subagentsDirFor(sessionDir);
    expect(subagentJsonlPath(sessionDir, 'z9').startsWith(dir + path.sep)).toBe(true);
    expect(subagentMetaPath(sessionDir, 'z9').startsWith(dir + path.sep)).toBe(true);
  });
});
