/**
 * Manages discovery and polling of foreign (non-current) workspace sessions.
 *
 * Extracted from SessionDiscovery to separate cross-workspace monitoring
 * from local session management. Owns all foreign state: sessions, meta,
 * cwd cache, scan counter.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './sessionManager.js';
import type { StatusConfidence, WorkspaceGroup } from './types.js';
import type { Logger } from './sessionDiscovery.js';

/** Age gate for foreign workspace scans: 14 days for slow-burn projects */
const FOREIGN_AGE_GATE_MS = 14 * 24 * 60 * 60 * 1000;
/** Full rescan every Nth poll cycle */
const FOREIGN_SCAN_INTERVAL = 10;
/** Confidence ranking for max-confidence aggregation */
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export class ForeignWorkspaceManager {
  private sessions: Map<string, SessionManager> = new Map();
  private meta: Map<string, Record<string, { dismissed?: boolean }>> = new Map();
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

  /** Scan all workspace directories for foreign sessions. */
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
            this.sessions.set(compositeId, manager);
            try {
              await manager.update();
            } catch (err) {
              this.log.warn(`Foreign session update failed (${compositeId}):`, err);
            }
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
      await this.loadMeta();
    } catch { /* projectsDir doesn't exist */ }
  }

  /** Load session-meta.json for foreign workspaces from local projects directory. */
  private async loadMeta(): Promise<void> {
    for (const wsKey of new Set([...this.sessions.values()].map(s => s.getSnapshot().workspaceKey))) {
      const metaPath = path.join(this.projectsDir, wsKey, 'session-meta.json');
      try {
        const content = await fs.promises.readFile(metaPath, 'utf-8');
        const parsed = JSON.parse(content);
        const sessions = parsed?.sessions ?? parsed;
        if (typeof sessions === 'object' && sessions !== null) {
          this.meta.set(wsKey, sessions);
          const entryCount = Object.keys(sessions).length;
          const dismissedCount = Object.values(sessions).filter((s: unknown) => (s as { dismissed?: boolean })?.dismissed).length;
          this.log.trace('[foreign] Loaded meta for %s: %d entries, %d dismissed', wsKey.slice(-40), entryCount, dismissedCount);
        }
      } catch (err) {
        this.log.trace('[foreign] No local meta for %s: %s', wsKey.slice(-40), String(err));
      }
    }
  }

  /** Poll active foreign sessions. Evicts stale entries beyond age gate. */
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

  /** Get foreign workspace summaries for the panel. */
  getWorkspaces(excludeSessionIds?: Set<string>): WorkspaceGroup[] {
    const groups = new Map<string, Record<string, number>>();
    const confidences = new Map<string, StatusConfidence>();

    for (const session of this.sessions.values()) {
      if (excludeSessionIds?.has(session.getSessionId())) { continue; }
      const snapshot = session.getSnapshot();
      const status = snapshot.status;
      if (status !== 'running' && status !== 'waiting' && status !== 'done') { continue; }

      const wsMeta = this.meta.get(snapshot.workspaceKey);
      if (wsMeta) {
        const sessionMeta = wsMeta[snapshot.sessionId];
        if (sessionMeta?.dismissed) { continue; }
      }

      let counts = groups.get(snapshot.workspaceKey);
      if (!counts) {
        counts = {};
        groups.set(snapshot.workspaceKey, counts);
      }
      counts[status] = (counts[status] || 0) + 1;

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
        counts,
        confidence: confidences.get(key) ?? 'low',
      });
    }
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return result;
  }

  /** Dispose all foreign sessions and clear state. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.meta.clear();
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
