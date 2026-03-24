import { describe, it, expect } from 'vitest';
import {
  validateRecord,
  parseTimestamp,
  isUserRecord,
  isAssistantRecord,
  isProgressRecord,
  isSystemRecord,
  isQueueOperation,
  isCustomTitle,
  isSidechain,
  isMeaningfulRecord,
  isMetadataRecord,
  getContentBlocks,
  getTextBlocks,
  getToolUseBlocks,
  getToolResultBlocks,
  getFirstText,
  getModelId,
  getInputTokens,
  getProgressType,
} from './jsonlValidator.js';
import type { JsonlRecord } from './types.js';

describe('validateRecord', () => {
  it('returns null for non-objects', () => {
    expect(validateRecord(null)).toBeNull();
    expect(validateRecord(undefined)).toBeNull();
    expect(validateRecord('string')).toBeNull();
    expect(validateRecord(42)).toBeNull();
    expect(validateRecord(true)).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(validateRecord([1, 2, 3])).toBeNull();
  });

  it('returns null for objects without type field', () => {
    expect(validateRecord({})).toBeNull();
    expect(validateRecord({ foo: 'bar' })).toBeNull();
  });

  it('returns null for non-string type', () => {
    expect(validateRecord({ type: 42 })).toBeNull();
    expect(validateRecord({ type: null })).toBeNull();
    expect(validateRecord({ type: '' })).toBeNull();
  });

  it('returns the record for valid objects with string type', () => {
    const record = { type: 'user', message: { content: [] } };
    expect(validateRecord(record)).toBe(record);
  });

  it('accepts any string type (extensible)', () => {
    expect(validateRecord({ type: 'unknown-future-type' })).not.toBeNull();
  });
});

