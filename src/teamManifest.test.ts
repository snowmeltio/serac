import { describe, it, expect } from 'vitest';
import { parseAgentTeamsConfig } from './teamManifest.js';

// ── Agent Teams config parser ─────────────────────────────────────────

function validAgentTeamsConfig() {
  return {
    name: 'serac-audit',
    description: 'Audit the Serac codebase',
    createdAt: 1774873638749,
    leadAgentId: 'team-lead@serac-audit',
    leadSessionId: '38161772-e647-4661-95e0-6efb3a101db9',
    members: [
      {
        agentId: 'team-lead@serac-audit',
        name: 'team-lead',
        agentType: 'team-lead',
        model: 'claude-opus-4-6',
        joinedAt: 1774873638749,
        tmuxPaneId: '',
        cwd: '/Users/murray/repos/snowmeltio/serac',
        subscriptions: [],
      },
      {
        agentId: 'type-auditor@serac-audit',
        name: 'type-auditor',
        agentType: 'Explore',
        model: 'haiku',
        prompt: 'Read src/types.ts and list exported interfaces.',
        color: 'blue',
        planModeRequired: false,
        joinedAt: 1774873649643,
        tmuxPaneId: '%1',
        cwd: '/Users/murray/repos/snowmeltio/serac',
        subscriptions: [],
        backendType: 'tmux',
        isActive: true,
      },
    ],
  };
}

describe('parseAgentTeamsConfig', () => {
  it('parses a valid Agent Teams config', () => {
    const result = parseAgentTeamsConfig(JSON.stringify(validAgentTeamsConfig()), 'serac-audit');
    expect(result).not.toBeNull();
    expect(result!.orchestrator.sessionId).toBe('38161772-e647-4661-95e0-6efb3a101db9');
    expect(result!.orchestrator.name).toBe('serac-audit');
    expect(result!.orchestrator.startedAt).toBe(1774873638749);
    expect(result!.orchestrator.cwd).toBe('/Users/murray/repos/snowmeltio/serac');
  });

  it('includes only tmux members as agents (filters in-process)', () => {
    const config = validAgentTeamsConfig();
    const result = parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit');
    expect(result).not.toBeNull();
    // Only the tmux member (type-auditor) should be included, not the lead
    expect(result!.agents).toHaveLength(1);
    expect(result!.agents[0].name).toBe('type-auditor');
    expect(result!.agents[0].sessionId).toBeNull();
    expect(result!.agents[0].parentSessionId).toBe('38161772-e647-4661-95e0-6efb3a101db9');
    expect(result!.agents[0].depth).toBe(1);
    expect(result!.agents[0].spawnedAt).toBe(1774873649643);
    expect(result!.agents[0].isActive).toBe(true);
  });

  it('filters in-process members out of agents but keeps their names for roster matching', () => {
    const config = validAgentTeamsConfig();
    // Make the tmux member in-process instead
    (config.members[1] as Record<string, unknown>).backendType = 'in-process';
    (config.members[1] as Record<string, unknown>).tmuxPaneId = 'in-process';
    const result = parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit');
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(0);
    // The name must survive: teammate badging, inbox resolution, and transcript
    // lookup all roster-match against it (an all-in-process team would otherwise
    // have an empty roster and the composer could never appear).
    expect(result!.inProcessMembers).toEqual(['type-auditor']);
  });

  it('reports no in-process members for an all-tmux team', () => {
    const result = parseAgentTeamsConfig(JSON.stringify(validAgentTeamsConfig()), 'serac-audit');
    expect(result).not.toBeNull();
    expect(result!.inProcessMembers).toEqual([]);
  });

  it('carries the member isActive flag through to the manifest', () => {
    const result = parseAgentTeamsConfig(JSON.stringify(validAgentTeamsConfig()), 'serac-audit');
    expect(result).not.toBeNull();
    // Members are removed from the config on completion, so isActive (not a
    // completion timestamp) is the only liveness signal the wire shape needs.
    expect(result!.agents[0].isActive).toBe(true);
  });

  it('uses epoch ms timestamps (not ISO 8601)', () => {
    const result = parseAgentTeamsConfig(JSON.stringify(validAgentTeamsConfig()), 'serac-audit');
    expect(result).not.toBeNull();
    expect(result!.orchestrator.startedAt).toBe(1774873638749);
    expect(result!.agents[0].spawnedAt).toBe(1774873649643);
  });

  it('uses most recent joinedAt as updatedAt', () => {
    const config = validAgentTeamsConfig();
    const result = parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit');
    expect(result).not.toBeNull();
    // type-auditor joined later (1774873649643) than createdAt (1774873638749)
    expect(result!.updatedAt).toBe(1774873649643);
  });

  it('rejects configs with a version field (Cornice sidecar)', () => {
    const config = { ...validAgentTeamsConfig(), version: 1 };
    expect(parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseAgentTeamsConfig('{broken', 'test')).toBeNull();
    expect(parseAgentTeamsConfig('', 'test')).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const config = validAgentTeamsConfig();
    delete (config as Record<string, unknown>).name;
    expect(parseAgentTeamsConfig(JSON.stringify(config), 'test')).toBeNull();
  });

  it('returns null for invalid leadSessionId', () => {
    const config = validAgentTeamsConfig();
    (config as Record<string, unknown>).leadSessionId = '../evil';
    expect(parseAgentTeamsConfig(JSON.stringify(config), 'test')).toBeNull();
  });

  it('returns null for empty members array', () => {
    const config = validAgentTeamsConfig();
    config.members = [];
    expect(parseAgentTeamsConfig(JSON.stringify(config), 'test')).toBeNull();
  });

  it('returns null for member with invalid name', () => {
    const config = validAgentTeamsConfig();
    (config.members[0] as Record<string, unknown>).name = '';
    expect(parseAgentTeamsConfig(JSON.stringify(config), 'test')).toBeNull();
  });

  it('handles config with only a lead member (no teammates)', () => {
    const config = validAgentTeamsConfig();
    config.members = [config.members[0]]; // only the lead
    const result = parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit');
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(0);
  });

  it('falls back to first member as lead if leadAgentId does not match', () => {
    const config = validAgentTeamsConfig();
    (config as Record<string, unknown>).leadAgentId = 'nonexistent@team';
    const result = parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit');
    expect(result).not.toBeNull();
    // First member becomes orchestrator, second becomes agent
    expect(result!.orchestrator.cwd).toBe('/Users/murray/repos/snowmeltio/serac');
  });

  it('rejects lead member with invalid cwd', () => {
    const config = validAgentTeamsConfig();
    (config.members[0] as Record<string, unknown>).cwd = 'relative/path';
    expect(parseAgentTeamsConfig(JSON.stringify(config), 'test')).toBeNull();
  });

  it('handles multiple tmux teammates', () => {
    const config = validAgentTeamsConfig();
    config.members.push({
      agentId: 'test-counter@serac-audit',
      name: 'test-counter',
      agentType: 'Explore',
      model: 'haiku',
      prompt: 'Count test files.',
      color: 'green',
      planModeRequired: false,
      joinedAt: 1774873660000,
      tmuxPaneId: '%2',
      cwd: '/Users/murray/repos/snowmeltio/serac',
      subscriptions: [],
      backendType: 'tmux',
      isActive: true,
    } as never);
    const result = parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit');
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(2);
    expect(result!.agents[0].name).toBe('type-auditor');
    expect(result!.agents[1].name).toBe('test-counter');
  });
});
