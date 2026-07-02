import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { validateRecord, getToolUseBlocks } from './jsonlValidator.js';
import { entryFromRecord, renderTranscript } from './transcriptRenderer.js';
import { parseEditInput, type EditInput } from './detailShared.js';
import type { JsonlRecord } from './types.js';

/**
 * Phase 4 (DESIGN-DETAIL-PANE-V2.md): three native "escape hatch" commands
 * that push out of the log webview into real VS Code editor primitives —
 * a raw JSON record, a whole-transcript markdown pop-out, and a native diff
 * of an Edit's before/after. Each is registered as an independent
 * `vscode.commands.registerCommand` in extension.ts and can be cut on its
 * own (comment out its registration; the webview button still posts a
 * message, detailPanel.ts's `executeCommand` call then simply rejects —
 * silently swallowed there — and the click is a no-op).
 *
 * Design-doc risk #1 (an unverified live-refresh jank risk for the
 * transcript pop-out) is resolved by NOT taking it: every document served
 * here is a SNAPSHOT, registered once under a freshly minted, never-reused
 * URI. `onDidChange` exists only to satisfy the `TextDocumentContentProvider`
 * interface — it is never fired. A re-invoke of any of the three commands
 * therefore opens a brand-new tab (a fresh token/URI), not a live update to
 * an existing one; this is the "re-invoke re-snapshots" behaviour the design
 * doc calls for.
 *
 * No fs read here is unbounded: every host-side re-scan of a transcript
 * file is capped at MAX_TRANSCRIPT_READ_BYTES (8MB, matching
 * workflowDiscovery.ts's STATS_MAX_BYTES precedent for a per-agent
 * transcript read) and refuses politely beyond it, rather than the 50MB
 * tail-window trick DetailPanel's live cache uses — there is no "always show
 * the tail" requirement for a single-record/single-edit lookup, so a flat
 * refusal is simpler and just as honest.
 */

/** URI scheme for every native-doc virtual document this module serves.
 *  Registered once against `NativeDocsProvider` in extension.ts. */
export const NATIVE_DOCS_SCHEME = 'serac-detail';

/** Content-addressed by a random, one-shot token — never a file path, so
 *  there is no path-traversal surface in the URI itself (VS Code resolves
 *  `provideTextDocumentContent` purely from `uri.query`, an opaque key into
 *  this in-memory map). "One-shot" describes how the token is minted (fresh
 *  per `register()` call, never derived from anything guessable or reused
 *  across invocations) — NOT that it is deleted after a single read: VS Code
 *  can legitimately re-invoke `provideTextDocumentContent` for the same open
 *  document (e.g. a split-editor duplicate), so eviction is capacity- and
 *  lifecycle-driven instead (see MAX_TOKENS and `clear()`). */
const MAX_TOKENS = 32;

export interface NativeDocResult {
  ok: boolean;
  error?: string;
}

/** The provider backing every native-doc virtual document. One instance is
 *  constructed in extension.ts and registered for NATIVE_DOCS_SCHEME; the
 *  same instance is threaded into each command's closure so they all share
 *  one token map. */
export class NativeDocsProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>(); // token -> content, insertion-ordered
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  /** Never fired (see module docstring) — declared only so this satisfies
   *  `vscode.TextDocumentContentProvider`. */
  readonly onDidChange = this.emitter.event;

  /** Register `content` under a fresh token and return the URI that serves
   *  it. `pathHint` becomes the visible tab title (sanitised — see
   *  `sanitiseLabel`); `ext` drives VS Code's language detection from the
   *  URI path (`json`/`md`, or the edited file's own extension for a diff
   *  pane) — no explicit `languageId` needed. */
  register(pathHint: string, content: string, ext: string): vscode.Uri {
    const token = randomBytes(16).toString('hex');
    this.store.set(token, content);
    this.evictIfNeeded();
    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '') || 'txt';
    const safeName = sanitiseLabel(pathHint);
    return vscode.Uri.parse(`${NATIVE_DOCS_SCHEME}:/${safeName}.${safeExt}?${token}`);
  }

  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    return this.store.get(uri.query);
  }

  private evictIfNeeded(): void {
    while (this.store.size > MAX_TOKENS) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) { break; }
      this.store.delete(oldest);
    }
  }

  /** Drop every cached snapshot — called when the detail panel that produced
   *  them closes (see DetailPanelDeps.clearNativeDocsCache), the second of
   *  the two eviction paths noted in the module docstring. Already-open
   *  editor tabs keep showing their last-served content (VS Code caches a
   *  TextDocument's text client-side once opened); this only stops NEW
   *  requests for those tokens from resolving. */
  clear(): void {
    this.store.clear();
  }

  dispose(): void {
    this.clear();
    this.emitter.dispose();
  }
}

