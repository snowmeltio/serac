/**
 * Resilience tests for record types Claude Code started writing around
 * v2.1.23x — shapes captured from real transcripts on 2026-08-20. The sharp
 * edge is `bridge-session`: it carries NO uuid and NO timestamp, so any code
 * assuming those fields exist on every record breaks on the FIRST line of a
 * Remote Control-enrolled transcript (which, with account-wide Remote Control,
 * is every new transcript).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord } from './types.js';
import { validateRecord } from './jsonlValidator.js';

// Mock JsonlTailer so we can feed records without files
let mockRecords: JsonlRecord[] = [];
vi.mock('./jsonlTailer.js', () => ({
  JsonlTailer: class {
    truncated = false;
    async readNewRecords() {
      const r = mockRecords;
      mockRecords = [];
      return r;
    }
  },
}));

// Import after mock is registered
const { SessionManager } = await import('./sessionManager.js');

function makeManager(): InstanceType<typeof SessionManager> {
  return new SessionManager('test-session-id', '/tmp/test.jsonl', 'test-workspace');
}

async function feedRecords(mgr: InstanceType<typeof SessionManager>, records: JsonlRecord[]): Promise<boolean> {
  mockRecords = records;
  return mgr.update();
}

// ── Real record shapes (sanitised; field structure verbatim) ─────────────

/** First line of a Remote Control-enrolled transcript. No uuid, no timestamp. */
const bridgeSessionRecord: JsonlRecord = {
  type: 'bridge-session',
  sessionId: 'test-session-id',
  bridgeSessionId: 'cse_01Xy3wR49sm6azguswDGYiNx',
  lastSequenceNum: 0,
  ownerAccountUuid: '4a87291c-0000-0000-0000-000000000000',
  ownerOrganizationUuid: 'a3b0cffa-0000-0000-0000-000000000000',
};

/** Harness context delta. Has uuid/timestamp but an unfamiliar payload. */
const attachmentRecord: JsonlRecord = {
  parentUuid: '58ffd30f-0000-0000-0000-000000000000',
  isSidechain: false,
  type: 'attachment',
  attachment: {
    type: 'deferred_tools_delta',
    addedNames: ['CronCreate', 'Monitor', 'WebFetch'],
  },
  uuid: 'bfc66392-0000-0000-0000-000000000000',
  timestamp: '2026-08-19T22:44:18.930Z',
};

/** file-history-snapshot: no top-level timestamp, no uuid. */
const fileHistorySnapshotRecord: JsonlRecord = {
  type: 'file-history-snapshot',
  messageId: '58ffd30f-0000-0000-0000-000000000000',
  snapshot: {
    messageId: '58ffd30f-0000-0000-0000-000000000000',
    trackedFileBackups: {},
    timestamp: '2026-08-19T22:44:18.965Z',
  },
  isSnapshotUpdate: false,
};

/** queue-operation can now carry the queued prompt text in `content`. */
const queueOperationWithContent: JsonlRecord = {
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: '2026-08-19T22:52:38.276Z',
  sessionId: 'test-session-id',
  content: 'How are the labels for these sessions derived?',
};

const allNewRecords = [bridgeSessionRecord, attachmentRecord, fileHistorySnapshotRecord, queueOperationWithContent];

describe('validateRecord on new record shapes', () => {
  it('accepts every captured shape (only a string type is structurally required)', () => {
    for (const rec of allNewRecords) {
      expect(validateRecord(JSON.parse(JSON.stringify(rec)))).not.toBeNull();
    }
  });
});

describe('SessionManager resilience to new record types', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes a transcript opening with bridge-session (no uuid/timestamp) without throwing', async () => {
    const mgr = makeManager();
    await expect(feedRecords(mgr, [bridgeSessionRecord])).resolves.toBeDefined();
  });

  it('bridge-session and attachment records never move status or lastActivity', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{
      type: 'user',
      timestamp: '2026-08-19T10:00:00.000Z',
      message: { content: [{ type: 'text', text: 'hello' }] },
    }]);
    const statusBefore = mgr.getStatus();
    const lastActivityBefore = mgr.getSnapshot().lastActivity;

    await feedRecords(mgr, [bridgeSessionRecord, attachmentRecord]);
    expect(mgr.getStatus()).toBe(statusBefore);
    expect(mgr.getSnapshot().lastActivity).toBe(lastActivityBefore);
  });

  it('captures bridgeSessionId into the snapshot (data-only; no renderer consumes it)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [bridgeSessionRecord]);
    expect(mgr.getSnapshot().bridgeSessionId).toBe('cse_01Xy3wR49sm6azguswDGYiNx');
  });

  it('drops a bridge-session record belonging to a different session', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{ ...bridgeSessionRecord, sessionId: 'some-other-session' }]);
    expect(mgr.getSnapshot().bridgeSessionId).toBeUndefined();
  });

  it('ignores a malformed bridge-session record (missing bridgeSessionId)', async () => {
    const mgr = makeManager();
    const { bridgeSessionId: _omit, ...withoutId } = bridgeSessionRecord;
    await feedRecords(mgr, [withoutId as JsonlRecord]);
    expect(mgr.getSnapshot().bridgeSessionId).toBeUndefined();
  });

  it('a full new-records preamble before the first user turn leaves the session ready', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [
      bridgeSessionRecord,
      queueOperationWithContent,
      { ...queueOperationWithContent, operation: 'dequeue', content: undefined },
      fileHistorySnapshotRecord,
      attachmentRecord,
      {
        type: 'user',
        timestamp: '2026-08-19T22:52:39.000Z',
        message: { content: [{ type: 'text', text: 'hello world' }] },
      },
    ]);
    expect(mgr.getStatus()).toBe('running');
    expect(mgr.getSnapshot().topic).toBe('hello world');
    expect(mgr.getSnapshot().bridgeSessionId).toBe('cse_01Xy3wR49sm6azguswDGYiNx');
  });
});
