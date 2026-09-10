/**
 * ReplayCache — a single JSON file shared by every window, profile, and
 * farmed account on this machine, letting a dormant `done` session's card
 * paint without replaying its JSONL from byte 0 (see the "Replay cache"
 * section of ARCHITECTURE.md).
 *
 * Split, same shape as sessionMetaStore.ts: pure functions for parsing,
 * eligibility, pruning, and merging (this file); a store class doing the I/O
 * (also this file, but exercised only through the pure functions in tests).
 * PR D locates the file beside the realpath'd `claudeProjectsDir()` and
 * wires `makeReplayCacheStore` into SessionDiscovery — this PR ships the
 * mechanism only ("merges dark").
 *
 * Concurrency: several windows/profiles/accounts share one file. `flush()`
 * RE-READS and merges before writing (unlike sessionMetaStore, which owns
 * its file alone) so a window's flush never clobbers another window's
 * entries written since this window last loaded.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CachedSessionState } from './types.js';
import type { Logger } from './sessionDiscovery.js';

/** Bump whenever CachedSessionState's shape or the status-machine semantics
 *  it captures change (per CLAUDE.md's "State machine changes" convention) —
 *  a version mismatch makes parseReplayCache() treat the whole file as
 *  absent rather than risk hydrating from a stale shape. */
export const REPLAY_CACHE_VERSION = 1;

/** A session must have been quiet (no lastActivity) for at least this long
 *  before it is eligible to be cached (exportCachedState) or hydrated from
 *  cache (isHydratable) — mirrors EXTERNAL_WRITER_QUIET_MS's 10-minute
 *  window; a session that only just went `done` gets no benefit from caching
 *  (it may well change again in seconds) and isn't worth the write. */
export const REPLAY_CACHE_QUIET_MS = 10 * 60 * 1000;

/** Cap on the number of entries kept in the cache file. Entries beyond the
 *  cap are pruned oldest-`cachedAt`-first — a low-priority eviction, since a
 *  dropped entry just becomes a cache miss (one full replay) next time. */
export const REPLAY_CACHE_MAX_ENTRIES = 1000;

/** Refuse to parse (or write) a cache file larger than this. Guards against
 *  a runaway/corrupt file being loaded wholesale into memory. */
export const REPLAY_CACHE_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Minimum interval between writes from one store instance (rate limit). */
const REPLAY_CACHE_MIN_FLUSH_INTERVAL_MS = 30_000;

/** Entries older than this (by `cachedAt`) are pruned regardless of any
 *  caller-supplied `maxAgeMs` — "the widest configured gate capped at 60 d"
 *  (plan). A caller may pass a tighter `maxAgeMs`; this is only the ceiling. */
const REPLAY_CACHE_HARD_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** One cached session's payload plus the disk stamp it was captured at and
 *  when it was written. Keyed by the session's absolute JSONL path in
 *  ReplayCacheFile.entries (paths are already realpath'd via
 *  claudeProjectsDir(), so the same transcript reached through a symlinked
 *  account alias still hits the same key). */
export interface ReplayCacheEntry {
  /** File size (bytes) at the moment the state was captured. */
  size: number;
  /** File mtime (ms since epoch) at the moment the state was captured. */
  mtimeMs: number;
  /** When this entry was written (ms since epoch) — used for pruning
   *  (age, over-cap eviction) and merge (newest wins). */
  cachedAt: number;
  state: CachedSessionState;
}

/** On-disk shape of the shared cache file. */
export interface ReplayCacheFile {
  version: number;
  entries: Record<string, ReplayCacheEntry>;
}

// ── Pure functions ──────────────────────────────────────────────────────

/** Lenient per-entry validation: reject a malformed individual entry without
 *  discarding the rest of the file (a torn write from another window, or a
 *  future field this version doesn't know about, must not nuke every other
 *  window's cached entries). */
function tryNormaliseEntry(value: unknown): ReplayCacheEntry | null {
  if (!value || typeof value !== 'object') { return null; }
  const v = value as Partial<ReplayCacheEntry>;
  if (typeof v.size !== 'number' || typeof v.mtimeMs !== 'number' || typeof v.cachedAt !== 'number') {
    return null;
  }
  const state = v.state as Partial<CachedSessionState> | undefined;
  if (!state || typeof state !== 'object') { return null; }
  if (typeof state.sessionId !== 'string' || typeof state.status !== 'string') { return null; }
  if (!Array.isArray(state.subagents)) { return null; }
  return { size: v.size, mtimeMs: v.mtimeMs, cachedAt: v.cachedAt, state: state as CachedSessionState };
}

/** Parse a cache file's raw contents into entries keyed by JSONL path. ANY
 *  failure — unreadable JSON, wrong/missing version, an oversized file, a
 *  malformed top-level shape — returns an empty map rather than throwing;
 *  the caller falls back to a full replay for everything, which is always
 *  correct (just slower), so there is no unsafe failure mode here. */
