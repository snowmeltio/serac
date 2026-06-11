/**
 * Hook-ingress wiring, extracted from activate() (audit refactor-wiring-1):
 * the singleton event router, the "Serac (Hooks)" debug channel, the liveness
 * watchdog, the per-workspace leader socket, the settings.json forwarder
 * patch lifecycle, and the header-bar enable/disable commands.
 *
 * wireHookIngress() owns the lot and hands back the router (SessionDiscovery
 * subscribes through it) plus the disposables, in the same order activate()
 * used to push them — the last one unpatches settings BEFORE the socket
 * closes, so an in-flight hook event is never routed to a vanished socket.
 */

import * as vscode from 'vscode';
import { HookEventRouter } from './hookEventRouter.js';
import { startHookIngress, type IngressHandle } from './hookIngress/index.js';
import { applyForwarderPatch, removeForwarderPatch } from './hookSettings/patcher.js';
import { readSettings } from './settings.js';

export interface HookWiring {
  /** The singleton router; trackers subscribe via SessionDiscovery. */
  router: HookEventRouter;
  /** Push onto context.subscriptions verbatim — order matters (see module doc). */
  disposables: vscode.Disposable[];
}

export function wireHookIngress(opts: {
  wsPath: string;
  /** Absolute path of the bundled serac-hook-forward.cjs forwarder script. */
  forwarderPath: string;
  log: vscode.LogOutputChannel;
}): HookWiring {
  const { wsPath, forwarderPath, log } = opts;
  const disposables: vscode.Disposable[] = [];

  // Singleton hook-event router. PR-D wired tracker subscriptions; PR-E
  // adds an optional debug observer that logs every routed event to a
  // dedicated output channel, and a liveness watchdog that warns when no
  // events arrive within LIVENESS_TIMEOUT_MS of a leader bind.
  const hookRouter = new HookEventRouter();
  disposables.push({ dispose: () => hookRouter.dispose() });

  const hooksDebugLog = vscode.window.createOutputChannel('Serac (Hooks)', { log: true });
  disposables.push(hooksDebugLog);

  const hooksDebugEnabled = () => readSettings().hooks.debug;

  /** Liveness watchdog: when this window becomes leader, set a 10 s timer.
   *  If it elapses without any event arriving, log a one-shot warning. The
   *  warning is informational only — the JSONL/timer fallback already
   *  guarantees correctness; this just tells Murray "hooks aren't reaching
   *  the router; verify settings.json patched and Claude Code restarted." */
  const LIVENESS_TIMEOUT_MS = 10_000;
  let livenessTimer: ReturnType<typeof setTimeout> | undefined;
  let firstEventSeen = false;
  const startLivenessWatchdog = () => {
    if (livenessTimer || firstEventSeen) { return; }
    livenessTimer = setTimeout(() => {
      if (!firstEventSeen) {
        hooksDebugLog.warn(
          `no hook events received within ${LIVENESS_TIMEOUT_MS / 1000} s of leader bind — ` +
          'JSONL fallback remains authoritative; if you expected hooks, verify ' +
          'serac.hooks.enabled is true and Claude Code has been restarted to pick up settings.json',
        );
      }
    }, LIVENESS_TIMEOUT_MS);
  };

  hookRouter.setDebugObserver((sessionId, eventType, event) => {
    if (!firstEventSeen) {
      firstEventSeen = true;
      if (livenessTimer) { clearTimeout(livenessTimer); livenessTimer = undefined; }
      hooksDebugLog.info(`first hook event received (${eventType}) — ingress is live`);
    }
    if (hooksDebugEnabled()) {
      const summary = summariseHookEvent(event);
      hooksDebugLog.trace(`${eventType} sid=${sessionId.slice(0, 8)} ${summary}`);
    }
  });
  disposables.push({ dispose: () => {
    if (livenessTimer) { clearTimeout(livenessTimer); livenessTimer = undefined; }
  }});

  // Per-workspace hook ingress. One leader window per workspace owns the
  // socket; sibling windows become inert followers and continue reading
  // session state via JSONL tailing. Foreign-workspace views are unaffected
  // — they have always been JSONL-only.
  let ingressHandle: IngressHandle | undefined;

  const hooksEnabled = () => readSettings().hooks.enabled;

  // Mirror the setting into a `when`-clause context var so the header
  // button can swap icon/title in-place. Refreshed on every config change
  // by the onDidChangeConfiguration handler below.
  const syncHooksContext = () => {
    void vscode.commands.executeCommand('setContext', 'serac.hooksEnabled', hooksEnabled());
  };
  syncHooksContext();

  // Header-bar commands: workspace-scoped toggle of serac.hooks.enabled.
  // Workspace target matches how the settings patch is scoped — flipping in
  // one window of a workspace affects every window opened on it.
  //
  // Cooldown: the icon swaps under the cursor on every flip, so a rapid
  // double-click could fire the OPPOSITE action immediately. We throttle
  // both commands behind a shared timestamp — a second toggle within
  // TOGGLE_COOLDOWN_MS no-ops with a brief status-bar nudge.
  const TOGGLE_COOLDOWN_MS = 2_000;
  let lastToggleAt = 0;
  const onCooldown = () => Date.now() - lastToggleAt < TOGGLE_COOLDOWN_MS;
  const cooldownNudge = () => vscode.window.setStatusBarMessage(
    'Serac: hook mode just changed — wait a moment before toggling again.',
    1_500,
  );

  disposables.push(
    vscode.commands.registerCommand('agentActivity.enableHooks', async () => {
      if (onCooldown()) { cooldownNudge(); return; }
      lastToggleAt = Date.now();
      await vscode.workspace.getConfiguration('serac.hooks')
        .update('enabled', true, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(
        'Serac hook mode enabled for this workspace. Restart Claude Code so it picks up the patched settings.json.',
        'Got it',
      );
    }),
    vscode.commands.registerCommand('agentActivity.disableHooks', async () => {
      if (onCooldown()) { cooldownNudge(); return; }
      lastToggleAt = Date.now();
      await vscode.workspace.getConfiguration('serac.hooks')
        .update('enabled', false, vscode.ConfigurationTarget.Workspace);
      vscode.window.setStatusBarMessage(
        'Serac hook mode disabled — Serac-managed settings.json entries removed.',
        5_000,
      );
    }),
  );

  const tryPatch = () => {
    if (!ingressHandle?.isLeader || !hooksEnabled()) { return; }
    try {
      const result = applyForwarderPatch(wsPath, forwarderPath);
      if (result.changed) { log.info(`hook settings patched: ${result.settingsPath}`); }
    } catch (err) {
      log.error(`hook settings patch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const tryUnpatch = () => {
    try {
      const result = removeForwarderPatch(wsPath);
      if (result.changed) { log.info(`hook settings unpatched: ${result.settingsPath}`); }
    } catch (err) {
      log.error(`hook settings unpatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  startHookIngress(wsPath, hookRouter, {
    onError: (err, ctx) => log.warn(`hook ingress ${ctx}: ${err.message}`),
  }).then(handle => {
    ingressHandle = handle;
    if (handle.isLeader) {
      log.info(`hook ingress: leader, socket=${handle.socketPath}`);
      hooksDebugLog.info(`leader bound — socket=${handle.socketPath}`);
      tryPatch();
      if (hooksEnabled()) { startLivenessWatchdog(); }
    } else {
      log.debug('hook ingress: follower (another window owns this workspace)');
    }
  }).catch(err => {
    log.error(`hook ingress failed to start: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Live-toggle the patch and refresh the header-button context var when
  // the user flips `serac.hooks.enabled` (via our button, the settings UI,
  // or any other source).
  disposables.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('serac.hooks.enabled')) { return; }
      syncHooksContext();
      if (hooksEnabled()) { tryPatch(); } else { tryUnpatch(); }
    }),
  );

  disposables.push({
    dispose: () => {
      // Order matters: unpatch settings while the socket is still bound, so a
      // hook event in flight isn't routed to a vanished socket. Then close
      // the socket. The leader-only patch path means followers no-op here.
      if (ingressHandle?.isLeader) { tryUnpatch(); }
      void ingressHandle?.dispose();
    },
  });

  return { router: hookRouter, disposables };
}

/** Render a one-line summary of a hook payload for the debug channel.
 *  Trims to the fields a human actually wants when tailing the channel:
 *  agent_id (subagent dispatch), tool_name (which tool), source (for
 *  SessionStart compact vs startup), permission_mode. */
function summariseHookEvent(event: unknown): string {
  if (typeof event !== 'object' || event === null) { return ''; }
  const e = event as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e.agent_id === 'string') { parts.push(`agent=${e.agent_id.slice(0, 8)}`); }
  if (typeof e.tool_name === 'string') { parts.push(`tool=${e.tool_name}`); }
  if (typeof e.source === 'string') { parts.push(`source=${e.source}`); }
  if (typeof e.permission_mode === 'string') { parts.push(`mode=${e.permission_mode}`); }
  return parts.join(' ');
}
