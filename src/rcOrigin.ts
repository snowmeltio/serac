/**
 * Dependency-free Remote Control origin predicate, shared by the webview
 * bundle (panelRender.ts / panel.ts) and the extension host. rcDetector.ts
 * re-exports it; it lives apart only because rcDetector pulls in `path` and
 * the git worktree helpers, which the webview bundle cannot carry.
 */

/** Registry and transcript `entrypoint` value stamped by a Remote
 *  Control-hosted (phone-driven) session process. */
export const RC_ENTRYPOINT = 'sdk-cli';

/**
 * Was this transcript written by a Remote Control-hosted (phone-driven)
 * process? The same `sdk-cli` stamp as the registry entry, but read from the
 * transcript's records, so it survives the process exiting — the durable
 * signal for "started from your phone" on ended sessions and on same-dir
 * sessions that never had a `bridge-cse_*` worktree. One predicate shared by
 * the card renderer and the host-side transfer flow.
 */
export function isRcOriginTranscript(entrypoint: string | undefined): boolean {
  return entrypoint === RC_ENTRYPOINT;
}
