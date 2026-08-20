/**
 * Resilience tests for record types Claude Code started writing around
 * v2.1.23x — shapes captured from real transcripts on 2026-08-20. The sharp
 * edge is `bridge-session`: it carries NO uuid and NO timestamp, so any code
 * assuming those fields exist on every record breaks on the FIRST line of a
 * Remote Control-enrolled transcript (which, with account-wide Remote Control,
 * is every new transcript).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JsonlRecord, BridgeTransition } from './types.js';
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

function makeManager(opts?: { onBridgeTransition?: (ev: BridgeTransition) => void }): InstanceType<typeof SessionManager> {
  return new SessionManager('test-session-id', '/tmp/test.jsonl', 'test-workspace', opts);
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

/** The DROP shape: same type, EMPTY id, no owner fields. Written by the
 *  binary's `clearBridgeSession` when the bridge tears down (captured from
 *  four live sessions on 2026-08-20). */
const bridgeDroppedRecord: JsonlRecord = {
  type: 'bridge-session',
  sessionId: 'test-session-id',
  bridgeSessionId: '',
  lastSequenceNum: 0,
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

const allNewRecords = [bridgeSessionRecord, bridgeDroppedRecord, attachmentRecord, fileHistorySnapshotRecord, queueOperationWithContent];

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
    expect(mgr.getSnapshot().bridgeState).toBe('enrolled');
  });

  it('leaves bridgeState unset when no bridge-session record has been seen', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [attachmentRecord]);
    expect(mgr.getSnapshot().bridgeState).toBeUndefined();
    expect(mgr.getSnapshot().bridgeSessionId).toBeUndefined();
  });

  it('drops a bridge-session record belonging to a different session', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [{ ...bridgeSessionRecord, sessionId: 'some-other-session' }]);
    expect(mgr.getSnapshot().bridgeSessionId).toBeUndefined();
    expect(mgr.getSnapshot().bridgeState).toBeUndefined();
  });

  it('ignores a malformed bridge-session record (missing bridgeSessionId)', async () => {
    const mgr = makeManager();
    const { bridgeSessionId: _omit, ...withoutId } = bridgeSessionRecord;
    await feedRecords(mgr, [withoutId as JsonlRecord]);
    expect(mgr.getSnapshot().bridgeSessionId).toBeUndefined();
    expect(mgr.getSnapshot().bridgeState).toBeUndefined();
  });

  it('ignores a bridge-session record whose id is not a string', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [bridgeSessionRecord, { ...bridgeSessionRecord, bridgeSessionId: null as unknown as string }]);
    expect(mgr.getSnapshot().bridgeSessionId).toBe('cse_01Xy3wR49sm6azguswDGYiNx');
    expect(mgr.getSnapshot().bridgeState).toBe('enrolled');
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

