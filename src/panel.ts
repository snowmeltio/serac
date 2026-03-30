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
  counts: Record<string, number>;
  confidence?: string;
}

/** Compact settings shape (mirrors CompactSettings from claudeSettings.ts,
 *  redefined here because the webview bundle cannot import extension-side modules). */
interface PanelCompactSettings { autoCompactWindow: number; autoCompactPct: number }

interface UpdateMessage {
  type: 'update';
  sessions: PanelSession[];
  waitingCount: number;
  workspacePath: string;
  usage?: UsageData;
  foreignWorkspaces?: WorkspaceGroup[];
  compactSettings?: PanelCompactSettings;
}

interface FocusMessage {
  type: 'focusSession';
  sessionId: string;
}

type WebviewIncomingMessage = UpdateMessage | FocusMessage;

const TRANSITION_MS = 300;
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
  let compactSettings: PanelCompactSettings | null = null;

  // Status debounce: tracks when each session entered waiting
  const needsInputSince: Record<string, number> = {};

  // Subagent list expansion state (persisted via vscode setState)
  const expandedSessions = new Set<string>(
    (savedState && Array.isArray(savedState.expandedSessions)) ? savedState.expandedSessions as string[] : []
  );

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
      vscode.setState({ archiveRange, expandedSessions: Array.from(expandedSessions) });
      if (lastSessions) render(lastSessions, lastNeedsInputCount, workspacePath);
      return;
    }

    // New chat button
    if (target.closest('#newChatBtn')) {
      vscode.postMessage({ type: 'newChat' });
      return;
    }

    // Cleanup button — confirm dialog replaces hover-to-arm
    if (target.closest('#cleanupBtn')) {
      const btn = target.closest<HTMLElement>('#cleanupBtn');
      if (btn && !btn.classList.contains('confirming')) {
        btn.classList.add('confirming');
        btn.textContent = 'Confirm?';
        const resetTimer = setTimeout(() => {
          btn.classList.remove('confirming');
          btn.textContent = 'Cleanup';
        }, 3000);
        btn.dataset.resetTimer = String(resetTimer);
      } else if (btn && btn.classList.contains('confirming')) {
        if (btn.dataset.resetTimer) clearTimeout(Number(btn.dataset.resetTimer));
        btn.classList.remove('confirming');
        btn.textContent = 'Cleanup';
        vscode.postMessage({ type: 'cleanup' });
      }
      return;
    }

    // Archive row click (undismiss)
    const archiveRow = target.closest<HTMLElement>('.compact-row[data-session-id]');
    if (archiveRow) {
      vscode.postMessage({ type: 'undismissSession', sessionId: archiveRow.dataset.sessionId });
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
    }
  });

  window.addEventListener('message', (event: MessageEvent<WebviewIncomingMessage>) => {
    try {
      const message = event.data;
      if (message.type === 'update') {
        lastUsage = message.usage || null;
        lastForeignWorkspaces = message.foreignWorkspaces ?? [];
        compactSettings = message.compactSettings ?? null;
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
    vscode.setState({ archiveRange: range, expandedSessions: Array.from(expandedSessions) });
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
      topBar.innerHTML = '<div class="top-bar-main"><div class="status-summary" aria-live="polite"></div>'
        + '<div class="top-bar-actions">'
        + '<button class="top-bar-btn cleanup-btn" id="cleanupBtn" title="Close all Claude Code tabs except one (hover 2s to arm)">Cleanup</button>'
        + '<button class="top-bar-btn new-chat-btn" id="newChatBtn">+ New</button>'
        + '</div></div>';
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

    // === Card section ===
    let cardSection = scrollWrap.querySelector('.card-section') as HTMLElement | null;
    if (!cardSection) {
      cardSection = document.createElement('div');
      cardSection.className = 'card-section';
      cardSection.setAttribute('role', 'list');
      cardSection.setAttribute('aria-label', 'Agent sessions');
      scrollWrap.appendChild(cardSection);
    }

    if (cards.length === 0 && archived.length === 0) {
      cardSection.innerHTML = '<div class="empty-state"><div class="icon">\u2298</div><div>No Claude Code sessions detected.</div><div class="hint">Sessions appear when you start Claude Code.</div></div>';
    } else {
      reconcileCards(cardSection, cards, now);
    }

    // === Archive section ===
    renderArchiveSection(archived, now, cardSection);

    // === Time-range bar ===
    renderTimeRangeBar(archived.length > 0);

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
      if (lastForeignWorkspaces.length > 0) {
        let rowsHtml = '<div class="ws-section-header">Other workspaces</div>';
        for (let i = 0; i < lastForeignWorkspaces.length; i++) {
          const ws = lastForeignWorkspaces[i];
          const running = ws.counts['running'] || 0;
          const waiting = ws.counts['waiting'] || 0;
          const done = ws.counts['done'] || 0;
          const wsStatus = waiting > 0 ? 'waiting' : running > 0 ? 'running' : done > 0 ? 'done' : 'idle';
          const rowClass = 'ws-row' + (waiting > 0 ? ' ws-row-waiting' : '');
          let countsHtml = '';
          if (waiting) countsHtml += '<span class="status-count waiting-count">' + waiting + 'W</span>';
          if (running) countsHtml += '<span class="status-count running-count">' + running + 'R</span>';
          if (done) countsHtml += '<span class="status-count done-count">' + done + 'D</span>';
          const hasLiveSessions = running > 0 || waiting > 0;
          rowsHtml += '<div class="' + rowClass + '"' + (hasLiveSessions ? ' data-confidence="' + (ws.confidence || 'medium') + '"' : '') + '>'
            + '<span class="ws-status-dot ws-dot-' + wsStatus + '"></span>'
            + '<span class="ws-name">' + escapeHtml(ws.displayName) + '</span>'
            + '<div class="ws-counts">' + countsHtml + '</div>'
            + '</div>';
        }
        foreignContainer.innerHTML = rowsHtml;
      } else {
        foreignContainer.innerHTML = '';
      }
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
  function renderArchiveSection(archived: PanelSession[], now: number, afterElement: HTMLElement): void {
    const scrollWrap = root.querySelector('.card-archive-scroll');
    let existingList = (scrollWrap || root).querySelector('.archive-list') as HTMLElement | null;

    if (archived.length === 0) {
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

    const canDismiss = s.status === 'done' || s.status === 'stale';
    let actionsHtml = '<div class="card-actions">';
    actionsHtml += '<button class="action-btn transcript-btn" data-transcript-id="' + escapeHtml(s.sessionId) + '" title="View transcript" aria-label="View transcript">&#x1f4dc;</button>';
    if (canDismiss) {
      actionsHtml += '<button class="action-btn dismiss-btn" data-dismiss-id="' + escapeHtml(s.sessionId) + '" title="Dismiss" aria-label="Dismiss session">&times;</button>';
    }
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

  // ===== USAGE SECTION RENDERER =====
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
        const overLabel = u.extraUsageEnabled ? 'EXTRA USAGE' : 'RATE LIMITED';
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

    // Updated-ago footer
    if (u.lastPoll) {
      const stateClass = u.apiConnected ? 'connected' : 'cached';
      const stateLabel = u.apiConnected ? '' : ' <span class="cached-tag">(cached)</span>';
      html += '<div class="usage-updated"><span class="api-dot ' + stateClass + '" title="API ' + stateClass + '"></span>Updated ' + formatAgeCoarse(Date.now() - u.lastPoll) + ' ago' + stateLabel + '</div>';
    }

    section.innerHTML = html;
  }

  // Request initial data
  vscode.postMessage({ type: 'requestUpdate' });
})();
