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

  isForeignSession,
  debounceStatuses,
  getElapsedPct,
  quotaClass,
  formatResetTime,
  sanitiseWorkspaceKey,
  getModelCapacity,
  getCompactThreshold,
  formatTokenCount,
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
  compactSettings?: PanelCompactSettings;
  footerSlots?: PanelFooterSlot[];
  olderSessionCount?: number;
}

interface FocusMessage {
  type: 'focusSession';
  sessionId: string;
}

type WebviewIncomingMessage = UpdateMessage | FocusMessage;

const TRANSITION_MS = 300;
const FOREIGN_SLIDE_MS = 220;
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
  let archiveRange = '1d';
  const savedState = vscode.getState();
  if (savedState && savedState.archiveRange && savedState.archiveRange in RANGE_MS) {
    archiveRange = savedState.archiveRange as string;
    // Notify extension of restored range so it can load extended archive if needed
    vscode.postMessage({ type: 'archiveRange', rangeMs: RANGE_MS[archiveRange] });
  }
  let workspacePath = '';
  let workspaceKey = '';
  let focusedSessionId: string | null = null;
  let lastSessions: PanelSession[] | null = null;
  let lastNeedsInputCount = 0;
  let lastUsage: UsageData | null = null;
  let lastForeignWorkspaces: WorkspaceGroup[] | null = null;
  let lastForeignWaiting: PanelSession[] = [];
  let lastForeignRunning: PanelSession[] = [];
  let lastTeams: PanelTeam[] = [];
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

  // Subagent list expansion state (persisted via vscode setState)
  const expandedSessions = new Set<string>(
    (savedState && Array.isArray(savedState.expandedSessions)) ? savedState.expandedSessions as string[] : []
  );
  const expandedTeams = new Set<string>(
    (savedState && Array.isArray(savedState.expandedTeams)) ? savedState.expandedTeams as string[] : []
  );

  function saveState(): void {
    vscode.setState({ archiveRange, expandedSessions: Array.from(expandedSessions), expandedTeams: Array.from(expandedTeams) });
  }

  // ===== DELEGATED EVENT HANDLERS =====
  root.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;

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

    // Subagent toggle
    const toggleBtn = target.closest<HTMLElement>('[data-toggle-session]');
    if (toggleBtn) {
      e.stopPropagation();
      const sid = toggleBtn.dataset.toggleSession!;
      if (expandedSessions.has(sid)) {
        expandedSessions.delete(sid);
      } else {
        expandedSessions.add(sid);
      }
      saveState();
      if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
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

    // Foreign workspace row click → open that workspace
    const wsRow = target.closest<HTMLElement>('.ws-row[data-cwd]');
    if (wsRow) {
      const cwd = wsRow.dataset.cwd;
      if (cwd) { vscode.postMessage({ type: 'openWorkspace', cwd }); }
      return;
    }

    // Card click
    const card = target.closest<HTMLElement>('.card:not(.card-leave)');
    if (card) {
      const sid = card.dataset.sessionId!;
      const isLive = card.classList.contains('running') || card.classList.contains('waiting');
      const isForeign = card.dataset.foreign === 'true';
      if (isLive || !isForeign) {
        focusedSessionId = sid;
        vscode.postMessage({ type: 'focusSession', sessionId: sid });
        if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      } else {
        vscode.postMessage({ type: 'viewTranscript', sessionId: sid });
      }
      return;
    }
  });

  // Keyboard support: Enter/Space activates focused element
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
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
    const foreignRunningRow = target.closest<HTMLElement>('.foreign-running-row');
    if (foreignRunningRow) {
      e.preventDefault();
      foreignRunningRow.click();
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
        lastFooterSlots = message.footerSlots ?? [];
        compactSettings = message.compactSettings ?? null;
        lastOlderSessionCount = message.olderSessionCount ?? 0;
        const sessions = debounceStatuses(message.sessions, needsInputSince, Date.now());
        render(sessions, message.waitingCount, message.workspacePath);
      } else if (message.type === 'focusSession') {
        focusedSessionId = message.sessionId;
        if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
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
    sessions = sessions.filter(s => !isGhost(s));

    const counts: Record<string, number> = { 'waiting': 0, running: 0, done: 0, stale: 0, archived: 0 };
    for (const s of sessions) {
      if (s.dismissed) { counts.archived++; }
      else { counts[s.status] = (counts[s.status] || 0) + 1; }
    }

    const cards = sessions.filter(s => !s.dismissed);
    const archived = sessions.filter(s => s.dismissed);
    const now = Date.now();

    // === Top bar ===
    let summaryHtml = '';
    if (counts['waiting'] > 0) summaryHtml += '<span class="status-count waiting-count">' + counts['waiting'] + ' waiting</span>';
    if (counts.running > 0) summaryHtml += '<span class="status-count running-count">' + counts.running + ' running</span>';
    if (counts.done > 0) summaryHtml += '<span class="status-count done-count">' + counts.done + ' done</span>';
    if (counts.stale > 0) summaryHtml += '<span class="status-count stale-count">' + counts.stale + ' seen</span>';
    if (!summaryHtml) summaryHtml = '<span class="status-count">No sessions</span>';

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
    renderForeignWaitingSection(scrollWrap, now);

    // === Team section (before individual session cards) ===
    renderTeamSection(scrollWrap, now);

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

    // Split local cards: active half (running/waiting/stale) goes above the
    // foreign-running strip, completed half (done) goes below it.
    const runningCards = cards.filter(c => c.status !== 'done');
    const doneCards = cards.filter(c => c.status === 'done');

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
    renderForeignRunningSection(scrollWrap, cardSection, now);

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
    renderArchiveSection(archived, archivedTeams, now, doneSection);

    // === Time-range bar ===
    renderTimeRangeBar(archived.length > 0 || archivedTeams.length > 0 || lastOlderSessionCount > 0);

    // === Foreign workspace rows (between time-range bar and usage) ===
    let foreignContainer = root.querySelector('.ws-foreign-rows') as HTMLElement | null;
    if (!foreignContainer) {
      foreignContainer = document.createElement('div');
      foreignContainer.className = 'ws-foreign-rows';
      root.appendChild(foreignContainer);
    }

    // === Usage section (always last) ===
    renderUsageSection();
    // Ensure foreign rows stay above usage section
    const usageEl = root.querySelector('.usage-section');
    if (usageEl && foreignContainer.nextElementSibling !== usageEl) {
      root.insertBefore(foreignContainer, usageEl);
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

    // 3. Mark removed cards for exit animation
    existing.forEach(el => {
      const htmlEl = el as HTMLElement;
      const id = htmlEl.dataset.sessionId;
      if (id && !newIds.has(id) && !htmlEl.classList.contains('card-leave')) {
        htmlEl.classList.add('card-leave');
        setTimeout(() => { if (htmlEl.parentNode) htmlEl.parentNode.removeChild(htmlEl); }, TRANSITION_MS);
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

      const foreign = isForeignSession(s, workspaceKey);
      el.className = 'card ' + s.status + (isFocused ? ' focused' : '') + (isNew ? ' card-enter' : '') + (foreign ? ' foreign' : '');
      el.setAttribute('role', 'listitem');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', escapeHtml(stripMarkdown(getDisplayName(s))) + ' \u2014 ' + s.status);
      el.dataset.foreign = foreign ? 'true' : 'false';
      el.dataset.confidence = s.confidence || 'high';
      el.innerHTML = renderCardInner(s, now, isFocused, foreign);

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
  function renderArchiveSection(archived: PanelSession[], archivedTeams: PanelTeam[], now: number, afterElement: HTMLElement): void {
    const scrollWrap = root.querySelector('.card-archive-scroll');
    let existingList = (scrollWrap || root).querySelector('.archive-list') as HTMLElement | null;

    if (archived.length === 0 && archivedTeams.length === 0) {
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

    const recentItems: PanelSession[] = [];
    const overflowItems: PanelSession[] = [];
    for (const s of archived) {
      const age = now - s.lastActivity;
      if (age <= DAY_MS) {
        recentItems.push(s);
      } else if (rangeMs === 0 || age <= rangeMs) {
        overflowItems.push(s);
      }
    }

    let archiveHtml = '';

    // Team archive rows (always shown at top of archive)
    for (const team of archivedTeams) {
      archiveHtml += renderTeamCompactRow(team, now);
    }

    for (const s of recentItems) {
      archiveHtml += renderCompactRow(s, now);
    }
    if (archiveRange !== '1d') {
      for (const s of overflowItems) {
        archiveHtml += renderCompactRow(s, now);
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

  // ===== SUBAGENT ITEM HELPER =====
  function renderSubagentItem(agent: PanelSession['subagents'][0], now: number): string {
    const isBackground = agent.running && !agent.blocking;
    const dotClass = agent.waitingOnPermission ? 'waiting'
      : isBackground ? 'background'
      : agent.running ? 'running'
      : 'done';
    let statusHtml: string;
    if (agent.waitingOnPermission) {
      statusHtml = '<span class="subagent-status waiting-status">waiting</span>';
    } else if (isBackground) {
      const toolsLabel = agent.toolsCompleted > 0 ? agent.toolsCompleted + ' tools' : '';
      statusHtml = '<span class="subagent-status background-status">'
        + (toolsLabel ? '<span class="subagent-tools">' + toolsLabel + '</span>' : '')
        + 'background</span>';
    } else if (agent.running) {
      const toolsLabel = agent.toolsCompleted > 0 ? agent.toolsCompleted + ' tools' : '';
      statusHtml = '<span class="subagent-status running-status">'
        + (toolsLabel ? '<span class="subagent-tools">' + toolsLabel + '</span>' : '')
        + '<span class="mini-spinner"></span></span>';
    } else {
      const durationMs = agent.startedAt ? now - agent.startedAt : 0;
      const durationLabel = durationMs > 1000 ? formatAge(durationMs) : '';
      statusHtml = '<span class="subagent-status">'
        + (durationLabel ? durationLabel + ' · ' : '')
        + 'done'
        + (agent.toolsCompleted > 0 ? ' · ' + agent.toolsCompleted + ' tools' : '')
        + '</span>';
    }
    let resultHtml = '';
    if (!agent.running && agent.resultPreview) {
      resultHtml = '<div class="subagent-result">' + escapeHtml(agent.resultPreview) + '</div>';
    }
    return '<div class="subagent-item' + (isBackground ? ' subagent-background' : '') + '">'
      + '<div class="subagent-dot ' + dotClass + '"></div>'
      + '<div class="subagent-content">'
      + '<div class="subagent-header">'
      + '<span class="subagent-text">' + escapeHtml(agent.description) + '</span>'
      + statusHtml
      + '</div>'
      + resultHtml
      + '</div>'
      + '</div>';
  }

  // ===== CARD INNER HTML =====
  function renderCardInner(s: PanelSession, now: number, isFocused: boolean, foreign: boolean): string {
    const statusLabel = getStatusLabel(s, now);
    const displayName = stripMarkdown(getDisplayName(s));

    let subagentHtml = '';
    const hasSubagents = s.subagents && s.subagents.length > 0;
    const showSubagents = hasSubagents && (s.status === 'running' || s.status === 'waiting' || isFocused);
    if (showSubagents && s.subagents) {
      const waitingAgents = s.subagents.filter(a => a.waitingOnPermission);
      const runningOnly = s.subagents.filter(a => a.running && !a.waitingOnPermission);
      const doneAgents = s.subagents.filter(a => !a.running);
      const doneCount = doneAgents.length;
      const activeAgents = waitingAgents.concat(runningOnly); // always shown individually

      const COMPACT_THRESHOLD = 5;
      const EXPAND_CAP = 20; // max done items shown even when expanded
      const shouldCompact = s.subagents.length > COMPACT_THRESHOLD;
      const isExpanded = shouldCompact && expandedSessions.has(s.sessionId);

      subagentHtml = '<div class="subagent-section">';

      // Always show active (waiting + running) agents individually
      for (const agent of activeAgents) {
        subagentHtml += renderSubagentItem(agent, now);
      }

      // Done agents: show individually only when focused+expanded (capped)
      if (isFocused && isExpanded && doneCount > 0) {
        const visible = doneAgents.slice(0, EXPAND_CAP);
        for (const agent of visible) {
          subagentHtml += renderSubagentItem(agent, now);
        }
        if (doneCount > EXPAND_CAP) {
          subagentHtml += '<div class="subagent-overflow">and ' + (doneCount - EXPAND_CAP) + ' more done</div>';
        }
      } else if (!shouldCompact && isFocused) {
        // Small list (<= threshold): show all done too
        for (const agent of doneAgents) {
          subagentHtml += renderSubagentItem(agent, now);
        }
      }

      // Summary line
      const summaryParts: string[] = [];
      if (waitingAgents.length > 0) summaryParts.push('<span class="waiting-count">' + waitingAgents.length + ' waiting</span>');
      if (runningOnly.length > 0) summaryParts.push('<span class="running-count">' + runningOnly.length + ' running</span>');
      if (doneCount > 0) summaryParts.push('<span>' + doneCount + ' done</span>');
      subagentHtml += '<div class="subagent-summary">'
        + s.subagents.length + ' subagent' + (s.subagents.length > 1 ? 's' : '') + ': ' + summaryParts.join(', ');
      if (shouldCompact && isFocused && doneCount > 0) {
        subagentHtml += ' <span class="subagent-toggle" data-toggle-session="' + escapeHtml(s.sessionId) + '">'
          + (isExpanded ? '▾ collapse' : '▸ show done') + '</span>';
      }
      subagentHtml += '</div>';
      subagentHtml += '</div>';
    }

    const isLive = s.status === 'running' || s.status === 'waiting';
    const dismissTitle = isLive
      ? 'Archive (use if status is stuck or hook hasn’t fired)'
      : 'Dismiss';
    let actionsHtml = '<div class="card-actions">';
    actionsHtml += '<button class="action-btn transcript-btn" data-transcript-id="' + escapeHtml(s.sessionId) + '" title="View transcript" aria-label="View transcript">&#x1f4dc;</button>';
    actionsHtml += '<button class="action-btn dismiss-btn' + (isLive ? ' dismiss-btn-force' : '') + '" data-dismiss-id="' + escapeHtml(s.sessionId) + '" title="' + escapeHtml(dismissTitle) + '" aria-label="Archive session">&times;</button>';
    actionsHtml += '</div>';

    let metaHtml = '<div class="card-meta">';
    metaHtml += '<span class="session-id-pill clickable" data-copy-id="' + escapeHtml(s.sessionId) + '" title="Copy session ID">' + escapeHtml(s.sessionId.slice(0, 8)) + '</span>';
    if (s.modelLabel) {
      const modelCls = 'model-pill' + (s.modelLabel === 'Sonnet' ? ' sonnet' : s.modelLabel === 'Haiku' ? ' haiku' : '');
      metaHtml += '<span class="' + modelCls + '">' + escapeHtml(s.modelLabel) + '</span>';
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

    const activityText = stripMarkdown(s.activity || 'No recent activity');
    const detailHtml = '<div class="card-detail">' + escapeHtml(activityText) + '</div>';

    const foreignPill = foreign ? '<span class="foreign-pill" title="From another workspace — view only">view only</span>' : '';

    return '<div class="card-top">'
      + '<span class="card-name">' + escapeHtml(displayName) + '</span>'
      + foreignPill
      + '<span class="status-pill">' + statusLabel + '</span>'
      + '</div>'
      + metaHtml
      + detailHtml
      + subagentHtml
      + contextBarHtml;
  }

  /** Render a single foreign workspace row (shared by grouped and ungrouped rendering). */
  function renderWsRow(ws: WorkspaceGroup): string {
    const running = ws.counts['running'] || 0;
    const waiting = ws.counts['waiting'] || 0;
    const done = ws.counts['done'] || 0;
    const rowClass = 'ws-row' + (waiting > 0 ? ' ws-row-waiting' : '') + (ws.cwd ? ' ws-row-clickable' : '');
    let countsHtml = '';
    if (waiting) countsHtml += '<span class="status-count waiting-count">' + waiting + 'W</span>';
    if (running) countsHtml += '<span class="status-count running-count">' + running + 'R</span>';
    if (done) countsHtml += '<span class="status-count done-count">' + done + 'D</span>';
    const hasLiveSessions = running > 0 || waiting > 0;
    const cwdAttr = ws.cwd ? ' data-cwd="' + escapeHtml(ws.cwd) + '" tabindex="0" role="button" title="Open workspace in VS Code"' : '';
    return '<div class="' + rowClass + '"'
      + (hasLiveSessions ? ' data-confidence="' + (ws.confidence || 'medium') + '"' : '')
      + cwdAttr + '>'
      + '<span class="ws-name">' + escapeHtml(ws.displayName) + '</span>'
      + '<div class="ws-counts">' + countsHtml + '</div>'
      + '</div>';
  }

  /** Abbreviate a path by replacing $HOME with ~. */
  function tildeAbbrev(p: string): string {
    const home = typeof process !== 'undefined' && process.env?.HOME;
    if (home && p.startsWith(home)) { return '~' + p.slice(home.length); }
    return p;
  }

  /** Group foreign workspaces by common parent directory. */
  function renderForeignWorkspaceRows(workspaces: WorkspaceGroup[]): string {
    let html = '<div class="ws-section-header">Other workspaces</div>';

    // Derive parent directory from cwd for each workspace
    const byParent = new Map<string, WorkspaceGroup[]>();
    const noParent: WorkspaceGroup[] = [];

    for (const ws of workspaces) {
      if (ws.cwd) {
        const trimmed = ws.cwd.endsWith('/') ? ws.cwd.slice(0, -1) : ws.cwd;
        const parent = trimmed.slice(0, trimmed.lastIndexOf('/'));
        if (parent) {
          let list = byParent.get(parent);
          if (!list) { list = []; byParent.set(parent, list); }
          list.push(ws);
          continue;
        }
      }
      noParent.push(ws);
    }

    // Partition into groups (2+ siblings) and singletons
    const groups: { parentPath: string; workspaces: WorkspaceGroup[]; hasActive: boolean }[] = [];
    const singletons: WorkspaceGroup[] = [...noParent];

    for (const [parent, wsList] of byParent) {
      if (wsList.length >= 2) {
        const hasActive = wsList.some(w => (w.counts['running'] || 0) > 0 || (w.counts['waiting'] || 0) > 0);
        wsList.sort((a, b) => a.displayName.localeCompare(b.displayName));
        groups.push({ parentPath: parent, workspaces: wsList, hasActive });
      } else {
        singletons.push(...wsList);
      }
    }

    // Sort groups: active first, then alphabetically by parent path
    groups.sort((a, b) => {
      if (a.hasActive !== b.hasActive) { return a.hasActive ? -1 : 1; }
      return a.parentPath.localeCompare(b.parentPath);
    });

    // Sort singletons alphabetically
    singletons.sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Render grouped workspaces
    for (const group of groups) {
      html += '<div class="ws-group-header">' + escapeHtml(tildeAbbrev(group.parentPath) + '/') + '</div>';
      for (const ws of group.workspaces) {
        html += renderWsRow(ws);
      }
    }

    // Render singletons (no group header)
    for (const ws of singletons) {
      html += renderWsRow(ws);
    }

    return html;
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
      return;
    }

    const fromHeight = container.getBoundingClientRect().height;
    const reduceMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (newHtml === '') {
      if (fromHeight > 0 && !reduceMotion) {
        cancelForeignSlide(container);
        runForeignSlide(container, fromHeight, 0, () => { container.innerHTML = ''; });
      } else {
        cancelForeignSlide(container);
        container.innerHTML = '';
        clearForeignSlideStyles(container);
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
      return;
    }

    // Set changed — pin to current height before swapping content so the new rows
    // don't flash at their natural height before the slide starts.
    cancelForeignSlide(container);
    container.style.height = fromHeight + 'px';
    container.style.overflow = 'hidden';
    container.style.transition = 'none';
    container.innerHTML = newHtml;
    const toHeight = container.scrollHeight;
    if (Math.abs(toHeight - fromHeight) < 1.5) {
      clearForeignSlideStyles(container);
    } else {
      runForeignSlide(container, fromHeight, toHeight);
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
    const foreign = isForeignSession(s, workspaceKey);

    return '<div class="compact-row" role="listitem" tabindex="0" data-session-id="' + escapeHtml(s.sessionId) + '" data-foreign="' + (foreign ? 'true' : 'false') + '">'
      + '<span class="compact-name">' + escapeHtml(displayName) + '</span>'
      + (foreign ? '<span class="foreign-pill compact-foreign">view only</span>' : '')
      + '<span class="compact-transcript" data-transcript-id="' + escapeHtml(s.sessionId) + '" title="View transcript">&#x1f4dc;</span>'
      + '<span class="compact-age">' + age + '</span>'
      + '</div>';
  }

  // ===== FOREIGN WAITING SECTION =====
  /** Render foreign workspace sessions that need user input. Sits at the very top
   *  of the panel (above teams + local cards) because waiting on input elsewhere
   *  is the most attention-worthy state we can surface. Click → open that window. */
  function renderForeignWaitingSection(scrollWrap: HTMLElement, now: number): void {
    let section = scrollWrap.querySelector('.foreign-waiting-section') as HTMLElement | null;
    const items = lastForeignWaiting.filter(s => !!s.cwd);

    if (items.length === 0) {
      if (section) section.remove();
      return;
    }

    if (!section) {
      section = document.createElement('div');
      section.className = 'foreign-waiting-section';
      // Ensure it lands above .team-section / .card-section
      scrollWrap.insertBefore(section, scrollWrap.firstChild);
    }

    let html = '<div class="foreign-waiting-header">Waiting in other workspaces</div>';
    for (const s of items) {
      html += renderForeignWaitingCard(s, now);
    }
    section.innerHTML = html;
  }

  function renderForeignWaitingCard(s: PanelSession, now: number): string {
    const displayName = stripMarkdown(getDisplayName(s));
    const cwd = s.cwd || '';
    const wsLabel = workspaceLabelFromCwd(cwd) || s.workspaceKey || '';
    const ageLabel = formatAge(now - s.lastActivity);

    return '<div class="card waiting foreign foreign-waiting"'
      + ' data-session-id="' + escapeHtml(s.sessionId) + '"'
      + ' data-cwd="' + escapeHtml(cwd) + '"'
      + ' role="button" tabindex="0"'
      + ' aria-label="' + escapeHtml(displayName) + ' — waiting in ' + escapeHtml(wsLabel) + ' (click to switch window)">'
      + '<div class="card-top">'
      + '<span class="card-name">' + escapeHtml(displayName) + '</span>'
      + '<span class="status-pill">Waiting</span>'
      + '</div>'
      + '<div class="foreign-waiting-meta">'
      + '<span class="foreign-waiting-ws">' + escapeHtml(wsLabel) + '</span>'
      + '<span class="foreign-waiting-age">' + ageLabel + '</span>'
      + '</div>'
      + '</div>';
  }

  // ===== FOREIGN RUNNING SECTION =====
  /** Render foreign workspace sessions that are currently running. Sits between
   *  local cards and the archive — single-line rows so the strip stays compact
   *  even at narrow panel widths. Click → open that window. */
  function renderForeignRunningSection(scrollWrap: HTMLElement, anchor: HTMLElement, now: number): void {
    let section = scrollWrap.querySelector('.foreign-running-section') as HTMLElement | null;
    const items = lastForeignRunning.filter(s => !!s.cwd);

    if (items.length === 0) {
      if (section) section.remove();
      return;
    }

    if (!section) {
      section = document.createElement('div');
      section.className = 'foreign-running-section';
    }
    if (section.previousElementSibling !== anchor) {
      anchor.after(section);
    }

    let html = '<div class="foreign-running-header">Running in other workspaces</div>';
    for (const s of items) {
      html += renderForeignRunningRow(s, now);
    }
    section.innerHTML = html;
  }

  function renderForeignRunningRow(s: PanelSession, _now: number): string {
    const displayName = stripMarkdown(getDisplayName(s));
    const cwd = s.cwd || '';
    const wsLabel = workspaceLabelFromCwd(cwd) || s.workspaceKey || '';

    return '<div class="foreign-running-row"'
      + ' data-session-id="' + escapeHtml(s.sessionId) + '"'
      + ' data-cwd="' + escapeHtml(cwd) + '"'
      + ' role="button" tabindex="0"'
      + ' aria-label="' + escapeHtml(displayName) + ' — running in ' + escapeHtml(wsLabel) + ' (click to switch window)">'
      + '<span class="foreign-running-name">' + escapeHtml(displayName) + '</span>'
      + '<span class="foreign-running-ws">' + escapeHtml(wsLabel) + '</span>'
      + '</div>';
  }

  /** Strip the trailing folder name from a cwd for display. */
  function workspaceLabelFromCwd(cwd: string): string {
    const trimmed = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
    const folder = trimmed.split('/').pop();
    return folder || trimmed;
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

      html += '<div class="team-agent-summary" data-toggle-team="' + escapeHtml(team.teamId) + '">'
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
    if (agent.subagents && agent.subagents.length > 0) {
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
      const sessionCls = quotaClass(u.quotaPct5h || 0, sessionTickPct);
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
      const weeklyCls = quotaClass(u.quotaPctWeekly || 0, weeklyTickPct);

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
