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
 * its file alone) so a window's flush folds in whatever any other window has
 * written since this window last read the file — narrowing, not closing,
 * the lost-update race: two windows flushing at the same instant can still
 * each miss the other's just-landed write (last rename wins), but the
 * loser's own entries are simply re-exported and re-written on ITS next
 * flush, so nothing is permanently lost, only delayed by one cycle. No
 * locking — a session card painting a poll cycle late is cheap; a lock file
 * that can be abandoned by a crashed window is not.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CachedSessionState, FileStamp } from './types.js';
import type { Logger } from './sessionDiscovery.js';
import { EXTERNAL_WRITER_QUIET_MS } from './writerActivity.js';

/** Bump whenever CachedSessionState's shape or the status-machine semantics
 *  it captures change (per CLAUDE.md's "State machine changes" convention) —
 *  a version mismatch makes parseReplayCache() treat the whole file as
 *  absent rather than risk hydrating from a stale shape. */
export const REPLAY_CACHE_VERSION = 1;

/** A session must have been quiet (no lastActivity) for at least this long
 *  before it is eligible to be cached (exportCachedState). Reuses
 *  writerActivity.ts's EXTERNAL_WRITER_QUIET_MS rather than an
 *  independently-tuned literal — same underlying question ("has this
 *  session genuinely gone quiet, or might it still be mid-turn"), so one
 *  constant, not two that could silently drift apart. */
export const REPLAY_CACHE_QUIET_MS = EXTERNAL_WRITER_QUIET_MS;

/** Cap on the number of entries kept in the cache file. Entries beyond the
 *  cap are pruned oldest-`cachedAt`-first — a low-priority eviction, since a
 *  dropped entry just becomes a cache miss (one full replay) next time. */
export const REPLAY_CACHE_MAX_ENTRIES = 1000;

/** Refuse to parse (or write) a cache file larger than this. Guards against
 *  a runaway/corrupt file being loaded wholesale into memory. Checked via
 *  `fs.Stat.size` BEFORE the file is read where a stat is available (see
 *  `FileReplayCacheStore.readDisk()`); `parseReplayCache()`'s own
 *  string-length check stays as a secondary guard for callers that only
 *  have raw text (e.g. tests, or a future caller with no stat handy). */
export const REPLAY_CACHE_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Minimum interval between writes from one store instance (rate limit). */
const REPLAY_CACHE_MIN_FLUSH_INTERVAL_MS = 30_000;

/** Entries older than this (by `cachedAt`) are pruned regardless of any
 *  caller-supplied `maxAgeMs` — "the widest configured gate capped at 60 d"
 *  (plan). A caller may pass a tighter `maxAgeMs`; this is only the ceiling.
 *
 *  Deliberately a LOCAL literal, not settings.ts's exported `DAY_MS`:
 *  settings.ts does `import * as vscode from 'vscode'`, and sessionManager.ts
 *  (which imports this module for REPLAY_CACHE_QUIET_MS) is exercised by
 *  ~15 test files that mock neither `vscode` nor this import — pulling
 *  settings.ts in transitively would force every one of them to add a
 *  `vscode` mock for one shared constant. Not worth the blast radius. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REPLAY_CACHE_HARD_MAX_AGE_MS = 60 * ONE_DAY_MS;

/** Chunk size for batched, async "does this file still exist" checks —
 *  mirrors the `UPDATE_BATCH_SIZE = 50` module-local convention already used
 *  by `sessionDiscovery.ts` and `teamDiscovery.ts` for their own dormant-poll
 *  batching (each keeps its own local constant rather than sharing one, same
 *  pattern followed here). */
const EXISTS_BATCH_SIZE = 50;

/** One cached session's payload plus the disk stamp it was captured at and
 *  when it was written. Keyed by the session's absolute JSONL path in
 *  ReplayCacheFile.entries (paths are already realpath'd via
 *  claudeProjectsDir(), so the same transcript reached through a symlinked
 *  account alias still hits the same key). Extends FileStamp so
 *  `sameStamp(entry, stat)` works directly — the JSON shape stays flat
 *  (`size`/`mtimeMs` alongside `cachedAt`/`state`), only the TYPE is
 *  composed. */
