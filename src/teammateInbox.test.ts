/**
 * Tests for teammateInbox — Serac's only write into ~/.claude/. Uses real fs
 * fixtures in tmpdir (the module is fs- and security-heavy; mocking would hide
 * the very confinement/atomicity behaviour under test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Partial fs mock: real behaviour throughout, except mkdirSync can be made to
// throw EEXIST once *after* creating the directory — faithfully simulating a
// second writer (another VS Code window) winning the inboxes/ creation race.
// Every other fs call (and mkdirSync when the flag is off) is the genuine one.
const fsCtl = vi.hoisted(() => ({ mkdirEexistOnce: false }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mkdirSync = ((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
    const r = actual.mkdirSync(p, opts);
    if (fsCtl.mkdirEexistOnce) {
      fsCtl.mkdirEexistOnce = false;
      const e = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
      e.code = 'EEXIST';
      throw e;
    }
    return r;
  }) as typeof actual.mkdirSync;
  return { ...actual, default: actual, mkdirSync };
});

import {
  appendInboxMessage, validateMessageText, InboxError, MAX_TEXT, _resetQueues,
  peekInboxMessages,
} from './teammateInbox.js';

let teamsDir: string;
const TEAM = 'my-team';
const MEMBER = 'reviewer';

/** Build <teamsDir>/<TEAM>/ (optionally with an inboxes dir). */
function makeTeam(withInboxes = true): string {
  const teamPath = path.join(teamsDir, TEAM);
  fs.mkdirSync(teamPath, { recursive: true });
  if (withInboxes) { fs.mkdirSync(path.join(teamPath, 'inboxes')); }
  return teamPath;
}

function inboxFile(member = MEMBER): string {
  return path.join(teamsDir, TEAM, 'inboxes', `${member}.json`);
}

function readInbox(member = MEMBER): unknown[] {
  return JSON.parse(fs.readFileSync(inboxFile(member), 'utf8'));
}

function send(over: Partial<Parameters<typeof appendInboxMessage>[0]> = {}): Promise<void> {
  return appendInboxMessage({
    teamsDir, teamDir: TEAM, member: MEMBER, from: 'murray', text: 'hello', ...over,
  });
}

beforeEach(() => {
  teamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serac-inbox-'));
  _resetQueues();
});

afterEach(() => {
  fs.rmSync(teamsDir, { recursive: true, force: true });
});

describe('validateMessageText', () => {
  it('accepts ordinary text and returns the NFKC-normalised form', () => {
    const r = validateMessageText('please review ①'); // ① → NFKC "1"
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.text).toBe('please review 1'); }
  });

  it('allows newlines and tabs', () => {
    const r = validateMessageText('line one\n\tline two');
    expect(r.ok).toBe(true);
  });

  it('rejects empty / non-string', () => {
    expect(validateMessageText('').ok).toBe(false);
    expect(validateMessageText(undefined).ok).toBe(false);
    expect(validateMessageText(123).ok).toBe(false);
  });

  it('rejects over-length', () => {
    expect(validateMessageText('a'.repeat(MAX_TEXT + 1)).ok).toBe(false);
    expect(validateMessageText('a'.repeat(MAX_TEXT)).ok).toBe(true);
  });

  it('rejects bidi override and zero-width characters', () => {
    expect(validateMessageText('safe‮evil').ok).toBe(false); // RLO
    expect(validateMessageText('a​b').ok).toBe(false);       // zero-width space
    expect(validateMessageText('a﻿b').ok).toBe(false);       // BOM
    expect(validateMessageText('ab').ok).toBe(false);       // BEL (C0)
    expect(validateMessageText('a\u061Cb').ok).toBe(false); // ALM (bidi mark outside the GP blocks)
  });
});

