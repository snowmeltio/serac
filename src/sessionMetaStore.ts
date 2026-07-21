/**
 * SessionMetaStore — owns the `session-meta.json` lifecycle for a workspace:
 * load (with legacy migration), external-change reload, dirty tracking, and
 * serialised atomic saves. Extracted from SessionDiscovery (audit 2026-07-21)
 * so the concurrency invariants live in one place:
 *
 *   [C1] `reloadIfChanged()` skips while dirty (an external read must never
 *        clobber unflushed in-memory mutations), and `save()` re-stats its own
 *        write so the next reload check doesn't re-read it. The dirty check is
 *        applied TWICE on the reload path — before the stat and again after
 *        the awaited read, so a mutation landing mid-read (e.g. a dismiss
 *        click during the file read) can never be reverted by the map swap.
 *   - Saves are atomic (unique tmp path + rename) and serialised through a
 *     promise queue, so overlapping fire-and-forget saves can neither clobber
 *     one tmp file nor interleave partial writes. A failed write unlinks its
 *     tmp file and leaves `dirty` set, so the next flush retries.
 *   [C2] `save()` snapshots the map and the mutation generation together; it
 *        only clears `dirty` when no mutation landed during its own awaits —
 *        a mid-save mutation keeps the flag for the next flush instead of
 *        being silently eaten.
 *   - Load distinguishes ENOENT (expected — attempt legacy migration) from a
 *     parse error (warn, preserve in-memory state).
 *
 * Mutation protocol (unchanged from the SessionDiscovery days): callers
 * mutate the returned SessionMeta object directly, then call `markDirty()`
 * (+ `enqueueSave()` for user-action paths that must persist immediately;
 * poll-cycle paths rely on the end-of-cycle `flush()`).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionMeta, SessionMetaFile } from './types.js';
import type { Logger } from './sessionDiscovery.js';

export interface SessionMetaStore {
  /** Load from disk. ENOENT → legacy migration; corrupt → preserve memory. */
  load(): Promise<void>;
  /** Reload only if the file changed externally since the last read [H2].
   *  No-op while dirty [C1]. */
  reloadIfChanged(): Promise<void>;
  /** Flush pending changes if dirty, through the serialising queue. */
  flush(): Promise<void>;
  /** Enqueue a fire-and-forget save (serialised; never concurrent). */
  enqueueSave(): void;
  /** Mark the in-memory state as ahead of disk. */
  markDirty(): void;
  isDirty(): boolean;
  get(id: string): SessionMeta | undefined;
  getOrCreate(id: string): SessionMeta;
  has(id: string): boolean;
  /** Delete an entry. Marks dirty when the entry existed. */
  delete(id: string): boolean;
  /** Snapshot of entries for iteration (safe to delete() while walking). */
  entries(): Array<[string, SessionMeta]>;
  /** The live backing map — for consumers that take Map<string, SessionMeta>
   *  (team/workflow snapshot builders). Read-only by convention. */
  asMap(): Map<string, SessionMeta>;
}

class FileSessionMetaStore implements SessionMetaStore {
  private sessionMeta: Map<string, SessionMeta> = new Map();
  private dirty = false;
  /** Last known mtime of session-meta.json (ms). 0 = never loaded. */
  private lastMtime = 0;
  /** Serialises fire-and-forget save() calls to prevent concurrent write races */
  private saveQueue: Promise<void> = Promise.resolve();
  /** Monotonic counter making each save's tmp path unique, so two overlapping
   *  save() writes can never share (and clobber) one tmp file. */
  private saveSeq = 0;
  /** Mutation generation [C2]: bumped by markDirty()/delete(). save() clears
   *  `dirty` only if the generation is unchanged since its snapshot. */
  private mutationSeq = 0;
  /** Consecutive failed saves — visibility for the dirty-forever state, where
   *  an unwritable disk pins `dirty` and [C1] pauses external reloads. */
  private saveFailures = 0;

  constructor(
    private readonly metaFilePath: string,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    await this.loadInner(false);
  }

