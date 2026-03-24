/**
 * Direct unit tests for exported pure functions: computeDemotion, getToolProfile.
 * These are tested indirectly through SessionManager tests, but direct tests
 * cover all branches explicitly and catch regressions faster.
 */
import { describe, it, expect } from 'vitest';
import { computeDemotion, getToolProfile } from './sessionManager.js';

describe('computeDemotion', () => {
  const NOW = 100_000;
  const THRESHOLD = 30_000; // 30s

  // Helper: build params with sensible defaults
  function demote(overrides: {
    status?: 'running' | 'waiting' | 'done';
    age?: number;
    activeTools?: number;
    blockingSubs?: boolean;
    turnStart?: number;
    seenOutput?: boolean;
  } = {}) {
    const status = overrides.status ?? 'running';
    const age = overrides.age ?? 0;
    const lastActivity = NOW - age;
    return computeDemotion(
      status,
      lastActivity,
      overrides.activeTools ?? 0,
      overrides.blockingSubs ?? false,
      NOW,
      THRESHOLD,
      overrides.turnStart ?? 0,
      overrides.seenOutput ?? true,
    );
  }

  // Branch 1: non-running/waiting status → null
  it('returns null for done status', () => {
    expect(demote({ status: 'done' })).toBeNull();
  });

  // Branch 2: hard ceiling (3min) → done
  it('returns done when running exceeds hard ceiling (3min)', () => {
    expect(demote({ age: 181_000 })).toBe('done');
  });

  // Branch 3: hard ceiling for waiting (10min) → done
  it('returns done when waiting exceeds 10min ceiling', () => {
    expect(demote({ status: 'waiting', age: 601_000 })).toBe('done');
  });

  // Branch 4: waiting below ceiling → null (only running demotes below ceiling)
  it('returns null for waiting below ceiling', () => {
    expect(demote({ status: 'waiting', age: 60_000 })).toBeNull();
  });

  // Branch 5: turn coherent + no output + no tools → suppressed (null)
  it('suppresses demotion during extended thinking (coherent turn, no output)', () => {
    const turnStart = NOW - 35_000; // turn started 35s ago
    const lastActivity = turnStart; // last activity = turn start (coherent)
    expect(computeDemotion(
      'running', lastActivity, 0, false, NOW, THRESHOLD, turnStart, false,
    )).toBeNull();
  });

  // Branch 5 negative: turn coherent + no output BUT has tools → NOT suppressed
  it('does not suppress when turn coherent but tools are active', () => {
    const turnStart = NOW - 35_000;
    const lastActivity = turnStart;
    expect(computeDemotion(
      'running', lastActivity, 1, false, NOW, THRESHOLD, turnStart, false,
    )).toBe('waiting');
  });

  // Branch 5 negative: incoherent turn (gap too large) → NOT suppressed
  it('does not suppress when turn is incoherent (large gap)', () => {
    const turnStart = NOW - 5_000; // turn started 5s ago
    const lastActivity = NOW - 35_000; // but last activity was 35s ago → incoherent
    expect(computeDemotion(
      'running', lastActivity, 0, false, NOW, THRESHOLD, turnStart, false,
    )).toBe('done');
  });

  // Branch 6: past threshold + blocking subagents → suppressed (null)
  it('suppresses demotion when blocking subagents are active', () => {
    expect(demote({ age: 35_000, blockingSubs: true })).toBeNull();
  });

  // Branch 7: past threshold + active tools + no blocking subs → waiting
  it('transitions to waiting when tools active past threshold', () => {
    expect(demote({ age: 35_000, activeTools: 2 })).toBe('waiting');
  });

  // Branch 8: past threshold + no tools + no blocking subs → done
  it('transitions to done when no tools past threshold', () => {
    expect(demote({ age: 35_000 })).toBe('done');
  });

  // Below threshold, running → null (not yet stale)
  it('returns null when running below threshold', () => {
    expect(demote({ age: 10_000 })).toBeNull();
  });

  // Hard ceiling overrides blocking subagents
  it('hard ceiling overrides blocking subagents', () => {
    expect(demote({ age: 181_000, blockingSubs: true })).toBe('done');
  });
});

describe('getToolProfile', () => {
  it('returns exempt profile for Read', () => {
    const p = getToolProfile('Read');
    expect(p.exempt).toBe(true);
    expect(p.slow).toBe(false);
    expect(p.orchestration).toBe(false);
  });

  it('returns orchestration profile for Agent', () => {
    const p = getToolProfile('Agent');
    expect(p.exempt).toBe(true);
    expect(p.orchestration).toBe(true);
  });

  it('returns orchestration profile for Task', () => {
    const p = getToolProfile('Task');
    expect(p.exempt).toBe(true);
    expect(p.orchestration).toBe(true);
  });

  it('returns slow profile for Bash', () => {
    const p = getToolProfile('Bash');
    expect(p.slow).toBe(true);
    expect(p.exempt).toBe(false);
  });

  it('returns userInput profile for AskUserQuestion', () => {
    const p = getToolProfile('AskUserQuestion');
    expect(p.userInput).toBe(true);
  });

  it('returns MCP profile for mcp__ prefixed tools', () => {
    const p = getToolProfile('mcp__slack__slack_send_message');
    expect(p.slow).toBe(true);
    expect(p.exempt).toBe(false);
    expect(p.orchestration).toBe(false);
  });

  it('returns MCP profile for any mcp__ prefix', () => {
    const p = getToolProfile('mcp__custom_server__tool');
    expect(p.slow).toBe(true);
  });

  it('returns default profile for unknown tools', () => {
    const p = getToolProfile('UnknownTool');
    expect(p.exempt).toBe(false);
    expect(p.slow).toBe(false);
    expect(p.userInput).toBe(false);
    expect(p.orchestration).toBe(false);
  });

  it('returns default profile for empty string', () => {
    const p = getToolProfile('');
    expect(p.exempt).toBe(false);
    expect(p.slow).toBe(false);
  });

  it('returns exempt profiles for all read-only tools', () => {
    for (const name of ['Glob', 'Grep', 'TodoWrite', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(getToolProfile(name).exempt).toBe(true);
    }
  });

  it('returns slow profiles for all network tools', () => {
    for (const name of ['WebSearch', 'WebFetch', 'Skill']) {
      expect(getToolProfile(name).slow).toBe(true);
    }
  });
});