describe('appendInboxMessage — happy path', () => {
  it('creates the inboxes dir + file when absent and writes one well-formed entry', async () => {
    makeTeam(false); // no inboxes dir yet
    await send({ text: 'first message', from: 'murray' });
    const entries = readInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      from: 'murray', text: 'first message', color: 'blue', type: 'message', read: false,
    });
    // timestamp is a strict ISO-8601 instant
    expect((entries[0] as { timestamp: string }).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('appends to an existing empty array', async () => {
    makeTeam();
    fs.writeFileSync(inboxFile(), '[]');
    await send({ text: 'hi' });
    expect(readInbox()).toHaveLength(1);
  });

  it('preserves foreign entries verbatim when appending', async () => {
    makeTeam();
    const foreign = { from: 'team-lead', text: 'existing', timestamp: '2026-06-01T00:00:00.000Z', color: 'green', type: 'message', read: true };
    fs.writeFileSync(inboxFile(), JSON.stringify([foreign]));
    await send({ text: 'appended' });
    const entries = readInbox();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(foreign); // untouched
    expect(entries[1]).toMatchObject({ text: 'appended', read: false });
  });

  it('leaves no .tmp file behind (atomic rename)', async () => {
    makeTeam();
    await send();
    const files = fs.readdirSync(path.join(teamsDir, TEAM, 'inboxes'));
    expect(files).toEqual([`${MEMBER}.json`]);
  });
});

describe('appendInboxMessage — kill-switch (refuse to overwrite a surprising shape)', () => {
  it('refuses a non-array inbox and leaves it untouched', async () => {
    makeTeam();
    fs.writeFileSync(inboxFile(), JSON.stringify({ not: 'an array' }));
    await expect(send()).rejects.toBeInstanceOf(InboxError);
    expect(fs.readFileSync(inboxFile(), 'utf8')).toBe(JSON.stringify({ not: 'an array' }));
  });

  it('refuses invalid JSON and leaves it untouched', async () => {
    makeTeam();
    fs.writeFileSync(inboxFile(), '{ broken');
    await expect(send()).rejects.toBeInstanceOf(InboxError);
    expect(fs.readFileSync(inboxFile(), 'utf8')).toBe('{ broken');
  });

  it('refuses an array with a non-object entry', async () => {
    makeTeam();
    fs.writeFileSync(inboxFile(), JSON.stringify(['a string entry']));
    await expect(send()).rejects.toBeInstanceOf(InboxError);
  });

  it('refuses an entry carrying a forbidden (proto-pollution) key', async () => {
    makeTeam();
    // Write a raw own "__proto__" key (JSON.parse keeps it as an own prop).
    fs.writeFileSync(inboxFile(), '[{"__proto__":{"polluted":true},"text":"x"}]');
    await expect(send()).rejects.toBeInstanceOf(InboxError);
  });
});

describe('appendInboxMessage — path confinement', () => {
  it('rejects a traversal member name synchronously', async () => {
    makeTeam();
    await expect(send({ member: '../../etc/cron' })).rejects.toBeInstanceOf(InboxError);
    await expect(send({ member: 'a/b' })).rejects.toBeInstanceOf(InboxError);
    await expect(send({ member: '.hidden' })).rejects.toBeInstanceOf(InboxError);
  });

  it('rejects a traversal team dir name synchronously', async () => {
    makeTeam();
    await expect(send({ teamDir: '..' })).rejects.toBeInstanceOf(InboxError);
  });

  it('rejects an invalid operator name (from)', async () => {
    makeTeam();
    await expect(send({ from: 'has space' })).rejects.toBeInstanceOf(InboxError);
    await expect(send({ from: 'a/b' })).rejects.toBeInstanceOf(InboxError);
  });

  it('refuses to write through a symlinked inbox file', async () => {
    makeTeam();
    const outside = path.join(teamsDir, 'OUTSIDE.json');
    fs.writeFileSync(outside, JSON.stringify([]));
    fs.symlinkSync(outside, inboxFile());
    await expect(send()).rejects.toBeInstanceOf(InboxError);
    // The symlink target must be untouched.
    expect(fs.readFileSync(outside, 'utf8')).toBe(JSON.stringify([]));
  });

  it('refuses a symlinked inboxes directory', async () => {
    makeTeam(false);
    const realDir = path.join(teamsDir, 'real-inboxes');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, path.join(teamsDir, TEAM, 'inboxes'));
    await expect(send()).rejects.toBeInstanceOf(InboxError);
  });

  it('refuses a symlinked team directory', async () => {
    const realTeam = path.join(teamsDir, 'real-team');
    fs.mkdirSync(path.join(realTeam, 'inboxes'), { recursive: true });
    fs.symlinkSync(realTeam, path.join(teamsDir, TEAM));
    await expect(send()).rejects.toBeInstanceOf(InboxError);
  });

  it('rejects message text with control/invisible chars', async () => {
    makeTeam();
    await expect(send({ text: 'evil‮hidden' })).rejects.toBeInstanceOf(InboxError);
  });
});

