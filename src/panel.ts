/**
 * Webview panel script for Serac.
 * Runs inside the VS Code webview (browser context).
 * Bundled by esbuild from src/panel.ts → media/panel.js.
 */

import {
  basename,
  countsChipsHtml,
  normPath,
  pickerChildRow,
  escapeHtml,
  stripMarkdown,
  getDisplayName,
  isGhost,
  formatAge,
  formatAgeCoarse,
  getStatusLabel,
  computeFileCollisions,
  debounceStatuses,
  getElapsedPct,
  quotaClass,
  formatResetTime,
  sanitiseWorkspaceKey,
  getModelCapacity,
  getCompactThreshold,
  formatTokenCount,
  groupForeignWorkspaces,
  PanelSession,
  UsageData,
} from './panelUtils.js';

// Declare the VS Code API type for the webview
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};

interface WorkspaceGroup {
  workspaceKey: string;
  displayName: string;
  cwd?: string | null;
  counts: Record<string, number>;
  confidence?: string;
  repoRoot?: string | null;
  /** Set on synthetic rows (groupForeignWorkspaces collapses repos with 2+
   *  worktrees into one row). Drives the worktree-count chip and gates the
   *  inline picker. */
  worktreeCount?: number;
  worktreeMembersLabel?: string;
  /** Every worktree of the repo (incl. main). Drives the inline picker. */
  worktrees?: Array<{ path: string; branch: string | null; isMain: boolean }>;
  /** Pre-aggregation per-worktree workspaces, kept so the picker can show
   *  per-worktree counts. Inactive worktrees have no matching member. */
  members?: WorkspaceGroup[];
  /** Set on synthetic rows consolidating non-git scratch dirs (under
   *  /private/tmp). The picker is driven by `members` and the chip relabelled. */
  pseudoRepo?: boolean;
  /** True when a live VS Code window has this workspace open (quiet IDE tag).
   *  Not synthesised onto aggregated rows. */
  ideOpen?: boolean;
}

/** Compact settings shape (mirrors CompactSettings from claudeSettings.ts,
 *  redefined here because the webview bundle cannot import extension-side modules). */
interface PanelCompactSettings { autoCompactWindow: number; autoCompactPct: number }

/** Team agent snapshot (mirrors TeamAgentSnapshot from types.ts) */
interface PanelTeamAgent {
  sessionId: string | null;
  name: string;
  cwd: string;
  parentSessionId: string;
  depth: number;
  spawnedAt: number;
  status: string;
  activity: string;
  confidence: string;
  subagents: PanelSession['subagents'];
  contextTokens: number;
  exitStatus: string | null;
}

/** Team snapshot (mirrors TeamSnapshot from types.ts) */
interface PanelTeam {
  teamId: string;
  name: string;
  orchestrator: {
    sessionId: string;
    status: string;
    activity: string;
    confidence: string;
    contextTokens: number;
    modelLabel: string;
  };
  agents: PanelTeamAgent[];
  counts: Record<string, number>;
  updatedAt: number;
  dismissed: boolean;
}

/** Detail-panel source key (mirrors DetailSource from types.ts; redeclared
 *  because the webview bundle cannot import extension-side modules). */
type DetailSource = 'workflow' | 'team' | 'subagents';

/** Workflow agent (subset of WorkflowAgentSnapshot the card needs). agentId and
 *  label are present at runtime (host sends the full snapshot) — they drive the
 *  inline not-done rows and their deep-link into the detail panel. */
interface PanelWorkflowAgent {
  phaseIndex: number | null;
  status: string;
  agentId?: string;
  label?: string;
}

/** Workflow run snapshot (mirrors WorkflowSnapshot from types.ts; the card
 *  uses a subset). One session may own several runs. */
interface PanelWorkflow {
  runId: string;
  sessionId: string;
  name: string;
  status: string;        // completed | running | failed | incomplete
  source: string;        // sidecar | live
  phases: { index: number; title: string }[];
  agents: PanelWorkflowAgent[];
  counts: Record<string, number>;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs: number | null;
  startTime: number;     // epoch ms; with durationMs gives the archive recency ts
  dismissed: boolean;
}

interface PanelFooterSlot {
  slotId: string;
  label: string;
  icon?: string;
  status?: 'ok' | 'warn' | 'critical';
  hasCommand: boolean;
  tooltip?: string;
}

interface PanelWorktreeRow {
  path: string;
  branch: string | null;
  displayName: string;
  counts: Record<string, number>;
  confidence: string;
  isCurrent: boolean;
  isMain: boolean;
}

interface UpdateMessage {
  type: 'update';
  sessions: PanelSession[];
  waitingCount: number;
  workspacePath: string;
  /** Host home dir for ~-abbreviation — the webview has no process.env. */
  home?: string;
  usage?: UsageData;
  foreignWorkspaces?: WorkspaceGroup[];
  foreignWaiting?: PanelSession[];
  foreignRunning?: PanelSession[];
  teams?: PanelTeam[];
  workflows?: PanelWorkflow[];
  compactSettings?: PanelCompactSettings;
  footerSlots?: PanelFooterSlot[];
  olderSessionCount?: number;
  worktrees?: PanelWorktreeRow[];
}

interface FocusMessage {
  type: 'focusSession';
  sessionId: string;
}

/** Mirrors SeracSettings from settings.ts. Webview bundle can't import
 *  extension-side modules (different bundling target), so the shape is
 *  redeclared here. Keep field names in sync. */
interface PanelSettings {
  show: {
    foreignWorkspaces: boolean;
    worktrees: boolean;
    usage: boolean;
    subagents: boolean;
    workflows: boolean;
    fileCollisions: boolean;
  };
  archive: { defaultRange: string; maxDoneShown: number };
  refresh: { intervalSeconds: number };
  discovery: { ageGateDays: number };
  foreignWorkspaces: { maxHeightPx: number };
  worktrees: { maxHeightPx: number; autoCollapseAfterSeconds: number };
  usage: { showWeekly: boolean; warnAtPercent: number; criticalAtPercent: number };
  animations: { enabled: boolean };
  cleanup: { confirmRequired: boolean };
}

interface SettingsMessage {
  type: 'settings';
  settings: PanelSettings;
}

type WebviewIncomingMessage = UpdateMessage | FocusMessage | SettingsMessage;

/** Defaults that mirror DEFAULT_SETTINGS in settings.ts. Used as the
 *  initial value before the first SettingsMessage arrives — kept in sync
 *  with the package.json `default` declarations. */
const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  show: { foreignWorkspaces: true, worktrees: true, usage: true, subagents: true, workflows: true, fileCollisions: false },
  archive: { defaultRange: '1d', maxDoneShown: 20 },
  refresh: { intervalSeconds: 5 },
  discovery: { ageGateDays: 7 },
  foreignWorkspaces: { maxHeightPx: 280 },
  worktrees: { maxHeightPx: 280, autoCollapseAfterSeconds: 20 },
  usage: { showWeekly: true, warnAtPercent: 85, criticalAtPercent: 100 },
  animations: { enabled: true },
  cleanup: { confirmRequired: true },
};

/** Animation timing. Derived from settings.animations.enabled — when
 *  animations are off, both collapse to 0 so render is instantaneous. */
let TRANSITION_MS = 300;
let FOREIGN_SLIDE_MS = 220;
// Range values in ms. 'all' uses 0 as sentinel (means no limit).
const RANGE_MS: Record<string, number> = {
  '1d': 86400000,
  '3d': 259200000,
  '7d': 604800000,
  '30d': 2592000000,
  'all': 0,
};