export function parseReplayCache(raw: string | null | undefined): Map<string, ReplayCacheEntry> {
  if (!raw) { return new Map(); }
  if (Buffer.byteLength(raw, 'utf-8') > REPLAY_CACHE_MAX_FILE_BYTES) { return new Map(); }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== 'object') { return new Map(); }
  const file = parsed as Partial<ReplayCacheFile>;
  if (file.version !== REPLAY_CACHE_VERSION) { return new Map(); }
  if (!file.entries || typeof file.entries !== 'object') { return new Map(); }
  const result = new Map<string, ReplayCacheEntry>();
  for (const [key, value] of Object.entries(file.entries)) {
    const entry = tryNormaliseEntry(value);
    if (entry) { result.set(key, entry); }
  }
  return result;
}

/** Whether a cache entry can be used to hydrate a SessionManager right now,
 *  instead of replaying the file from byte 0:
 *   - the entry's stamp matches the file's CURRENT stat exactly (both size
 *     and mtime — any drift at all means the cached state may not reflect
 *     what's actually on disk);
 *   - `live` (the registry liveness probe reading) is not `true` — a session
 *     with a confirmed-live process must always be replayed, never trusted
 *     from cache;
 *   - the cached state is `done` (never anything else — see
 *     CachedSessionState's doc comment);
 *   - the session has been quiet for at least `quietMs` since its own
 *     lastActivity (measured from `now`, the caller's clock). */
export function isHydratable(
  entry: ReplayCacheEntry,
  stat: { size: number; mtimeMs: number },
  live: boolean | null | undefined,
  now: number,
  quietMs: number = REPLAY_CACHE_QUIET_MS,
): boolean {
  if (entry.state.status !== 'done') { return false; }
  if (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) { return false; }
  if (live === true) { return false; }
  if (now - entry.state.lastActivity < quietMs) { return false; }
  return true;
}

/** Drop entries whose backing file no longer exists, that are older than
 *  `maxAgeMs` (capped at REPLAY_CACHE_HARD_MAX_AGE_MS regardless of what the
 *  caller passes), then cap the remainder to `maxEntries`, keeping the
 *  newest `cachedAt` first. Pure aside from the injected `exists` check. */
export function pruneEntries(
  entries: Map<string, ReplayCacheEntry>,
  now: number,
  opts: { maxAgeMs: number; maxEntries: number; exists: (filePath: string) => boolean },
): Map<string, ReplayCacheEntry> {
  const maxAgeMs = Math.min(opts.maxAgeMs, REPLAY_CACHE_HARD_MAX_AGE_MS);
  let kept: Array<[string, ReplayCacheEntry]> = [];
  for (const [filePath, entry] of entries) {
    if (now - entry.cachedAt > maxAgeMs) { continue; }
    if (!opts.exists(filePath)) { continue; }
    kept.push([filePath, entry]);
  }
  if (kept.length > opts.maxEntries) {
    kept.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    kept = kept.slice(0, opts.maxEntries);
  }
  return new Map(kept);
}

/** Combine two entry maps (typically "what's on disk" and "what this window
 *  knows"), keeping whichever side's entry has the newer `cachedAt` per key.
 *  A tie keeps `memory` (the caller's own freshly-captured view). */
export function mergeEntries(
  disk: Map<string, ReplayCacheEntry>,
  memory: Map<string, ReplayCacheEntry>,
): Map<string, ReplayCacheEntry> {
  const merged = new Map(disk);
  for (const [filePath, entry] of memory) {
    const existing = merged.get(filePath);
    if (!existing || entry.cachedAt >= existing.cachedAt) {
      merged.set(filePath, entry);
    }
  }
  return merged;
}

export function serialiseReplayCache(entries: Map<string, ReplayCacheEntry>): string {
  const file: ReplayCacheFile = { version: REPLAY_CACHE_VERSION, entries: Object.fromEntries(entries) };
  return JSON.stringify(file, null, 2);
}

// ── Store (I/O) ──────────────────────────────────────────────────────────

export interface ReplayCacheStore {
  /** Load from disk. Missing/unreadable/corrupt/oversized/wrong-version → an
   *  empty in-memory cache (never throws). */
  load(): Promise<void>;
  get(filePath: string): ReplayCacheEntry | undefined;
  /** Record (or overwrite) one entry in memory and mark the store dirty. Does
   *  not write to disk — see flush(). */
  put(filePath: string, entry: ReplayCacheEntry): void;
  /** Write pending changes to disk if dirty AND at least the configured
   *  minimum interval has elapsed since the last write. Re-reads the file
   *  and merges (newest-`cachedAt`-wins) before writing, since other
   *  windows/profiles/accounts share this file. Serialised — concurrent
   *  flush() calls from the same store queue rather than race. */
  flush(now: number): Promise<void>;
  /** Number of entries currently held in memory. */
  size(): number;
}

export interface ReplayCacheStoreOptions {
  /** Prune entries older than this (ms). Default: REPLAY_CACHE_HARD_MAX_AGE_MS. */
  maxAgeMs?: number;
  /** Prune entry count down to this cap. Default: REPLAY_CACHE_MAX_ENTRIES. */
  maxEntries?: number;
  /** Minimum ms between writes. Default: REPLAY_CACHE_MIN_FLUSH_INTERVAL_MS. */
  minFlushIntervalMs?: number;
}