describe('appendInboxMessage — concurrency + bounds', () => {
  it('serialises concurrent sends to one inbox with no lost updates', async () => {
    makeTeam();
    const texts = Array.from({ length: 8 }, (_, i) => `msg-${i}`);
    await Promise.all(texts.map(t => send({ text: t })));
    const entries = readInbox() as { text: string }[];
    expect(entries).toHaveLength(8);
    // All eight present (order is queue order; assert set membership).
    expect(new Set(entries.map(e => e.text))).toEqual(new Set(texts));
  });

  it('rejects sends beyond the per-inbox queue depth cap', async () => {
    makeTeam();
    // Fire 12 synchronously; the depth cap is 10, so at least one rejects.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => send({ text: `burst-${i}` })),
    );
    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InboxError);
    }
  });

  it('absorbs EEXIST when inboxes/ is created concurrently (second-writer race)', async () => {
    makeTeam(false);            // no inboxes dir — the write path will try to create it
    fsCtl.mkdirEexistOnce = true; // next mkdirSync creates the dir then reports EEXIST
    await expect(send({ text: 'survives the race' })).resolves.toBeUndefined();
    expect(readInbox()).toHaveLength(1);
    expect(fsCtl.mkdirEexistOnce).toBe(false); // the branch was exercised
  });

  it('refuses an implausibly large inbox file instead of slurping it', async () => {
    makeTeam();
    // > MAX_INBOX_READ_BYTES (4 MiB) of valid JSON — must be refused by fstat
    // size check before any parse, with the file left untouched.
    const blob = JSON.stringify([{ from: 'x', text: 'y'.repeat(5 * 1024 * 1024), timestamp: 't', color: 'blue', type: 'message', read: true }]);
    fs.writeFileSync(inboxFile(), blob);
    await expect(send({ text: 'nope' })).rejects.toThrow(/implausibly large/);
    expect(fs.readFileSync(inboxFile(), 'utf8')).toBe(blob); // untouched
  });

  it('measures the ring-buffer byte cap in UTF-8 bytes, not UTF-16 code units', async () => {
    makeTeam();
    // ~0.9M code units of CJK is ~2.7MB of UTF-8 — under the cap by .length,
    // far over it by byteLength. The old measure kept both entries; the byte
    // measure must drop the old one so the file lands under 1 MiB on disk.
    const cjk = { from: 'x', text: '気'.repeat(900_000), timestamp: 't', color: 'blue', type: 'message', read: true };
    fs.writeFileSync(inboxFile(), JSON.stringify([cjk]));
    await send({ text: 'small' });
    const onDisk = fs.statSync(inboxFile()).size;
    expect(onDisk).toBeLessThanOrEqual(1024 * 1024);
    const entries = readInbox() as { text: string }[];
    expect(entries[entries.length - 1].text).toBe('small');
  });

  it('drops an oversized foreign entry rather than blowing the byte cap', async () => {
    makeTeam();
    const huge = { from: 'x', text: 'z'.repeat(1024 * 1024 + 16), timestamp: '2026-06-01T00:00:00.000Z', color: 'blue', type: 'message', read: true };
    fs.writeFileSync(inboxFile(), JSON.stringify([huge]));
    await send({ text: 'small' });
    const entries = readInbox() as { text: string }[];
    expect(entries).toHaveLength(1);          // the >1MB foreign entry was dropped
    expect(entries[0].text).toBe('small');
  });

  it('ring-buffers an oversized inbox down (drops oldest, keeps the new entry)', async () => {
    makeTeam();
    // Seed 250 entries; the cap is 200, so after one append we expect 200 with
    // the newest at the tail and the oldest dropped.
    const seed = Array.from({ length: 250 }, (_, i) => ({
      from: 'x', text: `old-${i}`, timestamp: '2026-06-01T00:00:00.000Z', color: 'blue', type: 'message', read: true,
    }));
    fs.writeFileSync(inboxFile(), JSON.stringify(seed));
    await send({ text: 'newest' });
    const entries = readInbox() as { text: string }[];
    expect(entries).toHaveLength(200);
    expect(entries[entries.length - 1].text).toBe('newest');
    expect(entries[0].text).not.toBe('old-0'); // oldest trimmed
  });
});

