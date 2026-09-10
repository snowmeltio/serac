/**
 * Shared test fixtures for the dormant-session replay cache
 * (replayCache.test.ts, sessionManager.hydrate.test.ts). One canonical
 * "boring, eligible, done" CachedSessionState builder so both suites agree
 * on what a well-formed cache entry looks like, instead of two
 * independently hand-maintained ~20-field object literals drifting apart.
 */
import type { CachedSessionState } from '../types.js';
import type { ReplayCacheEntry } from '../replayCache.js';
import { REPLAY_CACHE_QUIET_MS } from '../replayCache.js';

/** Fixed once at module load, not per call: every makeReplayCacheEntry()
 *  within a test run shares an identical `mtimeMs` (so hardcoded stamp
 *  equality/mismatch checks stay deterministic), while staying fresh enough
 *  relative to whenever the suite actually runs to survive
 *  FileReplayCacheStore's mtimeMs-based age gate (pruneEntries ages by file
 *  mtime, not cachedAt — see replayCache.ts). A literal past timestamp would
 *  eventually age out of the 60-day ceiling as the calendar moves on. */
const FIXTURE_MTIME_MS = Date.now() - 60_000;

/** A well-formed, hydration-eligible CachedSessionState. `lastActivity`
 *  defaults comfortably past the quiet window so callers don't need to
 *  think about it unless the test is specifically exercising that gate. */
export function makeCachedSessionState(overrides: Partial<CachedSessionState> = {}): CachedSessionState {
  return {
    sessionId: 'cached-session',
    slug: 'cached-slug',
    workspaceKey: 'ws-key',
    cwd: '/Users/foo/bar',
    initialCwd: '/Users/foo/bar',
    topic: 'Cached topic',
    activity: 'Cached activity',
    status: 'done',
    lastActivity: Date.now() - REPLAY_CACHE_QUIET_MS - 60_000,
    firstActivity: Date.now() - 120_000,
    enqueuedAt: 0,
    contextTokens: 42,
    modelId: 'claude-sonnet-5',
    modelConfirmed: true,
    customTitle: 'Cached Title',
    aiTitle: 'Cached AI Title',
    userTurnCount: 3,
    gitBranch: 'main',
    toolErrorCount: 1,
    lastAssistantText: 'Cached preview',
    trackedFiles: ['a.ts'],
    subagents: [],
    ...overrides,
  };
}

/** A well-formed ReplayCacheEntry wrapping makeCachedSessionState(). */
export function makeReplayCacheEntry(overrides: Partial<ReplayCacheEntry> = {}): ReplayCacheEntry {
  return {
    size: 1000,
    mtimeMs: FIXTURE_MTIME_MS,
    cachedAt: Date.now(),
    state: makeCachedSessionState(),
    ...overrides,
  };
}
