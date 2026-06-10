/**
 * Webview panel script for Serac.
 * Runs inside the VS Code webview (browser context).
 * Bundled by esbuild from src/panel.ts → media/panel.js.
 */

import {
  escapeHtml,
  stripMarkdown,
  getDisplayName,
  isGhost,
  formatAge,
  formatAgeCoarse,
  getStatusLabel,
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
    teams: boolean;
    workflows: boolean;
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
  show: { foreignWorkspaces: true, worktrees: true, usage: true, subagents: true, teams: true, workflows: true },
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
  if (savedState && savedState.archiveRange && savedState.archiveRange in RANGE_MS) {
    archiveRange = savedState.archiveRange as string;
    archiveRangeFromSavedState = true;
    // Notify extension of restored range so it can load extended archive if needed
    vscode.postMessage({ type: 'archiveRange', rangeMs: RANGE_MS[archiveRange] });
  }
  let workspacePath = '';
  let workspaceKey = '';
  let homeDir = ''; // host home dir for ~-abbreviation (webview has no process.env)
  let focusedSessionId: string | null = null;
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

  // Team roster expansion state (persisted via vscode setState)
  const expandedTeams = new Set<string>(
    (savedState && Array.isArray(savedState.expandedTeams)) ? savedState.expandedTeams as string[] : []
  );
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
      expandedTeams: Array.from(expandedTeams),
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

    // Team dismiss button
    const teamDismissBtn = target.closest<HTMLElement>('[data-dismiss-team]');
    if (teamDismissBtn) {
      e.stopPropagation();
      vscode.postMessage({ type: 'dismissTeam', teamId: teamDismissBtn.dataset.dismissTeam });
      return;
    }

    // Team expand/collapse toggle
    const teamToggleBtn = target.closest<HTMLElement>('[data-toggle-team]');
    if (teamToggleBtn) {
      e.stopPropagation();
      const tid = teamToggleBtn.dataset.toggleTeam!;
      if (expandedTeams.has(tid)) { expandedTeams.delete(tid); } else { expandedTeams.add(tid); }
      saveState();
      if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      return;
    }

    // Team agent row click (focus session)
    const teamAgentRow = target.closest<HTMLElement>('.team-agent[data-session-id]');
    if (teamAgentRow) {
      e.stopPropagation();
      vscode.postMessage({ type: 'focusSession', sessionId: teamAgentRow.dataset.sessionId });
      return;
    }

    // Team orchestrator click (focus session)
    const teamOrch = target.closest<HTMLElement>('.team-orchestrator[data-session-id]');
    if (teamOrch) {
      e.stopPropagation();
      vscode.postMessage({ type: 'focusSession', sessionId: teamOrch.dataset.sessionId });
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

    // Foreign-waiting card click → open the other VS Code window (with focus hint)
    const foreignWaitingCard = target.closest<HTMLElement>('.card.foreign-waiting');
    if (foreignWaitingCard) {
      const cwd = foreignWaitingCard.dataset.cwd;
      const sid = foreignWaitingCard.dataset.sessionId;
      if (cwd) { vscode.postMessage({ type: 'openWorkspace', cwd, sessionId: sid }); }
      return;
    }

    // Foreign-running compact row click → open the other VS Code window
    const foreignRunningRow = target.closest<HTMLElement>('.foreign-running-row');
    if (foreignRunningRow) {
      const cwd = foreignRunningRow.dataset.cwd;
      const sid = foreignRunningRow.dataset.sessionId;
      if (cwd) { vscode.postMessage({ type: 'openWorkspace', cwd, sessionId: sid }); }
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
    // Team expand toggle — a role=button div nested in the team group, so it
    // must be matched before the generic .card branch swallows it.
    const toggleTeam = target.closest<HTMLElement>('[data-toggle-team]');
    if (toggleTeam) {
      e.preventDefault();
      toggleTeam.click();
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
    const foreignRunningRow = target.closest<HTMLElement>('.foreign-running-row');
    if (foreignRunningRow) {
      e.preventDefault();
      foreignRunningRow.click();
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
    const wsRootNorm = workspacePath.replace(/\/+$/, '');
    sessions = sessions.filter(s => {
      if (isGhost(s)) { return false; }
      if (!s.worktreeRoot) { return true; }
      return s.worktreeRoot.replace(/\/+$/, '') === wsRootNorm;
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

    // === Foreign waiting band (other workspaces — needs you) ===
    if (currentSettings.show.foreignWorkspaces) {
      renderForeignWaitingSection(scrollWrap, now);
    } else {
      scrollWrap.querySelector('.foreign-waiting-section')?.remove();
    }

    // === Teams === No separate section: a team folds into its orchestrator's
    // normal card (see teamByOrchestrator). We're always going through the lead,
    // so the team rides on its session rather than duplicating it above.
    scrollWrap.querySelector('.team-section')?.remove();

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

    // Split local cards: active half (running/waiting) goes above the
    // foreign-running strip, completed half (done/stale) goes below it.
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
      reconcileCards(cardSection, runningCards, now);
    }

    // === Foreign-running strip (between local active and local done) ===
    if (currentSettings.show.foreignWorkspaces) {
      renderForeignRunningSection(scrollWrap, cardSection, now);
    } else {
      scrollWrap.querySelector('.foreign-running-section')?.remove();
    }

    // === Done card section ===
    let doneSection = scrollWrap.querySelector('.card-section.done-section') as HTMLElement | null;
    if (!doneSection) {
      doneSection = document.createElement('div');
      doneSection.className = 'card-section done-section';
      doneSection.setAttribute('role', 'list');
      doneSection.setAttribute('aria-label', 'Completed sessions');
    }
    const doneAnchor = (scrollWrap.querySelector('.foreign-running-section') as HTMLElement | null) ?? cardSection;
    if (doneSection.previousElementSibling !== doneAnchor) {
      doneAnchor.after(doneSection);
    }
    if (cards.length > 0 || archived.length > 0 || activeTeams.length > 0) {
      reconcileCards(doneSection, doneCards, now);
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
  function reconcileCards(container: HTMLElement, cards: PanelSession[], now: number): void {
    // Clear non-card children
    const children = Array.from(container.children);
    for (const child of children) {
      if (!(child as HTMLElement).classList.contains('card')) {
        container.removeChild(child);
      }
    }

    // 1. Snapshot current positions (FLIP: First)
    const existing = container.querySelectorAll('.card');
    const firstRects = new Map<string, DOMRect>();
    const containerRect = container.getBoundingClientRect();
    const canAnimate = containerRect.height > 0;

    existing.forEach(el => {
      const id = (el as HTMLElement).dataset.sessionId;
      if (id && canAnimate) {
        firstRects.set(id, el.getBoundingClientRect());
      }
    });

    // 2. Build new ID set
    const newIds = new Set(cards.map(c => c.sessionId));

    // 3. Mark removed cards for exit animation.
    //    Take them out of flex flow (position: absolute) so siblings reflow
    //    upward immediately; the FLIP step below then animates that reflow.
    //    The card-leave class is added on the next frame so the browser
    //    registers the pre-leave state and the opacity transition actually
    //    animates.
    existing.forEach(el => {
      const htmlEl = el as HTMLElement;
      const id = htmlEl.dataset.sessionId;
      if (id && !newIds.has(id) && !htmlEl.classList.contains('card-leave')) {
        const topPx = htmlEl.offsetTop;
        const leftPx = htmlEl.offsetLeft;
        const widthPx = htmlEl.offsetWidth;
        const heightPx = htmlEl.offsetHeight;
        htmlEl.style.transition = 'none';
        htmlEl.style.transform = '';
        htmlEl.style.top = topPx + 'px';
        htmlEl.style.left = leftPx + 'px';
        htmlEl.style.width = widthPx + 'px';
        htmlEl.style.height = heightPx + 'px';
        htmlEl.style.position = 'absolute';
        requestAnimationFrame(() => {
          htmlEl.style.transition = '';
          htmlEl.classList.add('card-leave');
        });
        setTimeout(() => { if (htmlEl.parentNode) htmlEl.parentNode.removeChild(htmlEl); }, TRANSITION_MS + 50);
      }
    });

    // 4. Create/update/reorder cards
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
        el.classList.add('card', 'card-enter');
      }

      el.className = 'card ' + s.status + (isFocused ? ' focused' : '') + (isNew ? ' card-enter' : '');
      el.setAttribute('role', 'listitem');
      el.setAttribute('tabindex', '0');
      // setAttribute takes a plain DOM string \u2014 do NOT HTML-escape, or a screen
      // reader announces literal entities ("A&amp;B"). s.status is a fixed enum.
      el.setAttribute('aria-label', stripMarkdown(getDisplayName(s)) + ' \u2014 ' + s.status);
      el.dataset.confidence = s.confidence || 'high';
      el.innerHTML = renderCardInner(s, now, isFocused);

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

    // 5. FLIP: Last, Invert, Play
    if (canAnimate) {
      const updated = container.querySelectorAll('.card:not(.card-leave)');
      updated.forEach(el => {
        const htmlEl = el as HTMLElement;
        const id = htmlEl.dataset.sessionId;

        if (htmlEl.classList.contains('card-enter')) {
          requestAnimationFrame(() => { htmlEl.classList.remove('card-enter'); });
          return;
        }

        const firstRect = firstRects.get(id!);
        if (!firstRect) return;

        const lastRect = htmlEl.getBoundingClientRect();
        const deltaY = firstRect.top - lastRect.top;
        if (Math.abs(deltaY) < 1) return;

        htmlEl.style.transition = 'none';
        htmlEl.style.transform = 'translateY(' + deltaY + 'px)';

        requestAnimationFrame(() => {
          htmlEl.style.transition = '';
          htmlEl.style.transform = '';
        });
      });
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
  function renderDetailChip(label: string, source: DetailSource, containerId: string, sessionId: string, state: string): string {
    return '<span class="wf-tag wf-view-chip detail-chip wf-chip-' + escapeHtml(state) + '"'
      + ' data-detail-source="' + escapeHtml(source) + '"'
      + ' data-detail-container="' + escapeHtml(containerId) + '"'
      + ' data-detail-session="' + escapeHtml(sessionId) + '"'
      + ' role="button" tabindex="0" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label)
      + '">' + escapeHtml(label) + '<span class="wf-arrow">→</span></span>';
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
      && (s.status === 'running' || s.status === 'waiting' || isFocused);
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
    // A session's agents can come from workflow run(s) and/or plain Task
    // subagents. Both open the same detail panel (keyed to this session), which
    // surfaces a view switcher across them, so collapse to ONE chip rather than
    // two: workflow-specific label when only workflows, "subagents" when only
    // those, and a neutral "agents" when both — the switcher carries the rest.
    // Initial source is the workflow when present (richer), else subagents.
    // Tool-error badge — failed tool calls are the "done, but look closer"
    // triage signal; same quiet-chip pattern as the background-shell badge.
    const toolErrs = s.toolErrorCount ?? 0;
    if (toolErrs > 0) {
      metaHtml += '<span class="tool-error-badge" title="Tool calls that returned errors in this session">'
        + toolErrs + ' tool error' + (toolErrs === 1 ? '' : 's') + '</span>';
    }
    const hasWf = !!wfs && wfs.length > 0;
    const showSubChip = hasSubagents && currentSettings.show.subagents;
    const chipState = detailChipState(wfs, s.subagents);
    // One name for everything beneath a card — agents (be they workflow agents,
    // subagents, or teammates). The source still routes the drill-in: prefer the
    // workflow view when a run is present (richer), else the subagents view.
    if (hasWf) {
      metaHtml += renderDetailChip('agents', 'workflow', s.sessionId, s.sessionId, chipState);
    } else if (showSubChip) {
      metaHtml += renderDetailChip('agents', 'subagents', s.sessionId, s.sessionId, chipState);
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

  /** Render a single foreign workspace row (shared by grouped and ungrouped rendering).
   *  When the row aggregates 2+ worktrees, becomes a click-to-expand picker
   *  parent (chevron, no data-cwd) followed by an inline child list of every
   *  worktree of the repo. Otherwise behaves as a direct-open row. */
  function renderWsRow(ws: WorkspaceGroup, grouped: boolean = false): string {
    const running = ws.counts['running'] || 0;
    const waiting = ws.counts['waiting'] || 0;
    const done = ws.counts['done'] || 0;
    const seen = ws.counts['stale'] || 0;
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
      + (grouped ? ' ws-row-grouped' : '')
      + (isAggregated ? ' ws-row-aggregated' : '')
      + (pickerEligible ? ' ws-row-expandable' : '')
      + (waiting > 0 ? ' ws-row-waiting' : '')
      + ((pickerEligible || ws.cwd) ? ' ws-row-clickable' : '');
    let countsHtml = '';
    if (waiting) countsHtml += '<span class="status-count waiting-count">' + waiting + 'W</span>';
    if (running) countsHtml += '<span class="status-count running-count">' + running + 'R</span>';
    if (done) countsHtml += '<span class="status-count done-count">' + done + 'D</span>';
    if (seen) countsHtml += '<span class="status-count stale-count">' + seen + 'S</span>';
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
      + (hasLiveSessions ? ' data-confidence="' + (ws.confidence || 'medium') + '"' : '')
      + rowAttrs + '>'
      + chevron
      + '<span class="ws-name">' + escapeHtml(ws.displayName) + '</span>'
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
    const wsRootNorm = workspacePath.replace(/\/+$/, '');
    const memberByCwd = new Map<string, WorkspaceGroup>();
    for (const m of (ws.members ?? [])) {
      if (m.cwd) { memberByCwd.set(m.cwd.replace(/\/+$/, ''), m); }
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
      const pathNorm = wt.path.replace(/\/+$/, '');
      // Skip the worktree the user is already in — clicking it is a no-op.
      if (pathNorm === wsRootNorm) { continue; }
      const member = memberByCwd.get(pathNorm);
      const counts = member?.counts ?? {};
      const cRunning = counts['running'] || 0;
      const cWaiting = counts['waiting'] || 0;
      const cDone = counts['done'] || 0;
      const cSeen = counts['stale'] || 0;
      const childHasLive = cRunning > 0 || cWaiting > 0;
      let childCountsHtml = '';
      if (cWaiting) childCountsHtml += '<span class="status-count waiting-count">' + cWaiting + 'W</span>';
      if (cRunning) childCountsHtml += '<span class="status-count running-count">' + cRunning + 'R</span>';
      if (cDone) childCountsHtml += '<span class="status-count done-count">' + cDone + 'D</span>';
      if (cSeen) childCountsHtml += '<span class="status-count stale-count">' + cSeen + 'S</span>';
      const label = wt.branch || basenameOf(wt.path);
      const mainChip = wt.isMain
        ? '<span class="ws-main-chip" title="Main checkout">main</span>'
        : '';
      const detachedHint = wt.branch ? '' : ' (detached)';
      const titleText = tildeAbbrev(wt.path) + detachedHint;
      const noActivityHint = !member && !wt.isMain
        ? '<span class="ws-picker-quiet" title="No Claude Code activity in 7d">no activity</span>'
        : '';
      const childCls = 'ws-row ws-picker-child ws-row-clickable'
        + (cWaiting > 0 ? ' ws-row-waiting' : '');
      html += '<div class="' + childCls + '"'
        + (childHasLive ? ' data-confidence="' + escapeHtml(member?.confidence ?? 'medium') + '"' : '')
        + ' data-cwd="' + escapeHtml(wt.path) + '"'
        + ' data-parent-key="' + escapeHtml(ws.workspaceKey) + '"'
        + ' tabindex="0" role="button"'
        + ' title="' + escapeHtml(titleText) + '">'
        + '<span class="ws-name">' + escapeHtml(label) + '</span>'
        + mainChip
        + noActivityHint
        + '<div class="ws-counts">' + childCountsHtml + '</div>'
        + '</div>';
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
    const wsRootNorm = workspacePath.replace(/\/+$/, '');
    const sorted = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName));
    let html = '<div class="ws-picker-children" role="group" aria-label="Directories">';
    for (const m of sorted) {
      if (!m.cwd) { continue; }
      const pathNorm = m.cwd.replace(/\/+$/, '');
      if (pathNorm === wsRootNorm) { continue; }
      const counts = m.counts ?? {};
      const cRunning = counts['running'] || 0;
      const cWaiting = counts['waiting'] || 0;
      const cDone = counts['done'] || 0;
      const cSeen = counts['stale'] || 0;
      const childHasLive = cRunning > 0 || cWaiting > 0;
      let childCountsHtml = '';
      if (cWaiting) childCountsHtml += '<span class="status-count waiting-count">' + cWaiting + 'W</span>';
      if (cRunning) childCountsHtml += '<span class="status-count running-count">' + cRunning + 'R</span>';
      if (cDone) childCountsHtml += '<span class="status-count done-count">' + cDone + 'D</span>';
      if (cSeen) childCountsHtml += '<span class="status-count stale-count">' + cSeen + 'S</span>';
      const childCls = 'ws-row ws-picker-child ws-row-clickable'
        + (cWaiting > 0 ? ' ws-row-waiting' : '');
      html += '<div class="' + childCls + '"'
        + (childHasLive ? ' data-confidence="' + escapeHtml(m.confidence ?? 'medium') + '"' : '')
        + ' data-cwd="' + escapeHtml(m.cwd) + '"'
        + ' data-parent-key="' + escapeHtml(ws.workspaceKey) + '"'
        + ' tabindex="0" role="button"'
        + ' title="' + escapeHtml(tildeAbbrev(m.cwd)) + '">'
        + '<span class="ws-name">' + escapeHtml(basenameOf(m.cwd)) + '</span>'
        + '<div class="ws-counts">' + childCountsHtml + '</div>'
        + '</div>';
    }
    html += '</div>';
    return html;
  }

  function basenameOf(p: string): string {
    const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
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
    const done = wt.counts['done'] || 0;
    const seen = wt.counts['stale'] || 0;
    const hasLive = running > 0 || waiting > 0;
    let countsHtml = '';
    if (waiting) countsHtml += '<span class="status-count waiting-count">' + waiting + 'W</span>';
    if (running) countsHtml += '<span class="status-count running-count">' + running + 'R</span>';
    if (done) countsHtml += '<span class="status-count done-count">' + done + 'D</span>';
    if (seen) countsHtml += '<span class="status-count stale-count">' + seen + 'S</span>';

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

  // ===== FOREIGN WAITING SECTION =====
  /** Disabled: the foreign workspace row already flags waiting sessions with
   *  the W count. The full-card promotion to the top of the panel was too
   *  attention-grabbing for sessions the user can't action from this window.
   *  Kept as a no-op (with teardown) so the call site doesn't have to change. */
  function renderForeignWaitingSection(scrollWrap: HTMLElement, _now: number): void {
    const section = scrollWrap.querySelector('.foreign-waiting-section');
    if (section) section.remove();
  }

  // ===== FOREIGN RUNNING SECTION =====
  /** Disabled: the foreign workspace row already shows running counts, so the
   *  separate strip just duplicates the cue. Kept as a no-op (and tears down
   *  any leftover DOM from older builds) so the call site doesn't have to know. */
  function renderForeignRunningSection(scrollWrap: HTMLElement, _anchor: HTMLElement, _now: number): void {
    const section = scrollWrap.querySelector('.foreign-running-section');
    if (section) section.remove();
  }

  // ===== USAGE SECTION RENDERER =====
  // ===== TEAM RENDERING =====
  function renderTeamSection(scrollWrap: HTMLElement, now: number): void {
    let teamSection = scrollWrap.querySelector('.team-section') as HTMLElement | null;
    const activeTeams = lastTeams.filter(t => !t.dismissed);

    if (activeTeams.length === 0) {
      if (teamSection) teamSection.remove();
      return;
    }

    if (!teamSection) {
      teamSection = document.createElement('div');
      teamSection.className = 'team-section';
      // Insert before card-section
      const cardSection = scrollWrap.querySelector('.card-section');
      if (cardSection) {
        scrollWrap.insertBefore(teamSection, cardSection);
      } else {
        scrollWrap.appendChild(teamSection);
      }
    }

    let html = '<div class="team-section-header">Agent teams</div>';
    for (const team of activeTeams) {
      html += renderTeamGroup(team, now);
    }
    teamSection.innerHTML = html;
  }

  function renderTeamGroup(team: PanelTeam, now: number): string {
    const orchStatus = team.orchestrator.status;
    const hasWaiting = (team.counts['waiting'] || 0) > 0 || orchStatus === 'waiting';
    const hasRunning = (team.counts['running'] || 0) > 0 || orchStatus === 'running';
    const allDone = !hasWaiting && !hasRunning;

    let groupClass = 'team-group';
    if (hasWaiting) groupClass += ' team-waiting';
    else if (allDone) groupClass += ' team-done';

    const isExpanded = expandedTeams.has(team.teamId);

    // Sort agents: waiting > running > done, then by spawnedAt
    const sortedAgents = [...team.agents].sort((a, b) => {
      const order: Record<string, number> = { waiting: 0, running: 1, done: 2, stale: 3 };
      const aOrd = order[a.status] ?? 2;
      const bOrd = order[b.status] ?? 2;
      if (aOrd !== bOrd) return aOrd - bOrd;
      return a.spawnedAt - b.spawnedAt;
    });

    const activeAgents = sortedAgents.filter(a => a.status === 'running' || a.status === 'waiting');
    const doneAgents = sortedAgents.filter(a => a.status !== 'running' && a.status !== 'waiting');
    const COMPACT_THRESHOLD = 5;
    const shouldCompact = team.agents.length > COMPACT_THRESHOLD;

    let html = '<div class="' + groupClass + '">';

    // Orchestrator header
    html += renderTeamOrchestrator(team, now);

    // Agent summary (expandable)
    if (team.agents.length > 0) {
      const summaryParts: string[] = [];
      const waiting = team.counts['waiting'] || 0;
      const running = team.counts['running'] || 0;
      const done = team.counts['done'] || 0;
      if (waiting > 0) summaryParts.push('<span class="waiting-count">' + waiting + ' waiting</span>');
      if (running > 0) summaryParts.push('<span class="running-count">' + running + ' running</span>');
      if (done > 0) summaryParts.push('<span>' + done + ' done</span>');

      html += '<div class="team-agent-summary" role="button" tabindex="0"'
        + ' aria-expanded="' + (isExpanded ? 'true' : 'false') + '"'
        + ' data-toggle-team="' + escapeHtml(team.teamId) + '">'
        + '<span class="team-chevron' + (isExpanded ? ' expanded' : '') + '">&#x25B8;</span>'
        + team.agents.length + ' agent' + (team.agents.length > 1 ? 's' : '') + ': '
        + summaryParts.join(', ')
        + '</div>';

      // Agent list (always show active; show done when expanded or below threshold)
      if (isExpanded || activeAgents.length > 0) {
        html += '<div class="team-agent-list">';
        for (const agent of activeAgents) {
          html += renderTeamAgent(agent, now);
        }
        if (isExpanded || !shouldCompact) {
          for (const agent of doneAgents) {
            html += renderTeamAgent(agent, now);
          }
        }
        html += '</div>';
      }
    }

    html += '</div>';
    return html;
  }

  function renderTeamOrchestrator(team: PanelTeam, now: number): string {
    const o = team.orchestrator;
    const statusLabel = o.status === 'running' ? 'Running'
      : o.status === 'waiting' ? 'Waiting'
      : o.status === 'done' ? 'Done'
      : o.status;

    const activityText = stripMarkdown(o.activity || 'No recent activity');

    let metaHtml = '<div class="card-meta">';
    metaHtml += '<span class="session-id-pill clickable" data-copy-id="' + escapeHtml(o.sessionId) + '" title="Copy session ID">' + escapeHtml(o.sessionId.slice(0, 8)) + '</span>';
    if (o.modelLabel) {
      const modelCls = 'model-pill' + (o.modelLabel === 'Sonnet' ? ' sonnet' : o.modelLabel === 'Haiku' ? ' haiku' : '');
      metaHtml += '<span class="' + modelCls + '">' + escapeHtml(o.modelLabel) + '</span>';
    }
    metaHtml += '<span class="team-badge">orchestrator</span>';
    if (team.agents.length > 0) {
      const teamChipState = team.agents.some(a => a.status === 'waiting') || o.status === 'waiting' ? 'waiting'
        : team.agents.some(a => a.status === 'running') || o.status === 'running' ? 'running'
        : 'done';
      metaHtml += renderDetailChip('agent team', 'team', team.teamId, o.sessionId, teamChipState);
    }

    const teamLive = team.agents.some(a => a.status === 'running' || a.status === 'waiting')
      || o.status === 'running' || o.status === 'waiting';
    const teamDismissTitle = teamLive
      ? 'Archive team (use if status is stuck or hook hasn’t fired)'
      : 'Dismiss team';
    metaHtml += '<div class="card-actions"><button class="team-dismiss-btn' + (teamLive ? ' dismiss-btn-force' : '') + '" data-dismiss-team="' + escapeHtml(team.teamId) + '" title="' + escapeHtml(teamDismissTitle) + '" aria-label="Archive team">&times;</button></div>';
    metaHtml += '</div>';

    let contextBarHtml = '';
    if (o.contextTokens && o.contextTokens > 0) {
      const cw = compactSettings?.autoCompactWindow ?? 200000;
      const cp = compactSettings?.autoCompactPct ?? 95;
      const threshold = getCompactThreshold(cw, cp);
      const pct = Math.min(100, Math.round(o.contextTokens / threshold * 100));
      const fillClass = 'context-fill' + (pct >= 60 ? ' hot' : '');
      contextBarHtml = '<div class="context-bar"><div class="' + fillClass + '" style="width:' + pct + '%"></div></div>';
    }

    return '<div class="team-orchestrator" data-session-id="' + escapeHtml(o.sessionId) + '">'
      + '<div class="card-top"><span class="card-name">' + escapeHtml(team.name) + '</span>'
      + '<span class="status-pill">' + statusLabel + '</span></div>'
      + metaHtml
      + '<div class="card-detail">' + escapeHtml(activityText) + '</div>'
      + contextBarHtml
      + '</div>';
  }

  function renderTeamAgent(agent: PanelTeamAgent, now: number): string {
    const depthClass = agent.depth <= 3 ? 'depth-' + agent.depth : 'depth-3';
    const dotClass = agent.status === 'waiting' ? 'waiting'
      : agent.status === 'running' ? 'running'
      : agent.exitStatus === 'failed' ? 'failed'
      : agent.status === 'done' ? 'done'
      : 'stale';

    let statusHtml: string;
    if (agent.status === 'waiting') {
      statusHtml = '<span class="team-agent-status waiting-status">waiting</span>';
    } else if (agent.status === 'running') {
      statusHtml = '<span class="team-agent-status running-status"><span class="mini-spinner"></span></span>';
    } else if (agent.exitStatus === 'failed') {
      statusHtml = '<span class="team-agent-status failed-status">failed</span>';
    } else {
      const elapsed = agent.spawnedAt ? formatAge(now - agent.spawnedAt) : '';
      statusHtml = '<span class="team-agent-status">' + (elapsed ? elapsed + ' · ' : '') + 'done</span>';
    }

    // Session subagent dots
    let subagentDotsHtml = '';
    if (currentSettings.show.subagents && agent.subagents && agent.subagents.length > 0) {
      subagentDotsHtml = '<span class="team-agent-subagents">';
      for (const sa of agent.subagents) {
        const saDotClass = sa.waitingOnPermission ? 'waiting' : sa.running ? 'running' : 'done';
        subagentDotsHtml += '<span class="team-agent-subagent-dot ' + saDotClass + '"></span>';
      }
      subagentDotsHtml += '</span>';
    }

    // Depth badge for deeper nesting
    const depthBadge = agent.depth > 3 ? '<span class="team-depth-badge">d' + agent.depth + '</span>' : '';

    const activityHtml = agent.activity
      ? '<span class="team-agent-activity">' + escapeHtml(stripMarkdown(agent.activity)) + '</span>'
      : '';

    return '<div class="team-agent ' + depthClass + '"' + (agent.sessionId ? ' data-session-id="' + escapeHtml(agent.sessionId) + '"' : '') + '>'
      + '<div class="team-agent-dot ' + dotClass + '"></div>'
      + '<div class="team-agent-content">'
      + '<span class="team-agent-name">' + depthBadge + escapeHtml(agent.name) + '</span>'
      + activityHtml
      + subagentDotsHtml
      + statusHtml
      + '</div>'
      + '</div>';
  }

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