describe('parseTimestamp', () => {
  it('returns current time for undefined', () => {
    const before = Date.now();
    const result = parseTimestamp(undefined);
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('returns current time for malformed string', () => {
    const before = Date.now();
    const result = parseTimestamp('not-a-date');
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('parses valid ISO timestamp', () => {
    const result = parseTimestamp('2026-03-24T10:00:00.000Z');
    expect(result.toISOString()).toBe('2026-03-24T10:00:00.000Z');
  });
});

describe('type guards', () => {
  const user: JsonlRecord = { type: 'user', message: { content: [] } };
  const assistant: JsonlRecord = { type: 'assistant', message: { content: [] } };
  const progress: JsonlRecord = { type: 'progress', data: { type: 'agent_progress' } };
  const system: JsonlRecord = { type: 'system', subtype: 'compact_boundary' };
  const queue: JsonlRecord = { type: 'queue-operation', operation: 'enqueue' };
  const title: JsonlRecord = { type: 'custom-title', customTitle: 'Test' };
  const sidechain: JsonlRecord = { type: 'user', isSidechain: true, message: { content: [] } };
  const lastPrompt: JsonlRecord = { type: 'last-prompt' };
  const summary: JsonlRecord = { type: 'summary' };

  it('isUserRecord', () => {
    expect(isUserRecord(user)).toBe(true);
    expect(isUserRecord(assistant)).toBe(false);
  });

  it('isAssistantRecord', () => {
    expect(isAssistantRecord(assistant)).toBe(true);
    expect(isAssistantRecord(user)).toBe(false);
  });

  it('isProgressRecord', () => {
    expect(isProgressRecord(progress)).toBe(true);
    expect(isProgressRecord(user)).toBe(false);
  });

  it('isSystemRecord', () => {
    expect(isSystemRecord(system)).toBe(true);
    expect(isSystemRecord(user)).toBe(false);
  });

  it('isQueueOperation', () => {
    expect(isQueueOperation(queue)).toBe(true);
    expect(isQueueOperation(user)).toBe(false);
  });

  it('isCustomTitle', () => {
    expect(isCustomTitle(title)).toBe(true);
    expect(isCustomTitle(user)).toBe(false);
  });

  it('isSidechain', () => {
    expect(isSidechain(sidechain)).toBe(true);
    expect(isSidechain(user)).toBe(false);
  });

  it('isMeaningfulRecord — only main-thread user/assistant', () => {
    expect(isMeaningfulRecord(user)).toBe(true);
    expect(isMeaningfulRecord(assistant)).toBe(true);
    expect(isMeaningfulRecord(sidechain)).toBe(false);
    expect(isMeaningfulRecord(progress)).toBe(false);
    expect(isMeaningfulRecord(system)).toBe(false);
  });

  it('isMetadataRecord — custom-title, last-prompt, summary', () => {
    expect(isMetadataRecord(title)).toBe(true);
    expect(isMetadataRecord(lastPrompt)).toBe(true);
    expect(isMetadataRecord(summary)).toBe(true);
    expect(isMetadataRecord(user)).toBe(false);
    expect(isMetadataRecord(assistant)).toBe(false);
  });
});

describe('content block extraction', () => {
  const record: JsonlRecord = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
        { type: 'text', text: 'More text' },
      ],
    },
  };

  const userRecord: JsonlRecord = {
    type: 'user',
    message: {
      content: [
        { type: 'text', text: 'User message' },
        { type: 'tool_result', tool_use_id: 't1', content: 'result' },
        { type: 'tool_result', tool_use_id: 't2' },
      ],
    },
  };

  it('getContentBlocks returns content array', () => {
    expect(getContentBlocks(record)).toHaveLength(4);
  });

  it('getContentBlocks returns empty for records without content', () => {
    expect(getContentBlocks({ type: 'system' })).toEqual([]);
    expect(getContentBlocks({ type: 'user' })).toEqual([]);
  });

  it('getTextBlocks filters to text blocks with text', () => {
    const texts = getTextBlocks(record);
    expect(texts).toHaveLength(2);
    expect(texts[0].text).toBe('Hello world');
    expect(texts[1].text).toBe('More text');
  });

  it('getToolUseBlocks filters to tool_use with id and name', () => {
    const tools = getToolUseBlocks(record);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('Read');
    expect(tools[1].name).toBe('Edit');
  });

  it('getToolUseBlocks excludes tool_use without id or name', () => {
    const noId: JsonlRecord = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] }, // missing id
    };
    expect(getToolUseBlocks(noId)).toHaveLength(0);
  });

  it('getToolResultBlocks filters to tool_result with tool_use_id', () => {
    const results = getToolResultBlocks(userRecord);
    expect(results).toHaveLength(2);
    expect(results[0].tool_use_id).toBe('t1');
  });

  it('getFirstText returns first text content', () => {
    expect(getFirstText(record)).toBe('Hello world');
  });

  it('getFirstText returns null for no text', () => {
    expect(getFirstText({ type: 'system' })).toBeNull();
  });

  it('getFirstText trims whitespace', () => {
    const r: JsonlRecord = { type: 'user', message: { content: [{ type: 'text', text: '  spaced  ' }] } };
    expect(getFirstText(r)).toBe('spaced');
  });
});

describe('assistant record helpers', () => {
  it('getModelId extracts model string', () => {
    const r = { type: 'assistant', message: { model: 'claude-opus-4-6', content: [] } } as unknown as JsonlRecord;
    expect(getModelId(r)).toBe('claude-opus-4-6');
  });

  it('getModelId returns null when missing', () => {
    expect(getModelId({ type: 'assistant' })).toBeNull();
    expect(getModelId({ type: 'assistant', message: { content: [] } })).toBeNull();
  });

  it('getInputTokens sums all input token types', () => {
    const r = {
      type: 'assistant',
      message: {
        content: [],
        usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 200 },
      },
    } as unknown as JsonlRecord;
    expect(getInputTokens(r)).toBe(350);
  });

  it('getInputTokens returns null when no usage', () => {
    expect(getInputTokens({ type: 'assistant' })).toBeNull();
  });

  it('getInputTokens returns null when all zeros', () => {
    const r = {
      type: 'assistant',
      message: { content: [], usage: { input_tokens: 0 } },
    } as unknown as JsonlRecord;
    expect(getInputTokens(r)).toBeNull();
  });
});

describe('progress record helpers', () => {
  it('getProgressType extracts data.type', () => {
    const r: JsonlRecord = { type: 'progress', data: { type: 'agent_progress' } };
    expect(getProgressType(r)).toBe('agent_progress');
  });

  it('getProgressType returns null when missing', () => {
    expect(getProgressType({ type: 'progress' })).toBeNull();
    expect(getProgressType({ type: 'progress', data: {} })).toBeNull();
  });
});
