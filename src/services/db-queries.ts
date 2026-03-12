import { DatabaseSync } from 'node:sqlite'
import * as E from 'fp-ts/Either'
import { DbError, queryError, constraintError } from '../types/db'

// ============================================================================
// Helpers
// ============================================================================

const tryCatch = <T>(fn: () => T, label: string): E.Either<DbError, T> => {
  try {
    return E.right(fn())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE constraint') || msg.includes('FOREIGN KEY constraint')) {
      return E.left(constraintError(msg))
    }
    return E.left(queryError(msg, label))
  }
}

// ============================================================================
// Session types
// ============================================================================

export interface SessionRow {
  readonly id: string
  readonly slot_num: number
  readonly claude_session_id: string | null
  readonly project_name: string | null
  readonly thread_id: number | null
  readonly activated_at: string
  readonly last_heartbeat: string | null
  readonly trusted: number
  readonly approval_count: number
}

// ============================================================================
// Sessions
// ============================================================================

/**
 * Ensure a session row exists for IPC FK constraints.
 * If the session doesn't exist, clears any stale session on the same slot and inserts.
 */
export const ensureSessionForIpc = (
  db: DatabaseSync,
  sessionId: string,
  slotNum: number
): E.Either<DbError, void> =>
  tryCatch(() => {
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as
      | { id: string }
      | undefined
    if (existing) return

    // Remove any stale session occupying this slot (CASCADE cleans events/responses)
    db.prepare('DELETE FROM sessions WHERE slot_num = ?').run(slotNum)

    db.prepare(
      "INSERT INTO sessions (id, slot_num, activated_at) VALUES (?, ?, datetime('now'))"
    ).run(sessionId, slotNum)
  }, 'ensureSessionForIpc')

export const insertSession = (
  db: DatabaseSync,
  id: string,
  slotNum: number,
  projectName: string | null,
  activatedAt: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      'INSERT INTO sessions (id, slot_num, project_name, activated_at) VALUES (?, ?, ?, ?)'
    ).run(id, slotNum, projectName, activatedAt)
  }, 'insertSession')

export const findSessionBySlot = (
  db: DatabaseSync,
  slotNum: number
): E.Either<DbError, SessionRow | undefined> =>
  tryCatch(
    () => db.prepare('SELECT * FROM sessions WHERE slot_num = ?').get(slotNum) as SessionRow | undefined,
    'findSessionBySlot'
  )

export const findSessionByClaudeId = (
  db: DatabaseSync,
  claudeSessionId: string
): E.Either<DbError, SessionRow | undefined> =>
  tryCatch(
    () =>
      db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as
        | SessionRow
        | undefined,
    'findSessionByClaudeId'
  )

export const updateSessionBinding = (
  db: DatabaseSync,
  sessionId: string,
  claudeSessionId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(
      claudeSessionId,
      sessionId
    )
  }, 'updateSessionBinding')

export const updateSessionHeartbeat = (
  db: DatabaseSync,
  sessionId: string,
  heartbeat: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('UPDATE sessions SET last_heartbeat = ? WHERE id = ?').run(heartbeat, sessionId)
  }, 'updateSessionHeartbeat')

export const updateSessionTrust = (
  db: DatabaseSync,
  sessionId: string,
  trusted: boolean
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('UPDATE sessions SET trusted = ? WHERE id = ?').run(trusted ? 1 : 0, sessionId)
  }, 'updateSessionTrust')

export const incrementApprovalCount = (
  db: DatabaseSync,
  sessionId: string
): E.Either<DbError, number> =>
  tryCatch(() => {
    const row = db
      .prepare('UPDATE sessions SET approval_count = approval_count + 1 WHERE id = ? RETURNING approval_count')
      .get(sessionId) as { approval_count: number } | undefined
    return row?.approval_count ?? 0
  }, 'incrementApprovalCount')

export const updateSessionThreadId = (
  db: DatabaseSync,
  sessionId: string,
  threadId: number
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('UPDATE sessions SET thread_id = ? WHERE id = ?').run(threadId, sessionId)
  }, 'updateSessionThreadId')

export const deleteSession = (
  db: DatabaseSync,
  sessionId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }, 'deleteSession')

export const listActiveSessions = (
  db: DatabaseSync
): E.Either<DbError, readonly SessionRow[]> =>
  tryCatch(
    () => db.prepare('SELECT * FROM sessions ORDER BY slot_num').all() as unknown as SessionRow[],
    'listActiveSessions'
  )

