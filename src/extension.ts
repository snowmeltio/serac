import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionDiscovery } from './sessionDiscovery.js';
import { setConfidenceThresholds } from './sessionManager.js';
import { claudeProjectsDir, sessionDirFromJsonl, subagentsDirFor } from './paths.js';
import { FooterSlotRegistry } from './footerSlots.js';
import type { SeracExports } from './types.js';
import { AgentPanelProvider } from './panelProvider.js';
import { DetailPanel } from './detailPanel.js';
import type { DetailSource } from './types.js';
import { renderTranscript } from './transcriptRenderer.js';
import { UsageProvider } from './usageProvider.js';
import { ensureSessionMetadata } from './sessionRepair.js';
import { isRcOriginTranscript, RC_ENTRYPOINT } from './rcOrigin.js';
import { getSessionLastWriteMtime } from './writerActivity.js';
import {
  classifyTransfer, isSameProcess, waitForRelease,
  TRANSFER_QUIET_MS, RELEASE_TIMEOUT_MS, RELEASE_POLL_MS, RELEASE_SETTLE_MS,
} from './transferClassifier.js';
import { rewriteTranscriptEntrypoint, VSCODE_ENTRYPOINT } from './transcriptEntrypoint.js';
import { verifyClaudeProcess, registryStartMs } from './processIdentity.js';
import { readCompactSettings, getClaudeSettingsPath, readRemoteControlAtStartup, type CompactSettings } from './claudeSettings.js';
import {
  rcTerminalEnvOverrides, locateClaudeCli, rcStartCommand, rcInstallCommand, rcQuickPickItems, isDefaultProfile,
  RC_COMPANION_START_WITHHELD_MESSAGE,
  findLiveRcTerminal, rcWatchTick, rcWatchStarted, RC_TERMINAL_NAME, RC_WATCH_IDLE, RC_STOPPED_MESSAGE,
  type RcWatchState,
} from './rcLauncher.js';
import { sanitiseWorkspaceKey, applyWorkflowLiveStatus, normPath, computeWaitingCount, formatAge } from './panelUtils.js';
import { buildWorktreeRows } from './worktreeRows.js';
import {
  openWorkspaceFolder, writeFocusHint, consumeFocusHint, focusHintPath,
  addressedFocusHintPath, writeAddressedFocusHint, sweepStaleAddressedHints, deriveUserDataDir,
  addressedReleaseHintPath, writeAddressedReleaseHint,
} from './workspaceOpener.js';
import { isExtensionHostPid } from './writerOwnership.js';
import { isValidSessionId } from './validation.js';
import { wireHookIngress } from './hookWiring.js';
import { readSettings, onSettingsChanged, type SeracSettings } from './settings.js';
import { resolveRepoRoot } from './gitWorktreeUtil.js';
import { appendInboxMessage, peekInboxMessages } from './teammateInbox.js';
import {
  NativeDocsProvider, NATIVE_DOCS_SCHEME,
  makeShowRawRecordCommand, makeOpenTranscriptDocCommand, makeShowFileChangesCommand,
} from './nativeDocs.js';

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

  // This window's own VS Code instance dir (--user-data-dir), derived exactly
  // from globalStorage — null when the layout is unrecognised (portable mode),
  // in which case instance-targeted spawns are skipped rather than guessed.
  const ownUserDataDir: string | null =
    context.globalStorageUri ? deriveUserDataDir(context.globalStorageUri.fsPath) : null;

  /** Open (or reveal) a Claude Code editor tab via the companion extension's
   *  command. `sessionId` undefined opens a new chat. When a *different* VS
   *  Code window is confirmed to be this session's live writer right now,
   *  opening here would let two processes append to the same JSONL file — so
   *  instead of opening, this HANDS OFF: it drops a focus hint addressed to
   *  the owning window's extension-host pid, and that window foregrounds
   *  itself with the session revealed. When the owner can't be addressed (a
   *  terminal-parent false positive, or ps couldn't verify it), the legacy
   *  behaviour remains: blocked with a warning while recently active,
   *  reclaimable after the 10-minute quiet window. Failure otherwise usually
   *  means the Claude Code extension isn't installed — callers choose how
   *  loudly to say so. `onSettled` fires on every settled path (the undismiss
   *  flows re-render either way). */
  function openClaudeEditor(sessionId: string | undefined, opts: {
    onSettled?: () => void;
    /** Runs only when the editor actually opened the session HERE — not on
     *  a hand-off to another window and not on failure. */
    onOpened?: () => void;
    failMessage?: string;
    onFail?: (err: unknown) => void;
  } = {}): void {
    void (async () => {
      // Fresh, not cached — the poll loop's registry snapshot is exactly stale
      // during the highest-risk window (a session that just started, or just
      // finished, elsewhere). See resolveOpenGate()'s own doc comment.
      // Hint receivers run this same gate: aggregateWriterOwnership gives an
      // own-window process precedence, so a receiver that owns the session
      // opens it locally, one that watched ownership drift away forwards the
      // handoff to the new owner, and a genuine conflict still blocks — no
      // bypass needed, and no hint ping-pong.
      if (sessionId !== undefined) {
        const verdict = await discovery.resolveOpenGate(sessionId, { classifyOwner: true });
        if (verdict.kind === 'external') {
          // Addressable is checked BEFORE the quiet unlock, deliberately: a
          // session sitting idle in another live window is still that
          // window's session — the click means "take me there", not "reclaim
          // it here". Local reclaim happens once the owner process is gone
          // (verdict clears), or via the quiet unlock for owners that can't
          // be addressed at all.
          if (verdict.addressable && verdict.ownerPid !== null) {
            // File the hint under the OWNING window's workspace key — its
            // watcher covers the folder IT has open, which for a
            // sibling-worktree or cross-cwd session is not this window's.
            // ownerCwd comes from the process registry (getcwd — already
            // symlink-free); the fallback uses this window's resolved path
            // for the same reason the receive-side key does.
            const ownerKey = sanitiseWorkspaceKey(verdict.ownerCwd ?? canonicalWsPath);
            try {
              await writeAddressedFocusHint(projectsDir, ownerKey, verdict.ownerPid, sessionId);
            } catch (err) {
              log.warn('Failed to write addressed focus hint:', err);
              void vscode.window.showWarningMessage('Could not hand off to the other VS Code window.');
              opts.onSettled?.();
              return;
            }
            vscode.window.setStatusBarMessage('Switching to the window running this session…', 3000);
            const hintPath = addressedFocusHintPath(projectsDir, ownerKey, verdict.ownerPid);
            log.info(`Handoff: wrote addressed focus hint for session ${sessionId} → pid ${verdict.ownerPid} at ${hintPath}`);
            // Delivery check: an extension-host owner isn't necessarily a
            // Serac-running owner (Cursor/Windsurf, a profile without Serac,
            // an older Serac with no addressed watcher). Consumption deletes
            // the file; if it still exists shortly, nobody is listening —
            // withdraw it and say so instead of leaving a dead click. The
            // file is content-checked first: the basename carries the OWNER
            // pid, not the session, so a second handoff to the same window
            // overwrites it — this click's timer must not destroy (or warn
            // about) a successor click's fresh hint.
            setTimeout(() => {
              void (async () => {
                let raw: string;
                try {
                  raw = await fs.promises.readFile(hintPath, 'utf-8');
                } catch {
                  log.info(`Handoff: hint for pid ${verdict.ownerPid} consumed — the owning window took over`);
                  return;
                }
                try {
                  const parsed = JSON.parse(raw) as { sessionId?: unknown; requestedAt?: unknown };
                  const superseded = parsed?.sessionId !== sessionId
                    || (typeof parsed?.requestedAt === 'number' && Date.now() - parsed.requestedAt < 2400);
                  if (superseded) { return; } // a newer click's hint — its own timer covers it
                } catch { /* torn or foreign content — withdraw it below */ }
                fs.promises.unlink(hintPath).catch(() => { /* consumed after all, or GC'd */ });
                log.warn(`Handoff: hint for pid ${verdict.ownerPid} not consumed within 2.5s — withdrawn`);
                void vscode.window.showWarningMessage(
                  'The window running this session did not respond — it may not be running Serac. Not opening here to avoid a conflict.',
                );
              })();
            }, 2500);
            opts.onSettled?.();
            return;
          }
          if (!verdict.quietUnlocked) {
            log.info(`Handoff: session ${sessionId} externally owned but not addressable (ownerPid ${verdict.ownerPid ?? 'unknown'}) — blocking`);
            void vscode.window.showWarningMessage(
              'This session is open in another VS Code window right now — not opening here to avoid a conflict.',
            );
            opts.onSettled?.();
            return;
          }
          // Non-addressable owner past the quiet window: legacy unlock —
          // fall through and open locally.
        }
      }
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One).then(
        () => {
          // A card the webview marked external suppresses its own focus
          // highlight (the click usually means a handoff) — but this branch
          // just opened the session HERE (stale mark, or quiet unlock), so
          // the host drives the highlight it skipped.
          if (sessionId !== undefined && discovery.isMarkedExternalWriter(sessionId)) {
            panelProvider.focusSession(sessionId);
          }
          opts.onOpened?.();
          opts.onSettled?.();
        },
        (err: unknown) => {
          if (opts.failMessage) { void vscode.window.showInformationMessage(opts.failMessage); }
          opts.onFail?.(err);
          opts.onSettled?.();
        },
      );
    })();
  }

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
    isExternalWriterFresh: (sessionId: string) => discovery.isExternalWriterFresh(sessionId),
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
    // A phone-originated (sdk-cli) card while the transfer gate is on: the
    // Claude Code panel cannot restore it, so a plain open would only produce
    // an empty chat. The 📡→ chip is the way in; the body click is a no-op
    // with a hint. Gate off = today's behaviour, untouched.
    if (readSettings().experimental.transferPhoneSessions
        && isRcOriginTranscript(discovery.getEntrypointOf(sessionId))) {
      vscode.window.setStatusBarMessage('Phone session: use its \u{1F4E1}\u2192 chip to bring it here.', 5000);
      return;
    }
    // A click on an externally-owned card is a hand-off, not a view: skip the
    // acknowledge bookkeeping (the ack-only unseen contract means a session
    // never actually opened here must keep its done-but-unseen state) and
    // never write metadata into a JSONL another window's process owns (the
    // files are shared on disk across profile symlink farms). The mark probe
    // answers for every category — local, sibling, team lead — unlike a
    // getSnapshots() lookup.
    const ownedElsewhere = discovery.isMarkedExternalWriter(sessionId);
    if (!ownedElsewhere) {
      // Acknowledge the previously focused session now that the user has moved off it
      if (previouslyFocusedSessionId && previouslyFocusedSessionId !== sessionId) {
        acknowledgePrevious();
      }
      previouslyFocusedSessionId = sessionId;
      // Ensure the JSONL has summary metadata so the Claude extension can
      // discover it. Skip for running sessions to avoid concurrent write risk.
      const isRunning = discovery.isSessionRunning(sessionId) || discovery.isTeamSessionRunning(sessionId);
      if (!isRunning) {
        const jsonlPath = discovery.getSessionFilePath(sessionId)
          ?? discovery.getTeamSessionFilePath(sessionId);
        if (jsonlPath) { void ensureSessionMetadata(sessionId, jsonlPath); }
      }
    }
    openClaudeEditor(sessionId, { failMessage: 'Could not focus Claude Code session. Is the Claude Code extension installed?' });
  });

  /** Close THIS window's editor tab for `sessionId`. Claude tabs carry no
   *  per-session identity in their viewType, so: first look for the session id
   *  in any string of the tab input (some builds encode it in the uri); else
   *  fall back to focus-then-close — `claude-vscode.editor.open` reveals the
   *  session's EXISTING tab, and the now-active tab is closed only after
   *  verifying it is a Claude tab. Never closes a non-Claude tab. */
  function isClaudeTab(tab: vscode.Tab): boolean {
    const input = tab.input;
    return !!input && typeof input === 'object' && 'viewType' in input
      && (input as { viewType: string }).viewType.includes('claudeVSCode');
  }
  function allClaudeTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(isClaudeTab);
  }
  function findSessionTab(tabs: readonly vscode.Tab[], sessionId: string): vscode.Tab | undefined {
    return tabs.find(tab => {
      const input = tab.input as Record<string, unknown>;
      return Object.values(input).some(v =>
        (typeof v === 'string' && v.includes(sessionId))
        || (!!v && typeof v === 'object' && 'toString' in v && String(v).includes(sessionId)));
    });
  }
  async function closeOwnSessionTab(sessionId: string): Promise<boolean> {
    const byId = findSessionTab(allClaudeTabs(), sessionId);
    if (byId) {
      log.info(`Dual-writer release: closing session tab for ${sessionId} (matched by tab input)`);
      return vscode.window.tabGroups.close(byId);
    }
    // Focus-then-close fallback. The open command reveals the existing tab
    // for this session — or CREATES one when none exists, so the before-set
    // is captured to guarantee anything the open added gets closed even when
    // the active-tab check misses (focus can land elsewhere; leaving a
    // freshly created tab open would ADD a writer on a release request).
    const before = new Set(allClaudeTabs());
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, vscode.ViewColumn.One);
    } catch {
      return false;
    }
    const after = allClaudeTabs();
    // Best evidence first: an id match (the reveal may have made the input
    // identifiable), then any tab the open created, then the active tab.
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    const target = findSessionTab(after, sessionId)
      ?? after.find(t => !before.has(t))
      ?? (active && isClaudeTab(active) ? active : undefined);
    if (target) {
      log.info(`Dual-writer release: closing session tab for ${sessionId} (focus-then-close)`);
      return vscode.window.tabGroups.close(target);
    }
    return false;
  }

  // Sessions this window recently asked the OTHER window to release ("keep
  // here"). Guards the mutual-keep race: if both windows pick "keep here"
  // within the hint TTL, each receives the other's release hint — without
  // this, both tabs close and the session ends everywhere, the inverse of
  // both intents. A receiver that recently requested keep refuses instead.
  const keepRequestedAt = new Map<string, number>();
  const KEEP_GUARD_MS = 60_000; // ≥ the hint TTL, so a live hint never bypasses it

  /** 📡→ bring-here: take a phone-originated (Remote Control-hosted,
   *  `entrypoint: sdk-cli`) session into this window. The Claude Code panel
   *  refuses to restore such transcripts (its lister drops sdk-cli), so:
   *  (1) if the phone's process is alive and idle, ask, then SIGTERM it and
   *  wait for its registry entry to clear — never escalate; (2) rewrite the
   *  transcript's entrypoint to claude-vscode; (3) reload our tailer (the
   *  file grew in place); (4) open. This window's Remote Control auto-enrol
   *  then puts the session back on the phone under a new bridge id.
   *  Verified end to end 2026-09-03 (Claude Code 2.1.258). */
  const transferInFlight = new Set<string>();
  async function transferSession(sessionId: string): Promise<void> {
    if (transferInFlight.has(sessionId)) { return; } // a second activation while the first runs
    transferInFlight.add(sessionId);
    try {
      await transferSessionInner(sessionId);
    } catch (err) {
      log.warn(`Transfer: unexpected failure for session ${sessionId}:`, err);
      void vscode.window.showWarningMessage('Bringing the session here failed part-way. Nothing was changed on disk unless the log says otherwise.');
    } finally {
      transferInFlight.delete(sessionId);
    }
  }
  const gateOn = () => readSettings().experimental.transferPhoneSessions;
  async function transferSessionInner(sessionId: string): Promise<void> {
    if (!gateOn()) {
      vscode.window.setStatusBarMessage('Phone-session transfer is off (serac.experimental.transferPhoneSessions).', 5000);
      return;
    }
    // Local sessions only: a sibling-worktree card's transcript sits under a
    // project key this window's panel cannot restore from, and the tailer
    // that would need replaying belongs to that worktree's own window.
    if (discovery.getEntrypointOf(sessionId) === undefined) {
      vscode.window.setStatusBarMessage('This phone session belongs to another worktree \u2014 bring it in from that folder\u2019s window.', 6000);
      return;
    }
    const jsonlPath = discovery.getSessionFilePath(sessionId);
    if (!jsonlPath) {
      vscode.window.setStatusBarMessage('Could not find this session\u2019s transcript.', 4000);
      return;
    }
    const subagentsDir = subagentsDirFor(sessionDirFromJsonl(jsonlPath));
    const classify = async () => {
      const procs = await discovery.getProcessesForSessionFresh(sessionId);
      const nowMs = Date.now();
      const lastWriteMtimeMs = getSessionLastWriteMtime(jsonlPath, subagentsDir, { recentEnoughMs: TRANSFER_QUIET_MS, nowMs });
      return classifyTransfer({
        procs, nowMs, lastWriteMtimeMs,
        sessionRunning: discovery.isSessionRunning(sessionId),
      });
    };
    const busy = () => vscode.window.setStatusBarMessage('This session is still working from your phone. Try again when it goes quiet.', 5000);

    let verdict = await classify();
    if (verdict.kind === 'desktop') {
      // Already a window's session (e.g. transferred moments ago) — the
      // ordinary open path, with its ownership gate, is the right one.
      log.info(`Transfer: session ${sessionId} already has a window process — plain open`);
      openClaudeEditor(sessionId, { onSettled: sendUpdate });
      return;
    }
    if (verdict.kind === 'rc-busy') {
      log.info(`Transfer: session ${sessionId} busy on the phone (${verdict.reason}) — refused`);
      busy();
      return;
    }

    if (verdict.kind === 'rc-idle') {
      const target = verdict.proc;
      // The registry entry is a file the process wrote; a crashed child leaves
      // it behind and a recycled pid then reads as live. Ask the OS who the
      // pid is before offering to signal it.
      const identityOk = async (): Promise<boolean> => {
        const identity = await verifyClaudeProcess(target.pid, registryStartMs(target));
        if (identity.kind === 'verified') { return true; }
        log.warn(`Transfer: refusing to signal pid ${target.pid} for session ${sessionId} — identity ${identity.kind}`);
        void vscode.window.showWarningMessage(
          identity.kind === 'not-claude' || identity.kind === 'start-mismatch'
            ? 'The process registered for this phone session is not the one that started it (a stale registry entry). Nothing was changed. Try again shortly.'
            : 'Could not confirm which process is driving this phone session. Nothing was changed.');
        return false;
      };
      if (!(await identityOk())) { return; }
      const picked = await vscode.window.showWarningMessage(
        'Bring this phone session here?',
        { modal: true, detail: 'This ends the phone\u2019s copy of the session. It reappears on your phone once it is open here.' },
        'Bring here',
      );
      if (picked !== 'Bring here') { return; }
      if (!gateOn()) { // switched off while the modal sat open
        vscode.window.setStatusBarMessage('Phone-session transfer is off (serac.experimental.transferPhoneSessions).', 5000);
        return;
      }
      // Re-verify after the modal — it can sit open for a while, and the
      // phone may have started a turn or the process may have gone.
      verdict = await classify();
      if (verdict.kind === 'rc-busy') { busy(); return; }
      if (verdict.kind === 'desktop') { openClaudeEditor(sessionId, { onSettled: sendUpdate }); return; }
      if (verdict.kind === 'rc-idle') {
        if (!isSameProcess(verdict.proc, target)) {
          vscode.window.setStatusBarMessage('The phone\u2019s process changed underneath the prompt \u2014 nothing done. Try again.', 5000);
          return;
        }
        // The registry file cannot tell us the child died and its pid was
        // recycled while the modal sat open — only the OS can. Ask again,
        // right before the signal.
        if (!(await identityOk())) { return; }
        try {
          process.kill(target.pid, 'SIGTERM');
          log.info(`Transfer: sent SIGTERM to phone process ${target.pid} for session ${sessionId}`);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') {
            log.warn(`Transfer: could not signal pid ${target.pid}:`, err);
            void vscode.window.showWarningMessage('Could not end the phone\u2019s copy of this session. Nothing was changed.');
            return;
          }
        }
        const outcome = await waitForRelease(
          () => discovery.getProcessesForSessionFresh(sessionId), target,
          { timeoutMs: RELEASE_TIMEOUT_MS, intervalMs: RELEASE_POLL_MS },
        );
        if (outcome === 'timeout') {
          log.warn(`Transfer: pid ${target.pid} still registered after ${RELEASE_TIMEOUT_MS}ms — not touching the transcript`);
          void vscode.window.showWarningMessage('The phone\u2019s copy did not exit within 5 seconds. Nothing was changed. Try again shortly.');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, RELEASE_SETTLE_MS));
        // Last look before writing: a server that respawned a child (none
        // observed, but cheap to guard) would make the rewrite a race.
        const finalCheck = await classify();
        if (finalCheck.kind !== 'dead') {
          log.warn(`Transfer: session ${sessionId} has a live process again (${finalCheck.kind}) — aborting before rewrite`);
          vscode.window.setStatusBarMessage('A process picked this session back up. Nothing was changed. Try again.', 5000);
          return;
        }
      }
      // verdict.kind === 'dead' after the modal: the phone's process went on
      // its own while the prompt sat open — nothing to release, fall through.
    }

    // The rewrite runs INSIDE the session's update chain so no poll read can
    // land between the rename and the replay (see SessionManager.runThenReplay).
    let result: { changed: number; skipped: boolean };
    try {
      result = await discovery.reloadSessionAfter(
        sessionId,
        () => rewriteTranscriptEntrypoint(jsonlPath, { from: RC_ENTRYPOINT, to: VSCODE_ENTRYPOINT, sessionId }),
        r => !r.skipped,
      );
    } catch (err) {
      log.warn(`Transfer: rewrite failed for ${jsonlPath}:`, err);
      void vscode.window.showWarningMessage('Could not rewrite the transcript. Nothing was changed.');
      return;
    }
    log.info(`Transfer: ${result.skipped ? 'no sdk-cli records to rewrite' : `rewrote ${result.changed} record(s)`} for session ${sessionId}`);
    // The same bookkeeping tail a card click gets: the user is moving onto
    // this session, so the previous one is acknowledged and this one takes
    // the highlight — otherwise the replayed running→done flip would leave a
    // just-opened session teal-unseen.
    if (previouslyFocusedSessionId && previouslyFocusedSessionId !== sessionId) { acknowledgePrevious(); }
    previouslyFocusedSessionId = sessionId;
    sendUpdate();
    openClaudeEditor(sessionId, {
      onOpened: () => panelProvider.focusSession(sessionId),
      onSettled: sendUpdate,
      failMessage: 'Could not open the session here. Is the Claude Code extension installed?',
    });
  }
  panelProvider.setTransferSessionHandler((sessionId: string) => { void transferSession(sessionId); });

  // ⚠ dual-writer resolve: the session has live interactive processes in
  // this window AND another. The picker lets the user choose which window
  // keeps it; the loser's tab is closed (locally, or via an addressed
  // release hint the other window's Serac consumes).
  panelProvider.setResolveDualWriterHandler((sessionId: string) => {
    void (async () => {
      // Fresh re-verify at the moment of decision — the chip renders off the
      // cached poll tier and the conflict may already be gone.
      if (!(await discovery.isDualWriterFresh(sessionId))) {
        vscode.window.setStatusBarMessage('This session is no longer live in two windows.', 4000);
        sendUpdate();
        return;
      }
      const procs = discovery.getProcessesForSession(sessionId);
      const externalProc = procs.find(p => discovery.getOwnershipOf(p.pid) === true
        && discovery.getOwnerPidOf(p.pid) !== undefined);
      const ownerPid = externalProc ? discovery.getOwnerPidOf(externalProc.pid) : undefined;
      const otherLabel = externalProc?.cwd ? path.basename(externalProc.cwd) : 'another window';
      const age = (startedAt: number | null): string =>
        startedAt === null ? '' : ` (running ${formatAge(Date.now() - startedAt)})`;
      const ownProc = procs.find(p => discovery.getOwnershipOf(p.pid) === false);
      const picked = await vscode.window.showQuickPick([
        {
          label: '$(check) Keep here',
          description: `ask the window on ${otherLabel} to close its copy${age(externalProc?.startedAt ?? null)}`,
          action: 'keep' as const,
        },
        {
          label: '$(close) Release here',
          description: `close this window's copy${age(ownProc?.startedAt ?? null)}`,
          action: 'release' as const,
        },
      ], { title: 'Session is live in two windows', placeHolder: 'Two processes can write the same conversation file — pick the window that keeps it' });
      if (!picked) { return; }
      // Re-verify AFTER the picker too — it can sit open for minutes, and
      // acting on a stale verdict here closes the last live copy (release)
      // or asks a window that no longer holds the session (keep).
      if (!(await discovery.isDualWriterFresh(sessionId))) {
        vscode.window.setStatusBarMessage('This session is no longer live in two windows.', 4000);
        sendUpdate();
        return;
      }

      if (picked.action === 'release') {
        const closed = await closeOwnSessionTab(sessionId);
        if (!closed) {
          void vscode.window.showWarningMessage(
            'Could not identify this session’s tab — close it manually to resolve the conflict.');
        }
        return;
      }

      // Keep here: address a release hint to the other window, mirroring the
      // focus-hint handoff (addressability check, owner-key filing, 2.5s
      // delivery check with withdraw-and-warn).
      if (ownerPid === undefined || (await isExtensionHostPid(ownerPid)) !== true) {
        void vscode.window.showWarningMessage(
          'The other window could not be addressed — close the session’s tab there manually to resolve the conflict.');
        return;
      }
      const ownerKey = sanitiseWorkspaceKey(externalProc?.cwd ?? canonicalWsPath);
      keepRequestedAt.set(sessionId, Date.now()); // arm the mutual-keep guard before the hint lands
      try {
        await writeAddressedReleaseHint(projectsDir, ownerKey, ownerPid, sessionId);
      } catch (err) {
        log.warn('Failed to write addressed release hint:', err);
        void vscode.window.showWarningMessage('Could not ask the other VS Code window to release the session.');
        return;
      }
      vscode.window.setStatusBarMessage('Asked the other window to release this session…', 3000);
      const hintPath = addressedReleaseHintPath(projectsDir, ownerKey, ownerPid);
      log.info(`Dual-writer: wrote addressed release hint for session ${sessionId} → pid ${ownerPid} at ${hintPath}`);
      setTimeout(() => {
        void (async () => {
          let raw: string;
          try {
            raw = await fs.promises.readFile(hintPath, 'utf-8');
          } catch {
            log.info(`Dual-writer: release hint for pid ${ownerPid} consumed — the other window released`);
            return;
          }
          try {
            const parsed = JSON.parse(raw) as { sessionId?: unknown; requestedAt?: unknown };
            const superseded = parsed?.sessionId !== sessionId
              || (typeof parsed?.requestedAt === 'number' && Date.now() - parsed.requestedAt < 2400);
            if (superseded) { return; }
          } catch { /* torn or foreign content — withdraw it below */ }
          fs.promises.unlink(hintPath).catch(() => { /* consumed after all, or GC'd */ });
          log.warn(`Dual-writer: release hint for pid ${ownerPid} not consumed within 2.5s — withdrawn`);
          void vscode.window.showWarningMessage(
            'The other window did not respond — it may not be running Serac. Close the session’s tab there manually.');
        })();
      }, 2500);
    })();
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
    // Ensure metadata before opening (same as focus handler, including the
    // externally-owned skip — see there).
    if (!discovery.isSessionRunning(sessionId) && !discovery.isMarkedExternalWriter(sessionId)) {
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
  // Canonicalised (see claudeProjectsDir): every window must derive the same
  // hint/watch paths regardless of which account-farm alias launched it.
  const projectsDir = claudeProjectsDir();
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
      // Pinned to THIS window's own instance: with several profile instances
      // running, a bare CLI call routes by its own default-instance
      // resolution, which may be a different profile's window. Workspace and
      // worktree rows always open in the current profile — the session-card
      // swap (openClaudeEditor) is the only cross-profile affordance.
      const outcome = await openWorkspaceFolder(cwd, { userDataDir: ownUserDataDir ?? undefined });
      log.info(`openWorkspace: ${outcome.kind} for ${cwd}`);
    } catch (err) {
      log.warn('Failed to open workspace folder:', err);
      vscode.window.showWarningMessage(`Failed to open workspace at ${cwd}.`);
    }
  });


  // Receive side: when another Serac instance leaves us a focus hint, pick it up
  // both on activate (in case we just launched) and via a FileSystemWatcher
  // (already-running window). Keyed by the RESOLVED folder path: hint writers
  // derive keys from a claude process's registered cwd, which the OS reports
  // symlink-free (getcwd), while VS Code reports the folder as opened — a
  // workspace opened via /tmp/x (really /private/tmp/x) would otherwise watch
  // a key no writer ever uses.
  const canonicalWsPath = (() => {
    try { return fs.realpathSync(wsPath); } catch { return wsPath; }
  })();
  const localWorkspaceKey = sanitiseWorkspaceKey(canonicalWsPath);
  const localHintPath = focusHintPath(projectsDir, localWorkspaceKey);
  async function applyFocusHint() {
    const hint = await consumeFocusHint(localHintPath);
    if (!hint || !isValidSessionId(hint.sessionId)) { return; }
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

  // Addressed hints — the cross-window session handoff. Another window that
  // found US to be a clicked session's owner (via the claude process's parent
  // pid) drops focus-hint-<our extension-host pid>.json in the shared hint
  // dir; only this window watches that basename, so there is no consume race
  // with other windows on the same folder (profile symlink farms share the
  // projects dir) and legacy windows never see it. On pickup: raise our own
  // OS window by asking our own instance for our own folder — the one
  // --user-data-dir we know exactly (derived from globalStorage, never parsed
  // from ps) — then reveal the session. cliOnly: degrading to a duplicate
  // window of a folder we already have open would be worse than not raising.
  const addressedHintPath = addressedFocusHintPath(projectsDir, localWorkspaceKey, process.pid);
  // A single hint write fires both onDidCreate and onDidChange milliseconds
  // apart, and consumeFocusHint's unlink is fire-and-forget — without a
  // gate, both invocations read the hint before either delete lands and the
  // whole handoff (CLI spawn + editor open) runs twice. An event landing
  // while a hint is being processed (the self-foreground spawn alone takes
  // 200ms+) queues ONE re-check instead of being dropped — a second click's
  // hint must not sit unconsumed until the sender withdraws it.
  let addressedHintInFlight = false;
  let addressedHintRecheck = false;
  async function applyAddressedFocusHint() {
    if (addressedHintInFlight) { addressedHintRecheck = true; return; }
    addressedHintInFlight = true;
    try {
      do {
        addressedHintRecheck = false;
        const hint = await consumeFocusHint(addressedHintPath);
        if (!hint || !isValidSessionId(hint.sessionId)) { continue; }
        log.info(`Handoff: consumed addressed focus hint for session ${hint.sessionId}`);
        if (ownUserDataDir) {
          try {
            const outcome = await openWorkspaceFolder(wsPath, { userDataDir: ownUserDataDir, cliOnly: true });
            if (outcome.kind === 'spawned') {
              log.info(`Handoff: self-foreground via ${outcome.cli} --user-data-dir ${ownUserDataDir}`);
            } else {
              log.warn(`Handoff: self-foreground unavailable (${outcome.kind}) — revealing in place without raising the window`);
            }
          } catch (err) {
            log.warn('Self-foreground failed (continuing with in-window focus):', err);
          }
        }
        panelProvider.focusSession(hint.sessionId);
        // The gate re-runs here deliberately: own-window precedence in
        // aggregateWriterOwnership means we open locally when we own the
        // session, and forward the handoff if ownership drifted elsewhere
        // between the sender's classification and this pickup.
        openClaudeEditor(hint.sessionId);
      } while (addressedHintRecheck);
    } finally {
      addressedHintInFlight = false;
    }
  }
  const addressedHintWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(addressedHintPath)), path.basename(addressedHintPath)),
  );
  addressedHintWatcher.onDidCreate(() => { void applyAddressedFocusHint(); });
  addressedHintWatcher.onDidChange(() => { void applyAddressedFocusHint(); });
  context.subscriptions.push(addressedHintWatcher);
  // Addressed RELEASE hints — the dual-writer resolve. Another window whose
  // user chose "keep here" asks US to close our copy of the session. Same
  // addressing, watcher, and in-flight discipline as the focus hint; the
  // payload shape is identical so consumeFocusHint serves both.
  const releaseHintPath = addressedReleaseHintPath(projectsDir, localWorkspaceKey, process.pid);
  let releaseHintInFlight = false;
  let releaseHintRecheck = false;
  async function applyAddressedReleaseHint() {
    if (releaseHintInFlight) { releaseHintRecheck = true; return; }
    releaseHintInFlight = true;
    try {
      do {
        releaseHintRecheck = false;
        const hint = await consumeFocusHint(releaseHintPath);
        if (!hint || !isValidSessionId(hint.sessionId)) { continue; }
        log.info(`Dual-writer: consumed addressed release hint for session ${hint.sessionId}`);
        // Mutual-keep guard: if THIS window recently asked the other to
        // release the same session, both users chose "keep" — refuse rather
        // than let both tabs close (the inverse of both intents).
        if (Date.now() - (keepRequestedAt.get(hint.sessionId) ?? -Infinity) < KEEP_GUARD_MS) {
          log.warn(`Dual-writer: refusing release for ${hint.sessionId} — this window requested keep moments ago (both windows chose keep)`);
          void vscode.window.showWarningMessage(
            'Both windows chose to keep this session — nothing was closed. Pick "Release here" in the window giving it up.');
          continue;
        }
        // Fresh re-verify before acting: the session must STILL be dual.
        // Covers both stale-hint cases — our copy already gone (the
        // focus-then-close fallback would otherwise OPEN the session here,
        // adding a writer instead of removing one), and the sender's copy
        // gone (closing ours would kill the last live copy).
        if (!(await discovery.isDualWriterFresh(hint.sessionId))) {
          log.info(`Dual-writer: ignoring release hint for ${hint.sessionId} — no longer dual at pickup`);
          continue;
        }
        const closed = await closeOwnSessionTab(hint.sessionId);
        if (closed) {
          vscode.window.setStatusBarMessage('Released a session to another window (its tab here was closed).', 5000);
        } else {
          void vscode.window.showWarningMessage(
            'Another window asked to take over a session, but its tab here could not be identified — close it manually.');
        }
      } while (releaseHintRecheck);
    } finally {
      releaseHintInFlight = false;
    }
  }
  const releaseHintWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(releaseHintPath)), path.basename(releaseHintPath)),
  );
  releaseHintWatcher.onDidCreate(() => { void applyAddressedReleaseHint(); });
  releaseHintWatcher.onDidChange(() => { void applyAddressedReleaseHint(); });
  context.subscriptions.push(releaseHintWatcher);

  // Startup consume, mirroring the legacy path above: the extension-host pid
  // exists (and is addressable) from window launch, well before Serac
  // activates — a hint written during a reload predates the watcher, whose
  // onDidCreate never fires for a pre-existing file. Also GC hints addressed
  // to windows that died before consuming. (The release hint deliberately has
  // NO startup consume: closing a tab is destructive, and a hint written
  // while this window was reloading is best treated as expired intent —
  // the sender's 2.5s delivery check will have withdrawn it and warned.)
  setTimeout(() => { void applyAddressedFocusHint(); }, 800);
  void sweepStaleAddressedHints(projectsDir, localWorkspaceKey);

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
  // Claude Code's remoteControlAtStartup — one of the two top-bar signal
  // facts (the other is the rc server, read per poll). Reloaded by the
  // settings watchers below; never written by Serac.
  let rcAutoEnrol: boolean | null = readRemoteControlAtStartup(wsPath);
  // Companion-profile verdict — constant for the life of the window (env and
  // globalStorage cannot change under a running extension host). Logged once
  // so a wrong verdict is diagnosable from the output channel rather than
  // from a silently missing picker row.
  const rcCompanionProfile = !(context.globalStorageUri && isDefaultProfile({
    configDir: process.env.CLAUDE_CONFIG_DIR,
    globalStoragePath: context.globalStorageUri.fsPath,
    home: os.homedir(),
  }));
  log.info(`Remote Control profile verdict: ${rcCompanionProfile ? 'companion' : 'default'}`
    + ` (CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? '<unset>'}, globalStorage=${context.globalStorageUri?.fsPath ?? '<none>'})`);
  // The Remote Control server Serac started in THIS window, if any: the
  // terminal, so a second start reuses it rather than adding a rival server on
  // the same directory, and the watch that notices the process dying inside a
  // terminal that stays open (v1.22.0 shipped with neither — a dead server was
  // still painting "Connected" over a live shell prompt, 2026-08-21).
  let rcTerminal: vscode.Terminal | undefined;
  let rcWatch: RcWatchState = RC_WATCH_IDLE;
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
    const rcServing = discovery.getRcServing();
    panelProvider.updateSessions({
      sessions, waitingCount, workspacePath: wsPath, usage,
      foreignWorkspaces, compactSettings, teams, foreignWaiting,
      olderSessionCount, foreignRunning, worktrees, workflows,
      rcServing,
      rcAutoEnrol,
      rcCompanionProfile,
    });
    detailPanel.refresh();

    // A server Serac started can stop without the terminal showing it, so the
    // dark signal bar would otherwise be the only tell. Same cadence as the
    // indicator it contradicts; says it once, then goes quiet.
    const watched = rcWatchTick(rcWatch, rcServing, Date.now());
    rcWatch = watched.state;
    if (watched.notify) { void notifyRcServerStopped(); }

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
  const reloadSettings = () => {
    compactSettings = readCompactSettings();
    rcAutoEnrol = readRemoteControlAtStartup(wsPath);
    sendUpdate();
  };
  settingsWatcher.onDidChange(reloadSettings);
  settingsWatcher.onDidCreate(reloadSettings);
  settingsWatcher.onDidDelete(reloadSettings);
  context.subscriptions.push(settingsWatcher);
  // The project/local layers (<ws>/.claude/settings.json, settings.local.json)
  // can override remoteControlAtStartup; watch them too.
  const projectSettingsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(wsPath, '.claude')), 'settings{,.local}.json'),
  );
  projectSettingsWatcher.onDidChange(reloadSettings);
  projectSettingsWatcher.onDidCreate(reloadSettings);
  projectSettingsWatcher.onDidDelete(reloadSettings);
  context.subscriptions.push(projectSettingsWatcher);

  /** Start a Remote Control server in a terminal the user can see and close.
   *  Reuses the terminal from an earlier start instead of opening a second
   *  one: the picker only offers this while nothing is serving the workspace,
   *  so that shell is sitting at a prompt with a dead (or never-started)
   *  server scrolled above it. Serac still never stops a server — closing the
   *  terminal is the user's job and their only off switch. */
  /** Spawn mode for a server started or installed from here, as a boolean
   *  the command builders take. `worktree` is passed through even outside a
   *  git repo — the CLI's own "not a git repository" error is the honest
   *  outcome of asking for that; `auto` is the mode that consults the
   *  workspace. Resolved at the moment of acting, so a settings edit or a
   *  `git init` between offer and answer is honoured. */
  async function rcSpawnWorktree(): Promise<boolean> {
    const mode = readSettings().rc.spawnMode;
    if (mode === 'same-dir') { return false; }
    if (mode === 'worktree') { return true; }
    return (await resolveRepoRoot(wsPath)) !== null;
  }

  async function startRcServer(): Promise<void> {
    // Guarded here as well as at the picker rows, so a future call site (the
    // stopped-warning's "Start it again" today) cannot bypass the row-level
    // gate — the same defence-in-depth as the serving re-read below.
    if (rcCompanionProfile) {
      vscode.window.setStatusBarMessage(RC_COMPANION_START_WITHHELD_MESSAGE, 8000);
      return;
    }
    // The offer goes stale while it waits to be answered: a quick pick or the
    // stopped-warning can sit for minutes, and by then another window (or the
    // launchd server) may have taken this workspace. Starting a second server
    // on one directory is exactly the collision this path exists to avoid, so
    // re-read the fact at the moment of acting rather than trusting the one
    // the offer was built from. It can lag a poll cycle; better than nothing.
    if (discovery.getRcServing()) {
      vscode.window.setStatusBarMessage('A Remote Control server is already serving this workspace — nothing to start.', 6000);
      return;
    }
    const home = process.env.HOME ?? os.homedir();
    const exists = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    const spawnWorktree = await rcSpawnWorktree();
    const reused = findLiveRcTerminal(vscode.window.terminals);
    const terminal = reused ?? vscode.window.createTerminal({
      name: RC_TERMINAL_NAME,
      cwd: wsPath,
      env: rcTerminalEnvOverrides(process.env),
    });
    rcTerminal = terminal;
    terminal.show(false);
    terminal.sendText(rcStartCommand(locateClaudeCli(home, exists), spawnWorktree), true);
    rcWatch = rcWatchStarted();
    vscode.window.setStatusBarMessage(reused
      ? 'Remote Control server restarting in its existing terminal. The indicator fills in within a poll or two.'
      : 'Remote Control server starting in the terminal. The indicator fills in within a poll or two.', 8000);
  }

  /** The server Serac started is gone while its terminal is still open. */
  async function notifyRcServerStopped(): Promise<void> {
    const again = 'Start it again';
    const reveal = 'Show terminal';
    const actions = rcTerminal ? [again, reveal] : [again];
    const picked = await vscode.window.showWarningMessage(RC_STOPPED_MESSAGE, ...actions);
    if (picked === again) { await startRcServer(); }
    else if (picked === reveal) { rcTerminal?.show(false); }
  }

  // Closing that terminal IS how you stop the server, so it is not news:
  // disarm the watch rather than reporting the user's own action back at them.
  context.subscriptions.push(vscode.window.onDidCloseTerminal(t => {
    if (t !== rcTerminal) { return; }
    rcTerminal = undefined;
    rcWatch = RC_WATCH_IDLE;
  }));

  // Top-bar Remote Control indicator, clicked while below full: offer the
  // ways to turn the rest on. Serac may START a server — in a terminal the
  // user can see and close — and never stops one; it never writes
  // remoteControlAtStartup (the user's account-level consent), only opens
  // settings.json and points at it.
  panelProvider.setRcIndicatorClickHandler(() => {
    void (async () => {
      const facts = { autoEnrol: rcAutoEnrol, serving: discovery.getRcServing(), companionProfile: rcCompanionProfile };
      const items = rcQuickPickItems(facts, process.platform, { spawnWorktree: await rcSpawnWorktree() });
      if (items.length === 0) {
        // Nothing offerable is two different stories: everything already on,
        // or the start routes withheld by the profile gate. Say which — an
        // empty picker would say neither.
        vscode.window.setStatusBarMessage(facts.companionProfile && !facts.serving
          ? RC_COMPANION_START_WITHHELD_MESSAGE
          : 'Remote Control is already fully on for this workspace.', 8000);
        return;
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Remote Control for this workspace',
        ignoreFocusOut: true,
      });
      if (!picked) { return; }
      if (picked.action === 'start') { await startRcServer(); return; }
      if (picked.action === 'install') {
        const terminal = vscode.window.createTerminal({
          name: 'Remote Control installer',
          cwd: wsPath,
          env: rcTerminalEnvOverrides(process.env),
        });
        terminal.show(false);
        terminal.sendText(rcInstallCommand(context.extensionPath, wsPath, await rcSpawnWorktree()), true);
        vscode.window.setStatusBarMessage('Remote Control installer running in the terminal.', 8000);
        return;
      }
      // 'settings': open and point, never write.
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(getClaudeSettingsPath()));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const idx = doc.getText().indexOf('remoteControlAtStartup');
      if (idx >= 0) {
        const pos = doc.positionAt(idx);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      void vscode.window.showInformationMessage(
        'Turn on "Enable Remote Control for all sessions" in Claude Code\'s Remote Control popup, or set "remoteControlAtStartup": true in this file. Serac does not change it for you.',
      );
    })();
  });

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