describe('peekInboxMessages — read-side (queued-thread affordance)', () => {
  it('returns pending messages, sanitised and capped, after a real append', async () => {
    makeTeam();
    await send({ text: 'first' });
    await send({ text: 'second' });
    const msgs = peekInboxMessages({ teamsDir, teamDir: TEAM, member: MEMBER });
    expect(msgs.map(m => m.text)).toEqual(['first', 'second']);
    expect(msgs[0].from).toBe('murray');
    expect(typeof msgs[0].timestamp).toBe('string');
  });

  it('is fail-silent: missing inbox, malformed JSON, and symlinks all yield []', () => {
    expect(peekInboxMessages({ teamsDir, teamDir: TEAM, member: MEMBER })).toEqual([]);
    makeTeam();
    fs.writeFileSync(inboxFile(), 'not json');
    expect(peekInboxMessages({ teamsDir, teamDir: TEAM, member: MEMBER })).toEqual([]);
    fs.rmSync(inboxFile());
    fs.symlinkSync('/etc/hosts', inboxFile());
    expect(peekInboxMessages({ teamsDir, teamDir: TEAM, member: MEMBER })).toEqual([]);
  });

  it('refuses traversal in team/member just like the write path', () => {
    makeTeam();
    expect(peekInboxMessages({ teamsDir, teamDir: '../' + TEAM, member: MEMBER })).toEqual([]);
    expect(peekInboxMessages({ teamsDir, teamDir: TEAM, member: '../evil' })).toEqual([]);
  });

  it('strips bidi/control chars from foreign-written entries for display', () => {
    makeTeam();
    fs.writeFileSync(inboxFile(), JSON.stringify([
      { from: 'lead‮evil', text: 'do this‮ now', timestamp: '2026-06-10T00:00:00Z', color: 'blue', type: 'message', read: false },
    ]));
    const msgs = peekInboxMessages({ teamsDir, teamDir: TEAM, member: MEMBER });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe('leadevil');
    expect(msgs[0].text).toBe('do this now');
  });

  it('a shapeless entry trips the schema kill-switch — whole read refused', () => {
    makeTeam();
    fs.writeFileSync(inboxFile(), JSON.stringify([
      { from: 'lead', text: 'ok', timestamp: '', color: 'b', type: 'message', read: false },
      42,
    ]));
    expect(peekInboxMessages({ teamsDir, teamDir: TEAM, member: MEMBER })).toEqual([]);
  });

  it('caps a well-formed flood at 50 entries', () => {
    makeTeam();
    const entries = Array.from({ length: 60 }, (_, i) =>
      ({ from: 'lead', text: 'm' + i, timestamp: '', color: 'b', type: 'message', read: false }));
    fs.writeFileSync(inboxFile(), JSON.stringify(entries));
    const msgs = peekInboxMessages({ teamsDir, teamDir: TEAM, member: MEMBER });
    expect(msgs).toHaveLength(50);
    expect(msgs[0].text).toBe('m0');
  });
});
