/**
 * Manages discovery and polling of foreign (non-current) workspace sessions.
 *
 * Extracted from SessionDiscovery to separate cross-workspace monitoring
 * from local session management. A workspace appears in the panel as soon as
 * it has any tracked JSONL file within the age gate; counts (running/waiting/
 * done) are aggregated for display but a workspace with all-idle sessions is
 * still listed (with empty counts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import type { SessionSnapshot, StatusConfidence, WorkspaceGroup } from './types.js';
import type { Logger } from './sessionDiscovery.js';

/** Age gate for foreign workspace tracking */
const FOREIGN_AGE_GATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Full rescan every Nth poll cycle */
const FOREIGN_SCAN_INTERVAL = 10;
/** Confidence ranking for max-confidence aggregation */
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export class ForeignWorkspaceManager {
  private sessions: Map<string, SessionManager> = new Map();
  private cwdCache: Map<string, string> = new Map();
  private scanCounter = 0;

  constructor(
    private readonly projectsDir: string,
    private readonly localWorkspaceKey: string,
    private readonly log: Logger,
  ) {}

  /** Whether it's time for a full rescan (every Nth poll cycle). */
  shouldRescan(): boolean {
    this.scanCounter++;
    if (this.scanCounter >= FOREIGN_SCAN_INTERVAL) {
      this.scanCounter = 0;
      return true;
    }
    return false;
  }

  /** Scan all workspace directories for foreign sessions within the age gate. */
  async scan(): Promise<void> {
    const now = Date.now();
    try {
      const dirs = await fs.promises.readdir(this.projectsDir);
      for (const dir of dirs) {
        if (dir === this.localWorkspaceKey) { continue; }
        const wsPath = path.join(this.projectsDir, dir);
        try {
          const stat = await fs.promises.stat(wsPath);
          if (!stat.isDirectory()) { continue; }
        } catch { continue; }
        try {
          const files = await fs.promises.readdir(wsPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) { continue; }
            const sessionId = file.replace('.jsonl', '');
            const compositeId = `${dir}/${sessionId}`;
            if (this.sessions.has(compositeId)) { continue; }

            const filePath = path.join(wsPath, file);
            try {
              const fstat = await fs.promises.stat(filePath);
              if (now - fstat.mtimeMs > FOREIGN_AGE_GATE_MS) { continue; }
            } catch { continue; }

            const manager = new SessionManager(sessionId, filePath, dir);
            try {
              await manager.update();
            } catch (err) {
              this.log.warn(`Foreign session update failed (${compositeId}):`, err);
            }
            // Drop sessions whose meaningful activity (user/assistant turns) is past
            // the gate even though mtime is recent. Claude Code backfills `ai-title`
            // records to old sessions, bumping mtime without indicating real
            // activity — without this check, scan() keeps re-adding what poll()
            // evicts, causing the workspace to flicker.
            if (now - manager.getLastActivity().getTime() > FOREIGN_AGE_GATE_MS) {
              manager.dispose();
              continue;
            }
            this.sessions.set(compositeId, manager);
          }
        } catch { /* unreadable directory */ }
      }
      // Cache cwd per workspace key (stable display names)
      for (const session of this.sessions.values()) {
        const snapshot = session.getSnapshot();
        if (snapshot.cwd && !this.cwdCache.has(snapshot.workspaceKey)) {
          this.cwdCache.set(snapshot.workspaceKey, snapshot.cwd);
        }
      }
    } catch { /* projectsDir doesn't exist */ }
  }

  /** Poll active foreign sessions. Evicts entries past the age gate. */
  async poll(): Promise<boolean> {
    let changed = false;
    const now = Date.now();

    for (const [compositeId, session] of this.sessions) {
      const status = session.getStatus();
      if (status !== 'running' && status !== 'waiting') {
        if (now - session.getLastActivity().getTime() > FOREIGN_AGE_GATE_MS) {
          session.dispose();
          this.sessions.delete(compositeId);
          changed = true;
          continue;
        }
        try {
          const mtimeChanged = await session.checkMtime();
          if (mtimeChanged) {
            const hadData = await session.update();
            if (hadData) { changed = true; }
          }
        } catch { /* skip */ }
        continue;
      }
      try {
        const hadData = await session.update();
        if (hadData) { changed = true; }
        if (!hadData && session.demoteIfStale(30_000)) {
          changed = true;
        }
      } catch { /* skip */ }
    }
    return changed;
  }

  /** Get foreign workspace summaries for the panel.
   *  Every workspace with at least one tracked session is included. Counts
   *  (running/waiting/done) are aggregated for display; workspaces with no
   *  active sessions render with empty counts. */
  getWorkspaces(): WorkspaceGroup[] {
    const groups = new Map<string, Record<string, number>>();
    const confidences = new Map<string, StatusConfidence>();

    for (const session of this.sessions.values()) {
      const snapshot = session.getSnapshot();
      let counts = groups.get(snapshot.workspaceKey);
      if (!counts) {
        counts = {};
        groups.set(snapshot.workspaceKey, counts);
      }
      counts[snapshot.status] = (counts[snapshot.status] || 0) + 1;

      const capped: StatusConfidence = snapshot.confidence === 'high' ? 'medium' : snapshot.confidence;
      const existing = confidences.get(snapshot.workspaceKey) ?? 'low';
      if ((CONFIDENCE_RANK[capped] ?? 0) > (CONFIDENCE_RANK[existing] ?? 0)) {
        confidences.set(snapshot.workspaceKey, capped);
      }
    }

    const result: WorkspaceGroup[] = [];
    for (const [key, counts] of groups) {
      result.push({
        workspaceKey: key,
        displayName: ForeignWorkspaceManager.workspaceDisplayName(key, this.cwdCache.get(key)),
        cwd: this.cwdCache.get(key) ?? null,
        counts,
        confidence: confidences.get(key) ?? 'low',
      });
    }
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return result;
  }

  /** Get a CWD for a workspace key — uses the cached cwd from any session in that workspace. */
  getCwdForWorkspace(workspaceKey: string): string | null {
    return this.cwdCache.get(workspaceKey) ?? null;
  }

  /** Foreign sessions currently waiting on user input. cwd is filled from cwdCache
   *  when the session itself doesn't carry one (older JSONL records). */
  getWaitingSnapshots(): SessionSnapshot[] {
    const result: SessionSnapshot[] = [];
    for (const session of this.sessions.values()) {
      if (session.getStatus() !== 'waiting') { continue; }
      const snapshot = session.getSnapshot();
      if (!snapshot.cwd) {
        const cached = this.cwdCache.get(snapshot.workspaceKey);
        if (cached) { snapshot.cwd = cached; }
      }
      result.push(snapshot);
    }
    // Newest waiting first so the most recent prompt sits at the top
    result.sort((a, b) => b.lastActivity - a.lastActivity);
    return result;
  }

  /** Dispose all foreign sessions and clear state. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.cwdCache.clear();
  }

  /** Derive a human-readable name from a workspace CWD or sanitised key. */
  private static workspaceDisplayName(key: string, cwd?: string): string {
    if (cwd) {
      const trimmed = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
      const folderName = trimmed.split('/').pop();
      if (folderName) { return folderName; }
    }
    const segments = key.split('-').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^\d{4}$/.test(segments[i]) && i + 1 < segments.length && /^\d{2}$/.test(segments[i + 1])) {
        return segments.slice(i).join('-');
      }
    }
    return segments.slice(-3).join('-') || key;
  }
}
