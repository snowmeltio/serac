import * as path from 'path';
import * as vscode from 'vscode';
import { SessionDiscovery } from './sessionDiscovery.js';
import { setConfidenceThresholds } from './sessionManager.js';
import { claudeStateDir } from './paths.js';
import { FooterSlotRegistry } from './footerSlots.js';
import type { SeracExports } from './types.js';
import { AgentPanelProvider } from './panelProvider.js';
import { DetailPanel } from './detailPanel.js';
import type { DetailSource } from './types.js';
import { renderTranscript } from './transcriptRenderer.js';
import { UsageProvider } from './usageProvider.js';
import { ensureSessionMetadata } from './sessionRepair.js';
import { readCompactSettings, getClaudeSettingsPath, type CompactSettings } from './claudeSettings.js';
import { sanitiseWorkspaceKey } from './panelUtils.js';
import { buildWorktreeRows } from './worktreeRows.js';
import { openWorkspaceFolder, writeFocusHint, consumeFocusHint, focusHintPath } from './workspaceOpener.js';
import { HookEventRouter } from './hookEventRouter.js';
import { startHookIngress, type IngressHandle } from './hookIngress/index.js';
import { applyForwarderPatch, removeForwarderPatch } from './hookSettings/patcher.js';
import { readSettings, onSettingsChanged, type SeracSettings } from './settings.js';

