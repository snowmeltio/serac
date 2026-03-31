import { describe, it, expect } from 'vitest';
import { parseTeamManifest, parseAgentTeamsConfig } from './teamManifest.js';

/** Minimal valid manifest for reuse across tests */
function validManifestObj() {
  return {
    version: 1,
    orchestrator: {
      sessionId: 'orch-abc123',
      name: 'Strategy Day Planning',
      startedAt: '2026-03-30T02:15:00Z',
      cwd: '/Users/murray/repos/cornice',
    },
    agents: [
      {
        sessionId: 'agent-def456',
        name: 'research-competitor-landscape',
        cwd: '/Users/murray/repos/team-strategy-day',
        parentSessionId: 'orch-abc123',
        depth: 1,
        spawnedAt: '2026-03-30T02:15:03Z',
        completedAt: null,
        exitStatus: null,
      },
    ],
    updatedAt: '2026-03-30T02:15:03Z',
  };
}

describe('parseTeamManifest', () => {
  it('parses a valid manifest', () => {
    const result = parseTeamManifest(JSON.stringify(validManifestObj()));
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.orchestrator.sessionId).toBe('orch-abc123');
    expect(result!.orchestrator.name).toBe('Strategy Day Planning');
    expect(result!.orchestrator.startedAt).toBe(Date.parse('2026-03-30T02:15:00Z'));
    expect(result!.orchestrator.cwd).toBe('/Users/murray/repos/cornice');
    expect(result!.agents).toHaveLength(1);
    expect(result!.agents[0].sessionId).toBe('agent-def456');
    expect(result!.agents[0].depth).toBe(1);
    expect(result!.agents[0].completedAt).toBeNull();
    expect(result!.agents[0].exitStatus).toBeNull();
    expect(result!.updatedAt).toBe(Date.parse('2026-03-30T02:15:03Z'));
  });

  it('parses an agent with completedAt and exitStatus', () => {
    const obj = validManifestObj();
    obj.agents[0].completedAt = '2026-03-30T02:18:42Z' as unknown as null;
    obj.agents[0].exitStatus = 'success' as unknown as null;
    const result = parseTeamManifest(JSON.stringify(obj));
    expect(result).not.toBeNull();
    expect(result!.agents[0].completedAt).toBe(Date.parse('2026-03-30T02:18:42Z'));
    expect(result!.agents[0].exitStatus).toBe('success');
  });

  it('parses failed and cancelled exit statuses', () => {
    const obj = validManifestObj();
    obj.agents[0].exitStatus = 'failed' as unknown as null;
    expect(parseTeamManifest(JSON.stringify(obj))!.agents[0].exitStatus).toBe('failed');

    obj.agents[0].exitStatus = 'cancelled' as unknown as null;
    expect(parseTeamManifest(JSON.stringify(obj))!.agents[0].exitStatus).toBe('cancelled');
  });

  it('accepts a manifest with zero agents', () => {
    const obj = validManifestObj();
    obj.agents = [];
    const result = parseTeamManifest(JSON.stringify(obj));
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(0);
  });

  it('accepts multiple agents at different depths', () => {
    const obj = validManifestObj();
    obj.agents.push({
      sessionId: 'agent-ghi789',
      name: 'pricing-deep-dive',
      cwd: '/Users/murray/repos/team-strategy-day',
      parentSessionId: 'agent-def456',
      depth: 2,
      spawnedAt: '2026-03-30T02:16:00Z',
      completedAt: null,
      exitStatus: null,
    });
    const result = parseTeamManifest(JSON.stringify(obj));
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(2);
    expect(result!.agents[1].depth).toBe(2);
    expect(result!.agents[1].parentSessionId).toBe('agent-def456');
  });

  // ── Rejection cases ───────────────────────────────────────────────

  it('returns null for invalid JSON', () => {
    expect(parseTeamManifest('{')).toBeNull();
    expect(parseTeamManifest('')).toBeNull();
    expect(parseTeamManifest('null')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseTeamManifest('"string"')).toBeNull();
    expect(parseTeamManifest('42')).toBeNull();
    expect(parseTeamManifest('[]')).toBeNull();
    expect(parseTeamManifest('true')).toBeNull();
  });

  it('rejects version > 1', () => {
    const obj = validManifestObj();
    (obj as Record<string, unknown>).version = 2;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects version < 1', () => {
    const obj = validManifestObj();
    (obj as Record<string, unknown>).version = 0;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects non-numeric version', () => {
    const obj = validManifestObj();
    (obj as Record<string, unknown>).version = '1';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects missing orchestrator', () => {
    const obj = validManifestObj();
    delete (obj as Record<string, unknown>).orchestrator;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects orchestrator with path-traversal sessionId', () => {
    const obj = validManifestObj();
    obj.orchestrator.sessionId = '../etc/passwd';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects orchestrator with empty name', () => {
    const obj = validManifestObj();
    obj.orchestrator.name = '';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects orchestrator with relative cwd', () => {
    const obj = validManifestObj();
    obj.orchestrator.cwd = 'relative/path';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects orchestrator with null-byte in cwd', () => {
    const obj = validManifestObj();
    obj.orchestrator.cwd = '/Users/murray\0/repos';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects invalid orchestrator startedAt', () => {
    const obj = validManifestObj();
    obj.orchestrator.startedAt = 'not-a-date';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects agent with path-traversal sessionId', () => {
    const obj = validManifestObj();
    obj.agents[0].sessionId = '../../secret';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects agent with depth 0', () => {
    const obj = validManifestObj();
    (obj.agents[0] as Record<string, unknown>).depth = 0;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects agent with non-integer depth', () => {
    const obj = validManifestObj();
    (obj.agents[0] as Record<string, unknown>).depth = 1.5;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects agent with invalid exitStatus', () => {
    const obj = validManifestObj();
    obj.agents[0].exitStatus = 'exploded' as unknown as null;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects agent with invalid completedAt date', () => {
    const obj = validManifestObj();
    obj.agents[0].completedAt = 'tomorrow' as unknown as null;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects missing updatedAt', () => {
    const obj = validManifestObj();
    delete (obj as Record<string, unknown>).updatedAt;
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects agents that is not an array', () => {
    const obj = validManifestObj();
    (obj as Record<string, unknown>).agents = 'not-array';
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('rejects manifests with > 200 agents', () => {
    const obj = validManifestObj();
    obj.agents = Array.from({ length: 201 }, (_, i) => ({
      sessionId: `agent-${i}`,
      name: `agent-${i}`,
      cwd: '/Users/test/repo',
      parentSessionId: 'orch-abc123',
      depth: 1,
      spawnedAt: '2026-03-30T02:15:03Z',
      completedAt: null,
      exitStatus: null,
    }));
    expect(parseTeamManifest(JSON.stringify(obj))).toBeNull();
  });

  it('accepts manifests with exactly 200 agents', () => {
    const obj = validManifestObj();
    obj.agents = Array.from({ length: 200 }, (_, i) => ({
      sessionId: `agent-${i}`,
      name: `agent-${i}`,
      cwd: '/Users/test/repo',
      parentSessionId: 'orch-abc123',
      depth: 1,
      spawnedAt: '2026-03-30T02:15:03Z',
      completedAt: null,
      exitStatus: null,
    }));
    const result = parseTeamManifest(JSON.stringify(obj));
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(200);
  });

  it('sets isActive to null on Cornice agents', () => {
    const result = parseTeamManifest(JSON.stringify(validManifestObj()));
    expect(result).not.toBeNull();
    expect(result!.agents[0].isActive).toBeNull();
  });
});

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
    expect(result!.version).toBe(0);
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

  it('filters out in-process members', () => {
    const config = validAgentTeamsConfig();
    // Make the tmux member in-process instead
    (config.members[1] as Record<string, unknown>).backendType = 'in-process';
    (config.members[1] as Record<string, unknown>).tmuxPaneId = 'in-process';
    const result = parseAgentTeamsConfig(JSON.stringify(config), 'serac-audit');
    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(0);
  });

  it('treats all present members as active (no completedAt)', () => {
    const result = parseAgentTeamsConfig(JSON.stringify(validAgentTeamsConfig()), 'serac-audit');
    expect(result).not.toBeNull();
    // Members in config are active (removed on completion)
    expect(result!.agents[0].completedAt).toBeNull();
    expect(result!.agents[0].exitStatus).toBeNull();
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
