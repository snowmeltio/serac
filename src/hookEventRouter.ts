/**
 * HookEventRouter — fan-out + buffer-with-TTL primitive for Claude Code hook
 * events. Wired in production: `extension.ts` attaches the inbound forwarder
 * via `startHookIngress` (Unix socket + leader election, fed by
 * `bin/serac-hook-forward.cjs`) on one side, and `SessionDiscovery` injects
 * the router into each `SessionManager` so trackers subscribe on the other.
 *
 * Design (per HOOK-MONITORING.md):
 *   - Payloads typed `unknown` — Claude Code's hook schema is un-versioned;
 *     defensive parsing happens at the subscriber's edge, not here.
 *   - Subscribers register per (sessionId, eventType). Multiple subscribers
 *     for the same key are allowed; all are notified in registration order.
 *   - Cold-start race: if an event arrives before the matching subscriber
 *     registers (extension still activating), buffer it and replay on
 *     register. Buffered entries expire after `bufferTtlMs` (default 5s).
 *   - Built-in filter: phantom `SubagentStop` events with `agent_type === ""`
 *     are dropped at the router — confirmed from spike capture 2026-05-12 to
 *     be background title-generation subagents.
 *   - `dispose()` releases everything and makes the router inert.
 *
 * Empirical reference: PreToolUse fires 25-29 ms before PermissionRequest;
 * subscribers must scope to `PermissionRequest`, never `PreToolUse`, or
 * auto-approved tools will false-flag.
 */

export type HookEventCallback = (event: unknown) => void;

/** Default cold-start replay window. Long enough to cover an extension
 *  activation, short enough that stale events never reach a late subscriber. */
const DEFAULT_BUFFER_TTL_MS = 5_000;
/** Hard ceiling on distinct sessions holding buffered events. Pruning is
 *  otherwise lazy and per-key, so without this a flood of distinct session
 *  ids (or the organic residue of ended sessions) grows the map forever. */
const MAX_BUFFERED_SESSIONS = 64;

interface BufferedEvent {
  eventType: string;
  event: unknown;
  receivedAt: number;
}

interface SubscriberEntry {
  eventType: string;
  callback: HookEventCallback;
}

export interface HookEventRouterOptions {
  /** How long to retain unconsumed events for cold-start replay (ms). */
  bufferTtlMs?: number;
  /** Override clock for tests. */
  now?: () => number;
}

/** Fires once per event after phantom filtering. Used by the extension for
 *  observability (output-channel logging) and liveness (last-event timestamp).
 *  Errors thrown by the observer are isolated — they do not block routing. */
export type HookEventObserver = (sessionId: string, eventType: string, event: unknown) => void;

export class HookEventRouter {
  /** sessionId → list of subscribers (allows multiple per event type). */
  private readonly subscribers = new Map<string, SubscriberEntry[]>();
  /** sessionId → buffered events awaiting a late subscriber. */
  private readonly buffer = new Map<string, BufferedEvent[]>();
  private readonly bufferTtlMs: number;
  private readonly now: () => number;
  private disposed = false;
  private observer: HookEventObserver | undefined;

  constructor(opts: HookEventRouterOptions = {}) {
    this.bufferTtlMs = opts.bufferTtlMs ?? DEFAULT_BUFFER_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Install a debug observer. Fires once per inbound event (after phantom
   *  filtering, before subscriber dispatch). Replaces any prior observer.
   *  Pass `undefined` to clear. */
  setDebugObserver(observer: HookEventObserver | undefined): void {
    this.observer = observer;
  }

  /** Register a subscriber for (sessionId, eventType). Returns an
   *  unsubscribe function. Any buffered events still within TTL are
   *  replayed synchronously before this call returns. */
  register(
    sessionId: string,
    eventType: string,
    callback: HookEventCallback,
  ): () => void {
    if (this.disposed) { return () => {}; }

    let list = this.subscribers.get(sessionId);
    if (!list) {
      list = [];
      this.subscribers.set(sessionId, list);
    }
    const entry: SubscriberEntry = { eventType, callback };
    list.push(entry);

    this.replayBuffered(sessionId, eventType, callback);

    return () => this.unregisterEntry(sessionId, entry);
  }

  /** Remove all subscribers for (sessionId, eventType, callback). Idempotent. */
  unregister(
    sessionId: string,
    eventType: string,
    callback: HookEventCallback,
  ): void {
    const list = this.subscribers.get(sessionId);
    if (!list) { return; }
    const remaining = list.filter(
      e => !(e.eventType === eventType && e.callback === callback),
    );
    if (remaining.length === 0) {
      this.subscribers.delete(sessionId);
    } else {
      this.subscribers.set(sessionId, remaining);
    }
  }

  /** Deliver an inbound hook event. Filters phantom SubagentStop, fans out
   *  to matching subscribers, and buffers (within TTL) when no subscriber
   *  exists yet. */
  onHookEvent(sessionId: string, eventType: string, event: unknown): void {
    if (this.disposed) { return; }
    if (this.isPhantomSubagentStop(eventType, event)) { return; }

    if (this.observer) {
      try { this.observer(sessionId, eventType, event); } catch { /* observer errors are isolated */ }
    }

    const list = this.subscribers.get(sessionId);
    const matches = list?.filter(e => e.eventType === eventType) ?? [];
    if (matches.length > 0) {
      for (const m of matches) {
        try { m.callback(event); } catch { /* subscriber errors are isolated */ }
      }
      return;
    }

    // No subscriber yet — buffer for cold-start replay.
    this.appendBuffered(sessionId, { eventType, event, receivedAt: this.now() });
  }

  /** Current buffered event count for a session — primarily for tests. */
  getBufferedCount(sessionId: string): number {
    this.pruneBuffered(sessionId);
    return this.buffer.get(sessionId)?.length ?? 0;
  }

  /** Current subscriber count for a session — primarily for tests (pins the
   *  SessionManager.dispose() symmetry: every tracker registration must be
   *  released, or pruned managers leak their whole state graph). */
  getSubscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.length ?? 0;
  }

