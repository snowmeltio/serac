/**
 * CwdTracker — owns the cwd / initialCwd state for a session.
 *
 *   - `cwd` mirrors the latest cwd from any JSONL record (drifts on mid-session `cd`).
 *   - `initialCwd` is sticky — first cwd whose sanitisation matches workspaceKey wins.
 *     Earlier records may point at a subfolder (sanitisation collapses separators,
 *     so subfolder cwds produce a different key).
 *
 * No host needs: derives entirely from the JSONL stream + the constructor-supplied
 * workspaceKey. The hook variant (Phase 4) will populate from `SessionStart` /
 * `UserPromptSubmit` events; same shape, different source.
 */

import { sanitiseWorkspaceKey } from '../panelUtils.js';
import type { HookEventRouter } from '../hookEventRouter.js';

export interface CwdState {
  /** Most recent cwd field from any JSONL record. */
  cwd: string;
  /** First cwd whose sanitisation matches workspaceKey. Empty until matched. */
  initialCwd: string;
}

export interface CwdTracker {
  /** Process a cwd field from a JSONL record. No-op on undefined/empty. */
  onCwd(cwd: string | undefined): void;
  /** Read current cwd state. Safe to call any time. */
  getState(): Readonly<CwdState>;
  /** Stop the tracker. Idempotent. */
  dispose(): void;
}

class JsonlDerivedCwdTracker implements CwdTracker {
  private cwd = '';
  private initialCwd = '';

  constructor(private readonly workspaceKey: string) {}

  onCwd(cwd: string | undefined): void {
    if (!cwd) { return; }
    this.cwd = cwd;
    if (!this.initialCwd && sanitiseWorkspaceKey(cwd) === this.workspaceKey) {
      this.initialCwd = cwd;
    }
  }

  getState(): Readonly<CwdState> {
    return { cwd: this.cwd, initialCwd: this.initialCwd };
  }

  dispose(): void { /* no resources */ }
}

/**
 * Hook-overlay variant. Wraps a `JsonlDerivedCwdTracker` and routes
 * `SessionStart` + `UserPromptSubmit` hook payloads through its `onCwd`
 * method — every cwd path stays in one place (initialCwd matching,
 * sticky behaviour, sanitisation against workspaceKey).
 *
 * Why compose: both event streams (hooks + JSONL `processUserRecord`)
 * may deliver cwd; the JSONL stream still fires from inside SessionManager
 * via the existing `onCwd` calls. Letting both feed the same fallback
 * keeps the cwd-state logic single-sourced.
 *
 * Defensive parsing: `cwd` and `hook_event_name` are the only fields read,
 * both typed as `string`; anything else is ignored.
 */
class HookCwdTracker implements CwdTracker {
  private readonly fallback: JsonlDerivedCwdTracker;
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(workspaceKey: string, sessionId: string, router: HookEventRouter) {
    this.fallback = new JsonlDerivedCwdTracker(workspaceKey);
    const handle = (event: unknown) => {
      if (this.disposed) { return; }
      if (typeof event !== 'object' || event === null) { return; }
      const cwd = (event as Record<string, unknown>).cwd;
      if (typeof cwd === 'string') { this.fallback.onCwd(cwd); }
    };
    this.unsubscribers.push(router.register(sessionId, 'SessionStart', handle));
    this.unsubscribers.push(router.register(sessionId, 'UserPromptSubmit', handle));
  }

  onCwd(cwd: string | undefined): void { this.fallback.onCwd(cwd); }
  getState(): Readonly<CwdState> { return this.fallback.getState(); }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const u of this.unsubscribers) { u(); }
    this.fallback.dispose();
  }
}

export interface CwdTrackerFactoryOptions {
  /** Hook router for the owning workspace. */
  hookRouter?: HookEventRouter;
  /** Session UUID. Required for hook subscription. */
  sessionId?: string;
}

/** Construct the variant appropriate for the current environment.
 *
 *  - hookRouter + sessionId → `HookCwdTracker` (overlay)
 *  - otherwise → `JsonlDerivedCwdTracker` */
export function makeCwdTracker(
  workspaceKey: string,
  opts: CwdTrackerFactoryOptions = {},
): CwdTracker {
  if (opts.hookRouter && opts.sessionId) {
    return new HookCwdTracker(workspaceKey, opts.sessionId, opts.hookRouter);
  }
  return new JsonlDerivedCwdTracker(workspaceKey);
}