// ============================================================================
// Events
// ============================================================================

export interface EventRow {
  readonly id: string
  readonly session_id: string
  readonly created_at: string
  readonly event_type: string
  readonly payload: string
  readonly processed: number
  readonly processed_at: string | null
}

export const insertEvent = (
  db: DatabaseSync,
  id: string,
  sessionId: string,
  eventType: string,
  payload: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      'INSERT INTO events (id, session_id, event_type, payload) VALUES (?, ?, ?, ?)'
    ).run(id, sessionId, eventType, payload)
  }, 'insertEvent')

export const findUnprocessedEvents = (
  db: DatabaseSync,
  sessionId: string
): E.Either<DbError, readonly EventRow[]> =>
  tryCatch(
    () =>
      db
        .prepare('SELECT * FROM events WHERE session_id = ? AND processed = 0 ORDER BY created_at')
        .all(sessionId) as unknown as EventRow[],
    'findUnprocessedEvents'
  )

export const findAllUnprocessedEvents = (
  db: DatabaseSync
): E.Either<DbError, readonly EventRow[]> =>
  tryCatch(
    () =>
      db
        .prepare('SELECT * FROM events WHERE processed = 0 ORDER BY created_at')
        .all() as unknown as EventRow[],
    'findAllUnprocessedEvents'
  )

export const markEventProcessed = (
  db: DatabaseSync,
  eventId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      "UPDATE events SET processed = 1, processed_at = datetime('now') WHERE id = ?"
    ).run(eventId)
  }, 'markEventProcessed')

export const deleteSessionEvents = (
  db: DatabaseSync,
  sessionId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId)
  }, 'deleteSessionEvents')

// ============================================================================
// Responses
// ============================================================================

export interface ResponseRow {
  readonly id: string
  readonly event_id: string
  readonly created_at: string
  readonly payload: string
  readonly read: number
}

export const insertResponse = (
  db: DatabaseSync,
  id: string,
  eventId: string,
  payload: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      'INSERT INTO responses (id, event_id, payload) VALUES (?, ?, ?)'
    ).run(id, eventId, payload)
  }, 'insertResponse')

export const findUnreadResponse = (
  db: DatabaseSync,
  eventId: string
): E.Either<DbError, ResponseRow | undefined> =>
  tryCatch(
    () =>
      db.prepare('SELECT * FROM responses WHERE event_id = ? AND read = 0').get(eventId) as
        | ResponseRow
        | undefined,
    'findUnreadResponse'
  )

export const markResponseRead = (
  db: DatabaseSync,
  responseId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('UPDATE responses SET read = 1 WHERE id = ?').run(responseId)
  }, 'markResponseRead')

// ============================================================================
// Permission Batches
// ============================================================================

export interface BatchRow {
  readonly batch_id: string
  readonly session_id: string
  readonly slot_num: number
  readonly created_at: string
  readonly flushed_at: string | null
  readonly telegram_message_id: number | null
  readonly status: string
}

export interface BatchItemRow {
  readonly batch_id: string
  readonly event_id: string
}

export const insertBatch = (
  db: DatabaseSync,
  batchId: string,
  sessionId: string,
  slotNum: number
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      'INSERT INTO permission_batches (batch_id, session_id, slot_num) VALUES (?, ?, ?)'
    ).run(batchId, sessionId, slotNum)
  }, 'insertBatch')

export const addBatchItem = (
  db: DatabaseSync,
  batchId: string,
  eventId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      'INSERT INTO permission_batch_items (batch_id, event_id) VALUES (?, ?)'
    ).run(batchId, eventId)
  }, 'addBatchItem')

export const findBufferingBatch = (
  db: DatabaseSync,
  slotNum: number
): E.Either<DbError, BatchRow | undefined> =>
  tryCatch(
    () =>
      db
        .prepare("SELECT * FROM permission_batches WHERE slot_num = ? AND status = 'buffering'")
        .get(slotNum) as BatchRow | undefined,
    'findBufferingBatch'
  )

export const findFlushableBatches = (
  db: DatabaseSync,
  windowMs: number
): E.Either<DbError, readonly BatchRow[]> =>
  tryCatch(() => {
    return db
      .prepare(
        "SELECT * FROM permission_batches WHERE status = 'buffering' AND created_at <= datetime('now', ?)"
      )
      .all(`-${windowMs / 1000} seconds`) as unknown as BatchRow[]
  }, 'findFlushableBatches')

