import * as E from 'fp-ts/Either'
import { DatabaseSync } from 'node:sqlite'
import {
  insertSession,
  findSessionBySlot,
  findSessionByClaudeId,
  updateSessionBinding,
  updateSessionHeartbeat,
  updateSessionTrust,
  incrementApprovalCount,
  updateSessionThreadId,
  deleteSession,
  listActiveSessions,
  insertEvent,
  findUnprocessedEvents,
  markEventProcessed,
  deleteSessionEvents,
  insertResponse,
  findUnreadResponse,
  markResponseRead,
  insertBatch,
  addBatchItem,
  findBufferingBatch,
  findFlushableBatches,
  flushBatch,
  resolveBatch,
  findBatchById,
  findBatchItems,
  insertPendingStop,
  findPendingStopBySession,
  updatePendingStopTelegramId,
  updateQueuedInstruction,
  deletePendingStop,
  insertKnownTopic,
  markTopicDeleted,
  findActiveTopics,
} from '../db-queries'

// Schema from db.ts — duplicated here for test isolation
const SCHEMA_SQL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  slot_num INTEGER NOT NULL,
  claude_session_id TEXT UNIQUE,
  project_name TEXT,
  thread_id INTEGER,
  activated_at TEXT NOT NULL,
  last_heartbeat TEXT,
  trusted INTEGER DEFAULT 0,
  approval_count INTEGER DEFAULT 0,
  UNIQUE(slot_num)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed INTEGER DEFAULT 0,
  processed_at TEXT
);
CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  payload TEXT NOT NULL,
  read INTEGER DEFAULT 0
);
CREATE TABLE permission_batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slot_num INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  flushed_at TEXT,
  telegram_message_id INTEGER,
  status TEXT DEFAULT 'buffering'
);
CREATE TABLE permission_batch_items (
  batch_id TEXT NOT NULL REFERENCES permission_batches(batch_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, event_id)
);
CREATE TABLE pending_stops (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  telegram_message_id INTEGER,
  queued_instruction TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE known_topics (
  thread_id INTEGER PRIMARY KEY,
  topic_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT
);
`

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
  db.exec(SCHEMA_SQL)
  return db
}

function seedSession(db: DatabaseSync, id = 's1', slotNum = 1) {
  insertSession(db, id, slotNum, 'test-project', '2024-01-01T00:00:00Z')
}

function seedEvent(db: DatabaseSync, id = 'e1', sessionId = 's1') {
  insertEvent(db, id, sessionId, 'permission_request', '{"tool":"Bash"}')
}

describe('db-queries', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  // ========================================================================
  // Sessions
  // ========================================================================

  describe('sessions', () => {
    it('insertSession + findSessionBySlot', () => {
      const r = insertSession(db, 's1', 1, 'my-project', '2024-01-01T00:00:00Z')
      expect(E.isRight(r)).toBe(true)

      const found = findSessionBySlot(db, 1)
      expect(E.isRight(found)).toBe(true)
      if (!E.isRight(found)) return
      expect(found.right?.id).toBe('s1')
      expect(found.right?.slot_num).toBe(1)
      expect(found.right?.project_name).toBe('my-project')
    })

    it('findSessionBySlot returns undefined for empty slot', () => {
      const found = findSessionBySlot(db, 99)
      expect(E.isRight(found)).toBe(true)
      if (!E.isRight(found)) return
      expect(found.right).toBeUndefined()
    })

    it('insertSession rejects duplicate slot_num', () => {
      insertSession(db, 's1', 1, null, '2024-01-01T00:00:00Z')
      const dup = insertSession(db, 's2', 1, null, '2024-01-01T00:00:00Z')
      expect(E.isLeft(dup)).toBe(true)
      if (!E.isLeft(dup)) return
      expect(dup.left._tag).toBe('ConstraintError')
    })

    it('updateSessionBinding + findSessionByClaudeId', () => {
      seedSession(db)
      updateSessionBinding(db, 's1', 'claude-abc')
      const found = findSessionByClaudeId(db, 'claude-abc')
      expect(E.isRight(found)).toBe(true)
      if (!E.isRight(found)) return
      expect(found.right?.id).toBe('s1')
    })

    it('updateSessionHeartbeat', () => {
      seedSession(db)
      updateSessionHeartbeat(db, 's1', '2024-06-01T12:00:00Z')
      const found = findSessionBySlot(db, 1)
      if (!E.isRight(found)) return
      expect(found.right?.last_heartbeat).toBe('2024-06-01T12:00:00Z')
    })

    it('updateSessionTrust', () => {
      seedSession(db)
      updateSessionTrust(db, 's1', true)
      const found = findSessionBySlot(db, 1)
      if (!E.isRight(found)) return
      expect(found.right?.trusted).toBe(1)
    })

    it('incrementApprovalCount', () => {
      seedSession(db)
      const r1 = incrementApprovalCount(db, 's1')
      expect(E.isRight(r1)).toBe(true)
      if (!E.isRight(r1)) return
      expect(r1.right).toBe(1)

      const r2 = incrementApprovalCount(db, 's1')
      if (!E.isRight(r2)) return
      expect(r2.right).toBe(2)
    })

    it('updateSessionThreadId', () => {
      seedSession(db)
      updateSessionThreadId(db, 's1', 42)
      const found = findSessionBySlot(db, 1)
      if (!E.isRight(found)) return
      expect(found.right?.thread_id).toBe(42)
    })

    it('deleteSession removes session', () => {
      seedSession(db)
      deleteSession(db, 's1')
      const found = findSessionBySlot(db, 1)
      if (!E.isRight(found)) return
      expect(found.right).toBeUndefined()
    })

    it('deleteSession cascades to events and responses', () => {
      seedSession(db)
      seedEvent(db)
      insertResponse(db, 'r1', 'e1', '{"approved":true}')

      deleteSession(db, 's1')

      const events = findUnprocessedEvents(db, 's1')
      if (E.isRight(events)) expect(events.right).toHaveLength(0)

      const resp = findUnreadResponse(db, 'e1')
      if (E.isRight(resp)) expect(resp.right).toBeUndefined()
    })

    it('listActiveSessions returns all sessions ordered by slot', () => {
      insertSession(db, 's2', 2, null, '2024-01-01T00:00:00Z')
      insertSession(db, 's1', 1, null, '2024-01-01T00:00:00Z')
      const result = listActiveSessions(db)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(2)
      expect(result.right[0]?.slot_num).toBe(1)
      expect(result.right[1]?.slot_num).toBe(2)
    })
  })

  // ========================================================================
  // Events
  // ========================================================================

  describe('events', () => {
    beforeEach(() => seedSession(db))

    it('insertEvent + findUnprocessedEvents', () => {
      seedEvent(db)
      const result = findUnprocessedEvents(db, 's1')
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(1)
      expect(result.right[0]?.id).toBe('e1')
      expect(result.right[0]?.event_type).toBe('permission_request')
    })

    it('markEventProcessed excludes from unprocessed', () => {
      seedEvent(db)
      markEventProcessed(db, 'e1')
      const result = findUnprocessedEvents(db, 's1')
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(0)
    })

    it('insertEvent rejects invalid session_id (FK)', () => {
      const r = insertEvent(db, 'e1', 'nonexistent', 'test', '{}')
      expect(E.isLeft(r)).toBe(true)
    })

    it('deleteSessionEvents removes all events for session', () => {
      seedEvent(db, 'e1')
      seedEvent(db, 'e2')
      deleteSessionEvents(db, 's1')
      const result = findUnprocessedEvents(db, 's1')
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(0)
    })
  })

  // ========================================================================
  // Responses
  // ========================================================================

  describe('responses', () => {
    beforeEach(() => {
      seedSession(db)
      seedEvent(db)
    })

    it('insertResponse + findUnreadResponse', () => {
      insertResponse(db, 'r1', 'e1', '{"approved":true}')
      const result = findUnreadResponse(db, 'e1')
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right?.payload).toBe('{"approved":true}')
    })

    it('markResponseRead hides from unread query', () => {
      insertResponse(db, 'r1', 'e1', '{"approved":true}')
      markResponseRead(db, 'r1')
      const result = findUnreadResponse(db, 'e1')
      if (!E.isRight(result)) return
      expect(result.right).toBeUndefined()
    })

    it('findUnreadResponse returns undefined when no response', () => {
      const result = findUnreadResponse(db, 'e1')
      if (!E.isRight(result)) return
      expect(result.right).toBeUndefined()
    })
  })

  // ========================================================================
  // Permission Batches
  // ========================================================================

  describe('permission_batches', () => {
    beforeEach(() => {
      seedSession(db)
      seedEvent(db, 'e1')
      seedEvent(db, 'e2')
    })

    it('insertBatch + findBufferingBatch', () => {
      insertBatch(db, 'b1', 's1', 1)
      const result = findBufferingBatch(db, 1)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right?.batch_id).toBe('b1')
      expect(result.right?.status).toBe('buffering')
    })

    it('addBatchItem + findBatchItems', () => {
      insertBatch(db, 'b1', 's1', 1)
      addBatchItem(db, 'b1', 'e1')
      addBatchItem(db, 'b1', 'e2')
      const result = findBatchItems(db, 'b1')
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(2)
    })

    it('flushBatch updates status and telegram_message_id', () => {
      insertBatch(db, 'b1', 's1', 1)
      flushBatch(db, 'b1', 12345)
      const result = findBatchById(db, 'b1')
      if (!E.isRight(result)) return
      expect(result.right?.status).toBe('flushed')
      expect(result.right?.telegram_message_id).toBe(12345)
    })

    it('findFlushableBatches returns old buffering batches', () => {
      // Insert with a past timestamp
      db.prepare(
        "INSERT INTO permission_batches (batch_id, session_id, slot_num, created_at) VALUES ('b1', 's1', 1, '2020-01-01T00:00:00Z')"
      ).run()
      const result = findFlushableBatches(db, 1000)
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(1)
    })

    it('findFlushableBatches excludes recent batches', () => {
      insertBatch(db, 'b1', 's1', 1) // created just now
      const result = findFlushableBatches(db, 60000) // 60s window
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(0)
    })

    it('resolveBatch returns event IDs', () => {
      insertBatch(db, 'b1', 's1', 1)
      addBatchItem(db, 'b1', 'e1')
      addBatchItem(db, 'b1', 'e2')
      const result = resolveBatch(db, 'b1')
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(2)
      expect(result.right).toContain('e1')
      expect(result.right).toContain('e2')

      // Verify status changed
      const batch = findBatchById(db, 'b1')
      if (!E.isRight(batch)) return
      expect(batch.right?.status).toBe('resolved')
    })

    it('findBufferingBatch returns undefined after flush', () => {
      insertBatch(db, 'b1', 's1', 1)
      flushBatch(db, 'b1', 123)
      const result = findBufferingBatch(db, 1)
      if (!E.isRight(result)) return
      expect(result.right).toBeUndefined()
    })
  })

  // ========================================================================
  // Pending Stops
  // ========================================================================

  describe('pending_stops', () => {
    beforeEach(() => {
      seedSession(db)
      seedEvent(db)
    })

    it('insertPendingStop + findPendingStopBySession', () => {
      insertPendingStop(db, 'e1', 's1')
      const result = findPendingStopBySession(db, 's1')
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right?.event_id).toBe('e1')
    })

    it('updatePendingStopTelegramId', () => {
      insertPendingStop(db, 'e1', 's1')
      updatePendingStopTelegramId(db, 'e1', 99)
      const result = findPendingStopBySession(db, 's1')
      if (!E.isRight(result)) return
      expect(result.right?.telegram_message_id).toBe(99)
    })

    it('updateQueuedInstruction', () => {
      insertPendingStop(db, 'e1', 's1')
      updateQueuedInstruction(db, 'e1', 'do something')
      const result = findPendingStopBySession(db, 's1')
      if (!E.isRight(result)) return
      expect(result.right?.queued_instruction).toBe('do something')
    })

    it('deletePendingStop', () => {
      insertPendingStop(db, 'e1', 's1')
      deletePendingStop(db, 'e1')
      const result = findPendingStopBySession(db, 's1')
      if (!E.isRight(result)) return
      expect(result.right).toBeUndefined()
    })

    it('cascade deletes pending_stop when session deleted', () => {
      insertPendingStop(db, 'e1', 's1')
      deleteSession(db, 's1')
      const result = findPendingStopBySession(db, 's1')
      if (!E.isRight(result)) return
      expect(result.right).toBeUndefined()
    })
  })

  // ========================================================================
  // Known Topics
  // ========================================================================

  describe('known_topics', () => {
    it('insertKnownTopic + findActiveTopics', () => {
      insertKnownTopic(db, 100, 'Session 1')
      insertKnownTopic(db, 200, 'Session 2')
      const result = findActiveTopics(db)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(2)
      expect(result.right[0]?.topic_name).toBe('Session 1')
    })

    it('markTopicDeleted excludes from active', () => {
      insertKnownTopic(db, 100, 'Session 1')
      markTopicDeleted(db, 100)
      const result = findActiveTopics(db)
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(0)
    })

    it('insertKnownTopic rejects duplicate thread_id', () => {
      insertKnownTopic(db, 100, 'Session 1')
      const dup = insertKnownTopic(db, 100, 'Duplicate')
      expect(E.isLeft(dup)).toBe(true)
    })
  })
})
