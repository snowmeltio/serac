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
import { sanitiseWorkspaceKey, applyWorkflowLiveStatus, normPath, computeWaitingCount } from './panelUtils.js';
import { buildWorktreeRows } from './worktreeRows.js';
import { openWorkspaceFolder, writeFocusHint, consumeFocusHint, focusHintPath } from './workspaceOpener.js';
import { wireHookIngress } from './hookWiring.js';
import { readSettings, onSettingsChanged, type SeracSettings } from './settings.js';
import { appendInboxMessage, peekInboxMessages } from './teammateInbox.js';
import {
  NativeDocsProvider, NATIVE_DOCS_SCHEME,
  makeShowRawRecordCommand, makeOpenTranscriptDocCommand, makeShowFileChangesCommand,
} from './nativeDocs.js';

/** Open (or reveal) a Claude Code editor tab via the companion extension's
 *  command. `sessionId` undefined opens a new chat. Failure usually means the
 *  Claude Code extension isn't installed — callers choose how loudly to say
 *  so. `onSettled` fires on success AND failure (the undismiss flows re-render
 *  either way). */
function openClaudeEditor(sessionId: string | undefined, opts: {
  onSettled?: () => void;
  failMessage?: string;
  onFail?: (err: unknown) => void;
} = {}): void {
  vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
    () => opts.onSettled?.(),
    (err: unknown) => {
      if (opts.failMessage) { void vscode.window.showInformationMessage(opts.failMessage); }
      opts.onFail?.(err);
      opts.onSettled?.();
    },
  );
}

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

  // Hook ingress: router + leader socket + settings patch + toggle commands.
  // Mechanically extracted to hookWiring.ts (audit refactor-wiring-1); the
  // disposables are pushed in their original order — the last unpatches
  // settings before the socket closes.
  const hookWiring = wireHookIngress({
    wsPath,
    forwarderPath: vscode.Uri.joinPath(context.extensionUri, 'bin', 'serac-hook-forward.cjs').fsPath,
    log,
  });
  context.subscriptions.push(...hookWiring.disposables);
  const hookRouter = hookWiring.router;

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

  // Native escape hatches (Phase 4, DESIGN-DETAIL-PANE-V2.md): raw-JSON
  // record, whole-transcript markdown pop-out, and an Edit's before/after
  // diff — each a real, independently-registered vscode command (see
  // nativeDocs.ts's module docstring), invoked by DetailPanel via
  // `vscode.commands.executeCommand` after it validates the webview's
  // request. Deliberately NOT declared in package.json's contributes.commands:
  // all three act on a specific transcript row/chip the panel resolves
  // server-side (a file path + record index/target), so a bare palette
  // invocation would have nothing to act on — unlike e.g.
  // agentActivity.focusSession, which is in the palette despite also taking
  // an argument (a minor existing inconsistency, not a pattern to repeat
  // here: that command's argument is a plain session id a caller could
  // reasonably supply by hand; these three need a live transcript-row
  // resolution the palette has no way to provide).
  const nativeDocsProvider = new NativeDocsProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(NATIVE_DOCS_SCHEME, nativeDocsProvider),
    { dispose: () => nativeDocsProvider.dispose() },
    vscode.commands.registerCommand('serac.detail.showRawRecord', makeShowRawRecordCommand(nativeDocsProvider)),
    vscode.commands.registerCommand('serac.detail.openTranscriptDoc', makeOpenTranscriptDocCommand(nativeDocsProvider, wsPath)),
    vscode.commands.registerCommand('serac.detail.showFileChanges', makeShowFileChangesCommand(nativeDocsProvider)),
  );

  // Detail panel: an editor-area webview opened beside the conversation by a
  // card's "view workflow/team/subagents" affordance. Source-keyed — reads live
  // snapshots + resolves agent transcripts per source from discovery; "open
  // conversation" reuses the companion editor.
  const detailPanel = new DetailPanel(context.extensionUri, {
    getWorkflows: () => discovery.getWorkflowSnapshots(),
    getTeams: () => discovery.getTeamSnapshots(),
    getSession: (sessionId: string) => discovery.getSnapshots().find(s => s.sessionId === sessionId),
    listSubagents: (sessionId: string) => discovery.listSubagentFiles(sessionId),
    resolveAgentFile: (source: DetailSource, containerId: string, groupKey: string, agentId: string) => {
      if (source === 'workflow') { return discovery.getWorkflowAgentFilePath(groupKey, agentId); }
      if (source === 'subagents') { return discovery.getSubagentFilePath(containerId, agentId); }
      return discovery.getTeamAgentFilePath(containerId, agentId);
    },
    openConversation: (sessionId: string) => {
      openClaudeEditor(sessionId, { failMessage: 'Could not open the conversation. Is the Claude Code extension installed?' });
    },
    // Teammate messaging (experimental). Re-read on every send; the webview's
    // copy is display-only. operatorName is synthesized here, never from the
    // webview. The writer is anchored to discovery's validated teams root.
    getMessagingSettings: () => {
      const ex = readSettings().experimental;
      return { enabled: ex.teammateMessaging, operatorName: ex.operatorName };
    },
    resolveInboxTarget: (orchestratorSessionId: string, agentId: string) =>
      discovery.resolveInboxTarget(orchestratorSessionId, agentId),
    appendTeammateMessage: (teamDir: string, member: string, from: string, text: string) =>
      appendInboxMessage({ teamsDir: discovery.getTeamsDir(), teamDir, member, from, text }),
    peekTeammateInbox: (teamDir: string, member: string) =>
      peekInboxMessages({ teamsDir: discovery.getTeamsDir(), teamDir, member }),
    logMessaging: (line: string) => log.info(line),
    clearNativeDocsCache: () => nativeDocsProvider.clear(),
  });
  context.subscriptions.push({ dispose: () => detailPanel.dispose() });
  panelProvider.setOpenDetailHandler(
    (source: DetailSource, containerId: string, sessionId: string, target?: { groupKey: string; agentId: string }) =>
      detailPanel.show(source, containerId, sessionId, target),
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
    openClaudeEditor(sessionId, { failMessage: 'Could not focus Claude Code session. Is the Claude Code extension installed?' });
  });

  // Auto-focus the card of a newly started session (ui-focus-1). Seeded on the
  // first update so activation never grabs a card. Covers "+ New", sessions
  // started from the Claude Code tab, and terminal sessions alike — the JSONL
  // appears on first message and the next poll diff focuses it.
  let knownSessionIds: Set<string> | null = null;
  // How long after a chat's first activity an arrival-to-live transition still
  // counts as "newly created" for the focus highlight. A new chat's first JSONL
  // record is `enqueue` (status 'done') and only dequeues to 'running' a poll
  // later, so the highlight must fire on that promotion — but a session
  // re-discovered from outside the scan window (an old resume) replays to an old
  // firstActivity and must not. The window is generous against the sub-second
  // enqueue→dequeue gap plus one poll interval.
  const NEW_CHAT_FOCUS_WINDOW_MS = 30_000;

  // Handle new chat: open a fresh Claude Code editor panel. The new session's
  // card is focused by the generic new-session diff in sendUpdate() once its
  // JSONL appears.
  panelProvider.setNewChatHandler(() => {
    openClaudeEditor(undefined, { failMessage: 'Could not open new chat. Is the Claude Code extension installed?' });
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
    // A team folds into its orchestrator's session card (no separate team
    // section), so the card's dismiss is the team's only dismiss affordance:
    // archiving the lead archives the team. Undismiss stays per-artefact via
    // the archive compact rows.
    for (const team of discovery.getTeamSnapshots()) {
      if (!team.dismissed && team.orchestrator.sessionId === sessionId) {
        discovery.dismissTeam(team.teamId);
      }
    }
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
    openClaudeEditor(sessionId, { onSettled: sendUpdate });
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

  // Handle team undismiss (dismiss rides the orchestrator card's session
  // dismiss — see setDismissHandler above)
  panelProvider.setUndismissTeamHandler((teamId: string) => {
    discovery.undismissTeam(teamId);
    // Reopen the orchestrator conversation, mirroring session undismiss. Note
    // the team id is NOT the orchestrator session id for Agent Teams (it's
    // `at:<name>`), so resolve the lead session from the snapshot.
    const orchSessionId = discovery.getTeamSnapshots().find(t => t.teamId === teamId)?.orchestrator.sessionId;
    if (orchSessionId) {
      openClaudeEditor(orchSessionId, { onSettled: sendUpdate });
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
      openClaudeEditor(sessionId, { onSettled: sendUpdate });
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

  // Confinement for openWorkspace (audit security-webview-1): every legitimate
  // producer (foreign row, worktree pane row, picker child) posts a cwd the
  // host itself supplied, so the handler accepts only currently discovered
  // paths — a compromised webview gets no arbitrary-folder-open capability.
  // Rebuilt per call; discovery sets change as polls land.
  function discoveredWorkspaceCwds(): Set<string> {
    const allowed = new Set<string>([normPath(wsPath)]);
    for (const g of discovery.getForeignWorkspaces()) {
      if (g.cwd) { allowed.add(normPath(g.cwd)); }
      if (g.repoRoot) { allowed.add(normPath(g.repoRoot)); }
      for (const w of g.worktrees ?? []) { allowed.add(normPath(w.path)); }
    }
    for (const wt of discovery.getDiscoveredWorktrees()) { allowed.add(normPath(wt.path)); }
    for (const s of [...discovery.getForeignWaitingSnapshots(), ...discovery.getForeignRunningSnapshots()]) {
      if (s.cwd) { allowed.add(normPath(s.cwd)); }
    }
    return allowed;
  }

  panelProvider.setOpenWorkspaceHandler(async (cwd: string, sessionId?: string) => {
    if (!discoveredWorkspaceCwds().has(normPath(path.resolve(cwd)))) {
      log.warn('openWorkspace rejected: not a discovered workspace:', cwd);
      return;
    }
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
    // Failure is silent: the extension may not be installed; panel focus still helps.
    openClaudeEditor(hint.sessionId);
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
      openClaudeEditor(sessionId, { onFail: err => log.warn('Failed to focus session:', err) });
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
    const teams = discovery.getTeamSnapshots();
    const workflows = discovery.getWorkflowSnapshots();
    // A done/stale card with a live background workflow is still working —
    // upgrade it to running at the merge point (see applyWorkflowLiveStatus).
    const sessions = applyWorkflowLiveStatus(discovery.getSnapshots(), workflows);
    const usage = usageProvider.getSnapshot();
    const foreignWorkspaces = discovery.getForeignWorkspaces();
    const foreignWaiting = discovery.getForeignWaitingSnapshots();
    const foreignRunning = discovery.getForeignRunningSnapshots();
    const waitingCount = computeWaitingCount({
      localWaiting: discovery.getWaitingCount(),
      teams,
      foreignWaitingCount: foreignWaiting.length,
      siblingWaitingCount: discovery.getSiblingWaitingCount(),
    });
    const olderSessionCount = discovery.getOlderSessionCount();
    const worktrees = buildWorktreeRows(discovery.getDiscoveredWorktrees(), sessions, wsPath);
    panelProvider.updateSessions({
      sessions, waitingCount, workspacePath: wsPath, usage,
      foreignWorkspaces, compactSettings, teams, foreignWaiting,
      olderSessionCount, foreignRunning, worktrees, workflows,
    });
    detailPanel.refresh();

    // Auto-focus a single newly arrived live local session. Four gates keep the
    // highlight on a genuinely new chat:
    //   - The seed tick only records the baseline; activation never grabs a card.
    //   - Sibling-worktree sessions (a worktreeRoot pointing at ANOTHER window)
    //     never yank this window. NB sessionDiscovery tags every *local* snapshot
    //     with worktreeRoot === this workspace path, so "has a worktreeRoot" is
    //     NOT the sibling test — it would exclude every local session (and did:
    //     auto-focus silently never fired once local tagging landed). The sibling
    //     test mirrors the panel's local/sibling split (panel.ts).
    //   - A multi-session burst (wake-from-sleep, two chats starting at once)
    //     picks no winner arbitrarily.
    //   - firstActivity must be recent, which tells a brand-new chat (recent
    //     first record) apart from an old session re-discovered from outside the
    //     scan window (old replayed first record) — a resume must not re-fire.
    // A newcomer is absorbed into knownSessionIds only once seen live, so its
    // enqueue('done')→dequeue('running') promotion is still observed. The old
    // absorb-every-tick logic disqualified a new chat on the first tick it
    // flickered through 'done' before its turn began — the reported bug.
    if (knownSessionIds === null) {
      knownSessionIds = new Set(sessions.map(s => s.sessionId));
    } else {
      const now2 = Date.now();
      const wsNorm = normPath(wsPath);
      const isSibling = (s: { worktreeRoot?: string }): boolean =>
        !!s.worktreeRoot && normPath(s.worktreeRoot) !== wsNorm;
      const candidates = sessions.filter(s =>
        !knownSessionIds!.has(s.sessionId)
        && !isSibling(s)
        && (s.status === 'running' || s.status === 'waiting')
        && now2 - s.firstActivity < NEW_CHAT_FOCUS_WINDOW_MS);
      if (candidates.length === 1) {
        panelProvider.focusSession(candidates[0].sessionId);
      }
      // Absorb only once a session has been seen live (or is a sibling worktree,
      // which can never be a candidate) — a non-live local newcomer stays
      // eligible so its later promotion to live is not missed.
      for (const s of sessions) {
        if (s.status === 'running' || s.status === 'waiting' || isSibling(s)) {
          knownSessionIds.add(s.sessionId);
        }
      }
    }
  }

  discovery.start(() => sendUpdate()).catch(err => {
    log.error('SessionDiscovery start failed:', err);
  });
  usageProvider.start(() => sendUpdate());

  // Refresh usage when the window regains focus. Cheap when nothing changed
  // (cooldown short-circuits); picks up credential changes made while the
  // window was in the background without waiting for the next poll.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) { void usageProvider.refresh(); }
    }),
  );

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
      detailPanel.sendSettings(); // refresh the composer gate (experimental.*)
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
