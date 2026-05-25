/**
 * CwdTracker — owns the cwd / initialCwd state for a session.
 *
 * Spike extraction (entanglement test): can this tracker close its contract
 * without reading SessionManager-internal state? Pass criterion: no callbacks
 * back into SessionManager beyond the constructor-supplied workspaceKey.
 *
 * Behaviour preserved verbatim from sessionManager.ts:487-495:
 *   - `cwd` mirrors the latest cwd from any JSONL record (drifts on mid-session `cd`)
 *   - `initialCwd` is sticky — first cwd whose sanitisation matches workspaceKey wins.
 *     Earlier records may point at a subfolder (sanitisation collapses separators,
 *     so subfolder cwds produce a different key).
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

/** Future seam: returns the hook variant if hooks are wired, JSONL-derived otherwise.
 *  For now, always returns the JSONL-derived variant. */
export function makeCwdTracker(workspaceKey: string): CwdTracker {
  return new JsonlDerivedCwdTracker(workspaceKey);
}
