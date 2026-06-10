/**
 * End-to-end smoke test for the Phase 4 hook stack.
 *
 * Replays real Claude Code hook payloads — captured from `claude -p
 * --include-hook-events` sessions in spike/captures/ — through the full
 * router + tracker stack and asserts the host-observable behaviour
 * matches what SessionManager would see in production.
 *
 * Why this exists separately from forwarder.integration.test.ts:
 *   - forwarder.integration.test.ts proves the SEND path (forwarder
 *     binary → socket → router) round-trips correctly.
 *   - This file proves the RECEIVE path (router → trackers → host
 *     callbacks) handles every captured-payload shape correctly.
 *
 * The two together cover: forwarder produces payloads that the router
 * accepts, and the trackers extract the right fields and fire the right
 * callbacks. SessionManager's own composition is unit-tested elsewhere.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HookEventRouter } from '../hookEventRouter.js';
import { makePermissionTracker } from './permissionTracker.js';
import { makeCwdTracker } from './cwdTracker.js';
import { makeCompactBoundaryTracker } from './compactBoundaryTracker.js';
import { makeSubagentLifecycleTracker, type SubagentLifecycleTrackerHost } from './subagentLifecycleTracker.js';
import type { SubagentInfo } from '../types.js';

interface CapturedEnvelope { received_at_ns?: number; payload?: Record<string, unknown>; }

function loadCapture(name: string): Record<string, unknown>[] {
  // Fixture is the committed copy of the spike capture (spike/ itself is
  // gitignored as an internal dev artefact). Update both when re-running
  // the spike against a newer Claude Code version.
  const file = path.resolve(__dirname, '__fixtures__', name);
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\n').filter(Boolean).map(line => {
    const env = JSON.parse(line) as CapturedEnvelope;
    return env.payload ?? {};
  }).filter(p => typeof p.hook_event_name === 'string');
}

function makeSubagent(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    parentToolUseId: 'tu', description: 'test', running: true, waitingOnPermission: false,
    lastActivity: new Date(), activeTools: new Map(), permissionTracker: undefined,
    acknowledged: false, tailer: null, silenceTimerId: undefined, agentId: null,
    startedAt: new Date(), resultPreview: null, toolsCompleted: 0,
    ...overrides,
  };
}

describe('Phase 4 spike replay — subagent-hook-2026-05-25.jsonl', () => {
  const PAYLOADS = loadCapture('subagent-hook-2026-05-25.jsonl');
  // The capture script logs every hook event under a single parent session_id;
  // every payload share the same session_id so we read it once from the first.
  const SID = String(PAYLOADS[0].session_id);
  const AGENT_ID = String(
    PAYLOADS.find(p => p.hook_event_name === 'SubagentStart')!.agent_id,
  );

  it('capture file is non-empty and contains the expected event mix', () => {
    const types = new Set(PAYLOADS.map(p => p.hook_event_name));
    expect(types.has('SessionStart')).toBe(true);
    expect(types.has('SubagentStart')).toBe(true);
    expect(types.has('SubagentStop')).toBe(true);
    expect(types.has('PreToolUse')).toBe(true);
    expect(types.has('PostToolUse')).toBe(true);
    expect(types.has('Stop')).toBe(true);
  });

  it('CwdTracker picks up parent cwd from SessionStart', () => {
    const router = new HookEventRouter();
    const workspaceKey = '-private-tmp-serac-spike-subagent';
    const tracker = makeCwdTracker(workspaceKey, { hookRouter: router, sessionId: SID });
    for (const p of PAYLOADS) {
      router.onHookEvent(SID, String(p.hook_event_name), p);
    }
    const state = tracker.getState();
    expect(state.cwd).toBe('/private/tmp/serac-spike-subagent');
    expect(state.initialCwd).toBe('/private/tmp/serac-spike-subagent');
    tracker.dispose();
  });

  it('Parent HookPermissionTracker does NOT fire (no PermissionRequest in capture)', () => {
    // Sanity check that the parent filter ignores everything that's not
    // PermissionRequest. In the captured session permission was bypassed
    // (--permission-mode bypassPermissions), so no PermissionRequest fires.
    const router = new HookEventRouter();
    let fired = 0;
    const host = {
      getActiveTools: () => new Map([['tu', 'Bash']]),
      getLastToolResultAt: () => 0,
      onWaitingFired: () => { fired++; },
    };
    const tracker = makePermissionTracker(host, { hookRouter: router, sessionId: SID });
    for (const p of PAYLOADS) {
      router.onHookEvent(SID, String(p.hook_event_name), p);
    }
    expect(fired).toBe(0);
    tracker.dispose();
  });

  it('CompactBoundaryTracker does NOT fire (no SessionStart(source:compact) in capture)', () => {
    const router = new HookEventRouter();
    let fired = 0;
    const tracker = makeCompactBoundaryTracker({ onCompactDetected: () => { fired++; } }, { hookRouter: router, sessionId: SID });
    for (const p of PAYLOADS) {
      router.onHookEvent(SID, String(p.hook_event_name), p);
    }
    expect(fired).toBe(0);
    tracker.dispose();
  });

  it('HookSubagentLifecycleTracker calls onComplete via fallback for the captured SubagentStop', () => {
    const router = new HookEventRouter();
    const sub = makeSubagent({ agentId: AGENT_ID });
    const host: SubagentLifecycleTrackerHost = {
      isDisposed: () => false,
      getSessionFilePath: () => '/tmp/spike.jsonl',
      getAllSubagents: () => [sub],
    };
    const tracker = makeSubagentLifecycleTracker(host, { hookRouter: router, sessionId: SID });
    tracker.onSpawn(sub);
    expect(sub.silenceTimerId).toBeDefined();
    for (const p of PAYLOADS) {
      router.onHookEvent(SID, String(p.hook_event_name), p);
    }
    // SubagentStop should have cleared the silence timer. agentId is preserved
    // (only disposeAll clears it) so the completed subagent stays resolvable.
    expect(sub.silenceTimerId).toBeUndefined();
    expect(sub.agentId).toBe(AGENT_ID);
  });
});

// Note: permission-deny-2026-05-25.jsonl is the raw `claude -p
// stream-json` output (different envelope shape than capture-hook.py).
// Its finding — that `permissions.deny` auto-reject emits no
// PermissionRequest hook — is documented in HOOK-MONITORING.md and
// guaranteed by the unit tests in permissionTracker.test.ts (parent
// tracker only fires on PermissionRequest, and the timer fallback
// remains load-bearing for this deny mode).

describe('PermissionRequest positive path — all-hook-events-2026-06-01.jsonl', () => {
  // The one capture on disk with a REAL PermissionRequest payload (a Bash
  // tool blocked on a prompt, full production shape: tool_name, tool_input,
  // permission_suggestions). This is the ground-truth path that lets the 15s
  // slow-tool timer stay a backstop rather than the load-bearing signal —
  // these tests prove the wait surfaces immediately from the hook alone.
  const PAYLOADS = loadCapture('all-hook-events-2026-06-01.jsonl');
  const PERM = PAYLOADS.find(p => p.hook_event_name === 'PermissionRequest')!;
  const SID = String(PERM.session_id);

  it('fixture sanity: a real PermissionRequest payload exists with the production shape', () => {
    expect(PERM).toBeTruthy();
    expect(PERM.tool_name).toBe('Bash');
    expect(PERM.tool_input).toBeTruthy();
    expect(Array.isArray(PERM.permission_suggestions)).toBe(true);
    expect(typeof PERM.agent_id === 'undefined' || PERM.agent_id === '').toBe(true); // parent-level request
  });

  it('the real payload fires the parent tracker immediately, keyed to the captured tool', () => {
    const router = new HookEventRouter();
    const fired: (string | undefined)[] = [];
    const host = {
      getActiveTools: () => new Map([['tu-1', 'Bash']]),
      getLastToolResultAt: () => 0,
      onWaitingFired: (toolName?: string) => { fired.push(toolName); },
    };
    const tracker = makePermissionTracker(host, { hookRouter: router, sessionId: SID });
    // Replay the session's full event stream in capture order — only the
    // PermissionRequest may fire, and it must fire exactly once, with no
    // timer advance at all (ground truth beats the 15s heuristic).
    for (const p of PAYLOADS.filter(p => p.session_id === SID)) {
      router.onHookEvent(SID, String(p.hook_event_name), p);
    }
    expect(fired).toEqual(['Bash']);
    tracker.dispose();
  });

  it('keeps the active-tool gate on the real payload (no fire with empty activeTools)', () => {
    const router = new HookEventRouter();
    let fired = 0;
    const host = {
      getActiveTools: () => new Map<string, string>(),
      getLastToolResultAt: () => 0,
      onWaitingFired: () => { fired++; },
    };
    const tracker = makePermissionTracker(host, { hookRouter: router, sessionId: SID });
    router.onHookEvent(SID, 'PermissionRequest', PERM);
    expect(fired).toBe(0); // Bash is not a userInput tool — gate holds
    tracker.dispose();
  });

  it('parent/subagent filter discipline holds for the real payload shape', () => {
    const router = new HookEventRouter();
    let parentFired = 0;
    let subFired = 0;
    const host = (cb: () => void) => ({
      getActiveTools: () => new Map([['tu-1', 'Bash']]),
      getLastToolResultAt: () => 0,
      onWaitingFired: cb,
    });
    const parent = makePermissionTracker(host(() => { parentFired++; }), { hookRouter: router, sessionId: SID });
    const sub = makePermissionTracker(host(() => { subFired++; }), { hookRouter: router, sessionId: SID, agentId: 'agent-77' });
    // The same real payload, re-addressed to a subagent: parent must ignore
    // it; only the matching subagent tracker fires (bubble policy intact).
    router.onHookEvent(SID, 'PermissionRequest', { ...PERM, agent_id: 'agent-77' });
    expect(parentFired).toBe(0);
    expect(subFired).toBe(1);
    // And the parent-level original reaches only the parent.
    router.onHookEvent(SID, 'PermissionRequest', PERM);
    expect(parentFired).toBe(1);
    expect(subFired).toBe(1);
    parent.dispose();
    sub.dispose();
  });
});