(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root')!;
  /** Cached settings snapshot. Replaced on every SettingsMessage; consulted
   *  by render code via direct field reads. Defaults match
   *  DEFAULT_PANEL_SETTINGS so the very first render (before any
   *  SettingsMessage arrives) behaves the same as today. */
  let currentSettings: PanelSettings = DEFAULT_PANEL_SETTINGS;
  let archiveRange = '1d';
  /** Was archiveRange restored from saved state? If yes, the user has made
   *  an explicit pill choice and we keep it; the settings.archive.defaultRange
   *  applies only to fresh installs (no saved state). */
  let archiveRangeFromSavedState = false;
  const savedState = vscode.getState();
  if (savedState && typeof savedState.archiveRange === 'string' && savedState.archiveRange in RANGE_MS) {
    archiveRange = savedState.archiveRange;
    archiveRangeFromSavedState = true;
    // Notify extension of restored range so it can load extended archive if needed
    vscode.postMessage({ type: 'archiveRange', rangeMs: RANGE_MS[archiveRange] });
  }
  let workspacePath = '';
  let workspaceKey = '';
  let homeDir = ''; // host home dir for ~-abbreviation (webview has no process.env)
  let focusedSessionId: string | null = null;
  /** sessionId → file paths shared with another ACTIVE session this tick. */
  let fileCollisions = new Map<string, string[]>();
  let lastSessions: PanelSession[] | null = null;
  let lastNeedsInputCount = 0;
  let lastUsage: UsageData | null = null;
  let lastForeignWorkspaces: WorkspaceGroup[] | null = null;
  let lastWorktrees: PanelWorktreeRow[] = [];
  let lastWorktreesHtml = '';
  let lastForeignWaiting: PanelSession[] = [];
  let lastForeignRunning: PanelSession[] = [];
  let lastTeams: PanelTeam[] = [];
  let lastWorkflows: PanelWorkflow[] = [];
  /** Rebuilt each render: parent sessionId -> its runs (most relevant first). */
  let workflowsBySession = new Map<string, PanelWorkflow[]>();
  let lastFooterSlots: PanelFooterSlot[] = [];
  let compactSettings: PanelCompactSettings | null = null;
  let lastOlderSessionCount = 0;
  let lastForeignHtml = '';
  let lastForeignKeys = '';
  let foreignAnimToken = 0;
  let foreignAnimSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  let foreignAnimEndHandler: ((ev: TransitionEvent) => void) | null = null;

  // Status debounce: tracks when each session entered waiting
  const needsInputSince: Record<string, number> = {};

  // Last rendered inner HTML per card — reconcileCards skips the innerHTML
  // write when unchanged. Pruned each render pass against renderedIds.
  const cardHtmlCache = new Map<string, string>();

  // Worktree picker expansion state (persisted). Keyed on the synthetic
  // workspace key emitted by groupForeignWorkspaces (`repo:<repoRoot>`).
  const expandedWorkspaces = new Set<string>(
    (savedState && Array.isArray(savedState.expandedWorkspaces)) ? savedState.expandedWorkspaces as string[] : []
  );
  // Idle auto-collapse timers, keyed on workspaceKey. Kept in webview-local
  // state (not persisted) so reloads don't carry zombie timers — the
  // expansion itself survives reloads via expandedWorkspaces.
  const workspaceCollapseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function saveState(): void {
    vscode.setState({
      archiveRange,
      expandedWorkspaces: Array.from(expandedWorkspaces),
    });
  }

  function clearWorkspaceCollapseTimer(workspaceKey: string): void {
    const t = workspaceCollapseTimers.get(workspaceKey);
    if (t !== undefined) {
      clearTimeout(t);
      workspaceCollapseTimers.delete(workspaceKey);
    }
  }

  function scheduleWorkspaceCollapse(workspaceKey: string): void {
    clearWorkspaceCollapseTimer(workspaceKey);
    const idleMs = currentSettings.worktrees.autoCollapseAfterSeconds * 1000;
    const timerId = setTimeout(() => {
      workspaceCollapseTimers.delete(workspaceKey);
      // Only collapse if still expanded (user may have manually collapsed
      // in the meantime, which would have already cleared the timer).
      if (expandedWorkspaces.delete(workspaceKey)) {
        saveState();
        if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      }
    }, idleMs);
    workspaceCollapseTimers.set(workspaceKey, timerId);
  }

  /** Apply a fresh settings snapshot. Sets the cached value, syncs CSS
   *  custom properties so heights / animation timings update immediately,
   *  then re-renders if data is already in hand. Called from the message
   *  handler on every SettingsMessage receipt. */
  function applySettings(settings: PanelSettings): void {
    currentSettings = settings;
    TRANSITION_MS = settings.animations.enabled ? 300 : 0;
    FOREIGN_SLIDE_MS = settings.animations.enabled ? 220 : 0;
    const docRoot = document.documentElement.style;
    docRoot.setProperty(
      '--serac-foreign-max-height',
      settings.foreignWorkspaces.maxHeightPx === 0 ? 'none' : settings.foreignWorkspaces.maxHeightPx + 'px',
    );
    docRoot.setProperty(
      '--serac-worktrees-max-height',
      settings.worktrees.maxHeightPx === 0 ? 'none' : settings.worktrees.maxHeightPx + 'px',
    );
    docRoot.setProperty('--serac-transition-ms', TRANSITION_MS + 'ms');
    docRoot.setProperty('--serac-foreign-slide-ms', FOREIGN_SLIDE_MS + 'ms');
    // Apply the configured archive default only when no saved pill exists.
    // An explicit pill click survives reloads via vscode.setState and wins.
    if (!archiveRangeFromSavedState && settings.archive.defaultRange in RANGE_MS) {
      const next = settings.archive.defaultRange;
      if (next !== archiveRange) {
        archiveRange = next;
        vscode.postMessage({ type: 'archiveRange', rangeMs: RANGE_MS[next] });
      }
    }
    if (lastSessions) { render(lastSessions, lastNeedsInputCount, workspacePath); }
  }

  function collapseWorkspace(workspaceKey: string, rerender: boolean): void {
    clearWorkspaceCollapseTimer(workspaceKey);
    if (expandedWorkspaces.delete(workspaceKey)) {
      saveState();
      if (rerender && lastSessions) { render(lastSessions, lastNeedsInputCount, workspacePath); }
    }
  }

  // ===== DELEGATED EVENT HANDLERS =====
  root.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    // "view workflow/team/subagents →" chip — opens the source-keyed detail
    // panel. Checked first: the chip nests inside cards and team headers, whose
    // own click handlers (focusSession) would otherwise swallow it.
    const detailChip = target.closest<HTMLElement>('.detail-chip');
    if (detailChip) {
      e.stopPropagation();
      const source = detailChip.dataset.detailSource;
      const containerId = detailChip.dataset.detailContainer;
      const sessionId = detailChip.dataset.detailSession;
      if (source && containerId && sessionId) {
        vscode.postMessage({ type: 'openDetail', source, containerId, sessionId });
        // Opening the drill-in also focuses the invoking conversation — the
        // detail panel docks beside it, so you keep talking to the parent on
        // the left and read its agents on the right. Mirrors a card-body click
        // (focusedSessionId + re-render for the focused state, plus focusSession
        // to reveal the conversation editor).
        focusedSessionId = sessionId;
        vscode.postMessage({ type: 'focusSession', sessionId });
        if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      }
      return;
    }

    // Inline agent row (not-done teammate / subagent / workflow agent) — opens
    // the detail panel deep-linked to that agent. Checked before the generic
    // card-body handler (focusSession) that would otherwise swallow it.
    const agentRow = target.closest<HTMLElement>('.card-agent-row');
    if (agentRow) {
      e.stopPropagation();
      const source = agentRow.dataset.detailSource;
      const containerId = agentRow.dataset.detailContainer;
      const sessionId = agentRow.dataset.detailSession;
      const agentId = agentRow.dataset.agent;
      if (source && containerId && sessionId) {
        const detailMsg: Record<string, unknown> = { type: 'openDetail', source, containerId, sessionId };
        if (agentId) { detailMsg.agentId = agentId; detailMsg.groupKey = agentRow.dataset.group ?? ''; }
        vscode.postMessage(detailMsg);
        // Mirror the detail chip: dock beside + focus the parent conversation.
        focusedSessionId = sessionId;
        vscode.postMessage({ type: 'focusSession', sessionId });
        if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      }
      return;
    }

    // Dismiss button
    const dismissBtn = target.closest<HTMLElement>('[data-dismiss-id]');
    if (dismissBtn) {
      e.stopPropagation();
      vscode.postMessage({ type: 'dismissSession', sessionId: dismissBtn.dataset.dismissId });
      return;
    }

    // Transcript button
    const transcriptBtn = target.closest<HTMLElement>('[data-transcript-id]');
    if (transcriptBtn) {
      e.stopPropagation();
      vscode.postMessage({ type: 'viewTranscript', sessionId: transcriptBtn.dataset.transcriptId });
      return;
    }

    // Footer slot click (companion-registered usage-card slot)
    const footerSlot = target.closest<HTMLElement>('.usage-slot-row[data-slot-id]');
    if (footerSlot && footerSlot.classList.contains('clickable')) {
      e.stopPropagation();
      vscode.postMessage({ type: 'footerSlotClick', slotId: footerSlot.dataset.slotId });
      return;
    }

    // Copy ID pill
    const copyPill = target.closest<HTMLElement>('[data-copy-id]');
    if (copyPill) {
      e.stopPropagation();
      vscode.postMessage({ type: 'copyToClipboard', text: copyPill.dataset.copyId });
      copyPill.textContent = 'copied';
      setTimeout(() => { copyPill.textContent = copyPill.dataset.copyId!.slice(0, 8); }, 1000);
      return;
    }

    // Time range pill
    const timePill = target.closest<HTMLElement>('[data-range]');
    if (timePill) {
      e.stopPropagation();
      setArchiveRange(timePill.dataset.range!);
      return;
    }

    // Team archive compact row click (undismiss)
    const teamArchiveRow = target.closest<HTMLElement>('.team-compact-row[data-team-id]');
    if (teamArchiveRow) {
      vscode.postMessage({ type: 'undismissTeam', teamId: teamArchiveRow.dataset.teamId });
      return;
    }

    // Workflow archive compact row click (undismiss → reopen the parent conversation)
    const wfArchiveRow = target.closest<HTMLElement>('.workflow-compact-row[data-run-id]');
    if (wfArchiveRow) {
      vscode.postMessage({ type: 'undismissWorkflow', runId: wfArchiveRow.dataset.runId });
      return;
    }

    // Archive row click (undismiss)
    const archiveRow = target.closest<HTMLElement>('.compact-row[data-session-id]');
    if (archiveRow) {
      vscode.postMessage({ type: 'undismissSession', sessionId: archiveRow.dataset.sessionId });
      return;
    }

    // Worktree picker child row → open the chosen worktree, then collapse parent
    const pickerChild = target.closest<HTMLElement>('.ws-picker-child[data-cwd]');
    if (pickerChild) {
      e.stopPropagation();
      const cwd = pickerChild.dataset.cwd;
      const parentKey = pickerChild.dataset.parentKey;
      if (cwd) { vscode.postMessage({ type: 'openWorkspace', cwd }); }
      if (parentKey) { collapseWorkspace(parentKey, true); }
      return;
    }

    // Expandable foreign workspace row → toggle picker expansion
    const expandableRow = target.closest<HTMLElement>('.ws-row-expandable[data-workspace-key]');
    if (expandableRow) {
      const key = expandableRow.dataset.workspaceKey!;
      if (expandedWorkspaces.has(key)) {
        collapseWorkspace(key, true);
      } else {
        expandedWorkspaces.add(key);
        saveState();
        scheduleWorkspaceCollapse(key);
        if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      }
      return;
    }

    // Foreign workspace row click → open that workspace
    const wsRow = target.closest<HTMLElement>('.ws-row[data-cwd]');
    if (wsRow) {
      const cwd = wsRow.dataset.cwd;
      if (cwd) { vscode.postMessage({ type: 'openWorkspace', cwd }); }
      return;
    }

    // Card click. Cards in the main list are always local (sibling-worktree
    // sessions are filtered out — accessed via the Worktrees pane), so the
    // click always opens the Claude Code companion editor for that session.
    const card = target.closest<HTMLElement>('.card:not(.card-leave)');
    if (card) {
      const sid = card.dataset.sessionId!;
      focusedSessionId = sid;
      vscode.postMessage({ type: 'focusSession', sessionId: sid });
      if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      return;
    }
  });

  // Keyboard support: Enter/Space activates focused element
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    // Native <button>s (transcript, dismiss, team-dismiss) activate themselves on
    // Enter/Space and fire a real click the delegate routes. Bail out before the
    // generic .card catch below, which would otherwise preventDefault and steal
    // the activation — focusing the card instead of running the button's action.
    if (target.closest('button')) { return; }
    const detailChip = target.closest<HTMLElement>('.detail-chip');
    if (detailChip) {
      e.preventDefault();
      detailChip.click();
      return;
    }
    // Companion footer slots — role=button rows, need Enter/Space wiring
    const footerSlot = target.closest<HTMLElement>('.usage-slot-row[data-slot-id]');
    if (footerSlot && footerSlot.classList.contains('clickable')) {
      e.preventDefault();
      footerSlot.click();
      return;
    }
    // Inline agent row — a role=button div, matched before the generic .card
    // branch so Enter/Space drills to the agent instead of focusing the card.
    const agentRow = target.closest<HTMLElement>('.card-agent-row');
    if (agentRow) {
      e.preventDefault();
      agentRow.click();
      return;
    }
    const card = target.closest<HTMLElement>('.card:not(.card-leave)');
    if (card) {
      e.preventDefault();
      card.click();
      return;
    }
    const archiveRow = target.closest<HTMLElement>('.compact-row[data-session-id]');
    if (archiveRow) {
      e.preventDefault();
      archiveRow.click();
      return;
    }
    // Team / workflow archive compact rows (role=listitem spans, tabindex 0)
    const teamArchiveRow = target.closest<HTMLElement>('.team-compact-row[data-team-id]');
    if (teamArchiveRow) {
      e.preventDefault();
      teamArchiveRow.click();
      return;
    }
    const wfArchiveRow = target.closest<HTMLElement>('.workflow-compact-row[data-run-id]');
    if (wfArchiveRow) {
      e.preventDefault();
      wfArchiveRow.click();
      return;
    }
    const pickerChild = target.closest<HTMLElement>('.ws-picker-child[data-cwd]');
    if (pickerChild) {
      e.preventDefault();
      pickerChild.click();
      return;
    }
    const expandableRow = target.closest<HTMLElement>('.ws-row-expandable[data-workspace-key]');
    if (expandableRow) {
      e.preventDefault();
      expandableRow.click();
      return;
    }
    const wsRow = target.closest<HTMLElement>('.ws-row[data-cwd]');
    if (wsRow) {
      e.preventDefault();
      wsRow.click();
    }
  });

  window.addEventListener('message', (event: MessageEvent<WebviewIncomingMessage>) => {
    try {
      const message = event.data;
      if (message.type === 'update') {
        lastUsage = message.usage || null;
        lastForeignWorkspaces = message.foreignWorkspaces ?? [];
        lastForeignWaiting = message.foreignWaiting ?? [];
        lastForeignRunning = message.foreignRunning ?? [];
        lastTeams = message.teams ?? [];
        lastWorkflows = message.workflows ?? [];
        lastFooterSlots = message.footerSlots ?? [];
        compactSettings = message.compactSettings ?? null;
        lastOlderSessionCount = message.olderSessionCount ?? 0;
        lastWorktrees = message.worktrees ?? [];
        homeDir = message.home ?? '';
        const sessions = debounceStatuses(message.sessions, needsInputSince, Date.now());
        // Same-file collisions across every active session we can see —
        // local plus foreign/worktree strips (they all carry trackedFiles).
        fileCollisions = computeFileCollisions([
          ...sessions, ...lastForeignWaiting, ...lastForeignRunning,
        ]);
        render(sessions, message.waitingCount, message.workspacePath);
      } else if (message.type === 'focusSession') {
        focusedSessionId = message.sessionId;
        if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      } else if (message.type === 'settings') {
        applySettings(message.settings);
      }
    } catch (err) {
      showErrorBoundary(err);
    }
  });

  function setArchiveRange(range: string): void {
    archiveRange = range;
    saveState();
    // Tell the extension to load extended archive data if needed
    const rangeMs = RANGE_MS[range] ?? 86400000;
    vscode.postMessage({ type: 'archiveRange', rangeMs });
    if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
  }

  // ===== ERROR BOUNDARY =====
  function showErrorBoundary(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    root.innerHTML = '<div class="empty-state">'
      + '<div class="icon">&#x26A0;</div>'
      + '<div class="error-overlay-msg">Something went wrong</div>'
      + '<div class="error-overlay-detail">' + escapeHtml(message) + '</div>'
      + '<button class="top-bar-btn" id="errorReloadBtn">Reload</button>'
      + '</div>';
    const btn = document.getElementById('errorReloadBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        root.innerHTML = '<div class="empty-state"><div class="icon">\u2298</div><div>Loading...</div></div>';
        vscode.postMessage({ type: 'requestUpdate' });
      });
    }
  }

  // ===== RENDER =====
  function render(sessions: PanelSession[], waitingCount: number, wsPath: string): void {
    try {
    if (wsPath) {
      workspacePath = wsPath;
      workspaceKey = sanitiseWorkspaceKey(wsPath);
    }
    lastSessions = sessions;
    lastNeedsInputCount = waitingCount;
    // Main card list is local-only. Sibling-worktree sessions (worktreeRoot
    // points elsewhere) are reached through the Worktrees pane — clicking a
    // row switches windows. Sessions whose worktreeRoot equals the current
    // workspace path ARE local (the current workspace is itself a worktree)
    // and stay in the list.
    const wsRootNorm = normPath(workspacePath);
    sessions = sessions.filter(s => {
      if (isGhost(s)) { return false; }
      if (!s.worktreeRoot) { return true; }
      return normPath(s.worktreeRoot) === wsRootNorm;
    });

    const counts: Record<string, number> = { 'waiting': 0, running: 0, done: 0, stale: 0, archived: 0 };
    for (const s of sessions) {
      if (s.dismissed) { counts.archived++; }
      else { counts[s.status] = (counts[s.status] || 0) + 1; }
    }

    const cards = sessions.filter(s => !s.dismissed);
    const archived = sessions.filter(s => s.dismissed);
    const now = Date.now();

    // Group workflow runs by parent session (discovery pre-sorts active/recent
    // first) so cards can show a WF tag, roll-up, and View pill. Empty when the
    // toggle is off, which removes all workflow affordances in one place.
    workflowsBySession = new Map<string, PanelWorkflow[]>();
    const archivedWorkflows: PanelWorkflow[] = [];
    if (currentSettings.show.workflows) {
      for (const wf of lastWorkflows) {
        // A dismissed run leaves its parent card and becomes an archive row.
        if (wf.dismissed) { archivedWorkflows.push(wf); continue; }
        const arr = workflowsBySession.get(wf.sessionId);
        if (arr) { arr.push(wf); } else { workflowsBySession.set(wf.sessionId, [wf]); }
      }
    }

    // === Top bar ===
    let summaryHtml = '';
    if (counts['waiting'] > 0) summaryHtml += '<span class="status-count waiting-count">' + counts['waiting'] + ' waiting</span>';
    if (counts.running > 0) summaryHtml += '<span class="status-count running-count">' + counts.running + ' running</span>';
    if (counts.done > 0) summaryHtml += '<span class="status-count done-count">' + counts.done + ' done</span>';
    if (counts.stale > 0) summaryHtml += '<span class="status-count stale-count">' + counts.stale + ' seen</span>';
    if (!summaryHtml) summaryHtml = '<span class="status-count">No active sessions</span>';

    let topBar = root.querySelector('.top-bar') as HTMLElement | null;
    if (!topBar) {
      root.innerHTML = '';
      topBar = document.createElement('div');
      topBar.className = 'top-bar';
      topBar.innerHTML = '<div class="status-summary" aria-live="polite"></div>';
      root.appendChild(topBar);
    }
    const summaryEl = topBar.querySelector('.status-summary');
    if (summaryEl) { summaryEl.innerHTML = summaryHtml; }

    // === Scroll container ===
    let scrollWrap = root.querySelector('.card-archive-scroll') as HTMLElement | null;
    if (!scrollWrap) {
      scrollWrap = document.createElement('div');
      scrollWrap.className = 'card-archive-scroll';
      topBar.after(scrollWrap);
    }

    // FLIP "First": snapshot every card's painted position before any layout
    // mutation this pass. Shared across the active and done sections so a
    // card whose status flips slides to its new section instead of fading
    // out in one place and back in at another. Rects include any in-flight
    // transform, which is exactly the visual position an interrupted
    // animation must continue from.
    const prevRects = new Map<string, DOMRect>();
    scrollWrap.querySelectorAll('.card:not(.card-leave)').forEach(el => {
      const id = (el as HTMLElement).dataset.sessionId;
      if (id) { prevRects.set(id, el.getBoundingClientRect()); }
    });
    // Every session rendered as a card somewhere this pass — used to tell a
    // cross-section move apart from a genuine removal.
    const renderedIds = new Set(cards.map(c => c.sessionId));

    // === Teams === No separate section: a team folds into its orchestrator's
    // normal card (sessionDiscovery suppresses the orchestrator claim so the
    // lead renders as a plain session card; the team rides on it rather than
    // duplicating it above). Dismissing that card archives the team too.

    // === Card section (running/waiting/stale) ===
    let cardSection = scrollWrap.querySelector('.card-section:not(.done-section)') as HTMLElement | null;
    if (!cardSection) {
      cardSection = document.createElement('div');
      cardSection.className = 'card-section';
      cardSection.setAttribute('role', 'list');
      cardSection.setAttribute('aria-label', 'Active sessions');
      scrollWrap.appendChild(cardSection);
    }

    const activeTeams = lastTeams.filter(t => !t.dismissed);
    const archivedTeams = lastTeams.filter(t => t.dismissed);

    // Split local cards: active half (running/waiting) above, completed
    // half (done/stale) below.
    const runningCards = cards.filter(c => c.status === 'running' || c.status === 'waiting');
    const doneCards = cards.filter(c => c.status === 'done' || c.status === 'stale');

    if (cards.length === 0 && archived.length === 0 && activeTeams.length === 0) {
      const hasOlder = lastOlderSessionCount > 0;
      const headline = hasOlder
        ? lastOlderSessionCount + ' older session' + (lastOlderSessionCount === 1 ? '' : 's') + ' beyond the 7-day window.'
        : 'No Claude Code sessions detected.';
      const hint = hasOlder
        ? 'Widen the range below to load them.'
        : 'Sessions appear when you start Claude Code.';
      cardSection.innerHTML = '<div class="empty-state"><div class="icon">\u2298</div><div>'
        + escapeHtml(headline) + '</div><div class="hint">' + escapeHtml(hint) + '</div></div>';
    } else {
      reconcileCards(cardSection, runningCards, now, prevRects, renderedIds);
    }

    // === Done card section ===
    let doneSection = scrollWrap.querySelector('.card-section.done-section') as HTMLElement | null;
    if (!doneSection) {
      doneSection = document.createElement('div');
      doneSection.className = 'card-section done-section';
      doneSection.setAttribute('role', 'list');
      doneSection.setAttribute('aria-label', 'Completed sessions');
    }
    if (doneSection.previousElementSibling !== cardSection) {
      cardSection.after(doneSection);
    }
    if (cards.length > 0 || archived.length > 0 || activeTeams.length > 0) {
      reconcileCards(doneSection, doneCards, now, prevRects, renderedIds);
    }
    // Drop cache entries for cards no longer rendered anywhere this pass.
    for (const key of Array.from(cardHtmlCache.keys())) {
      if (!renderedIds.has(key)) { cardHtmlCache.delete(key); }
    }

    // === Archive section ===
    renderArchiveSection(archived, archivedTeams, archivedWorkflows, now, doneSection);

    // === Time-range bar ===
    renderTimeRangeBar(archived.length > 0 || archivedTeams.length > 0 || archivedWorkflows.length > 0 || lastOlderSessionCount > 0);

    // === Worktrees pane (sits above Other workspaces) ===
    let worktreesContainer = root.querySelector('.ws-worktree-rows') as HTMLElement | null;
    if (currentSettings.show.worktrees) {
      if (!worktreesContainer) {
        worktreesContainer = document.createElement('div');
        worktreesContainer.className = 'ws-worktree-rows';
        root.appendChild(worktreesContainer);
      }
      updateWorktreesContainer(worktreesContainer);
    } else {
      worktreesContainer?.remove();
      worktreesContainer = null;
    }

    // === Foreign workspace rows (between time-range bar and usage) ===
    let foreignContainer = root.querySelector('.ws-foreign-rows') as HTMLElement | null;
    if (currentSettings.show.foreignWorkspaces) {
      if (!foreignContainer) {
        foreignContainer = document.createElement('div');
        foreignContainer.className = 'ws-foreign-rows';
        root.appendChild(foreignContainer);
      }
    } else {
      foreignContainer?.remove();
      foreignContainer = null;
    }

    // === Usage section (always last) ===
    if (currentSettings.show.usage) {
      renderUsageSection();
    } else {
      root.querySelector('.usage-section')?.remove();
    }
    // Order: worktrees → foreign → usage. Re-parent if any of the three exists.
    const usageEl = root.querySelector('.usage-section');
    if (usageEl) {
      if (foreignContainer && foreignContainer.nextElementSibling !== usageEl) {
        root.insertBefore(foreignContainer, usageEl);
      }
      if (worktreesContainer) {
        const wtAnchor = foreignContainer ?? usageEl;
        if (worktreesContainer.nextElementSibling !== wtAnchor) {
          root.insertBefore(worktreesContainer, wtAnchor);
        }
      }
    } else if (foreignContainer && worktreesContainer && worktreesContainer.nextElementSibling !== foreignContainer) {
      root.insertBefore(worktreesContainer, foreignContainer);
    }
    if (foreignContainer) {
      updateForeignContainer(foreignContainer);
    }

    } catch (err) {
      showErrorBoundary(err);
    }
  }

  // ===== DOM RECONCILER with FLIP =====
  // prevRects is the cross-section position snapshot taken at the top of
  // render(), before any layout mutation; renderedIds is every session that
  // gets a card somewhere this pass. Together they let a card that changed
  // sections FLIP-slide to its new home instead of cross-fading in two
  // places at once.
  function reconcileCards(container: HTMLElement, cards: PanelSession[], now: number, prevRects: Map<string, DOMRect>, renderedIds: Set<string>): void {
    // Clear non-card children
    const children = Array.from(container.children);
    for (const child of children) {
      if (!(child as HTMLElement).classList.contains('card')) {
        container.removeChild(child);
      }
    }

    const existing = container.querySelectorAll('.card');
    const containerRect = container.getBoundingClientRect();
    const canAnimate = containerRect.height > 0 && TRANSITION_MS > 0;

    // 1. ID set for THIS container
    const newIds = new Set(cards.map(c => c.sessionId));

    // 2. Departures. Classify and measure before mutating anything: taking
    //    one leaver out of flow reflows the next, so a second leaver measured
    //    mid-loop would pin to the wrong spot.
    //    - A card whose session moved to the other section is removed
    //      outright; its replacement FLIPs from prevRects so the same card
    //      visually slides rather than fading out here and in there.
    //    - A genuinely removed card exits in place: pinned absolute so
    //      siblings reflow (animated by the FLIP step), fading out behind.
    const movers: HTMLElement[] = [];
    const leavers: Array<{ el: HTMLElement; top: number; left: number; width: number; height: number }> = [];
    existing.forEach(el => {
      const htmlEl = el as HTMLElement;
      const id = htmlEl.dataset.sessionId;
      if (!id || newIds.has(id) || htmlEl.classList.contains('card-leave')) { return; }
      if (renderedIds.has(id)) {
        movers.push(htmlEl);
      } else {
        leavers.push({ el: htmlEl, top: htmlEl.offsetTop, left: htmlEl.offsetLeft, width: htmlEl.offsetWidth, height: htmlEl.offsetHeight });
      }
    });
    movers.forEach(el => container.removeChild(el));
    if (canAnimate) {
      for (const l of leavers) {
        l.el.style.transition = 'none';
        l.el.style.transform = '';
        l.el.style.top = l.top + 'px';
        l.el.style.left = l.left + 'px';
        l.el.style.width = l.width + 'px';
        l.el.style.height = l.height + 'px';
        l.el.style.position = 'absolute';
        setTimeout(() => { if (l.el.parentNode) { l.el.parentNode.removeChild(l.el); } }, TRANSITION_MS + 50);
      }
      if (leavers.length > 0) {
        void container.offsetHeight; // commit the pinned pre-leave state
        for (const l of leavers) {
          l.el.style.transition = '';
          l.el.classList.add('card-leave');
        }
      }
    } else {
      leavers.forEach(l => container.removeChild(l.el));
    }

    // 3. Create/update/reorder cards
    const existingMap = new Map<string, HTMLElement>();
    container.querySelectorAll('.card:not(.card-leave)').forEach(el => {
      existingMap.set((el as HTMLElement).dataset.sessionId!, el as HTMLElement);
    });

    let prevNode: HTMLElement | null = null;
    for (const s of cards) {
      let el = existingMap.get(s.sessionId);
      const isNew = !el;
      const isFocused = s.sessionId === focusedSessionId;

      if (!el) {
        el = document.createElement('div');
        el.dataset.sessionId = s.sessionId;
      }

      // A new element with a previous rect is a section move \u2014 FLIP it from
      // its old position below instead of playing the enter fade.
      const enters = isNew && !prevRects.has(s.sessionId);
      const cls = 'card ' + s.status + (isFocused ? ' focused' : '') + (enters ? ' card-enter' : '');
      if (el.className !== cls) { el.className = cls; }
      el.setAttribute('role', 'listitem');
      el.setAttribute('tabindex', '0');
      // setAttribute takes a plain DOM string \u2014 do NOT HTML-escape, or a screen
      // reader announces literal entities ("A&amp;B"). s.status is a fixed enum.
      el.setAttribute('aria-label', stripMarkdown(getDisplayName(s)) + ' \u2014 ' + s.status);
      el.dataset.confidence = s.confidence || 'high';
      // Skip the innerHTML write when the rendered card is byte-identical to
      // the last pass \u2014 the string build is cheap, the DOM teardown is not.
      // Skipping also stops an unchanged card's inline agent-list scroll and
      // the transient "copied" pill being wiped on every tick.
      const inner = renderCardInner(s, now, isFocused);
      if (isNew || cardHtmlCache.get(s.sessionId) !== inner) {
        el.innerHTML = inner;
        cardHtmlCache.set(s.sessionId, inner);
      }

      // Place in correct order
      let desiredNext: HTMLElement | null = prevNode ? prevNode.nextElementSibling as HTMLElement | null : container.firstElementChild as HTMLElement | null;
      while (desiredNext && desiredNext.classList.contains('card-leave')) {
        desiredNext = desiredNext.nextElementSibling as HTMLElement | null;
      }
      if (el !== desiredNext) {
        container.insertBefore(el, desiredNext);
      }

      prevNode = el;
    }

    // 4. FLIP: Last, Invert, Play. Batched with forced reflows rather than
    //    rAF pairs: a reflow deterministically commits the inverted state, so
    //    the release below always transitions (a lone rAF could coalesce both
    //    writes into one style recalc and the animation never played).
    const updated = Array.from(container.querySelectorAll('.card:not(.card-leave)')) as HTMLElement[];
    if (canAnimate) {
      const entering: HTMLElement[] = [];
      const flipped: Array<{ el: HTMLElement; first: DOMRect }> = [];
      for (const el of updated) {
        if (el.classList.contains('card-enter')) { entering.push(el); continue; }
        const first = prevRects.get(el.dataset.sessionId!);
        if (first) { flipped.push({ el, first }); }
      }

      // Invert: clear any in-flight transform so the measurement below is
      // pure layout. prevRects holds the painted (mid-animation) position,
      // so an interrupted move continues from where it visually is instead
      // of jumping.
      for (const f of flipped) {
        f.el.style.transition = 'none';
        f.el.style.transform = '';
      }
      if (flipped.length > 0) { void container.offsetHeight; }
      const inverted: HTMLElement[] = [];
      for (const f of flipped) {
        const deltaY = f.first.top - f.el.getBoundingClientRect().top;
        if (Math.abs(deltaY) < 1) { f.el.style.transition = ''; continue; }
        f.el.style.transform = 'translateY(' + deltaY + 'px)';
        inverted.push(f.el);
      }

      // Play: commit the inverted/enter state, then release in one batch.
      if (inverted.length > 0 || entering.length > 0) { void container.offsetHeight; }
      for (const el of inverted) {
        el.style.transition = '';
        el.style.transform = '';
      }
      for (const el of entering) { el.classList.remove('card-enter'); }
    } else {
      for (const el of updated) { el.classList.remove('card-enter'); }
    }
  }

  // ===== ARCHIVE SECTION =====
  function renderArchiveSection(archived: PanelSession[], archivedTeams: PanelTeam[], archivedWorkflows: PanelWorkflow[], now: number, afterElement: HTMLElement): void {
    const scrollWrap = root.querySelector('.card-archive-scroll');
    let existingList = (scrollWrap || root).querySelector('.archive-list') as HTMLElement | null;

    if (archived.length === 0 && archivedTeams.length === 0 && archivedWorkflows.length === 0) {
      if (existingList) existingList.remove();
      return;
    }

    if (!existingList) {
      existingList = document.createElement('div');
      existingList.className = 'archive-list';
      existingList.id = 'archiveList';
      existingList.setAttribute('role', 'list');
      existingList.setAttribute('aria-label', 'Archived sessions');
      afterElement.after(existingList);
    }

    const DAY_MS = 86400000;
    const rangeMs = RANGE_MS[archiveRange]; // 0 = no limit (all)

    // Unify sessions, teams, and workflows into one recency-sorted stream so an
    // archived workflow/team reads like any other archived row. Each carries a
    // `ts` (last-activity epoch ms): sessions use lastActivity; teams the
    // orchestrator's updatedAt; workflows their end time (start + duration).
    // `alwaysShow` exempts an item from the day-window. Teams and workflows are
    // low-volume "container" archives (and a team's updatedAt can predate its
    // dismissal — the 7-day discovery gate is keyed on config mtime, not
    // updatedAt — so age-windowing them would silently hide a just-dismissed
    // team). They still take part in the recency sort; only their *visibility*
    // is unconditional, matching the pre-interleave behaviour. The window stays
    // on plain sessions, which are the high-volume case it exists to bound.
    interface ArchiveItem { ts: number; html: string; alwaysShow?: boolean }
    const items: ArchiveItem[] = [];
    for (const s of archived) {
      items.push({ ts: s.lastActivity, html: renderCompactRow(s, now) });
    }
    for (const team of archivedTeams) {
      items.push({ ts: team.updatedAt, html: renderTeamCompactRow(team, now), alwaysShow: true });
    }
    for (const wf of archivedWorkflows) {
      items.push({ ts: wf.startTime + (wf.durationMs || 0), html: renderWorkflowCompactRow(wf, now), alwaysShow: true });
    }

    // Newest first.
    items.sort((a, b) => b.ts - a.ts);

    // Window: containers and rows from the last day always show; older sessions
    // show only when the range allows (1d hides them; a wider/all range reveals).
    let archiveHtml = '';
    for (const item of items) {
      const age = now - item.ts;
      if (item.alwaysShow || age <= DAY_MS) {
        archiveHtml += item.html;
      } else if ((rangeMs === 0 || age <= rangeMs) && archiveRange !== '1d') {
        archiveHtml += item.html;
      }
    }

    existingList.innerHTML = archiveHtml;
  }

  // ===== TIME-RANGE BAR =====
  function renderTimeRangeBar(hasArchived: boolean): void {
    let existing = root.querySelector('.time-range-bar') as HTMLElement | null;
    if (!hasArchived) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'time-range-bar';
      const usage = root.querySelector('.usage-section');
      if (usage) root.insertBefore(existing, usage);
      else root.appendChild(existing);
    }
    const ranges = ['1d', '3d', '7d', '30d', 'all'];
    let html = 'Showing archived from last ';
    for (const r of ranges) {
      const active = r === archiveRange;
      html += '<span class="time-pill' + (active ? ' active' : '') + '" data-range="' + r + '">' + r + '</span>';
    }
    existing.innerHTML = html;
  }

  // ===== CARD INNER HTML =====

  /** A clickable meta-row chip that opens the source-keyed detail panel.
   *  `source` selects the drill-in (workflow | team | subagents); `containerId`
   *  is the sessionId (workflow/subagents) or teamId (team); `sessionId` is the
   *  invoking conversation the panel header jumps back to. Styling reuses the
   *  status-tinted `.wf-view-chip` recipe; `.detail-chip` is the click hook.
   *  `state` (running | waiting | failed | done) tints the chip to reflect the
   *  agents' OWN aggregate state, not the parent card's turn state — a stale
   *  (seen) parent dims it via CSS. */
  function renderDetailChip(label: string, source: DetailSource, containerId: string, sessionId: string, state: string, visibleHtml?: string): string {
    return '<span class="wf-tag wf-view-chip detail-chip wf-chip-' + escapeHtml(state) + '"'
      + ' data-detail-source="' + escapeHtml(source) + '"'
      + ' data-detail-container="' + escapeHtml(containerId) + '"'
      + ' data-detail-session="' + escapeHtml(sessionId) + '"'
      + ' role="button" tabindex="0" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label)
      + '">' + (visibleHtml ?? escapeHtml(label)) + '<span class="wf-arrow">→</span></span>';
  }

  /** Visible content of the agents chip: robot glyph + live-agent count.
   *  The glyph replaces the word "agents" (meta-row space); the count is how
   *  many agents are working RIGHT NOW — workflow agents plus subagents,
   *  detached background agents included, so a `done` card with live robots
   *  still reads as active down here. Zero live → glyph only; the chip's
   *  wf-chip-* tint (count + arrow inherit it) says how the crew is going. */
  function agentsChipHtml(liveCount: number): string {
    return '\u{1F916}' + (liveCount > 0 ? ' <span class="agent-live-count">' + liveCount + '</span>' : '');
  }

  /** Live (running or awaiting permission) agents beneath a card. */
  function countLiveAgents(wfs: PanelWorkflow[] | undefined, subs: PanelSession['subagents'] | undefined): number {
    const wfLive = (wfs ?? []).reduce((n, w) =>
      n + w.agents.filter(a => a.status === 'running' || a.status === 'waiting').length, 0);
    const subLive = (subs ?? []).filter(a => a.running || a.waitingOnPermission).length;
    return wfLive + subLive;
  }

  /** Aggregate state for a session card's detail chip — reflects what the chip
   *  opens (its workflow run(s) and/or plain Task subagents), so a live workflow
   *  under an idle session still reads as running. Precedence: a permission wait
   *  outranks running, which outranks a failed/incomplete run, else done. */
  function detailChipState(wfs: PanelWorkflow[] | undefined, subs: PanelSession['subagents'] | undefined): string {
    if ((subs ?? []).some(a => a.waitingOnPermission)) { return 'waiting'; }
    if ((wfs ?? []).some(w => w.status === 'running') || (subs ?? []).some(a => a.running)) { return 'running'; }
    if ((wfs ?? []).some(w => w.status === 'failed' || w.status === 'incomplete')) { return 'failed'; }
    return 'done';
  }

  /** Inline rows for the still-working agents under a card — the at-a-glance
   *  "who's active" list (one name for all kinds: agents). Capped to ~6 rows by
   *  CSS max-height + scroll. Each row deep-links the detail panel to that agent
   *  (groupKey + agentId). Empty list → nothing rendered. */
  function renderInlineAgents(
    agents: { agentId?: string | null; label: string; status: string }[],
    source: DetailSource,
    containerId: string,
    sessionId: string,
    groupKey: string,
  ): string {
    if (agents.length === 0) { return ''; }
    let html = '<div class="card-agent-list" role="list">';
    for (const a of agents) {
      const dot = a.status === 'waiting' ? 'waiting' : a.status === 'failed' ? 'failed' : 'running';
      html += '<div class="card-agent-row" role="listitem button" tabindex="0"'
        + ' data-detail-source="' + escapeHtml(source) + '"'
        + ' data-detail-container="' + escapeHtml(containerId) + '"'
        + ' data-detail-session="' + escapeHtml(sessionId) + '"'
        + ' data-group="' + escapeHtml(groupKey) + '"'
        + ' data-agent="' + escapeHtml(a.agentId ?? '') + '"'
        + ' title="' + escapeHtml(a.label) + '">'
        + '<span class="card-agent-dot ' + dot + '"></span>'
        + '<span class="card-agent-name">' + escapeHtml(a.label) + '</span>'
        + '</div>';
    }
    html += '</div>';
    return html;
  }

  /** A session's current workflow run contributes only its still-working agents
   *  as inline rows — no progress bar, no "✓ N agents" tick (decided by Murray:
   *  a finished run needs neither; the "agents →" chip carries the click-through).
   *  A terminal run (completed / failed / killed→incomplete) renders nothing. */
  function renderWorkflowBlock(wfs: PanelWorkflow[]): string {
    const run = wfs[0];
    if (run.status !== 'running') { return ''; }
    const active = run.agents.filter(a => a.status === 'running' || a.status === 'waiting');
    return renderInlineAgents(
      active.map(a => ({ agentId: a.agentId, label: a.label || (a.agentId ? a.agentId.slice(0, 8) : 'agent'), status: a.status })),
      'workflow', run.sessionId, run.sessionId, run.runId);
  }

  /** Stable hue for a model label: djb2 hash spread by the golden angle so
   *  near-identical names land far apart. Same input → same hue, every build. */
  function modelHue(label: string): number {
    let h = 5381;
    for (let i = 0; i < label.length; i++) { h = ((h << 5) + h + label.charCodeAt(i)) >>> 0; }
    return Math.round((h * 137.508) % 360);
  }

  function renderCardInner(s: PanelSession, now: number, isFocused: boolean): string {
    const statusLabel = getStatusLabel(s, now);
    const displayName = stripMarkdown(getDisplayName(s));

    let subagentHtml = '';
    const hasSubagents = s.subagents && s.subagents.length > 0;
    const showSubagents = hasSubagents
      && currentSettings.show.subagents
      // Live agents always earn their roster rows — a `done` card can still
      // have detached background agents working under it.
      && (s.status === 'running' || s.status === 'waiting' || isFocused
        || s.subagents!.some(a => a.running || a.waitingOnPermission));
    if (showSubagents && s.subagents) {
      // Only the still-working agents are listed inline (running / awaiting
      // permission); click one to drill straight to it. When all are done there's
      // no list and no count tick — the "agents →" chip is the click-through.
      const active = s.subagents.filter(a => a.running || a.waitingOnPermission);
      subagentHtml = renderInlineAgents(
        active.map(a => ({ agentId: a.agentId, label: a.description, status: a.waitingOnPermission ? 'waiting' : 'running' })),
        'subagents', s.sessionId, s.sessionId, '');
    }

    const isLive = s.status === 'running' || s.status === 'waiting';
    const dismissTitle = isLive
      ? 'Archive (use if status is stuck or hook hasn’t fired)'
      : 'Dismiss';
    let actionsHtml = '<div class="card-actions">';
    actionsHtml += '<button class="action-btn transcript-btn" data-transcript-id="' + escapeHtml(s.sessionId) + '" title="View transcript" aria-label="View transcript">&#x1f4dc;</button>';
    actionsHtml += '<button class="action-btn dismiss-btn' + (isLive ? ' dismiss-btn-force' : '') + '" data-dismiss-id="' + escapeHtml(s.sessionId) + '" title="' + escapeHtml(dismissTitle) + '" aria-label="Archive session">&times;</button>';
    actionsHtml += '</div>';

    const wfs = workflowsBySession.get(s.sessionId);
    let metaHtml = '<div class="card-meta">';
    metaHtml += '<span class="session-id-pill clickable" data-copy-id="' + escapeHtml(s.sessionId) + '" title="Copy session ID">' + escapeHtml(s.sessionId.slice(0, 8)) + '</span>';
    if (s.modelLabel) {
      // Hash-derived hue: unique and consistent per model with no hardcoded
      // per-model class list (which silently skipped new models). A separate
      // colour register from status colours — hue varies, sat/light are fixed
      // per theme in CSS, so the pills read as family, not as status.
      metaHtml += '<span class="model-pill" style="--model-hue:' + modelHue(s.modelLabel) + '">' + escapeHtml(s.modelLabel) + '</span>';
    }
    if (s.gitBranch) {
      metaHtml += '<span class="branch-pill" title="Git branch: ' + escapeHtml(s.gitBranch) + '">' + escapeHtml('\u2387 ' + s.gitBranch) + '</span>';
    }
    // Background-shell badge — a detached `run_in_background` shell is still
    // going after the turn ended. Non-status (the card keeps its real status);
    // a quiet running-tinted chip so a `done` card still flags the live build.
    const bgShells = s.backgroundShellCount ?? 0;
    if (bgShells > 0) {
      const bgLabel = bgShells + ' shell' + (bgShells === 1 ? '' : 's') + ' running';
      metaHtml += '<span class="bg-shell-badge" title="Background shells launched with run_in_background still running">' + bgLabel + '</span>';
    }
    // Loops badge — the card is sleeping (ScheduleWakeup pending) or looping
    // (session crons live). Same quiet running-tinted chip as the shell badge:
    // a "done" card that will re-invoke itself is not finished, just idle.
    if (s.pendingWakeupAt && s.pendingWakeupAt > now) {
      const wakeTitle = 'Wakes at ' + new Date(s.pendingWakeupAt).toLocaleTimeString()
        + (s.pendingWakeupReason ? ' — ' + s.pendingWakeupReason : '');
      metaHtml += '<span class="bg-shell-badge" title="' + escapeHtml(wakeTitle) + '">'
        + 'sleeping · ' + formatAge(s.pendingWakeupAt - now) + '</span>';
    }
    const cronN = s.sessionCronCount ?? 0;
    if (cronN > 0) {
      const cronTitle = 'Session cron' + (cronN === 1 ? '' : 's') + ' — re-invokes on schedule'
        + (s.sessionCronLabel ? ': ' + s.sessionCronLabel : '');
      metaHtml += '<span class="bg-shell-badge" title="' + escapeHtml(cronTitle) + '">'
        + 'loop' + (cronN > 1 ? ' · ' + cronN : '') + '</span>';
    }
    // A session's agents can come from workflow run(s) and/or plain Task
    // subagents. Both open the same detail panel (keyed to this session), which
    // surfaces a view switcher across them, so collapse to ONE chip rather than
    // two: workflow-specific label when only workflows, "subagents" when only
    // those, and a neutral "agents" when both — the switcher carries the rest.
    // Initial source is the workflow when present (richer), else subagents.
    // (Tool-error badge removed 2026-06-10 — Murray: non-actionable and badly
    // correlated with real trouble (benign failed greps/probes inflate it).
    // toolErrorCount stays in the snapshot for a future actionable surface.)
    // Same-file collision — another ACTIVE session is editing the same
    // file(s); a merge conflict in the making. Same quiet-chip pattern as
    // the tool-error badge; lists the shared paths in the tooltip.
    const collisions = currentSettings.show.fileCollisions ? fileCollisions.get(s.sessionId) : undefined;
    if (collisions && collisions.length > 0) {
      const shown = collisions.slice(0, 6).map(f => f.split('/').pop() || f);
      const extra = collisions.length > 6 ? ' (+' + (collisions.length - 6) + ' more)' : '';
      metaHtml += '<span class="tool-error-badge" title="'
        + escapeHtml('Files also being edited by another active session:\n' + shown.join('\n') + extra)
        + '">' + collisions.length + ' shared file' + (collisions.length === 1 ? '' : 's') + '</span>';
    }
    const hasWf = !!wfs && wfs.length > 0;
    const showSubChip = hasSubagents && currentSettings.show.subagents;
    // Hidden subagents (show.subagents off) must not drive the chip's count or
    // tint when a workflow keeps the chip visible — mirror the show.workflows
    // gate, which zeroes its data at the ingress.
    const subsForChip = currentSettings.show.subagents ? s.subagents : undefined;
    const chipState = detailChipState(wfs, subsForChip);
    // One chip for everything beneath a card — agents (be they workflow agents,
    // subagents, or teammates), rendered as 🤖 + live count + arrow. The source
    // still routes the drill-in: prefer the workflow view when a run is present
    // (richer), else the subagents view.
    if (hasWf || showSubChip) {
      const live = countLiveAgents(wfs, subsForChip);
      const label = live > 0 ? 'agents — ' + live + ' running' : 'agents';
      metaHtml += renderDetailChip(label, hasWf ? 'workflow' : 'subagents',
        s.sessionId, s.sessionId, chipState, agentsChipHtml(live));
    }
    metaHtml += actionsHtml;
    metaHtml += '</div>';

    // Context window fill bar — tracks effective compact threshold, tooltip shows both
    let contextBarHtml = '';
    if (s.contextTokens && s.contextTokens > 0) {
      const cw = compactSettings?.autoCompactWindow ?? 200_000;
      const cp = compactSettings?.autoCompactPct ?? 95;
      const threshold = getCompactThreshold(cw, cp);
      const capacity = getModelCapacity(s.modelLabel);
      const pct = Math.min(100, Math.round((s.contextTokens / threshold) * 100));
      const tokenLabel = formatTokenCount(s.contextTokens);
      const thresholdLabel = formatTokenCount(threshold);
      const capacityLabel = formatTokenCount(capacity);
      const fillClass = 'context-fill' + (pct >= 60 ? ' hot' : '');
      const tooltip = 'Context: ' + tokenLabel + ' / ' + thresholdLabel + ' compact (' + pct + '%) \u2014 ' + capacityLabel + ' model';
      contextBarHtml = '<div class="context-bar" title="' + escapeHtml(tooltip) + '">'
        + '<div class="' + fillClass + '" style="width:' + pct + '%"></div>'
        + '</div>';
    }

    // A finished card's most useful line is WHAT it finished with — prefer the
    // last assistant reply over the final tool-name activity on done/stale.
    const isTerminal = s.status === 'done' || s.status === 'stale';
    const activityText = stripMarkdown(
      (isTerminal && s.lastAssistantText ? s.lastAssistantText : s.activity) || 'No recent activity');
    const detailHtml = '<div class="card-detail">' + escapeHtml(activityText) + '</div>';

    return '<div class="card-top">'
      + '<span class="card-name">' + escapeHtml(displayName) + '</span>'
      + '<span class="status-pill">' + statusLabel + '</span>'
      + '</div>'
      + metaHtml
      + detailHtml
      + (wfs && wfs.length > 0 ? renderWorkflowBlock(wfs) : '')
      + subagentHtml
      + contextBarHtml;
  }

  /** Render a single foreign workspace row.
   *  When the row aggregates 2+ worktrees, becomes a click-to-expand picker
   *  parent (chevron, no data-cwd) followed by an inline child list of every
   *  worktree of the repo. Otherwise behaves as a direct-open row. */
  function renderWsRow(ws: WorkspaceGroup): string {
    const running = ws.counts['running'] || 0;
    const waiting = ws.counts['waiting'] || 0;
    const wtCount = ws.worktreeCount ?? 0;
    const wtMembers = ws.worktreeMembersLabel ?? '';
    const isAggregated = wtCount > 1;
    // Pseudo rows (consolidated /private/tmp scratch dirs) have no git
    // worktrees — their picker is driven by `members` (one child per dir).
    const isPseudo = ws.pseudoRepo === true;
    // Expandable picker when we have per-worktree paths (foreign manager
    // populated `worktrees`) or, for pseudo rows, per-dir members. Otherwise
    // fall back to the legacy direct-open aggregated row.
    const pickerEligible = isAggregated && (
      (Array.isArray(ws.worktrees) && ws.worktrees.length > 0)
      || (isPseudo && Array.isArray(ws.members) && ws.members.length > 0)
    );
    const isExpanded = pickerEligible && expandedWorkspaces.has(ws.workspaceKey);
    const rowClass = 'ws-row'
      + (isAggregated ? ' ws-row-aggregated' : '')
      + (pickerEligible ? ' ws-row-expandable' : '')
      + (waiting > 0 ? ' ws-row-waiting' : '')
      + ((pickerEligible || ws.cwd) ? ' ws-row-clickable' : '');
    const countsHtml = countsChipsHtml(ws.counts);
    const hasLiveSessions = running > 0 || waiting > 0;
    const chevron = pickerEligible
      ? '<span class="ws-chevron' + (isExpanded ? ' expanded' : '') + '">&#x25B8;</span>'
      : '';
    // Pseudo (tmp) rows borrow the familiar `Nwt` suffix but mark it with a `*`
    // — these aren't real git worktrees, just consolidated scratch dirs. The
    // `*` is explained in the chip tooltip. (Avoided `Nd`: the `d` reads as the
    // Done count or "days".)
    const wtChip = isAggregated
      ? '<span class="worktree-count-chip" title="' + escapeHtml(isPseudo ? '* not git worktrees — consolidated scratch dirs under /tmp\n' + wtMembers : wtMembers) + '">' + wtCount + 'wt' + (isPseudo ? '*' : '') + '</span>'
      : '';
    // Picker parent rows don't open on click — they expand — so they don't
    // carry data-cwd. Plain aggregated rows (no per-worktree data) still
    // open the canonical checkout directly.
    const pickerNoun = isPseudo ? 'directories' : 'worktrees';
    const titleText = pickerEligible
      ? (isExpanded ? 'Collapse ' + pickerNoun : 'Show ' + wtCount + ' ' + pickerNoun)
      : (ws.cwd ? tildeAbbrev(ws.cwd) : '');
    let rowAttrs: string;
    if (pickerEligible) {
      rowAttrs = ' data-workspace-key="' + escapeHtml(ws.workspaceKey)
        + '" tabindex="0" role="button" aria-expanded="' + (isExpanded ? 'true' : 'false') + '"'
        + ' title="' + escapeHtml(titleText) + '"';
    } else if (ws.cwd) {
      rowAttrs = ' data-cwd="' + escapeHtml(ws.cwd) + '" tabindex="0" role="button" title="' + escapeHtml(titleText) + '"';
    } else {
      rowAttrs = '';
    }
    let html = '<div class="' + rowClass + '"'
      + (hasLiveSessions ? ' data-confidence="' + escapeHtml(ws.confidence || 'medium') + '"' : '')
      + rowAttrs + '>'
      + chevron
      + '<span class="ws-name">' + escapeHtml(ws.displayName) + '</span>'
      + (ws.ideOpen ? '<span class="ws-picker-quiet" title="Open in a VS Code window now">IDE</span>' : '')
      + wtChip
      + '<div class="ws-counts">' + countsHtml + '</div>'
      + '</div>';
    if (isExpanded) {
      html += renderWorktreePickerChildren(ws);
    }
    return html;
  }

  /** Render the inline picker children for an expanded aggregated row.
   *  Lists every worktree of the repo (incl. main). Skips the current
   *  workspace path so we never offer a no-op target. Per-worktree counts
   *  come from `ws.members[i].counts` matched on path. */
  function renderWorktreePickerChildren(ws: WorkspaceGroup): string {
    // Pseudo rows (consolidated scratch dirs) have no git worktrees — list the
    // member dirs directly, each opening its own cwd.
    if (ws.pseudoRepo === true) { return renderScratchPickerChildren(ws); }
    const worktrees = ws.worktrees ?? [];
    if (worktrees.length === 0) { return ''; }
    const wsRootNorm = normPath(workspacePath);
    const memberByCwd = new Map<string, WorkspaceGroup>();
    for (const m of (ws.members ?? [])) {
      if (m.cwd) { memberByCwd.set(normPath(m.cwd), m); }
    }
    // Sort: main first, then by branch/path
    const sorted = [...worktrees].sort((a, b) => {
      if (a.isMain !== b.isMain) { return a.isMain ? -1 : 1; }
      const aLabel = a.branch ?? a.path;
      const bLabel = b.branch ?? b.path;
      return aLabel.localeCompare(bLabel);
    });
    let html = '<div class="ws-picker-children" role="group" aria-label="Worktrees">';
    for (const wt of sorted) {
      const pathNorm = normPath(wt.path);
      // Skip the worktree the user is already in — clicking it is a no-op.
      if (pathNorm === wsRootNorm) { continue; }
      const member = memberByCwd.get(pathNorm);
      const mainChip = wt.isMain
        ? '<span class="ws-main-chip" title="Main checkout">main</span>'
        : '';
      const detachedHint = wt.branch ? '' : ' (detached)';
      const noActivityHint = !member && !wt.isMain
        ? '<span class="ws-picker-quiet" title="No Claude Code activity in 7d">no activity</span>'
        : '';
      html += pickerChildRow({
        cwd: wt.path,
        parentKey: ws.workspaceKey,
        label: wt.branch || basename(wt.path),
        title: tildeAbbrev(wt.path) + detachedHint,
        counts: member?.counts ?? {},
        confidence: member?.confidence,
        extraChipsHtml: mainChip + noActivityHint,
      });
    }
    html += '</div>';
    return html;
  }

  /** Render the inline picker children for an expanded pseudo (scratch) row.
   *  One child per member dir, each opening its own cwd. Skips the current
   *  workspace path so we never offer a no-op target. Unlike the worktree
   *  picker there are no main/detached/no-activity hints — every member is a
   *  live scratch dir with sessions. */
  function renderScratchPickerChildren(ws: WorkspaceGroup): string {
    const members = ws.members ?? [];
    if (members.length === 0) { return ''; }
    const wsRootNorm = normPath(workspacePath);
    const sorted = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName));
    let html = '<div class="ws-picker-children" role="group" aria-label="Directories">';
    for (const m of sorted) {
      if (!m.cwd) { continue; }
      if (normPath(m.cwd) === wsRootNorm) { continue; }
      html += pickerChildRow({
        cwd: m.cwd,
        parentKey: ws.workspaceKey,
        label: basename(m.cwd),
        title: tildeAbbrev(m.cwd),
        counts: m.counts ?? {},
        confidence: m.confidence,
      });
    }
    html += '</div>';
    return html;
  }

  /** Abbreviate a path by replacing $HOME with ~. */
  function tildeAbbrev(p: string): string {
    // homeDir is injected by the host 'update' message — the webview runs in the
    // browser and has no process.env, so reading process.env.HOME never worked.
    if (homeDir && p.startsWith(homeDir)) { return '~' + p.slice(homeDir.length); }
    return p;
  }

  /** Render one row of the Worktrees pane. Reuses .ws-row classes for visual
   *  consistency with foreign rows. The current worktree gets data-current so
   *  CSS can mark it; clicking any non-current row sends openWorkspace. */
  function renderWorktreeRow(wt: PanelWorktreeRow): string {
    const running = wt.counts['running'] || 0;
    const waiting = wt.counts['waiting'] || 0;
    const hasLive = running > 0 || waiting > 0;
    const countsHtml = countsChipsHtml(wt.counts);

    const cls = 'ws-row ws-row-worktree'
      + (waiting > 0 ? ' ws-row-waiting' : '')
      + (wt.isCurrent ? ' ws-row-current' : ' ws-row-clickable');
    // Tooltip is the full worktree path (with $HOME tilde-abbreviated). Keeps
    // it on one line; "Switch to" / "Current worktree" prefixes were redundant
    // when the path itself is shown.
    const branchHint = wt.branch ? '' : ' (detached)';
    const titleText = tildeAbbrev(wt.path) + branchHint
      + (wt.isCurrent ? ' (current)' : '');
    const cwdAttr = wt.isCurrent
      ? ''
      : ' data-cwd="' + escapeHtml(wt.path) + '" tabindex="0" role="button"';
    // Pin sits AFTER the name (before the optional `main` chip), so non-current
    // rows don't need a placeholder column on the left. Inline SVG keeps the
    // icon themable via currentColor and avoids a webfont fetch under our
    // restrictive CSP.
    const pinSlot = wt.isCurrent
      ? '<span class="ws-current-pin" title="You are here" aria-label="You are here">'
        + '<svg viewBox="0 0 24 24" width="9" height="11" fill="currentColor" aria-hidden="true">'
        + '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/>'
        + '</svg></span>'
      : '';
    const mainChip = wt.isMain
      ? '<span class="ws-main-chip" title="Main checkout">main</span>'
      : '';
    return '<div class="' + cls + '"'
      + (hasLive ? ' data-confidence="' + escapeHtml(wt.confidence) + '"' : '')
      + cwdAttr
      + ' title="' + escapeHtml(titleText) + '">'
      + '<span class="ws-name">' + escapeHtml(wt.displayName) + '</span>'
      + pinSlot
      + mainChip
      + '<div class="ws-counts">' + countsHtml + '</div>'
      + '</div>';
  }

  function renderWorktreesPane(rows: PanelWorktreeRow[]): string {
    let html = '<div class="ws-section-header">Worktrees</div>';
    for (const wt of rows) { html += renderWorktreeRow(wt); }
    return html;
  }

  function updateWorktreesContainer(container: HTMLElement): void {
    const html = lastWorktrees.length > 0 ? renderWorktreesPane(lastWorktrees) : '';
    if (html === lastWorktreesHtml) { return; }
    container.innerHTML = html;
    lastWorktreesHtml = html;
  }

  /** Collapse multi-worktree repos into a single row (e.g. when viewed from
   *  outside serac, all `serac-spike-*` worktrees fold into one `serac` row
   *  with a `Nwt` chip); render everything else flat. */
  function renderForeignWorkspaceRows(workspaces: WorkspaceGroup[]): string {
    let html = '<div class="ws-section-header">Other workspaces</div>';
    const rows = groupForeignWorkspaces(workspaces, tildeAbbrev);
    for (const ws of rows) {
      html += renderWsRow(ws);
    }
    return html;
  }

  /** Read the CSS-resolved max-height for a container, or +Infinity when
   *  no cap is set. Used to clamp slide-animation targets so the intermediate
   *  height never overshoots what max-height will clip to. */
  function getMaxHeight(el: HTMLElement): number {
    const raw = window.getComputedStyle(el).maxHeight;
    if (!raw || raw === 'none') { return Infinity; }
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : Infinity;
  }

  /** Toggle the `is-overflowing` class so the bottom-fade scroll cue only
   *  appears when content actually overflows the cap. */
  function updateOverflowState(container: HTMLElement): void {
    container.classList.toggle('is-overflowing', container.scrollHeight > container.clientHeight + 1);
  }

  /** Update the foreign-workspaces container. Slides the height open/closed when
   *  workspaces are added or removed. For in-place updates (counts or confidence
   *  changing within the same set of workspaces) the innerHTML is swapped without
   *  any height pinning so subpixel jitter can't trigger spurious animations. */
  function updateForeignContainer(container: HTMLElement): void {
    const wsList = lastForeignWorkspaces ?? [];
    const newHtml = wsList.length > 0 ? renderForeignWorkspaceRows(wsList) : '';
    if (newHtml === lastForeignHtml) { return; }

    const newKeys = wsList.map((w) => w.workspaceKey).sort().join('|');
    const setChanged = newKeys !== lastForeignKeys;

    // In-place update: same workspace set, only counts or confidence shifted.
    // Skip all height gymnastics — the row count is unchanged so the height is too.
    if (!setChanged && newHtml !== '' && lastForeignHtml !== '') {
      cancelForeignSlide(container);
      clearForeignSlideStyles(container);
      container.innerHTML = newHtml;
      lastForeignHtml = newHtml;
      updateOverflowState(container);
      return;
    }

    const fromHeight = container.getBoundingClientRect().height;
    const reduceMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (newHtml === '') {
      if (fromHeight > 0 && !reduceMotion) {
        cancelForeignSlide(container);
        runForeignSlide(container, fromHeight, 0, () => {
          container.innerHTML = '';
          updateOverflowState(container);
        });
      } else {
        cancelForeignSlide(container);
        container.innerHTML = '';
        clearForeignSlideStyles(container);
        updateOverflowState(container);
      }
      lastForeignHtml = newHtml;
      lastForeignKeys = newKeys;
      return;
    }

    if (reduceMotion) {
      cancelForeignSlide(container);
      container.innerHTML = newHtml;
      clearForeignSlideStyles(container);
      lastForeignHtml = newHtml;
      lastForeignKeys = newKeys;
      updateOverflowState(container);
      return;
    }

    // Set changed — pin to current height before swapping content so the new rows
    // don't flash at their natural height before the slide starts.
    cancelForeignSlide(container);
    container.style.height = fromHeight + 'px';
    container.style.overflow = 'hidden';
    container.style.transition = 'none';
    container.innerHTML = newHtml;
    // Clamp target height to the CSS cap so the slide doesn't briefly expand
    // to scrollHeight (e.g. 400px) before max-height clips it back.
    const cap = getMaxHeight(container);
    const toHeight = Math.min(container.scrollHeight, cap);
    if (Math.abs(toHeight - fromHeight) < 1.5) {
      clearForeignSlideStyles(container);
      updateOverflowState(container);
    } else {
      runForeignSlide(container, fromHeight, toHeight, () => updateOverflowState(container));
    }
    lastForeignHtml = newHtml;
    lastForeignKeys = newKeys;
  }

  function clearForeignSlideStyles(el: HTMLElement): void {
    el.style.height = '';
    el.style.overflow = '';
    el.style.transition = '';
  }

  function cancelForeignSlide(container: HTMLElement): void {
    foreignAnimToken++;
    if (foreignAnimSafetyTimer) {
      clearTimeout(foreignAnimSafetyTimer);
      foreignAnimSafetyTimer = null;
    }
    if (foreignAnimEndHandler) {
      container.removeEventListener('transitionend', foreignAnimEndHandler);
      foreignAnimEndHandler = null;
    }
  }

  function runForeignSlide(el: HTMLElement, fromPx: number, toPx: number, onDone?: () => void): void {
    el.style.height = fromPx + 'px';
    el.style.overflow = 'hidden';
    el.style.transition = 'none';
    void el.offsetHeight; // force reflow so the next transition starts from fromPx
    el.style.transition = `height ${FOREIGN_SLIDE_MS}ms ease-out`;
    el.style.height = toPx + 'px';
    const myToken = ++foreignAnimToken;
    const finish = (): void => {
      if (myToken !== foreignAnimToken) { return; }
      foreignAnimToken++;
      if (foreignAnimSafetyTimer) { clearTimeout(foreignAnimSafetyTimer); foreignAnimSafetyTimer = null; }
      if (foreignAnimEndHandler) { el.removeEventListener('transitionend', foreignAnimEndHandler); foreignAnimEndHandler = null; }
      clearForeignSlideStyles(el);
      if (onDone) { onDone(); }
    };
    foreignAnimEndHandler = (ev: TransitionEvent): void => {
      if (ev.propertyName === 'height' && ev.target === el) { finish(); }
    };
    el.addEventListener('transitionend', foreignAnimEndHandler);
    foreignAnimSafetyTimer = setTimeout(finish, FOREIGN_SLIDE_MS + 80);
  }

  function renderCompactRow(s: PanelSession, now: number): string {
    const age = formatAge(now - s.lastActivity);
    const displayName = getDisplayName(s);
    return '<div class="compact-row" role="listitem" tabindex="0" data-session-id="' + escapeHtml(s.sessionId) + '">'
      + '<span class="compact-name">' + escapeHtml(displayName) + '</span>'
      + '<span class="compact-transcript" data-transcript-id="' + escapeHtml(s.sessionId) + '" title="View transcript">&#x1f4dc;</span>'
      + '<span class="compact-age">' + age + '</span>'
      + '</div>';
  }

  // ===== TEAM RENDERING =====
  function renderTeamCompactRow(team: PanelTeam, _now: number): string {
    const agentCount = team.agents.length;
    const countLabel = agentCount + ' agent' + (agentCount !== 1 ? 's' : '');
    return '<div class="team-compact-row" role="listitem" tabindex="0" data-team-id="' + escapeHtml(team.teamId) + '">'
      + '<span class="team-badge">team</span>'
      + '<span class="compact-name">' + escapeHtml(team.name) + '</span>'
      + '<span class="compact-age">' + countLabel + '</span>'
      + '</div>';
  }

  /** Archived workflow run: a compact row that un-dismisses (reopens the
   *  invoking conversation) on click, mirroring the team/session archive rows. */
  function renderWorkflowCompactRow(wf: PanelWorkflow, now: number): string {
    const age = formatAge(now - (wf.startTime + (wf.durationMs || 0)));
    return '<div class="workflow-compact-row" role="listitem" tabindex="0" data-run-id="' + escapeHtml(wf.runId) + '">'
      + '<span class="wf-badge">wf</span>'
      + '<span class="compact-name">' + escapeHtml(wf.name) + '</span>'
      + '<span class="compact-age">' + age + '</span>'
      + '</div>';
  }

  function renderUsageSection(): void {
    // Always show the usage section — use ghost state when no data
    if (!lastUsage || !lastUsage.loaded) {
      let section = root.querySelector('.usage-section') as HTMLElement | null;
      if (!section) {
        section = document.createElement('div');
        section.className = 'usage-section';
        root.appendChild(section);
      }
      section.innerHTML = '<div class="usage-ghost-msg" style="font-style:normal">Calling usage API\u2026</div>';
      return;
    }

    const u = lastUsage;
    let section = root.querySelector('.usage-section') as HTMLElement | null;
    if (!section) {
      section = document.createElement('div');
      section.className = 'usage-section';
      root.appendChild(section);
    }

    let html = '';

    // Platform not supported — no OAuth credential access
    if (!u.platformSupported) {
      html += '<div class="usage-row"><div class="usage-row-label usage-row-disabled">Live usage not available. <a class="usage-link" href="https://claude.ai/settings/usage">View online.</a></div></div>';
      section.innerHTML = html;
      return;
    }

    // API disconnected state
    if (!u.apiConnected) {
      html += '<div class="usage-updated" style="text-align:left"><span class="api-dot disconnected"></span>Live usage unavailable \u00b7 <a class="usage-link" href="https://claude.ai/settings/usage">view online</a></div>';
      section.innerHTML = html;
      return;
    }

    // --- Current session (5h) ---
    const sessionExpired = u.resetTime && u.resetTime <= Date.now();
    if (sessionExpired) {
      // Ghost state: window expired
      html += '<div class="usage-row ghost">';
      html += '<div class="usage-row-label">Current session</div>';
      html += '<div class="usage-row-reset" style="color:#555555">window expired</div>';
      html += '</div>';
      html += '<div class="usage-bar-row">';
      html += '<div class="usage-bar-wrap ghost"></div>';
      html += '<span class="usage-bar-pct ghost">\u2014</span>';
      html += '</div>';
      html += '<div class="usage-ghost-msg">Next interaction starts new session.</div>';
    } else {
      const sessionTickPct = getElapsedPct(u.resetTime, 5 * 60 * 60 * 1000);
      const sessionCls = quotaClass(u.quotaPct5h || 0, sessionTickPct, currentSettings.usage.warnAtPercent, currentSettings.usage.criticalAtPercent);
      const overQuota = (u.quotaPct5h || 0) >= 100;

      html += '<div class="usage-row">';
      html += '<div class="usage-row-label">Current session usage</div>';
      if (u.resetTime) {
        html += '<div class="usage-row-reset">Resets in ' + formatResetTime(u.resetTime) + '</div>';
      }
      html += '</div>';

      html += '<div class="usage-bar-row">';
      html += '<div class="usage-bar-wrap">';
      html += '<div class="usage-bar-fill ' + sessionCls + '" style="width:' + Math.min(100, u.quotaPct5h || 0) + '%"></div>';
      if (sessionTickPct > 0) html += '<div class="usage-bar-tick" style="left:' + sessionTickPct + '%" title="' + Math.round(sessionTickPct) + '% of window elapsed"></div>';
      html += '</div>';
      html += '<span class="usage-bar-pct ' + sessionCls + '">' + Math.round(u.quotaPct5h || 0) + '%<span class="usage-bar-elapsed"> / ' + Math.round(sessionTickPct) + '%</span></span>';
      html += '</div>';

      if (overQuota) {
        const overLabel = u.extraUsageEnabled ? 'EXTRA USAGE' : 'LIMIT REACHED';
        html += '<div class="usage-status critical">' + overLabel + '</div>';
      }
    }

    // --- Weekly ---
    if (!currentSettings.usage.showWeekly) {
      // Skip the weekly block entirely; footer still appears below.
    } else {
    const weeklyExpired = u.weeklyResetTime && u.weeklyResetTime <= Date.now();
    if (weeklyExpired) {
      // Ghost state: weekly window expired
      html += '<div class="usage-weekly-sep">';
      html += '<div class="usage-row ghost">';
      html += '<div class="usage-row-label">Weekly session usage</div>';
      html += '<div class="usage-row-reset" style="color:#555555">no active window</div>';
      html += '</div>';
      html += '<div class="usage-bar-row">';
      html += '<div class="usage-bar-wrap ghost"></div>';
      html += '<span class="usage-bar-pct ghost">\u2014</span>';
      html += '</div>';
      html += '</div>';
    } else if ((u.quotaPctWeekly || 0) > 0 || u.weeklyResetTime) {
      const weeklyTickPct = getElapsedPct(u.weeklyResetTime, 7 * 24 * 60 * 60 * 1000);
      const weeklyCls = quotaClass(u.quotaPctWeekly || 0, weeklyTickPct, currentSettings.usage.warnAtPercent, currentSettings.usage.criticalAtPercent);

      html += '<div class="usage-weekly-sep">';
      html += '<div class="usage-row">';
      html += '<div class="usage-row-label">Weekly session usage</div>';
      if (u.weeklyResetTime) {
        html += '<div class="usage-row-reset">Resets in ' + formatResetTime(u.weeklyResetTime) + '</div>';
      }
      html += '</div>';
      html += '<div class="usage-bar-row">';
      html += '<div class="usage-bar-wrap">';
      html += '<div class="usage-bar-fill ' + weeklyCls + '" style="width:' + Math.min(100, u.quotaPctWeekly || 0) + '%"></div>';
      if (weeklyTickPct > 0) html += '<div class="usage-bar-tick" style="left:' + weeklyTickPct + '%" title="' + Math.round(weeklyTickPct) + '% of window elapsed"></div>';
      html += '</div>';
      html += '<span class="usage-bar-pct ' + weeklyCls + '">' + Math.round(u.quotaPctWeekly || 0) + '%<span class="usage-bar-elapsed"> / ' + Math.round(weeklyTickPct) + '%</span></span>';
      html += '</div>';
      html += '</div>';
    }
    } // end showWeekly gate

    // Footer row: companion slots on the left, Updated-ago on the right
    let footer = '';
    if (u.lastPoll) {
      const stateClass = u.apiConnected ? 'connected' : 'cached';
      const stateLabel = u.apiConnected ? '' : ' <span class="cached-tag">(cached)</span>';
      footer += '<div class="usage-updated"><span class="api-dot ' + stateClass + '" title="API ' + stateClass + '"></span>Updated ' + formatAgeCoarse(Date.now() - u.lastPoll) + ' ago' + stateLabel + '</div>';
    }
    const slotsHtml = renderFooterSlots(lastFooterSlots);
    if (footer || slotsHtml) {
      html += '<div class="usage-footer">' + slotsHtml + footer + '</div>';
    }

    section.innerHTML = html;
  }

  /** Render companion-registered slots under the usage card.
   *  All companion-supplied strings go through escapeHtml — no HTML ever
   *  reaches the DOM as-is. */
  function renderFooterSlots(slots: PanelFooterSlot[]): string {
    if (!slots || slots.length === 0) { return ''; }
    let html = '<div class="usage-slots">';
    for (const slot of slots) {
      const cls = ['usage-slot-row'];
      if (slot.hasCommand) { cls.push('clickable'); }
      const role = slot.hasCommand ? ' role="button" tabindex="0"' : '';
      const tooltip = slot.tooltip ? ' title="' + escapeHtml(slot.tooltip) + '"' : '';
      html += '<div class="' + cls.join(' ') + '" data-slot-id="' + escapeHtml(slot.slotId) + '"' + role + tooltip + '>';
      if (slot.status) {
        html += '<span class="api-dot ' + slot.status + '" title="' + escapeHtml(slot.status) + '"></span>';
      }
      if (slot.icon) {
        html += '<span class="usage-slot-icon">' + escapeHtml(slot.icon) + '</span>';
      }
      html += '<span class="usage-slot-label">' + escapeHtml(slot.label) + '</span>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // Request initial data
  vscode.postMessage({ type: 'requestUpdate' });
})();