export interface ReplayCacheEntry extends FileStamp {
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

/** Two file stamps refer to the identical file content (same size, same
 *  mtime). mtimeMs round-trips losslessly through JSON.stringify/parse
 *  (both IEEE-754 float64, same representable range) — no epsilon needed. */
export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// ── Pure functions ──────────────────────────────────────────────────────

/** Lenient per-entry validation: reject a malformed individual entry without
 *  discarding the rest of the file (a torn write from another window, or a
 *  future field this version doesn't know about, must not nuke every other
 *  window's cached entries). Deliberately thorough — a NaN `lastActivity`
 *  hydrating in would give a card an Invalid Date (disposed on the next poll
 *  / broken zone sort), and an unchecked subagent field is exactly as
 *  reachable via a hand-edited or partially-written file. */
function tryNormaliseEntry(value: unknown): ReplayCacheEntry | null {
  if (!value || typeof value !== 'object') { return null; }
  const v = value as Partial<ReplayCacheEntry>;
  if (!Number.isFinite(v.size) || !Number.isFinite(v.mtimeMs) || !Number.isFinite(v.cachedAt)) {
    return null;
  }
  const state = tryNormaliseState(v.state);
  if (!state) { return null; }
  return { size: v.size as number, mtimeMs: v.mtimeMs as number, cachedAt: v.cachedAt as number, state };
}

function isFiniteOrUndefined(v: unknown): v is number | undefined {
  return v === undefined || Number.isFinite(v);
}

function isStringOrUndefined(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

/** Validate a cached subagent: every field the roster row actually renders,
 *  rejecting the whole subagent (not just the offending field) on failure —
 *  a partial SubagentInfo is not a type the rest of the code ever produces
 *  from a live replay, so hydrate() must not be handed one either. */
function tryNormaliseSubagent(value: unknown): CachedSessionState['subagents'][number] | null {
  if (!value || typeof value !== 'object') { return null; }
  const s = value as Partial<CachedSessionState['subagents'][number]>;
  if (typeof s.parentToolUseId !== 'string' || typeof s.description !== 'string') { return null; }
  if (!Number.isFinite(s.startedAt) || !Number.isFinite(s.toolsCompleted) || !Number.isFinite(s.lastActivity)) {
    return null;
  }
  if (s.agentId !== null && typeof s.agentId !== 'string') { return null; }
  if (s.resultPreview !== null && typeof s.resultPreview !== 'string') { return null; }
  if (s.background !== undefined && typeof s.background !== 'boolean') { return null; }
  return {
    parentToolUseId: s.parentToolUseId,
    agentId: s.agentId ?? null,
    description: s.description,
    resultPreview: s.resultPreview ?? null,
    toolsCompleted: s.toolsCompleted as number,
    startedAt: s.startedAt as number,
    lastActivity: s.lastActivity as number,
    background: s.background,
  };
}

/** Validate a whole CachedSessionState blob. Rejects on the first bad field
 *  rather than coercing — a coerced-empty-string identity field or a
 *  silently-zeroed timestamp is worse than a cache miss (one full replay). */
function tryNormaliseState(value: unknown): CachedSessionState | null {
  if (!value || typeof value !== 'object') { return null; }
  const s = value as Partial<CachedSessionState>;
  if (s.status !== 'done') { return null; }
  if (typeof s.sessionId !== 'string' || typeof s.slug !== 'string' || typeof s.workspaceKey !== 'string') { return null; }
  if (typeof s.cwd !== 'string' || typeof s.initialCwd !== 'string') { return null; }
  if (typeof s.topic !== 'string' || typeof s.activity !== 'string') { return null; }
  if (!Number.isFinite(s.lastActivity) || !Number.isFinite(s.firstActivity)) { return null; }
  // enqueuedAt is required on a freshly-exported entry (0 = never enqueued),
  // but a present, non-finite value (corruption, not mere absence) still
  // rejects the entry outright — only a genuinely MISSING field falls back
  // to 0, tolerating an older/foreign writer's entry missing one low-stakes
  // counter rather than discarding the whole entry over it.
  if (!isFiniteOrUndefined(s.enqueuedAt)) { return null; }
  const enqueuedAt = s.enqueuedAt ?? 0;
  if (!Number.isFinite(s.contextTokens)) { return null; }
  if (typeof s.modelId !== 'string' || typeof s.modelConfirmed !== 'boolean') { return null; }
  if (typeof s.customTitle !== 'string' || typeof s.aiTitle !== 'string') { return null; }
  if (!Number.isFinite(s.userTurnCount)) { return null; }
  if (!isStringOrUndefined(s.permissionMode) || !isStringOrUndefined(s.jsonlPermissionMode)) { return null; }
  if (!isStringOrUndefined(s.entrypoint) || !isStringOrUndefined(s.bridgeSessionId)) { return null; }
  if (!isStringOrUndefined(s.endReason) || !isStringOrUndefined(s.gitBranch)) { return null; }
  if (!isStringOrUndefined(s.lastAssistantText)) { return null; }
  if (s.bridgeState !== undefined && s.bridgeState !== 'enrolled' && s.bridgeState !== 'dropped') { return null; }
  if (!isFiniteOrUndefined(s.toolErrorCount)) { return null; }
  if (s.trackedFiles !== undefined && (!Array.isArray(s.trackedFiles) || !s.trackedFiles.every(f => typeof f === 'string'))) {
    return null;
  }
  if (!Array.isArray(s.subagents)) { return null; }
  const subagents: CachedSessionState['subagents'] = [];
  for (const raw of s.subagents) {
    const sub = tryNormaliseSubagent(raw);
    if (!sub) { return null; }
    subagents.push(sub);
  }
  return {
    sessionId: s.sessionId, slug: s.slug, workspaceKey: s.workspaceKey,
    cwd: s.cwd, initialCwd: s.initialCwd, topic: s.topic, activity: s.activity,
    status: 'done',
    lastActivity: s.lastActivity as number, firstActivity: s.firstActivity as number,
    enqueuedAt, contextTokens: s.contextTokens as number,
    modelId: s.modelId, modelConfirmed: s.modelConfirmed,
    customTitle: s.customTitle, aiTitle: s.aiTitle, userTurnCount: s.userTurnCount as number,
    permissionMode: s.permissionMode, jsonlPermissionMode: s.jsonlPermissionMode,
    entrypoint: s.entrypoint, bridgeSessionId: s.bridgeSessionId, bridgeState: s.bridgeState,
    endReason: s.endReason, gitBranch: s.gitBranch, toolErrorCount: s.toolErrorCount,
    lastAssistantText: s.lastAssistantText, trackedFiles: s.trackedFiles,
    subagents,
  };
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
 *     from cache.
 *
 *  Does NOT re-check the quiet window or `status === 'done'` — both are
 *  already guaranteed by the time an entry reaches here: `status` is the
 *  literal `'done'` type (anything else is rejected at parse time, see
 *  `tryNormaliseState`), and the quiet window was already enforced once, at
 *  EXPORT time, against the wall clock then — re-checking it now against a
 *  DIFFERENT wall clock (whenever this window happens to poll) would only
 *  ever make hydration MORE conservative for no safety benefit, since the
 *  stamp-match check above already guarantees the file hasn't changed since
 *  that quiet, already-validated moment. */
export function isHydratable(
  entry: ReplayCacheEntry,
  stat: FileStamp,
  live: boolean | null | undefined,
): boolean {
  if (!sameStamp(entry, stat)) { return false; }
  if (live === true) { return false; }
  return true;
}

/** Drop entries older than `maxAgeMs` (capped at REPLAY_CACHE_HARD_MAX_AGE_MS
 *  regardless of what the caller passes), then cap the remainder to
 *  `maxEntries`, keeping the newest `cachedAt` first. Pure — the missing-file
 *  check is a SEPARATE, async, I/O-touching step (see `pruneMissingFiles`
 *  below); folding it in here would make this synchronous function block on
 *  disk, and — more importantly — would re-stat every entry (up to 1000) on
 *  every 30 s flush instead of only the ones actually worth checking. */
export function pruneEntries(
  entries: Map<string, ReplayCacheEntry>,
  now: number,
  opts: { maxAgeMs: number; maxEntries: number },
): Map<string, ReplayCacheEntry> {
  const maxAgeMs = Math.min(opts.maxAgeMs, REPLAY_CACHE_HARD_MAX_AGE_MS);
  let kept: Array<[string, ReplayCacheEntry]> = [];
  for (const [filePath, entry] of entries) {
    if (now - entry.cachedAt > maxAgeMs) { continue; }
    kept.push([filePath, entry]);
  }
  if (kept.length > opts.maxEntries) {
    kept.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    kept = kept.slice(0, opts.maxEntries);
  }
  return new Map(kept);
}

/** True only when `filePath` is CONFIRMED gone (ENOENT). Any other error —
 *  EACCES, EMFILE, a symlink farm mid-recreate, a transient network-mount
 *  hiccup — is "can't tell", not "gone", and must never evict a real entry
 *  over a passing disk error. */
async function existsOrUnknown(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

/** Async, batched (chunks of EXISTS_BATCH_SIZE, mirroring the
 *  UPDATE_BATCH_SIZE convention) existence check, applied ONLY to
 *  `keysToCheck` — not the whole map. Drops an entry only on a CONFIRMED
 *  ENOENT (see `existsOrUnknown`); every other outcome keeps it. Callers
 *  choose which keys are worth checking: `load()` checks everything once
 *  (a fresh process, no established trust yet); `flush()` checks only the
 *  entries newly seen from another window's disk write (see
 *  `FileReplayCacheStore.saveInner`), not the whole map on every 30 s write —
 *  an entry this window already trusted before the merge doesn't get
 *  re-stat'd just because a flush happened to run. */
export async function pruneMissingFiles(
  entries: Map<string, ReplayCacheEntry>,
  keysToCheck: Iterable<string>,
  exists: (filePath: string) => Promise<boolean> = existsOrUnknown,
): Promise<Map<string, ReplayCacheEntry>> {
  const candidates = [...keysToCheck].filter(k => entries.has(k));
  if (candidates.length === 0) { return entries; }
  const gone = new Set<string>();
  for (let i = 0; i < candidates.length; i += EXISTS_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + EXISTS_BATCH_SIZE);
    const flags = await Promise.all(chunk.map(p => exists(p)));
    chunk.forEach((p, idx) => { if (!flags[idx]) { gone.add(p); } });
  }
  if (gone.size === 0) { return entries; }
  const result = new Map(entries);
  for (const k of gone) { result.delete(k); }
  return result;
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

/** No pretty-printing — this file is machine-written and machine-read only;
 *  indentation just costs bytes and parse time at up to 1000 entries. */
export function serialiseReplayCache(entries: Map<string, ReplayCacheEntry>): string {
  const file: ReplayCacheFile = { version: REPLAY_CACHE_VERSION, entries: Object.fromEntries(entries) };
  return JSON.stringify(file);
}

// ── Store (I/O) ──────────────────────────────────────────────────────────

export interface ReplayCacheStore {
  /** Load from disk. Missing/unreadable/corrupt/oversized/wrong-version → an
   *  empty in-memory cache (never throws). Also runs the missing-file prune
   *  across every loaded entry once (see `pruneMissingFiles`). */
  load(): Promise<void>;
  get(filePath: string): ReplayCacheEntry | undefined;
  /** Record (or overwrite) one entry in memory and mark the store dirty. Does
   *  not write to disk — see flush(). */
  put(filePath: string, entry: ReplayCacheEntry): void;
  /** Write pending changes to disk if dirty AND at least the configured
   *  minimum interval has elapsed since the last write (unless `force`).
   *  Re-reads the file and merges (newest-`cachedAt`-wins) before writing,
   *  since other windows/profiles/accounts share this file — SKIPPED when
   *  the cache file's own stat is unchanged since this store last read or
   *  wrote it (nothing to fold in). Serialised — concurrent flush() calls
   *  from the same store queue rather than race. */
  flush(now: number, opts?: { force?: boolean }): Promise<void>;
}

export interface ReplayCacheStoreOptions {
  /** Prune entries older than this (ms). Default: REPLAY_CACHE_HARD_MAX_AGE_MS. */
  maxAgeMs?: number;
  /** Prune entry count down to this cap. Default: REPLAY_CACHE_MAX_ENTRIES. */
  maxEntries?: number;
  /** Minimum ms between writes. Default: REPLAY_CACHE_MIN_FLUSH_INTERVAL_MS. */
  minFlushIntervalMs?: number;
}

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

class FileReplayCacheStore implements ReplayCacheStore {
  private entries: Map<string, ReplayCacheEntry> = new Map();
  private dirty = false;
  private lastFlushAt = 0;
  private saveSeq = 0;
  /** The cache FILE's own {size, mtimeMs} as of the last time this store
   *  actually read or wrote it — distinct from each per-session
   *  ReplayCacheEntry's stamp. Lets saveInner() skip the re-read+merge+parse
   *  when nothing has touched the shared file since (the common case: no
   *  other window/profile/account happened to flush in the same 30 s
   *  window). */
  private diskStamp: FileStamp | null = null;
  /** Serialises overlapping flush() calls onto one write at a time — same
   *  rationale as SessionMetaStore's saveQueue: two concurrent writers to one
   *  tmp-then-rename sequence must never interleave. */
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly cachePath: string,
    private readonly log: Logger,
    private readonly opts: ReplayCacheStoreOptions = {},
  ) {}

  /** Read + parse the cache file, shared by load() and the merge step in
   *  saveInner(). Stats FIRST so the 16 MB cap is enforced before a large
   *  file is even read into memory — parseReplayCache()'s own string-length
   *  check is a secondary guard for callers with only raw text in hand.
   *  Returns null on any failure (missing, oversized, unreadable) — never
   *  throws. */
  private async readDisk(): Promise<{ entries: Map<string, ReplayCacheEntry>; stamp: FileStamp } | null> {
    const stat = await statOrNull(this.cachePath);
    if (!stat || stat.size > REPLAY_CACHE_MAX_FILE_BYTES) { return null; }
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.cachePath, 'utf-8');
    } catch {
      return null;
    }
    return { entries: parseReplayCache(raw), stamp: { size: stat.size, mtimeMs: stat.mtimeMs } };
  }

  async load(): Promise<void> {
    const disk = await this.readDisk();
    if (!disk) { return; }
    this.entries = await pruneMissingFiles(disk.entries, disk.entries.keys());
    this.diskStamp = disk.stamp;
  }

  get(filePath: string): ReplayCacheEntry | undefined {
    return this.entries.get(filePath);
  }

  put(filePath: string, entry: ReplayCacheEntry): void {
    this.entries.set(filePath, entry);
    this.dirty = true;
  }

  async flush(now: number, opts: { force?: boolean } = {}): Promise<void> {
    if (!this.dirty) { return; }
    if (!opts.force) {
      const minInterval = this.opts.minFlushIntervalMs ?? REPLAY_CACHE_MIN_FLUSH_INTERVAL_MS;
      if (this.lastFlushAt > 0 && now - this.lastFlushAt < minInterval) { return; }
    }
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
      // SKIPPED (merged := this.entries as-is) when the file's own stat
      // hasn't moved since we last read/wrote it — nothing to fold in.
      const knownKeysBeforeMerge = new Set(this.entries.keys());
      let merged = this.entries;

      const currentStat = await statOrNull(this.cachePath);
      const fileUnchanged = currentStat && this.diskStamp && sameStamp(currentStat, this.diskStamp);
      if (!fileUnchanged) {
        // this.entries reflects any put() that landed during the stat above
        // (JS has no preemption between an await resuming and this line), so
        // folding disk knowledge in here can't drop it.
        const disk = await this.readDisk();
        if (disk) {
          merged = mergeEntries(disk.entries, this.entries);
          this.diskStamp = disk.stamp;
        }
      }

      // Missing-file prune, but ONLY for keys this window didn't already
      // know about before the merge — an entry we already trusted (our own
      // put(), or already validated on a prior load()/flush()) isn't worth
      // re-stat'ing every 30 s just because a flush happened to run.
      const newKeysFromDisk = [...merged.keys()].filter(k => !knownKeysBeforeMerge.has(k));
      if (newKeysFromDisk.length > 0) {
        merged = await pruneMissingFiles(merged, newKeysFromDisk);
      }

      const pruned = pruneEntries(merged, now, {
        maxAgeMs: this.opts.maxAgeMs ?? REPLAY_CACHE_HARD_MAX_AGE_MS,
        maxEntries: this.opts.maxEntries ?? REPLAY_CACHE_MAX_ENTRIES,
      });
      this.entries = pruned;

      await fs.promises.mkdir(path.dirname(this.cachePath), { recursive: true });
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
      // Record OUR OWN write's stat so the next flush can skip the re-read
      // if nothing else touches the file before then.
      const postWriteStat = await statOrNull(this.cachePath);
      if (postWriteStat) { this.diskStamp = { size: postWriteStat.size, mtimeMs: postWriteStat.mtimeMs }; }
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