const MAX_LABEL_CHARS = 80;
/** Anything outside this set is replaced with `_` — deliberately restrictive
 *  (word chars, space, dot, parens, hyphen) so the sanitised label can be
 *  dropped straight into a URI PATH SEGMENT with no percent-encoding step:
 *  there is nothing left in it that a URI parser would treat specially. */
const UNSAFE_LABEL_CHARS = /[^\w .()-]/g;

/** A display label (agent name, filename) made safe for both a URI path
 *  segment and a plain-text title suffix. Never empty — falls back to
 *  'agent' so a stripped-to-nothing label still produces a valid URI. */
export function sanitiseLabel(s: string): string {
  const cleaned = (s || '').replace(UNSAFE_LABEL_CHARS, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, MAX_LABEL_CHARS) || 'agent';
}

/** Per-agent transcript re-scan cap (see module docstring's rationale for why
 *  this is a flat 8MB refusal, not the 50MB tail-window DetailPanel's live
 *  cache uses). */
const MAX_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;

export type RecordLookupResult =
  | { ok: true; record: JsonlRecord }
  | { ok: false; reason: 'too-large' | 'not-found' | 'read-error' };

function lookupErrorMessage(reason: 'too-large' | 'not-found' | 'read-error'): string {
  if (reason === 'too-large') { return 'Transcript is too large to re-open here (over 8MB) — try the classic view instead.'; }
  if (reason === 'not-found') { return 'Could not find that record — the transcript may have changed since it was loaded.'; }
  return 'Could not read the transcript file.';
}

/** Read `filePath` once (size-capped) and return its complete-line, parsed
 *  content as raw text — shared by both scan functions below so the cap and
 *  the "how do we read this file" logic lives in exactly one place. */
async function readCappedTranscript(filePath: string): Promise<{ ok: true; raw: string } | { ok: false; reason: 'too-large' | 'read-error' }> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { ok: false, reason: 'read-error' };
  }
  if (stat.size > MAX_TRANSCRIPT_READ_BYTES) { return { ok: false, reason: 'too-large' }; }
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return { ok: true, raw };
  } catch {
    return { ok: false, reason: 'read-error' };
  }
}

/** Walk `filePath`, applying the SAME acceptance filter `entryFromRecord`
 *  applies (transcriptRenderer.ts) — a record only counts towards the index
 *  if `entryFromRecord` would have turned it into a TranscriptEntry — and
 *  return the `entryIndex`-th accepted record. This is what keeps the
 *  webview's row index and this re-scan's record aligned: both walk the
 *  exact same records, in the exact same order, through the exact same
 *  filter (see nativeDocs.test.ts's alignment test against `parseTranscript`,
 *  the module that already relies on this invariant). */