export function activate(context: vscode.ExtensionContext): SeracExports {
  // Footer slot registry must be created up-front: companions resolve
  // Serac's exports during their own activate(), and that may run before
  // workspace folders are present.
  const footerSlots = new FooterSlotRegistry();
  const exports: SeracExports = {
    apiVersion: 1,
    registerUsageFooterSlot: (slotId, initial) => footerSlots.register(slotId, initial),
  };

  const workspacePath: string | undefined = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) { return exports; }
  const wsPath: string = workspacePath;

  const log = vscode.window.createOutputChannel('Serac', { log: true });
  context.subscriptions.push(log);

  // Singleton hook-event router. PR-D wired tracker subscriptions; PR-E
  // adds an optional debug observer that logs every routed event to a
  // dedicated output channel, and a liveness watchdog that warns when no
  // events arrive within LIVENESS_TIMEOUT_MS of a leader bind.
  const hookRouter = new HookEventRouter();
  context.subscriptions.push({ dispose: () => hookRouter.dispose() });

  const hooksDebugLog = vscode.window.createOutputChannel('Serac (Hooks)', { log: true });
  context.subscriptions.push(hooksDebugLog);

  const hooksDebugEnabled = () =>
    vscode.workspace.getConfiguration('serac.hooks').get<boolean>('debug') ?? false;

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
  context.subscriptions.push({ dispose: () => {
    if (livenessTimer) { clearTimeout(livenessTimer); livenessTimer = undefined; }
  }});

  // Per-workspace hook ingress. One leader window per workspace owns the
  // socket; sibling windows become inert followers and continue reading
  // session state via JSONL tailing. Foreign-workspace views are unaffected
  // — they have always been JSONL-only.
  let ingressHandle: IngressHandle | undefined;
  const forwarderPath = vscode.Uri.joinPath(context.extensionUri, 'bin', 'serac-hook-forward.cjs').fsPath;

  const hooksEnabled = () =>
    vscode.workspace.getConfiguration('serac.hooks').get<boolean>('enabled') ?? false;

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

  context.subscriptions.push(
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
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('serac.hooks.enabled')) { return; }
      syncHooksContext();
      if (hooksEnabled()) { tryPatch(); } else { tryUnpatch(); }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      // Order matters: unpatch settings while the socket is still bound, so a
      // hook event in flight isn't routed to a vanished socket. Then close
      // the socket. The leader-only patch path means followers no-op here.
      if (ingressHandle?.isLeader) { tryUnpatch(); }
      void ingressHandle?.dispose();
    },
  });

  const discovery = new SessionDiscovery(wsPath, { log, hookRouter });
  const usageProvider = new UsageProvider(wsPath);
  const panelProvider = new AgentPanelProvider(context.extensionUri);

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentPanelProvider.viewType,
      panelProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Detail panel: an editor-area webview opened beside the conversation by a
  // card's "view workflow/team/subagents" affordance. Source-keyed — reads live
  // snapshots + resolves agent transcripts per source from discovery; "open
  // conversation" reuses the companion editor.
  const detailPanel = new DetailPanel(context.extensionUri, {
    getWorkflows: () => discovery.getWorkflowSnapshots(),
    getTeams: () => discovery.getTeamSnapshots(),
    getSession: (sessionId: string) => discovery.getSnapshots().find(s => s.sessionId === sessionId),
    resolveAgentFile: (source: DetailSource, containerId: string, groupKey: string, agentId: string) => {
      if (source === 'workflow') { return discovery.getWorkflowAgentFilePath(groupKey, agentId); }
      if (source === 'subagents') { return discovery.getSubagentFilePath(containerId, agentId); }
      return discovery.getTeamAgentFilePath(containerId, agentId);
    },
    openConversation: (sessionId: string) => {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
        undefined,
        () => vscode.window.showInformationMessage(
          'Could not open the conversation. Is the Claude Code extension installed?',
        ),
      );
    },
  });
  context.subscriptions.push({ dispose: () => detailPanel.dispose() });
  panelProvider.setOpenDetailHandler(
    (source: DetailSource, containerId: string, sessionId: string) => detailPanel.show(source, containerId, sessionId),
  );

  // Handle session focus: open Claude Code editor panel for the specific session.
  // claude-vscode.editor.open accepts (sessionId, initialPrompt, viewColumn).
  // When called with a session ID, it reveals the existing panel or creates one.
  // Track the previously focused session so we can acknowledge it when focus moves away
  let previouslyFocusedSessionId: string | null = null;

  function acknowledgePrevious() {
    if (previouslyFocusedSessionId) {
      discovery.acknowledgeIfDone(previouslyFocusedSessionId);
      discovery.acknowledgeSubagents(previouslyFocusedSessionId);
      previouslyFocusedSessionId = null;
    }
  }

  panelProvider.setFocusHandler((sessionId: string) => {
    // Acknowledge the previously focused session now that the user has moved off it
    if (previouslyFocusedSessionId && previouslyFocusedSessionId !== sessionId) {
      acknowledgePrevious();
    }
    previouslyFocusedSessionId = sessionId;
    // Ensure the JSONL has summary metadata so the Claude extension can discover it.
    // Skip for running sessions to avoid concurrent write risk.
    const isRunning = discovery.isSessionRunning(sessionId) || discovery.isTeamSessionRunning(sessionId);
    if (!isRunning) {
      const jsonlPath = discovery.getSessionFilePath(sessionId)
        ?? discovery.getTeamSessionFilePath(sessionId);
      if (jsonlPath) { void ensureSessionMetadata(sessionId, jsonlPath); }
    }
    vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
      undefined,
      () => {
        vscode.window.showInformationMessage(
          'Could not focus Claude Code session. Is the Claude Code extension installed?'
        );
      },
    );
  });

  // Handle new chat: open a fresh Claude Code editor panel, then auto-focus
  // when the JSONL file appears (which happens on first message, not on panel open).
  // We snapshot known IDs and let the regular poll loop detect the new session.
  let pendingNewChatKnownIds: Set<string> | null = null;
  let pendingNewChatTimer: ReturnType<typeof setTimeout> | null = null;
  const NEW_CHAT_TIMEOUT_MS = 30_000;

  panelProvider.setNewChatHandler(() => {
    pendingNewChatKnownIds = new Set(discovery.getSnapshots().map(s => s.sessionId));
    // Clear stale pending state if user abandons the new chat (closes without sending)
    if (pendingNewChatTimer) { clearTimeout(pendingNewChatTimer); }
    pendingNewChatTimer = setTimeout(() => {
      pendingNewChatKnownIds = null;
      pendingNewChatTimer = null;
    }, NEW_CHAT_TIMEOUT_MS);
    vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined, vscode.ViewColumn.One).then(
      undefined,
      () => {
        pendingNewChatKnownIds = null;
        vscode.window.showInformationMessage(
          'Could not open new chat. Is the Claude Code extension installed?'
        );
      },
    );
  });

  // Handle cleanup: close all Claude Code editor tabs except the most recent
  panelProvider.setCleanupHandler(() => {
    const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);

    const claudeTabs = allTabs.filter(tab => {
      const input = tab.input;
      if (!input || typeof input !== 'object') { return false; }
      if ('viewType' in input) {
        const vt = (input as { viewType: string }).viewType;
        return vt.includes('claudeVSCode');
      }
      return false;
    });

    if (claudeTabs.length <= 1) { return; }

    // Keep the active tab if one exists, otherwise keep the first
    const activeTab = claudeTabs.find(t => t.isActive);
    const keepTab = activeTab || claudeTabs[0];
    const tabsToClose = claudeTabs.filter(t => t !== keepTab);

    for (const tab of tabsToClose) {
      vscode.window.tabGroups.close(tab);
    }
  });

  // Handle session dismiss
  panelProvider.setDismissHandler((sessionId: string) => {
    // If dismissing the focused session, acknowledge it
    if (previouslyFocusedSessionId === sessionId) {
      acknowledgePrevious();
    }
    discovery.dismissSession(sessionId);
    sendUpdate();
  });

  // Handle session undismiss — restores card to list, then focuses the editor
  panelProvider.setUndismissHandler((sessionId: string) => {
    discovery.undismissSession(sessionId);
    // Ensure metadata before opening (same as focus handler)
    if (!discovery.isSessionRunning(sessionId)) {
      const jsonlPath = discovery.getSessionFilePath(sessionId);
      if (jsonlPath) { void ensureSessionMetadata(sessionId, jsonlPath); }
    }
    // Open editor first, then update panel — avoids panel re-render stealing focus
    vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
      () => sendUpdate(),
      () => sendUpdate(),
    );
  });


  // Handle transcript view: render JSONL to markdown and open it
  panelProvider.setTranscriptHandler((sessionId: string) => {
    const jsonlPath = discovery.getSessionFilePath(sessionId)
      ?? discovery.getTeamSessionFilePath(sessionId);
    if (!jsonlPath) {
      vscode.window.showWarningMessage('Session file not found.');
      return;
    }
    renderTranscript(jsonlPath, sessionId, wsPath).then(
      outputPath => {
        vscode.workspace.openTextDocument(outputPath).then(
          doc => vscode.window.showTextDocument(doc, { preview: true }),
          err => log.warn('Failed to open transcript document:', err),
        );
      },
      err => {
        vscode.window.showErrorMessage(`Failed to render transcript: ${err}`);
      },
    );
  });

  // Handle archive range change
  panelProvider.setArchiveRangeHandler((rangeMs: number) => {
    discovery.setArchiveRange(rangeMs).then(
      changed => { if (changed) { sendUpdate(); } },
      err => log.warn('Failed to set archive range:', err),
    );
  });

  // Handle team dismiss/undismiss
  panelProvider.setDismissTeamHandler((teamId: string) => {
    discovery.dismissTeam(teamId);
    sendUpdate();
  });

  panelProvider.setUndismissTeamHandler((teamId: string) => {
    discovery.undismissTeam(teamId);
    // Reopen the orchestrator conversation, mirroring session undismiss. Note
    // the team id is NOT the orchestrator session id for Agent Teams (it's
    // `at:<name>`), so resolve the lead session from the snapshot.
    const orchSessionId = discovery.getTeamSnapshots().find(t => t.teamId === teamId)?.orchestrator.sessionId;
    if (orchSessionId) {
      vscode.commands.executeCommand('claude-vscode.editor.open', orchSessionId, undefined, vscode.ViewColumn.One).then(
        () => sendUpdate(),
        () => sendUpdate(),
      );
    } else {
      sendUpdate();
    }
  });

  // Handle workflow dismiss/undismiss (archive a run as a compact row)
  panelProvider.setDismissWorkflowHandler((runId: string) => {
    discovery.dismissWorkflow(runId);
    sendUpdate();
  });

  panelProvider.setUndismissWorkflowHandler((runId: string) => {
    discovery.undismissWorkflow(runId);
    // Reopen the invoking conversation (the session that owns the run).
    const sessionId = discovery.getWorkflowSnapshots().find(w => w.runId === runId)?.sessionId;
    if (sessionId) {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
        () => sendUpdate(),
        () => sendUpdate(),
      );
    } else {
      sendUpdate();
    }
  });

  // Handle "open another workspace" — used by foreign waiting cards and ws rows.
  // If a sessionId is supplied, drop a focus hint that the receiving Serac will
  // pick up (either on activate or via its FileSystemWatcher) and open the card.
  const projectsDir = path.join(claudeStateDir(), 'projects');
  // Wire the footer-slot bridge: panelProvider snapshots payloads each tick,
  // and forwards click events into VS Code's command bus.
  panelProvider.setFooterSlotBridge(
    () => footerSlots.getPayloads(),
    (slotId: string) => {
      const command = footerSlots.getCommand(slotId);
      if (!command) { return; }
      vscode.commands.executeCommand(command).then(undefined, err => {
        log.warn(`Footer slot "${slotId}" command "${command}" failed:`, err);
      });
    },
  );
  // Re-render whenever a companion registers/updates/disposes a slot.
  footerSlots.setOnChange(() => panelProvider.refresh());

  panelProvider.setOpenWorkspaceHandler(async (cwd: string, sessionId?: string) => {
    if (sessionId) {
      const targetWorkspaceKey = sanitiseWorkspaceKey(cwd);
      try {
        await writeFocusHint(projectsDir, targetWorkspaceKey, sessionId);
      } catch (err) {
        log.warn('Failed to write focus hint:', err);
      }
    }
    try {
      await openWorkspaceFolder(cwd);
    } catch (err) {
      log.warn('Failed to open workspace folder:', err);
      vscode.window.showWarningMessage(`Failed to open workspace at ${cwd}.`);
    }
  });


  // Receive side: when another Serac instance leaves us a focus hint, pick it up
  // both on activate (in case we just launched) and via a FileSystemWatcher
  // (already-running window).
  const localWorkspaceKey = sanitiseWorkspaceKey(wsPath);
  const localHintPath = focusHintPath(projectsDir, localWorkspaceKey);
  async function applyFocusHint() {
    const hint = await consumeFocusHint(localHintPath);
    if (!hint) { return; }
    // Surface the card and tell Claude Code to open the editor for that session.
    panelProvider.focusSession(hint.sessionId);
    vscode.commands.executeCommand(
      'claude-vscode.editor.open', hint.sessionId, undefined, vscode.ViewColumn.One,
    ).then(undefined, () => { /* extension may not be installed; the panel focus still helps */ });
  }
  // Run after the panel has had a moment to mount
  setTimeout(() => { void applyFocusHint(); }, 800);
  const hintWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(localHintPath)), path.basename(localHintPath)),
  );
  hintWatcher.onDidCreate(() => { void applyFocusHint(); });
  hintWatcher.onDidChange(() => { void applyFocusHint(); });
  context.subscriptions.push(hintWatcher);

  // Register refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.refresh', () => {
      sendUpdate();
    }),
  );

  // Title-bar new chat — same handler as the old in-panel button
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.newChat', () => {
      const handler = panelProvider.getNewChatHandler();
      if (handler) { handler(); }
    }),
  );

  // Title-bar cleanup uses a two-click arm/confirm pattern, matching the old
  // in-panel button. The first click sets `serac.cleanupArming = true`, which
  // the view/title `when` clauses use to swap the icon to a warning glyph; the
  // second click runs cleanup. Auto-disarms after 3s so a forgotten armed icon
  // doesn't lurk indefinitely.
  //
  // Cooldown: the icon swaps under the cursor on arm, so a rapid double-click
  // would fire confirm immediately on the second hit. Block confirm for
  // CLEANUP_CONFIRM_COOLDOWN_MS after arming with a brief status-bar nudge.
  // The cooldown is shorter than the 3 s auto-disarm so the user still has
  // ~2.5 s of intentional-confirm window.
  const CLEANUP_CONFIRM_COOLDOWN_MS = 500;
  let cleanupArmTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupArmedAt = 0;
  function disarmCleanup() {
    if (cleanupArmTimer) { clearTimeout(cleanupArmTimer); cleanupArmTimer = null; }
    vscode.commands.executeCommand('setContext', 'serac.cleanupArming', false);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.cleanup', () => {
      // When confirmation isn't required, skip the arm/confirm dance and
      // fire cleanup immediately on first click.
      if (!readSettings().cleanup.confirmRequired) {
        const handler = panelProvider.getCleanupHandler();
        if (handler) { handler(); }
        return;
      }
      cleanupArmedAt = Date.now();
      vscode.commands.executeCommand('setContext', 'serac.cleanupArming', true);
      if (cleanupArmTimer) { clearTimeout(cleanupArmTimer); }
      cleanupArmTimer = setTimeout(disarmCleanup, 3000);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.cleanupConfirm', () => {
      if (Date.now() - cleanupArmedAt < CLEANUP_CONFIRM_COOLDOWN_MS) {
        vscode.window.setStatusBarMessage(
          'Serac: cleanup just armed — wait a moment before confirming.',
          1_500,
        );
        return;
      }
      disarmCleanup();
      const handler = panelProvider.getCleanupHandler();
      if (handler) { handler(); }
    }),
  );
  context.subscriptions.push({ dispose: disarmCleanup });

  // Register focus command (for external use)
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.focusSession', (sessionId: string) => {
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId).then(
        undefined,
        err => log.warn('Failed to focus session:', err),
      );
    }),
  );

  // Title-bar cog: open VS Code's settings UI scoped to the Serac extension.
  context.subscriptions.push(
    vscode.commands.registerCommand('agentActivity.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:snowmeltio.serac-claude-code');
    }),
  );

  // Start discovery and wire updates
  let lastSendTime = 0;
  let compactSettings: CompactSettings = readCompactSettings();
  function sendUpdate() {
    const now = Date.now();
    if (now - lastSendTime < 200) { return; }
    lastSendTime = now;
    const sessions = discovery.getSnapshots();
    const teams = discovery.getTeamSnapshots();
    const workflows = discovery.getWorkflowSnapshots();
    // Include team agents waiting on input in the badge count
    let waitingCount = discovery.getWaitingCount();
    for (const team of teams) {
      if (team.dismissed) { continue; }
      for (const agent of team.agents) {
        if (agent.status === 'waiting') { waitingCount++; }
      }
      if (team.orchestrator.status === 'waiting') { waitingCount++; }
    }
    const usage = usageProvider.getSnapshot();
    const foreignWorkspaces = discovery.getForeignWorkspaces();
    const foreignWaiting = discovery.getForeignWaitingSnapshots();
    const foreignRunning = discovery.getForeignRunningSnapshots();
    // Foreign waiting cards demand attention too, so they bump the badge.
    waitingCount += foreignWaiting.length;
    const olderSessionCount = discovery.getOlderSessionCount();
    const worktrees = buildWorktreeRows(discovery.getDiscoveredWorktrees(), sessions, wsPath);
    panelProvider.updateSessions(sessions, waitingCount, wsPath, usage, foreignWorkspaces, compactSettings, teams, foreignWaiting, olderSessionCount, foreignRunning, worktrees, workflows);
    detailPanel.refresh();

    // Auto-focus new session created via "+ New" button
    if (pendingNewChatKnownIds) {
      const freshSession = sessions.find(s => !pendingNewChatKnownIds!.has(s.sessionId));
      if (freshSession) {
        pendingNewChatKnownIds = null;
        if (pendingNewChatTimer) { clearTimeout(pendingNewChatTimer); pendingNewChatTimer = null; }
        panelProvider.focusSession(freshSession.sessionId);
      }
    }
  }

  discovery.start(() => sendUpdate()).catch(err => {
    log.error('SessionDiscovery start failed:', err);
  });
  usageProvider.start(() => sendUpdate());

  // Watch settings.json (in active Claude state dir) for compact setting changes
  const settingsPath = getClaudeSettingsPath();
  const settingsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(settingsPath)), path.basename(settingsPath)),
  );
  const reloadSettings = () => { compactSettings = readCompactSettings(); sendUpdate(); };
  settingsWatcher.onDidChange(reloadSettings);
  settingsWatcher.onDidCreate(reloadSettings);
  settingsWatcher.onDidDelete(reloadSettings);
  context.subscriptions.push(settingsWatcher);

  // Timestamp freshness timer (relative time labels in UI). Reactive to
  // serac.refresh.intervalSeconds — rebuilt whenever the user changes it.
  let seracSettings: SeracSettings = readSettings();
  // Push user-tunable confidence-decay thresholds into vscode-free core.
  const applyConfidenceThresholds = (s: SeracSettings) =>
    setConfidenceThresholds(s.sessions.highConfidenceSeconds * 1000, s.sessions.mediumConfidenceSeconds * 1000);
  applyConfidenceThresholds(seracSettings);
  let refreshTimer: ReturnType<typeof setInterval> = setInterval(
    () => sendUpdate(),
    seracSettings.refresh.intervalSeconds * 1000,
  );
  function rebuildRefreshTimer(intervalSeconds: number) {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => sendUpdate(), intervalSeconds * 1000);
  }

  context.subscriptions.push(
    onSettingsChanged(next => {
      const intervalChanged = next.refresh.intervalSeconds !== seracSettings.refresh.intervalSeconds;
      seracSettings = next;
      applyConfidenceThresholds(next);
      panelProvider.sendSettings(next);
      if (intervalChanged) { rebuildRefreshTimer(next.refresh.intervalSeconds); }
      sendUpdate();
    }),
  );

  context.subscriptions.push({
    dispose() {
      discovery.stop();
      usageProvider.stop();
      clearInterval(refreshTimer);
    },
  });

  // Initial update after a short delay for panel to mount
  setTimeout(() => sendUpdate(), 500);

  return exports;
}

export function deactivate() {}

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