describe('bridge-session tri-state (enrolled / dropped / unset)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRecords = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an empty-id record marks the session dropped and clears the id', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [bridgeSessionRecord, bridgeDroppedRecord]);
    expect(mgr.getSnapshot().bridgeState).toBe('dropped');
    expect(mgr.getSnapshot().bridgeSessionId).toBeUndefined();
  });

  it('a drop with no prior enrolment still reads as dropped (transcript opened mid-life)', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [bridgeDroppedRecord]);
    expect(mgr.getSnapshot().bridgeState).toBe('dropped');
    expect(mgr.getSnapshot().bridgeSessionId).toBeUndefined();
  });

  it('enrol → drop → new enrol lands on enrolled with the NEW id', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [
      bridgeSessionRecord,
      bridgeDroppedRecord,
      { ...bridgeSessionRecord, bridgeSessionId: 'cse_02NewIdAfterReopen000000' },
    ]);
    expect(mgr.getSnapshot().bridgeState).toBe('enrolled');
    expect(mgr.getSnapshot().bridgeSessionId).toBe('cse_02NewIdAfterReopen000000');
  });

  it('an empty-id record for another session is ignored', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [bridgeSessionRecord, { ...bridgeDroppedRecord, sessionId: 'some-other-session' }]);
    expect(mgr.getSnapshot().bridgeState).toBe('enrolled');
    expect(mgr.getSnapshot().bridgeSessionId).toBe('cse_01Xy3wR49sm6azguswDGYiNx');
  });

  it('a drop record never moves status or lastActivity', async () => {
    const mgr = makeManager();
    await feedRecords(mgr, [
      bridgeSessionRecord,
      { type: 'user', timestamp: '2026-08-19T10:00:00.000Z', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const statusBefore = mgr.getStatus();
    const lastActivityBefore = mgr.getSnapshot().lastActivity;
    await feedRecords(mgr, [bridgeDroppedRecord]);
    expect(mgr.getStatus()).toBe(statusBefore);
    expect(mgr.getSnapshot().lastActivity).toBe(lastActivityBefore);
  });

  describe('onBridgeTransition trace', () => {
    it('fires once per real transition, never for a re-emitted identical enrol record', async () => {
      const events: BridgeTransition[] = [];
      const mgr = makeManager({ onBridgeTransition: (ev) => events.push(ev) });
      await feedRecords(mgr, [bridgeSessionRecord, bridgeSessionRecord, bridgeSessionRecord]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ from: undefined, to: 'enrolled', bridgeSessionId: 'cse_01Xy3wR49sm6azguswDGYiNx' });
    });

    it('a repeated drop record does not re-fire', async () => {
      const events: BridgeTransition[] = [];
      const mgr = makeManager({ onBridgeTransition: (ev) => events.push(ev) });
      await feedRecords(mgr, [bridgeSessionRecord, bridgeDroppedRecord, bridgeDroppedRecord]);
      expect(events.map((e) => e.to)).toEqual(['enrolled', 'dropped']);
      expect(events[1]).toMatchObject({ from: 'enrolled', to: 'dropped' });
      expect(events[1].bridgeSessionId).toBeUndefined();
    });

    it('re-enrolment after a drop reports from=dropped with the new id', async () => {
      const events: BridgeTransition[] = [];
      const mgr = makeManager({ onBridgeTransition: (ev) => events.push(ev) });
      await feedRecords(mgr, [
        bridgeSessionRecord,
        bridgeDroppedRecord,
        { ...bridgeSessionRecord, bridgeSessionId: 'cse_02NewIdAfterReopen000000' },
      ]);
      expect(events.map((e) => e.to)).toEqual(['enrolled', 'dropped', 'enrolled']);
      expect(events[2]).toMatchObject({ from: 'dropped', to: 'enrolled', bridgeSessionId: 'cse_02NewIdAfterReopen000000' });
    });

    it('marks records from the first read as replay and later appends as live', async () => {
      const events: BridgeTransition[] = [];
      const mgr = makeManager({ onBridgeTransition: (ev) => events.push(ev) });
      await feedRecords(mgr, [bridgeSessionRecord]);          // startup replay
      await feedRecords(mgr, [bridgeDroppedRecord]);          // live append
      expect(events.map((e) => [e.to, e.replay])).toEqual([['enrolled', true], ['dropped', false]]);
    });

    it('carries the newest turn timestamp seen before the record as lastActivity', async () => {
      const events: BridgeTransition[] = [];
      const mgr = makeManager({ onBridgeTransition: (ev) => events.push(ev) });
      await feedRecords(mgr, [
        bridgeSessionRecord,
        { type: 'user', timestamp: '2026-08-19T10:00:00.000Z', message: { content: [{ type: 'text', text: 'hello' }] } },
        bridgeDroppedRecord,
      ]);
      const drop = events.find((e) => e.to === 'dropped')!;
      expect(drop.lastActivity.toISOString()).toBe('2026-08-19T10:00:00.000Z');
    });

    it('does not fire for a wrong-session or malformed record', async () => {
      const events: BridgeTransition[] = [];
      const mgr = makeManager({ onBridgeTransition: (ev) => events.push(ev) });
      const { bridgeSessionId: _omit, ...withoutId } = bridgeSessionRecord;
      await feedRecords(mgr, [
        { ...bridgeDroppedRecord, sessionId: 'some-other-session' },
        withoutId as JsonlRecord,
      ]);
      expect(events).toHaveLength(0);
    });
  });
});