export const flushBatch = (
  db: DatabaseSync,
  batchId: string,
  telegramMessageId: number
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      "UPDATE permission_batches SET status = 'flushed', flushed_at = datetime('now'), telegram_message_id = ? WHERE batch_id = ?"
    ).run(telegramMessageId, batchId)
  }, 'flushBatch')

export const resolveBatch = (
  db: DatabaseSync,
  batchId: string
): E.Either<DbError, readonly string[]> =>
  tryCatch(() => {
    db.prepare(
      "UPDATE permission_batches SET status = 'resolved' WHERE batch_id = ?"
    ).run(batchId)
    const items = db
      .prepare('SELECT event_id FROM permission_batch_items WHERE batch_id = ?')
      .all(batchId) as Array<{ event_id: string }>
    return items.map((i) => i.event_id)
  }, 'resolveBatch')

export const findBatchById = (
  db: DatabaseSync,
  batchId: string
): E.Either<DbError, BatchRow | undefined> =>
  tryCatch(
    () =>
      db.prepare('SELECT * FROM permission_batches WHERE batch_id = ?').get(batchId) as
        | BatchRow
        | undefined,
    'findBatchById'
  )

export const findBatchItems = (
  db: DatabaseSync,
  batchId: string
): E.Either<DbError, readonly BatchItemRow[]> =>
  tryCatch(
    () =>
      db.prepare('SELECT * FROM permission_batch_items WHERE batch_id = ?').all(batchId) as unknown as BatchItemRow[],
    'findBatchItems'
  )

// ============================================================================
// Pending Stops
// ============================================================================

export interface PendingStopRow {
  readonly event_id: string
  readonly session_id: string
  readonly telegram_message_id: number | null
  readonly queued_instruction: string | null
  readonly created_at: string
}

export const insertPendingStop = (
  db: DatabaseSync,
  eventId: string,
  sessionId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      'INSERT INTO pending_stops (event_id, session_id) VALUES (?, ?)'
    ).run(eventId, sessionId)
  }, 'insertPendingStop')

export const findPendingStopBySession = (
  db: DatabaseSync,
  sessionId: string
): E.Either<DbError, PendingStopRow | undefined> =>
  tryCatch(
    () =>
      db.prepare('SELECT * FROM pending_stops WHERE session_id = ?').get(sessionId) as
        | PendingStopRow
        | undefined,
    'findPendingStopBySession'
  )

export const updatePendingStopTelegramId = (
  db: DatabaseSync,
  eventId: string,
  telegramMessageId: number
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('UPDATE pending_stops SET telegram_message_id = ? WHERE event_id = ?').run(
      telegramMessageId,
      eventId
    )
  }, 'updatePendingStopTelegramId')

export const updateQueuedInstruction = (
  db: DatabaseSync,
  eventId: string,
  instruction: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('UPDATE pending_stops SET queued_instruction = ? WHERE event_id = ?').run(
      instruction,
      eventId
    )
  }, 'updateQueuedInstruction')

export const deletePendingStop = (
  db: DatabaseSync,
  eventId: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare('DELETE FROM pending_stops WHERE event_id = ?').run(eventId)
  }, 'deletePendingStop')

// ============================================================================
// Known Topics
// ============================================================================

export interface KnownTopicRow {
  readonly thread_id: number
  readonly topic_name: string
  readonly created_at: string
  readonly deleted_at: string | null
}

export const insertKnownTopic = (
  db: DatabaseSync,
  threadId: number,
  topicName: string
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      'INSERT INTO known_topics (thread_id, topic_name) VALUES (?, ?)'
    ).run(threadId, topicName)
  }, 'insertKnownTopic')

export const markTopicDeleted = (
  db: DatabaseSync,
  threadId: number
): E.Either<DbError, void> =>
  tryCatch(() => {
    db.prepare(
      "UPDATE known_topics SET deleted_at = datetime('now') WHERE thread_id = ?"
    ).run(threadId)
  }, 'markTopicDeleted')

export const findActiveTopics = (
  db: DatabaseSync
): E.Either<DbError, readonly KnownTopicRow[]> =>
  tryCatch(
    () =>
      db.prepare('SELECT * FROM known_topics WHERE deleted_at IS NULL ORDER BY thread_id').all() as unknown as KnownTopicRow[],
    'findActiveTopics'
  )
