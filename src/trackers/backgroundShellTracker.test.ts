import { describe, it, expect } from 'vitest';
import {
  makeBackgroundShellTracker,
  parseBackgroundStart,
  parseBackgroundCompletion,
  BACKGROUND_SHELL_CEILING_MS,
} from './backgroundShellTracker.js';

// Real surface strings observed in production JSONL (session 672181b9 — the
// "Debug Google Workspace MCP" card from the spike, and 314fe9ce for the
// completion shape). Kept verbatim so a Claude Code wording change fails loudly.
const LAUNCH_BFZRK =
  'Command running in background with ID: bfzrk3tz9. Output is being written to: ' +
  '/private/tmp/claude-501/-Users-murraystubbs-claudecode/672181b9/tasks/bfzrk3tz9.output. You will be notified.';
const LAUNCH_B5LKU =
  'Command running in background with ID: b5lku6yoc. Output is being written to: /private/tmp/.../b5lku6yoc.output.';
const COMPLETION_B3O9 =
  '<retrieval_status>success</retrieval_status>\n<task_id>b3o9dv2x1</task_id>\n' +
  '<task_type>local_bash</task_type>\n<status>completed</status>\n<exit_code>0</exit_code>\n<output> done </output>';

describe('parseBackgroundStart', () => {
  it('extracts the shell id from a real launch banner', () => {
    expect(parseBackgroundStart(LAUNCH_BFZRK)).toBe('bfzrk3tz9');
    expect(parseBackgroundStart(LAUNCH_B5LKU)).toBe('b5lku6yoc');
  });

  it('returns null for unrelated tool_result text', () => {
    expect(parseBackgroundStart('Edited file foo.ts')).toBeNull();
    expect(parseBackgroundStart('')).toBeNull();
  });
});

describe('parseBackgroundCompletion', () => {
  it('extracts the shell id from a terminal retrieval', () => {
    expect(parseBackgroundCompletion(COMPLETION_B3O9)).toBe('b3o9dv2x1');
  });

  it('treats failed/killed as terminal', () => {
    expect(parseBackgroundCompletion('<task_id>x1</task_id><status>failed</status>')).toBe('x1');
    expect(parseBackgroundCompletion('<task_id>x2</task_id><status>killed</status>')).toBe('x2');
  });

  it('does NOT clear on a mid-flight running poll', () => {
    expect(parseBackgroundCompletion('<task_id>bfzrk3tz9</task_id><status>running</status>')).toBeNull();
  });

  it('returns null when there is no task_id', () => {
    expect(parseBackgroundCompletion('<status>completed</status>')).toBeNull();
  });
});

describe('BackgroundShellTracker', () => {
  it('is empty on construction', () => {
    const t = makeBackgroundShellTracker();
    expect(t.hasOutstanding()).toBe(false);
    expect(t.count()).toBe(0);
    expect(t.outstandingIds()).toEqual([]);
  });

  it('flags a launched shell as outstanding until its terminal retrieval', () => {
    const t = makeBackgroundShellTracker();
    t.noteToolResult(LAUNCH_BFZRK, 1000);
    expect(t.hasOutstanding()).toBe(true);
    expect(t.outstandingIds()).toEqual(['bfzrk3tz9']);

    // A running poll keeps it outstanding.
    t.noteToolResult('<task_id>bfzrk3tz9</task_id><status>running</status>', 2000);
    expect(t.hasOutstanding()).toBe(true);

    // Terminal retrieval clears it.
    t.noteToolResult('<task_id>bfzrk3tz9</task_id><status>completed</status><exit_code>0</exit_code>', 3000);
    expect(t.hasOutstanding()).toBe(false);
  });

  it('reproduces the screenshot gap: launch + turn ends, shell still outstanding', () => {
    // This is the 672181b9 sequence — the deploy launches and the turn ends with
    // "Stand by." No retrieval arrives in this turn, so the shell stays outstanding
    // while the card reads DONE. That is exactly the signal we want to surface.
    const t = makeBackgroundShellTracker();
    t.noteToolResult(LAUNCH_BFZRK, 1000);
    expect(t.count()).toBe(1);
    expect(t.outstandingIds()).toEqual(['bfzrk3tz9']);
  });

  it('tracks multiple concurrent shells independently, in launch order', () => {
    const t = makeBackgroundShellTracker();
    t.noteToolResult(LAUNCH_B5LKU, 1000);
    t.noteToolResult(LAUNCH_BFZRK, 1500);
    expect(t.outstandingIds()).toEqual(['b5lku6yoc', 'bfzrk3tz9']);

    t.noteToolResult('<task_id>b5lku6yoc</task_id><status>completed</status>', 2000);
    expect(t.outstandingIds()).toEqual(['bfzrk3tz9']);
  });

  it('does not reset a shell\'s start time when its launch banner is re-seen', () => {
    const t = makeBackgroundShellTracker();
    t.noteToolResult(LAUNCH_BFZRK, 1000);
    t.noteToolResult(LAUNCH_BFZRK, 9000); // replay (truncation re-read)
    // Start time stays 1000, so it prunes against the original launch.
    t.prune(1000 + BACKGROUND_SHELL_CEILING_MS + 1, BACKGROUND_SHELL_CEILING_MS);
    expect(t.hasOutstanding()).toBe(false);
  });

  it('an unknown completion id is a harmless no-op (e.g. local_agent retrieval)', () => {
    const t = makeBackgroundShellTracker();
    t.noteToolResult(LAUNCH_BFZRK, 1000);
    t.noteToolResult(COMPLETION_B3O9, 2000); // b3o9dv2x1 was never tracked here
    expect(t.outstandingIds()).toEqual(['bfzrk3tz9']);
  });

  it('prunes shells past the hard ceiling (abandoned / missed completion)', () => {
    const t = makeBackgroundShellTracker();
    t.noteToolResult(LAUNCH_BFZRK, 1000);
    t.prune(1000 + BACKGROUND_SHELL_CEILING_MS - 1, BACKGROUND_SHELL_CEILING_MS);
    expect(t.hasOutstanding()).toBe(true); // not yet
    t.prune(1000 + BACKGROUND_SHELL_CEILING_MS + 1, BACKGROUND_SHELL_CEILING_MS);
    expect(t.hasOutstanding()).toBe(false);
  });

  it('reset and dispose clear all state', () => {
    const t = makeBackgroundShellTracker();
    t.noteToolResult(LAUNCH_BFZRK, 1000);
    t.reset();
    expect(t.hasOutstanding()).toBe(false);
    t.noteToolResult(LAUNCH_B5LKU, 1000);
    t.dispose();
    expect(t.hasOutstanding()).toBe(false);
  });
});