  /** Release all subscribers and buffers. After dispose(), the router is
   *  inert: register() returns a no-op unsubscribe, onHookEvent() is a no-op. */
  dispose(): void {
    this.disposed = true;
    this.subscribers.clear();
    this.buffer.clear();
  }

  // ── internals ─────────────────────────────────────────────────────

  private unregisterEntry(sessionId: string, entry: SubscriberEntry): void {
    const list = this.subscribers.get(sessionId);
    if (!list) { return; }
    const idx = list.indexOf(entry);
    if (idx === -1) { return; }
    list.splice(idx, 1);
    if (list.length === 0) {
      this.subscribers.delete(sessionId);
    }
  }

  private replayBuffered(
    sessionId: string,
    eventType: string,
    callback: HookEventCallback,
  ): void {
    this.pruneBuffered(sessionId);
    const buf = this.buffer.get(sessionId);
    if (!buf || buf.length === 0) { return; }

    const remaining: BufferedEvent[] = [];
    for (const item of buf) {
      if (item.eventType === eventType) {
        try { callback(item.event); } catch { /* isolated */ }
      } else {
        remaining.push(item);
      }
    }
    if (remaining.length === 0) {
      this.buffer.delete(sessionId);
    } else {
      this.buffer.set(sessionId, remaining);
    }
  }

  private appendBuffered(sessionId: string, item: BufferedEvent): void {
    this.pruneBuffered(sessionId);
    const buf = this.buffer.get(sessionId);
    if (buf) {
      buf.push(item);
      return;
    }
    // New key past the cap: sweep expired buffers globally, then if still
    // full evict the stalest session — the buffer exists only for cold-start
    // replay within the TTL, so the evictee was already past useful.
    if (this.buffer.size >= MAX_BUFFERED_SESSIONS) {
      for (const key of [...this.buffer.keys()]) { this.pruneBuffered(key); }
      if (this.buffer.size >= MAX_BUFFERED_SESSIONS) {
        let stalest: string | null = null;
        let stalestAt = Number.POSITIVE_INFINITY;
        for (const [key, items] of this.buffer) {
          const newest = items[items.length - 1]?.receivedAt ?? 0;
          if (newest < stalestAt) { stalestAt = newest; stalest = key; }
        }
        if (stalest !== null) { this.buffer.delete(stalest); }
      }
    }
    this.buffer.set(sessionId, [item]);
  }

  private pruneBuffered(sessionId: string): void {
    const buf = this.buffer.get(sessionId);
    if (!buf) { return; }
    const cutoff = this.now() - this.bufferTtlMs;
    const live = buf.filter(item => item.receivedAt >= cutoff);
    if (live.length === 0) {
      this.buffer.delete(sessionId);
    } else if (live.length !== buf.length) {
      this.buffer.set(sessionId, live);
    }
  }

  private isPhantomSubagentStop(eventType: string, event: unknown): boolean {
    if (eventType !== 'SubagentStop') { return false; }
    if (typeof event !== 'object' || event === null) { return false; }
    const agentType = (event as Record<string, unknown>).agent_type;
    return agentType === '';
  }
}