export async function findRecordByEntryIndex(filePath: string, entryIndex: number): Promise<RecordLookupResult> {
  const read = await readCappedTranscript(filePath);
  if (!read.ok) { return read; }
  let count = -1;
  for (const line of read.raw.split('\n')) {
    if (!line.trim()) { continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const record = validateRecord(parsed);
    if (!record) { continue; }
    if (!entryFromRecord(record)) { continue; }
    count++;
    if (count === entryIndex) { return { ok: true, record }; }
  }
  return { ok: false, reason: 'not-found' };
}

/** Walk `filePath` for the FIRST assistant record whose primary tool_use is
 *  an `Edit` targeting `targetPath` exactly — the Result strip's file-chip
 *  flow (DESIGN-DETAIL-PANE-V2.md Phase 4: "that file's FIRST edit in the
 *  transcript"). Unlike findRecordByEntryIndex this is a predicate scan, not
 *  an index walk, so it does NOT apply entryFromRecord's filter (an Edit
 *  tool_use always passes it anyway — this just doesn't need to reproduce
 *  that logic for a scan that's already narrowly typed). */
export async function findFirstEditForFile(filePath: string, targetPath: string): Promise<RecordLookupResult> {
  const read = await readCappedTranscript(filePath);
  if (!read.ok) { return read; }
  for (const line of read.raw.split('\n')) {
    if (!line.trim()) { continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const record = validateRecord(parsed);
    if (!record || record.type !== 'assistant') { continue; }
    for (const block of getToolUseBlocks(record)) {
      if (block.name !== 'Edit') { continue; }
      if (block.input && block.input.file_path === targetPath) { return { ok: true, record }; }
    }
  }
  return { ok: false, reason: 'not-found' };
}

/** Extract an Edit's file_path/old_string/new_string from a raw JsonlRecord
 *  (as returned by the two scan functions above), reusing `parseEditInput`
 *  (detailShared.ts) for the actual field validation — the SAME function the
 *  webview uses to decide whether to show the "Show file changes" button, so
 *  the two sides can never disagree on what counts as a valid Edit. */
export function editInputFromRecord(record: JsonlRecord): EditInput | null {
  if (record.type !== 'assistant') { return null; }
  const primary = getToolUseBlocks(record)[0];
  if (!primary || primary.name !== 'Edit' || primary.input === undefined) { return null; }
  let raw: string;
  try {
    raw = JSON.stringify(primary.input) || '';
  } catch {
    return null;
  }
  return parseEditInput(raw);
}

function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '(could not serialise this record)';
  }
}

function extOf(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, '');
  return ext || 'txt';
}

function basenameOf(filePath: string): string {
  return path.basename(filePath) || filePath;
}

async function openDoc(uri: vscode.Uri): Promise<NativeDocResult> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    // `preview: false` — each opened doc is a real, persistent tab (never
    // reused/replaced by the next preview-mode open), which is the whole
    // point of "pinning two agents' transcripts side by side as real tabs".
    await vscode.window.showTextDocument(doc, { preview: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not open the document.' };
  }
}

// ── Command 1: View raw JSON ────────────────────────────────────────────

export async function showRawRecordDoc(
  provider: NativeDocsProvider, filePath: string, entryIndex: number, label: string,
): Promise<NativeDocResult> {
  const found = await findRecordByEntryIndex(filePath, entryIndex);
  if (!found.ok) { return { ok: false, error: lookupErrorMessage(found.reason) }; }
  const pretty = safePrettyJson(found.record);
  const uri = provider.register(sanitiseLabel(label) + '-record-' + entryIndex, pretty, 'json');
  return openDoc(uri);
}

// ── Command 2: Open transcript in editor ────────────────────────────────

/** Timestamp suffix for the pop-out's tab title/filename — HHhMMmSS local
 *  time is enough to distinguish successive re-invokes without being as
 *  noisy as a full ISO stamp. */
function snapshotStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
}

/** Reuses `renderTranscript()` (transcriptRenderer.ts) UNMODIFIED — it
 *  writes the rendered markdown to `.claude/transcripts/<label>.md` in the
 *  workspace (its existing, accepted side effect: the pre-Phase-4
 *  "view session transcript" command already does this) and returns that
 *  path. We then read the written file back and re-serve its content as a
 *  SNAPSHOT virtual document — decoupling the editor tab from the on-disk
 *  file, so a stray edit in the tab can never corrupt anything on disk, and
 *  a re-invoke (which overwrites the same on-disk path) produces a brand
 *  new tab rather than mutating an old one. `agentIdForFile` is used only
 *  for the transient on-disk filename — it's already validated
 *  (isValidSessionId) by the caller, so it's path-safe. */