  /** `abortIfDirty` is the reload path's post-read [C1] re-check: the initial
   *  load must always commit (disk is authoritative at startup), but a RELOAD
   *  whose awaited read overlapped a mutation must abandon the map swap — the
   *  memory state is now ahead, and committing would silently revert a user
   *  action (e.g. a dismiss clicked while the file was being read). The
   *  abandoned external change is then overwritten by the pending save:
   *  ordinary last-writer-wins between windows, with the user action intact. */
  private async loadInner(abortIfDirty: boolean): Promise<void> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.metaFilePath, 'utf-8');
    } catch {
      if (abortIfDirty && this.dirty) { return; }
      // File doesn't exist — try legacy migration
      this.sessionMeta = new Map();
      await this.migrateFromLegacy();
      return;
    }

    try {
      const file: SessionMetaFile = JSON.parse(content);
      if (abortIfDirty && this.dirty) { return; }
      this.sessionMeta = new Map(Object.entries(file.sessions));
      try {
        const stat = await fs.promises.stat(this.metaFilePath);
        this.lastMtime = stat.mtimeMs;
      } catch { /* stat failed; leave mtime as-is */ }
    } catch (err) {
      // File exists but is corrupted — warn and preserve existing in-memory state
      this.log.warn('session-meta.json is corrupted, preserving in-memory state:', err);
      if (this.sessionMeta.size === 0) {
        // No in-memory state to preserve — try legacy migration as fallback
        await this.migrateFromLegacy();
      }
    }
  }

  async reloadIfChanged(): Promise<void> {
    // Skip reload when we have unflushed in-memory mutations [C1]
    if (this.dirty) { return; }
    try {
      const stat = await fs.promises.stat(this.metaFilePath);
      if (stat.mtimeMs > this.lastMtime) {
        await this.loadInner(true);
      }
    } catch {
      // File doesn't exist — nothing to reload
    }
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.metaFilePath);
    try {
      await fs.promises.access(dir);
    } catch {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    // Snapshot the map and the mutation generation TOGETHER [C2]: any
    // markDirty()/delete() landing during the awaits below bumps the
    // generation, and this save then must NOT clear the flag — the next
    // flush persists what this snapshot missed.
    const seqAtSnapshot = this.mutationSeq;
    const file: SessionMetaFile = {
      sessions: Object.fromEntries(this.sessionMeta),
    };
    const tmpPath = `${this.metaFilePath}.${process.pid}.${++this.saveSeq}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
      await fs.promises.rename(tmpPath, this.metaFilePath);
    } catch (err) {
      // Don't leave the tmp file orphaned beside the real one.
      void fs.promises.unlink(tmpPath).catch(() => { /* already gone */ });
      throw err;
    }
    // Update mtime so reloadIfChanged() won't re-read our own write [C1]
    try {
      const stat = await fs.promises.stat(this.metaFilePath);
      this.lastMtime = stat.mtimeMs;
    } catch { /* stat failed */ }
    if (this.mutationSeq === seqAtSnapshot) {
      this.dirty = false;
    }
    this.saveFailures = 0;
  }

  async flush(): Promise<void> {
    if (this.dirty) {
      this.enqueueSave();
      await this.saveQueue;
    }
  }

  enqueueSave(): void {
    this.saveQueue = this.saveQueue
      .then(() => this.save())
      .catch((err) => {
        this.saveFailures++;
        this.log.error(`saveMeta failed (${this.saveFailures} consecutive):`, err);
        if (this.saveFailures >= 3) {
          // The dirty flag stays set (correct — memory is ahead of disk), but
          // that also pauses external-change reloads [C1]. Say so, once the
          // failure looks persistent, instead of failing silently forever.
          this.log.warn('session-meta.json cannot be written; external-change reloads stay paused until a save succeeds.');
        }
      });
  }

  /** One-time migration from legacy dismissed-sessions + acknowledged-sessions files */
  private async migrateFromLegacy(): Promise<void> {
    const claudeDir = path.dirname(this.metaFilePath);
    const dismissedPath = path.join(claudeDir, 'dismissed-sessions');
    const acknowledgedPath = path.join(claudeDir, 'acknowledged-sessions');
    let migrated = false;

    // Read legacy dismissed
    try {
      const content = await fs.promises.readFile(dismissedPath, 'utf-8');
      const ids = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const id of ids) {
        const meta = this.getOrCreate(id);
        meta.dismissed = true;
        migrated = true;
      }
    } catch { /* no legacy file */ }

    // Read legacy acknowledged
    try {
      const content = await fs.promises.readFile(acknowledgedPath, 'utf-8');
      const ids = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const id of ids) {
        const meta = this.getOrCreate(id);
        meta.acknowledged = true;
        // Timestamp 0 = immediately stale on reload (same as old behaviour)
        meta.acknowledgedAt = 0;
        migrated = true;
      }
    } catch { /* no legacy file */ }

    if (migrated) {
      await this.save();
    }
  }

  markDirty(): void {
    this.dirty = true;
    this.mutationSeq++;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  get(id: string): SessionMeta | undefined {
    return this.sessionMeta.get(id);
  }

  getOrCreate(id: string): SessionMeta {
    let meta = this.sessionMeta.get(id);
    if (!meta) {
      meta = {
        title: null,
        dismissed: false,
        acknowledged: false,
        acknowledgedAt: null,
        firstSeen: Date.now(),
      };
      this.sessionMeta.set(id, meta);
    }
    return meta;
  }

  has(id: string): boolean {
    return this.sessionMeta.has(id);
  }

  delete(id: string): boolean {
    const existed = this.sessionMeta.delete(id);
    if (existed) {
      this.dirty = true;
      this.mutationSeq++;
    }
    return existed;
  }

  entries(): Array<[string, SessionMeta]> {
    return Array.from(this.sessionMeta);
  }

  asMap(): Map<string, SessionMeta> {
    return this.sessionMeta;
  }
}

/** Factory. One store per workspace's session-meta.json. */
export function makeSessionMetaStore(metaFilePath: string, log: Logger): SessionMetaStore {
  return new FileSessionMetaStore(metaFilePath, log);
}
