/**
 * JSONL record validation and content extraction helpers.
 *
 * Single entry point for structural validation, timestamp normalisation,
 * and typed content block extraction. Reduces JSONL format coupling by
 * providing shared utilities that all consumers use instead of inline parsing.
 *
 * Consumers: sessionManager, transcriptRenderer, sessionRepair, jsonlTailer.
 */

import type { JsonlRecord, JsonlContentBlock } from './types.js';

// ── Record validation ──────────────────────────────────────────────

/** Validate and normalise a raw parsed JSON value into a JsonlRecord.
 *  Returns null for malformed records (not an object, missing type field). */
export function validateRecord(raw: unknown): JsonlRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !obj.type) return null;
  return obj as JsonlRecord;
}

/** Parse a JSONL timestamp string into a Date. Returns current time for
 *  missing/malformed timestamps (prevents NaN propagation). */
export function parseTimestamp(timestamp: string | undefined): Date {
  if (!timestamp) return new Date();
  const parsed = new Date(timestamp);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

// ── Type guards (discriminated union refinement) ───────────────────

export function isUserRecord(record: JsonlRecord): record is JsonlRecord & { type: 'user' } {
  return record.type === 'user';
}

export function isAssistantRecord(record: JsonlRecord): record is JsonlRecord & { type: 'assistant' } {
  return record.type === 'assistant';
}

export function isProgressRecord(record: JsonlRecord): record is JsonlRecord & { type: 'progress' } {
  return record.type === 'progress';
}

export function isSystemRecord(record: JsonlRecord): record is JsonlRecord & { type: 'system' } {
  return record.type === 'system';
}

export function isQueueOperation(record: JsonlRecord): record is JsonlRecord & { type: 'queue-operation' } {
  return record.type === 'queue-operation';
}

export function isCustomTitle(record: JsonlRecord): record is JsonlRecord & { type: 'custom-title' } {
  return record.type === 'custom-title';
}

export function isSidechain(record: JsonlRecord): record is JsonlRecord & { isSidechain: true } {
  return record.isSidechain === true;
}

/** Whether the record type contributes to session lastActivity timestamps.
 *  Only main-thread user/assistant records are "meaningful" for display timing. */
export function isMeaningfulRecord(record: JsonlRecord): boolean {
  return (record.type === 'user' || record.type === 'assistant') && !record.isSidechain;
}

/** Whether the record is a metadata record used by session discovery/repair
 *  (custom-title, last-prompt, summary). */
export function isMetadataRecord(record: JsonlRecord): boolean {
  return record.type === 'custom-title'
    || record.type === 'last-prompt'
    || record.type === 'summary';
}

// ── Content block extraction ───────────────────────────────────────

/** Get the content blocks array from a record, defaulting to empty.
 *  Safe for both user and assistant records. */
export function getContentBlocks(record: JsonlRecord): JsonlContentBlock[] {
  return record.message?.content || [];
}

/** Extract all text blocks from a record's content. */
export function getTextBlocks(record: JsonlRecord): JsonlContentBlock[] {
  return getContentBlocks(record).filter(b => b.type === 'text' && b.text);
}

/** Extract all tool_use blocks from a record's content. */
export function getToolUseBlocks(record: JsonlRecord): JsonlContentBlock[] {
  return getContentBlocks(record).filter(b => b.type === 'tool_use' && b.id && b.name);
}

/** Extract all tool_result blocks from a record's content. */
export function getToolResultBlocks(record: JsonlRecord): JsonlContentBlock[] {
  return getContentBlocks(record).filter(b => b.type === 'tool_result' && b.tool_use_id);
}

/** Get the first text string from a record's content blocks.
 *  Useful for topic extraction and title generation. */
export function getFirstText(record: JsonlRecord): string | null {
  for (const block of getContentBlocks(record)) {
    if (block.type === 'text' && block.text) {
      return block.text.trim();
    }
  }
  return null;
}

/** Get the model ID from an assistant record. */
export function getModelId(record: JsonlRecord): string | null {
  const msg = record.message as Record<string, unknown> | undefined;
  const model = msg?.model;
  return typeof model === 'string' ? model : null;
}

/** Get token usage from an assistant record. Returns total input tokens
 *  (input + cache_creation + cache_read) or null if not present. */
export function getInputTokens(record: JsonlRecord): number | null {
  const msg = record.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, number> | undefined;
  if (!usage) return null;
  const total = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  return total > 0 ? total : null;
}

/** Get the progress data type from a progress record (e.g. 'agent_progress'). */
export function getProgressType(record: JsonlRecord): string | null {
  const dataType = record.data?.type;
  return typeof dataType === 'string' ? dataType : null;
}
