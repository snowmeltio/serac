/**
 * Direct unit tests for exported pure functions: computeDemotion, getToolProfile.
 * These are tested indirectly through SessionManager tests, but direct tests
 * cover all branches explicitly and catch regressions faster.
 */
import { describe, it, expect } from 'vitest';
import { computeDemotion, getToolProfile, SessionManager } from './sessionManager.js';

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

  // Extended thinking (coherent, no output, no tools) is NOT demoted by the
  // 3-min hard ceiling — it defers to the caller's liveness check up to the
  // 15-min extended backstop. A long ruminate before a tool/Workflow launch.
  // (now is large here so the turn-start timestamps stay positive.)
  it('does not demote a no-output extended-thinking turn past the 3-min ceiling', () => {
    const now = 1_000_000;
    const turnStart = now - 200_000; // 3m20s of pure thinking
    const lastActivity = turnStart;  // no records since the turn began (coherent)
    expect(computeDemotion(
      'running', lastActivity, 0, false, now, THRESHOLD, turnStart, false,
    )).toBeNull();
  });

  // Still deferring just UNDER the 15-min backstop (this point discriminates the
  // EXTENDED_THINKING_CEILING_MS value — would be 'done' under the old 3-min
  // ceiling AND if the constant were lowered below ~14.6 min).
  it('keeps deferring a no-output extended-thinking turn just under the 15-min backstop', () => {
    const now = 1_000_000;
    const turnStart = now - 880_000; // 14m40s of pure thinking, under the backstop
    const lastActivity = turnStart;
    expect(computeDemotion(
      'running', lastActivity, 0, false, now, THRESHOLD, turnStart, false,
    )).toBeNull();
  });

  // ...but the generous 15-min backstop still fires (truly hung / unconfirmable).
  // Pairs with the 880k point above to bracket the constant within [880k, 901k].
  it('demotes a no-output extended-thinking turn past the 15-min backstop', () => {
    const now = 1_000_000;
    const turnStart = now - 901_000; // past EXTENDED_THINKING_CEILING_MS
    const lastActivity = turnStart;
    expect(computeDemotion(
      'running', lastActivity, 0, false, now, THRESHOLD, turnStart, false,
    )).toBe('done');
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

  it('returns slow (not exempt) profile for Workflow', () => {
    // Workflow raises a real permission prompt, so it must stay timer-eligible;
    // slow delay absorbs launch latency (observed max 2.3s).
    const p = getToolProfile('Workflow');
    expect(p.slow).toBe(true);
    expect(p.exempt).toBe(false);
    expect(p.orchestration).toBe(false);
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
    for (const name of ['WebSearch', 'WebFetch', 'Skill', 'Monitor']) {
      expect(getToolProfile(name).slow).toBe(true);
    }
  });

  it('returns exempt+orchestration for Agent Teams primitives', () => {
    for (const name of ['TaskOutput', 'TaskStop', 'TeamCreate', 'TeamDelete', 'SendMessage']) {
      const p = getToolProfile(name);
      expect(p.exempt).toBe(true);
      expect(p.orchestration).toBe(true);
    }
  });

  it('returns exempt for instant fire-and-forget primitives', () => {
    for (const name of [
      'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
      'RemoteTrigger', 'PushNotification',
    ]) {
      const p = getToolProfile(name);
      expect(p.exempt).toBe(true);
      expect(p.orchestration).toBe(false);
    }
  });

  it('returns exempt for editor/notebook/worktree tools', () => {
    for (const name of ['NotebookEdit', 'EnterWorktree', 'ExitWorktree']) {
      expect(getToolProfile(name).exempt).toBe(true);
    }
  });
});

describe('SessionManager.extractAssistantPreview', () => {
  const extract = (t: string, cap?: number) => SessionManager.extractAssistantPreview(t, cap);

  it('stops at the sentence boundary instead of straddling a trailing heading (the reported bug)', () => {
    const text = "Everything's set up and the fan-out is running. Status:\n\n**Done this session**\n- FY25 closed out";
    expect(extract(text)).toBe("Everything's set up and the fan-out is running.");
  });

  it('skips a leading markdown heading and takes the first prose line', () => {
    expect(extract('## Status\n\nThe build is green and deployed.')).toBe('The build is green and deployed.');
  });

  it('returns empty for an all-headings/rules message so the prior preview is kept', () => {
    expect(extract('## Status\n\n**Done this session**\n\n---')).toBe('');
  });

  it('does not truncate at abbreviations or dotted filenames', () => {
    const text = 'Updated config.json and added e.g. a regression test for the loader and parser changes.';
    expect(extract(text)).toBe('Updated config.json and added e.g. a regression test for the loader and parser changes.');
  });

  it('keeps a short two-sentence reply whole (boundary is below the floor)', () => {
    expect(extract('All done. Shipping now.')).toBe('All done. Shipping now.');
  });

  it('strips a leading list marker from a bulleted reply', () => {
    expect(extract('**Summary**\n- Fixed the parser bug and added a test\n- Updated docs')).toBe('Fixed the parser bug and added a test');
  });

  it('caps an over-long single line', () => {
    const long = 'x'.repeat(500);
    expect(extract(long, 200)).toHaveLength(200);
  });
});