export async function openTranscriptDocDoc(
  provider: NativeDocsProvider, workspacePath: string, filePath: string, agentIdForFile: string, label: string,
): Promise<NativeDocResult> {
  let outputPath: string;
  try {
    outputPath = await renderTranscript(filePath, agentIdForFile, workspacePath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not render the transcript.' };
  }
  let content: string;
  try {
    content = await fs.promises.readFile(outputPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not read the rendered transcript.' };
  }
  const stamp = snapshotStamp(new Date());
  const pathHint = sanitiseLabel(label) + '-transcript-' + stamp;
  const uri = provider.register(pathHint, content, 'md');
  return openDoc(uri);
}

// ── Command 3: Show file changes ────────────────────────────────────────

export type FileChangeTarget = { entryIndex: number } | { targetPath: string };

export async function showFileChangesDoc(
  provider: NativeDocsProvider, filePath: string, target: FileChangeTarget, label: string,
): Promise<NativeDocResult> {
  const found = 'entryIndex' in target
    ? await findRecordByEntryIndex(filePath, target.entryIndex)
    : await findFirstEditForFile(filePath, target.targetPath);
  if (!found.ok) { return { ok: false, error: lookupErrorMessage(found.reason) }; }
  const edit = editInputFromRecord(found.record);
  if (!edit) { return { ok: false, error: 'This is not an Edit call with both old_string and new_string.' }; }
  const base = basenameOf(edit.filePath);
  const ext = extOf(edit.filePath);
  // The honesty label from the design doc: this is the edit's own
  // before/after, not a live repo diff (the file may have changed further
  // since, or the edit may never have been applied at all if it errored).
  const title = base + ' — as edited by ' + sanitiseLabel(label);
  const leftUri = provider.register(base + ' (before)', edit.oldString, ext);
  const rightUri = provider.register(base + ' (after)', edit.newString, ext);
  try {
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not open the diff.' };
  }
}

// ── Command factories (bound in extension.ts) ───────────────────────────
// Each wraps one of the functions above with the user-facing failure surface
// (a warning toast — the same pattern extension.ts's other one-off commands
// already use, e.g. setTranscriptHandler's "Failed to render transcript").
// This is a DIFFERENT posture from the teammate-composer's in-webview-only
// errors: that feature suppresses toasts because sends are frequent and a
// repeated toast would be disruptive; these are one-off, explicit clicks,
// so a single toast on failure is the established, expected pattern here.

export interface ShowRawRecordArgs { filePath: string; entryIndex: number; label: string }
export interface OpenTranscriptDocArgs { filePath: string; agentId: string; label: string }
export interface ShowFileChangesArgs { filePath: string; target: FileChangeTarget; label: string }

export function makeShowRawRecordCommand(provider: NativeDocsProvider): (args: ShowRawRecordArgs) => Promise<void> {
  return async (args) => {
    const result = await showRawRecordDoc(provider, args.filePath, args.entryIndex, args.label);
    if (!result.ok) { void vscode.window.showWarningMessage(result.error ?? 'Could not open the raw record.'); }
  };
}

export function makeOpenTranscriptDocCommand(provider: NativeDocsProvider, workspacePath: string): (args: OpenTranscriptDocArgs) => Promise<void> {
  return async (args) => {
    const result = await openTranscriptDocDoc(provider, workspacePath, args.filePath, args.agentId, args.label);
    if (!result.ok) { void vscode.window.showWarningMessage(result.error ?? 'Could not open the transcript.'); }
  };
}

export function makeShowFileChangesCommand(provider: NativeDocsProvider): (args: ShowFileChangesArgs) => Promise<void> {
  return async (args) => {
    const result = await showFileChangesDoc(provider, args.filePath, args.target, args.label);
    if (!result.ok) { void vscode.window.showWarningMessage(result.error ?? 'Could not open the file changes.'); }
  };
}
