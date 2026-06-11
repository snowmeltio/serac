/**
 * Webview panel script for Serac.
 * Runs inside the VS Code webview (browser context).
 * Bundled by esbuild from src/panel.ts → media/panel.js.
 *
 * This file owns the mutable webview state, the keyed DOM reconciler (FLIP),
 * event wiring, and host messaging. The pure HTML builders live in
 * panelRender.ts and receive ambient state via a RenderContext built once
 * per render pass (audit refactor-panel-4).
 */

import {
  normPath,
  escapeHtml,
  stripMarkdown,
  getDisplayName,
  isGhost,
  computeFileCollisions,
  debounceStatuses,
  sanitiseWorkspaceKey,
  PanelSession,
  UsageData,
} from './panelUtils.js';
import {
  DEFAULT_PANEL_SETTINGS,
  RANGE_MS,
  archiveListHtml,
  emptyStateHtml,
  renderCardInner,
  renderForeignWorkspaceRows,
  renderUsageHtml,
  renderWorktreesPane,
  statusSummaryHtml,
  timeRangePillsHtml,
  type PanelCompactSettings,
  type PanelFooterSlot,
  type PanelSettings,
  type PanelTeam,
  type PanelWorkflow,
  type PanelWorktreeRow,
  type RenderContext,
  type WorkspaceGroup,
} from './panelRender.js';

// Declare the VS Code API type for the webview
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
};

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

interface SettingsMessage {
  type: 'settings';
  settings: PanelSettings;
}

type WebviewIncomingMessage = UpdateMessage | FocusMessage | SettingsMessage;

/** Animation timing. Derived from settings.animations.enabled — when
 *  animations are off, both collapse to 0 so render is instantaneous. */
let TRANSITION_MS = 300;
let FOREIGN_SLIDE_MS = 220;

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

  /** Snapshot the ambient webview state the pure renderers read. Built once
   *  per render pass (after workflowsBySession is regrouped) so every builder
   *  in panelRender.ts sees one consistent view of this tick. */
  function makeRenderContext(): RenderContext {
    return {
      settings: currentSettings,
      workspacePath,
      homeDir,
      fileCollisions,
      workflowsBySession,
      compactSettings,
      expandedWorkspaces,
    };
  }

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

    // Archive-row detail glyph — opens the detail panel for the archived
    // team/workflow. Checked before the row branches, whose click is undismiss.
    const archiveDetailGlyph = target.closest<HTMLElement>('.compact-transcript[data-detail-source]');
    if (archiveDetailGlyph) {
      e.stopPropagation();
      const source = archiveDetailGlyph.dataset.detailSource;
      const containerId = archiveDetailGlyph.dataset.detailContainer;
      const sessionId = archiveDetailGlyph.dataset.detailSession;
      if (source && containerId && sessionId) {
        vscode.postMessage({ type: 'openDetail', source, containerId, sessionId });
      }
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
    // Transcript/detail glyphs inside archive rows — matched before the row
    // branches so Enter fires the glyph instead of undismissing the row.
    const archiveGlyph = target.closest<HTMLElement>('.compact-transcript');
    if (archiveGlyph) {
      e.preventDefault();
      archiveGlyph.click();
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

    // Ambient state snapshot for the pure renderers in panelRender.ts. Built
    // AFTER workflowsBySession is regrouped above so the context holds this
    // pass's map, and reused by every builder call below.
    const ctx = makeRenderContext();

    // === Top bar ===
    const summaryHtml = statusSummaryHtml(counts);

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
      cardSection.innerHTML = emptyStateHtml(lastOlderSessionCount);
    } else {
      reconcileCards(ctx, cardSection, runningCards, now, prevRects, renderedIds);
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
      reconcileCards(ctx, doneSection, doneCards, now, prevRects, renderedIds);
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
      updateWorktreesContainer(ctx, worktreesContainer);
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
      renderUsageSection(ctx, now);
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
      updateForeignContainer(ctx, foreignContainer);
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
  function reconcileCards(ctx: RenderContext, container: HTMLElement, cards: PanelSession[], now: number, prevRects: Map<string, DOMRect>, renderedIds: Set<string>): void {
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
      const inner = renderCardInner(ctx, s, now, isFocused);
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

    existingList.innerHTML = archiveListHtml(archived, archivedTeams, archivedWorkflows, now, archiveRange);
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
    existing.innerHTML = timeRangePillsHtml(archiveRange);
  }

  function updateWorktreesContainer(ctx: RenderContext, container: HTMLElement): void {
    const html = lastWorktrees.length > 0 ? renderWorktreesPane(ctx, lastWorktrees) : '';
    if (html === lastWorktreesHtml) { return; }
    container.innerHTML = html;
    lastWorktreesHtml = html;
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
  function updateForeignContainer(ctx: RenderContext, container: HTMLElement): void {
    const wsList = lastForeignWorkspaces ?? [];
    const newHtml = wsList.length > 0 ? renderForeignWorkspaceRows(ctx, wsList) : '';
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

  /** DOM wrapper for the usage section: ensures the container exists and
   *  swaps in the HTML built by panelRender.renderUsageHtml(). */
  function renderUsageSection(ctx: RenderContext, now: number): void {
    let section = root.querySelector('.usage-section') as HTMLElement | null;
    if (!section) {
      section = document.createElement('div');
      section.className = 'usage-section';
      root.appendChild(section);
    }
    section.innerHTML = renderUsageHtml(ctx, lastUsage, lastFooterSlots, now);
  }

  // Request initial data
  vscode.postMessage({ type: 'requestUpdate' });
})();
