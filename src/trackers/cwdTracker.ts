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

export class JsonlDerivedCwdTracker implements CwdTracker {
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

/** Construct the variant appropriate for the current environment.
 *
 *  Today: always returns `JsonlDerivedCwdTracker` — no other variant exists.
 *
 *  Why the factory exists *before* a second variant does: Phase 4 of the
 *  hook-monitoring work will introduce `HookDerivedCwdTracker`, populated from
 *  Claude Code's `SessionStart`/`UserPromptSubmit` hook events. When that
 *  lands, the factory's body grows a feature-flag branch; every call site at
 *  the SessionManager remains unchanged. Without the factory, every spawn
 *  site (currently two: session-level and per-subagent in PermissionTracker)
 *  would need to learn about the variant decision.
 *
 *  This is a deliberate one-line layer of indirection, not pretend
 *  abstraction. Removing it now would force a wider diff in Phase 4. */
export function makeCwdTracker(workspaceKey: string): CwdTracker {
  return new JsonlDerivedCwdTracker(workspaceKey);
}
