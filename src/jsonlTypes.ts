/**
 * Raw JSONL transcript record types. Part of the domain-split type modules —
 * import from './types.js' (the central re-export) unless you are inside
 * another type module.
 */

/** Known JSONL record types that the extension processes */
export type JsonlRecordType =
  | 'user'
  | 'assistant'
  | 'progress'
  | 'system'
  | 'queue-operation'
  | 'tool_result'
  | 'result'
  | 'custom-title'
  | 'ai-title'
  | 'last-prompt'
  | 'summary'
  // Constant marker seen as {"type":"mode","mode":"normal",...} — surveyed
  // 2026-07-07 across ~2,870 real occurrences, always "normal". NOT a
  // permission-mode signal (an earlier note here assumed it was; corrected).
  // Purpose otherwise unconfirmed.
  | 'mode'
  // Permission-mode change marker: {"type":"permission-mode","permissionMode":
  // "auto"|"acceptEdits"|"default"|"plan"|"dontAsk",...}. The `permissionMode`
  // field also rides on every plain `user` record (far more frequent — see
  // JsonlRecord.permissionMode). This is the real auto-accept-aware permission
  // timer signal (see isAutoAcceptPermissionMode in toolProfiles.ts).
  | 'permission-mode'
  // Remote Control bridge enrolment marker: {"type":"bridge-session",
  // "sessionId":..., "bridgeSessionId":"cse_...", "lastSequenceNum":N,
  // "ownerAccountUuid":..., "ownerOrganizationUuid":...}. Written at session
  // start when the account has Remote Control enabled and re-emitted on
  // reconnects. Carries NO uuid and NO timestamp. Surveyed 2026-08-20 across
  // 154 real records: sessionId always matches the containing file (no
  // resume/compaction carry-over observed).
  // The DROP shape, written by the binary's `clearBridgeSession` when the
  // bridge tears down: {"type":"bridge-session","sessionId":...,
  // "bridgeSessionId":"","lastSequenceNum":0} — same type, EMPTY id, no owner
  // fields. Written when Remote Control is toggled off for the session (the
  // popup's X or `/remote-control`); the session is then absent from the
  // phone until `/remote-control` is run again or the chat is closed and
  // reopened (new `cse_` id either way).
  // Parsed into SessionState.bridgeState (sessionTypes.ts).
  | 'bridge-session'
  // Serac's own marker, appended once by the phone-session transfer flow
  // (transcriptEntrypoint.ts) after it rewrites every record's `entrypoint`
  // from `sdk-cli` to `claude-vscode`: {"type":"serac-transfer","sessionId":
  // ...,"fromEntrypoint":"sdk-cli","toEntrypoint":"claude-vscode","at":ISO}.
  // Records the original value so the change is visible and reversible in
  // the file itself. Claude Code ignores record types it does not know.
  | 'serac-transfer'
  // Harness context deltas (deferred_tools_delta, skill_listing, ...) under an
  // `attachment` object. Not session-state relevant; skipped.
  | 'attachment'
  | (string & {}); // allows any string but provides autocomplete for known types

/** Raw JSONL record from Claude Code transcript files */
export interface JsonlRecord {
  type: JsonlRecordType;
  sessionId?: string;
  slug?: string;
  cwd?: string;
  /** The session's permission mode at the time of this record — carried on
   *  every `user` record and the dedicated `permission-mode` record type. See
   *  isAutoAcceptPermissionMode() in toolProfiles.ts. Also feeds
   *  SessionState.permissionMode directly (arrives well before the
   *  hook-derived PreToolUse enrichment, which requires the model to have
   *  already invoked a tool). */
  permissionMode?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  message?: {
    // The Anthropic message shape allows `content` to be either an array of
    // blocks or a plain string. Main-session records use the array form, but a
    // workflow/agent record-0 (the inception brief) arrives as a string — see
    // getContentBlocks(), which normalises the string case to a single text block.
    content?: JsonlContentBlock[] | string;
  };
  data?: {
    type?: string;
    [key: string]: unknown;
  };
  toolUseID?: string;
  parentToolUseID?: string;
  subtype?: string;
  operation?: string;
  customTitle?: string;
  /** Auto-generated title from `ai-title` records */
  aiTitle?: string;
  /** Remote Control bridge session id (`cse_...`) from `bridge-session`
   *  records; the empty string is the drop marker (see JsonlRecordType). */
  bridgeSessionId?: string;
  /** Which front end wrote the record: `claude-vscode` (the VS Code panel),
   *  `cli`, `claude-desktop`, or `sdk-cli` for a Remote Control-hosted
   *  session driven from the phone. Stamped on user/assistant/system records;
   *  absent on `queue-operation`, `last-prompt`, `atis-latch`. The Claude Code
   *  panel refuses to restore transcripts whose value is `sdk-cli`. */
  entrypoint?: string;
  [key: string]: unknown;
}

export interface JsonlContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  [key: string]: unknown;
}