class FileReplayCacheStore implements ReplayCacheStore {
  private entries: Map<string, ReplayCacheEntry> = new Map();
  private dirty = false;
  private lastFlushAt = 0;
  private saveSeq = 0;
  /** Serialises overlapping flush() calls onto one write at a time — same
   *  rationale as SessionMetaStore's saveQueue: two concurrent writers to one
   *  tmp-then-rename sequence must never interleave. */
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly cachePath: string,
    private readonly log: Logger,
    private readonly opts: ReplayCacheStoreOptions = {},
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.cachePath, 'utf-8');
    } catch {
      return; // ENOENT or unreadable — start empty, not an error
    }
    this.entries = parseReplayCache(raw);
  }

  get(filePath: string): ReplayCacheEntry | undefined {
    return this.entries.get(filePath);
  }

  put(filePath: string, entry: ReplayCacheEntry): void {
    this.entries.set(filePath, entry);
    this.dirty = true;
  }

  size(): number {
    return this.entries.size;
  }

  async flush(now: number): Promise<void> {
    if (!this.dirty) { return; }
    const minInterval = this.opts.minFlushIntervalMs ?? REPLAY_CACHE_MIN_FLUSH_INTERVAL_MS;
    if (this.lastFlushAt > 0 && now - this.lastFlushAt < minInterval) { return; }
    this.lastFlushAt = now;
    this.saveQueue = this.saveQueue.then(() => this.saveInner(now));
    await this.saveQueue;
  }

  private async saveInner(now: number): Promise<void> {
    // Optimistic clear BEFORE the read/merge/write below: a put() landing at
    // ANY point from here on (mid-read, mid-write) unconditionally re-sets
    // dirty=true, so it is never silently dropped — it just waits for the
    // NEXT flush(), which will re-read-and-merge and pick it up. No
    // generation counter needed (unlike SessionMetaStore) because put()
    // doesn't distinguish "during a save" from "before one" — either way the
    // freshly-written file doesn't yet contain it.
    this.dirty = false;
    try {
      // Re-read and merge before writing: several windows/profiles/accounts
      // share this one file, and each process only knows its OWN entries —
      // skipping this would make every flush() clobber every other window's
      // cached sessions with whatever this window happened to hold in memory.
      let onDisk = new Map<string, ReplayCacheEntry>();
      try {
        const raw = await fs.promises.readFile(this.cachePath, 'utf-8');
        onDisk = parseReplayCache(raw);
      } catch { /* no file yet, or unreadable — merge from empty */ }

      // this.entries reflects any put() that landed during the read above
      // (JS has no preemption between the await resuming and this line), so
      // folding disk knowledge in here can't drop it.
      const merged = mergeEntries(onDisk, this.entries);
      const pruned = pruneEntries(merged, now, {
        maxAgeMs: this.opts.maxAgeMs ?? REPLAY_CACHE_HARD_MAX_AGE_MS,
        maxEntries: this.opts.maxEntries ?? REPLAY_CACHE_MAX_ENTRIES,
        exists: (p) => {
          try { fs.statSync(p); return true; } catch { return false; }
        },
      });
      this.entries = pruned;

      const dir = path.dirname(this.cachePath);
      try {
        await fs.promises.access(dir);
      } catch {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      // Unique per pid+seq so two overlapping writers (different SessionDiscovery
      // instances in the SAME process, or a stale queued write from before a
      // reload) can never share — and clobber — one tmp file.
      const tmpPath = `${this.cachePath}.${process.pid}.${++this.saveSeq}.tmp`;
      const serialised = serialiseReplayCache(pruned);
      try {
        await fs.promises.writeFile(tmpPath, serialised, 'utf-8');
        await fs.promises.rename(tmpPath, this.cachePath);
      } catch (err) {
        // Awaited (unlike sessionMetaStore.ts's fire-and-forget unlink) so
        // cleanup is deterministic before the outer catch below re-arms
        // dirty — this method's caller (flush()) awaits the whole chain, and
        // a stray tmp file must not still be on disk once that await resolves.
        await fs.promises.unlink(tmpPath).catch(() => { /* already gone */ });
        throw err;
      }
    } catch (err) {
      // The write never landed — this.entries may already hold merged/pruned
      // state that hasn't been persisted. Re-arm dirty so the next flush()
      // retries (it will re-read-and-merge again, which is safe/idempotent).
      this.dirty = true;
      this.log.error('replay cache save failed:', err);
    }
  }
}

/** Factory. `cachePath` is supplied by the caller — PR D locates it beside
 *  the realpath'd claudeProjectsDir(); this PR does not compute a default. */
export function makeReplayCacheStore(
  cachePath: string,
  log: Logger,
  opts: ReplayCacheStoreOptions = {},
): ReplayCacheStore {
  return new FileReplayCacheStore(cachePath, log, opts);
}
