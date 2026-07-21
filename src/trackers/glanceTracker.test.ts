import { describe, it, expect, beforeEach } from 'vitest';
import { makeGlanceTracker, type GlanceTracker } from './glanceTracker.js';
import type { JsonlRecord } from '../types.js';

function userRecord(text: string): JsonlRecord {
  return {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text }] },
  } as JsonlRecord;
}

function fileHistoryRecord(paths: string[]): JsonlRecord {
  const backups: Record<string, unknown> = {};
  for (const p of paths) { backups[p] = {}; }
  return {
    type: 'file-history-snapshot',
    timestamp: new Date().toISOString(),
    snapshot: { trackedFileBackups: backups },
  } as unknown as JsonlRecord;
}

let tracker: GlanceTracker;

beforeEach(() => {
  tracker = makeGlanceTracker();
});

describe('topic extraction', () => {
  it('takes the first line of the first user message, capped at 60 chars', () => {
    tracker.onUserRecord(userRecord('Fix the login bug\nmore detail here'));
    expect(tracker.getTopic()).toBe('Fix the login bug');

    tracker.onUserRecord(userRecord('x'.repeat(100)));
    expect(tracker.getTopic()).toBe('Fix the login bug'); // sticky
  });

  it('caps a long first line at 60 chars', () => {
    tracker.onUserRecord(userRecord('a'.repeat(100)));
    expect(tracker.getTopic()).toHaveLength(60);
  });

  it('skips system injections (leading <)', () => {
    tracker.onUserRecord(userRecord('<system-reminder>noise</system-reminder>'));
    expect(tracker.getTopic()).toBe('');
    tracker.onUserRecord(userRecord('Real prompt'));
    expect(tracker.getTopic()).toBe('Real prompt');
  });

  it('extracts the title from a HANDOFF-PROMPT prefix', () => {
    tracker.onUserRecord(userRecord('HANDOFF-PROMPT: Migrate auth to OAuth'));
    expect(tracker.getTopic()).toBe('Migrate auth to OAuth');
  });

  it('rewrites a /continue path prompt to the project folder name', () => {
    tracker.onUserRecord(userRecord('Continuing: /Users/x/repos/serac'));
    expect(tracker.getTopic()).toBe('Continuing: serac');
  });

  it('topic survives reset() (compaction lands as a truncation)', () => {
    tracker.onUserRecord(userRecord('Original topic'));
    tracker.reset();
    expect(tracker.getTopic()).toBe('Original topic');
  });
});

describe('gitBranch capture', () => {
  it('captures a branch and suppresses the literal HEAD', () => {
    tracker.onGitBranch('feature/x');
    expect(tracker.snapshotFields().gitBranch).toBe('feature/x');

    tracker.onGitBranch('HEAD'); // detached / non-git — differentiates nothing
    expect(tracker.snapshotFields().gitBranch).toBe('feature/x');

    tracker.onGitBranch('main'); // real branch overwrites
    expect(tracker.snapshotFields().gitBranch).toBe('main');
  });

  it('ignores non-string and empty values', () => {
    tracker.onGitBranch(undefined);
    tracker.onGitBranch(42);
    tracker.onGitBranch('');
    expect(tracker.snapshotFields().gitBranch).toBeUndefined();
  });
});

describe('tracked files (file-history-snapshot)', () => {
  it('is latest-wins and reports whether the set changed', () => {
    expect(tracker.onFileHistorySnapshot(fileHistoryRecord(['a.ts', 'b.ts']))).toBe(true);
    expect(tracker.snapshotFields().trackedFiles).toEqual(['a.ts', 'b.ts']);

    // Same set again — no change
    expect(tracker.onFileHistorySnapshot(fileHistoryRecord(['a.ts', 'b.ts']))).toBe(false);

    // Shrinks to the latest record's set, not a union
    expect(tracker.onFileHistorySnapshot(fileHistoryRecord(['c.ts']))).toBe(true);
    expect(tracker.snapshotFields().trackedFiles).toEqual(['c.ts']);
  });

  it('ignores malformed snapshots', () => {
    expect(tracker.onFileHistorySnapshot({ type: 'file-history-snapshot', timestamp: '' } as JsonlRecord)).toBe(false);
    expect(tracker.onFileHistorySnapshot({
      type: 'file-history-snapshot', timestamp: '', snapshot: { trackedFileBackups: ['not-an-object'] },
    } as unknown as JsonlRecord)).toBe(false);
    expect(tracker.snapshotFields().trackedFiles).toBeUndefined();
  });
});

describe('assistant preview + tool errors', () => {
  it('keeps the prior preview when a block is all headings/rules', () => {
    tracker.onAssistantText('Fixed the flaky test by pinning the clock.');
    tracker.onAssistantText('## Status\n---\n**Done this session**');
    expect(tracker.snapshotFields().lastAssistantText)
      .toBe('Fixed the flaky test by pinning the clock.');
  });

  it('counts tool errors and omits zero counts from the snapshot', () => {
    expect(tracker.snapshotFields().toolErrorCount).toBeUndefined();
    tracker.onToolError();
    tracker.onToolError();
    expect(tracker.snapshotFields().toolErrorCount).toBe(2);
  });
});

describe('reset', () => {
  it('clears everything except topic', () => {
    tracker.onUserRecord(userRecord('Sticky topic'));
    tracker.onGitBranch('main');
    tracker.onToolError();
    tracker.onAssistantText('Some preview text that is long enough to keep.');
    tracker.onFileHistorySnapshot(fileHistoryRecord(['a.ts']));

    tracker.reset();

    const fields = tracker.snapshotFields();
    expect(fields.gitBranch).toBeUndefined();
    expect(fields.toolErrorCount).toBeUndefined();
    expect(fields.lastAssistantText).toBeUndefined();
    expect(fields.trackedFiles).toBeUndefined();
    expect(tracker.getTopic()).toBe('Sticky topic');
  });
});
