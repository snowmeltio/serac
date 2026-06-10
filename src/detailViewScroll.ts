// Pure scroll-position decisions for the detail-panel reader, extracted from the
// detailView.ts webview IIFE so the "log/terminal" scroll behaviour is unit-
// testable (jsdom has no layout, so it can't be exercised in place). No DOM here.

/** Default px tolerance for treating the reader as "at the bottom". */
export const STICK_THRESHOLD_PX = 40;

/** Is the reader scrolled to within `threshold` px of the bottom? */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold: number = STICK_THRESHOLD_PX,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * The scrollTop to apply to the freshly re-rendered reader:
 *  - switching agents        → 0 (start at the top — read the brief/first turns);
 *  - same agent, was at bottom → scrollHeight (stick to the bottom; a running
 *    agent's new turns tail live);
 *  - same agent, scrolled up  → prevTop (preserve the anchor, so appended
 *    content stays below the fold and what you're reading never jumps).
 */
export function chooseReaderScrollTop(o: {
  isAgentChange: boolean;
  wasAtBottom: boolean;
  prevTop: number;
  scrollHeight: number;
}): number {
  if (o.isAgentChange) { return 0; }
  if (o.wasAtBottom) { return o.scrollHeight; }
  return o.prevTop;
}
