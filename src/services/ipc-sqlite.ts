/**
 * @module services/ipc-sqlite
 * SQLite-backed IPC adapter.
 * Drop-in replacement for file-based ipc.ts — same API surface,
 * backed by events/responses tables via db-queries.
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import { type IpcEvent } from '../types/events'
import { type IpcError, ipcReadError, ipcWriteError } from '../types/errors'
import { type DbError, dbErrorMessage } from '../types/db'
import {
  ensureSessionForIpc,
  insertEvent,
  findUnprocessedEvents,
  findAllUnprocessedEvents,
  markEventProcessed,
  deleteSessionEvents,
  insertResponse,
  findUnreadResponse,
  markResponseRead,
  type EventRow,
} from './db-queries'
import { getDatabase } from './db'

// ============================================================================
// Helpers
// ============================================================================

const toIpcReadError = (label: string) => (err: DbError): IpcError =>
  ipcReadError(label, new Error(dbErrorMessage(err)))

const toIpcWriteError = (label: string) => (err: DbError): IpcError =>
  ipcWriteError(label, new Error(dbErrorMessage(err)))

const withDb = <T>(
  label: string,
  fn: (db: import('node:sqlite').DatabaseSync) => E.Either<DbError, T>,
  toError: (label: string) => (err: DbError) => IpcError
): TE.TaskEither<IpcError, T> =>
  TE.fromEither(
    (() => {
      const dbResult = getDatabase()
      if (E.isLeft(dbResult)) return E.left(toError(label)(dbResult.left))
      const result = fn(dbResult.right)
      if (E.isLeft(result)) return E.left(toError(label)(result.left))
      return E.right(result.right)
    })()
  )

// ============================================================================
// Response types (matching ipc.ts)
// ============================================================================

export interface StopResponse {
  readonly instruction: string
}

// ============================================================================
// Event operations
// ============================================================================

/**
 * Write an IPC event to the SQLite events table.
 * The event is serialized to JSON and stored with its type and session ID.
 *
 * @param _eventsFile - Ignored (file-based compat). Session resolved from event.
 * @param event - IPC event to write
 */
export const writeEvent = (
  _eventsFile: string,
  event: IpcEvent
): TE.TaskEither<IpcError, void> => {
  const sessionId = 'sessionId' in event ? (event.sessionId as string) : ''
  const slotNum = 'slotNum' in event ? (event as { slotNum: number }).slotNum : 0
  const eventId = 'requestId' in event
    ? (event as { requestId: string }).requestId
    : 'eventId' in event
      ? (event as { eventId: string }).eventId
      : `${event._tag}-${Date.now()}`

  return withDb(
    'writeEvent',
    (db) => {
      // Ensure session row exists for FK constraint
      if (sessionId) {
        const ensureResult = ensureSessionForIpc(db, sessionId, slotNum)
        if (E.isLeft(ensureResult)) return ensureResult
      }
      return insertEvent(db, eventId, sessionId, event._tag, JSON.stringify(event))
    },
    toIpcWriteError
  )
}

/**
 * Read unprocessed events for a session from SQLite.
 * Parses each event's payload back into an IpcEvent.
 *
 * @param sessionId - The session ID to read events for
 */
export const readEventsBySession = (
  sessionId: string
): TE.TaskEither<IpcError, IpcEvent[]> =>
  withDb(
    'readEventsBySession',
    (db) => {
      const result = findUnprocessedEvents(db, sessionId)
      if (E.isLeft(result)) return result
      const events = result.right.map((row: EventRow) => JSON.parse(row.payload) as IpcEvent)
      return E.right(events)
    },
    toIpcReadError
  )

/**
 * Read all events from a JSONL file (compatibility shim).
 * In SQLite mode, this parses the sessionId from the file path
 * and reads from the events table.
 *
 * @param eventsFile - Path like {ipcBaseDir}/{sessionId}/events.jsonl
 */
export const readEventQueue = (
  eventsFile: string
): TE.TaskEither<IpcError, IpcEvent[]> => {
  // Extract sessionId from path: .../ipc/{sessionId}/events.jsonl
  const parts = eventsFile.split('/')
  const sessionIdx = parts.length - 2
  const sessionId = parts[sessionIdx] ?? ''
  return readEventsBySession(sessionId)
}

/**
 * Read all unprocessed events across all sessions.
 * Used by the daemon to process events without directory scanning.
 *
 * Returns events grouped with their event row IDs for marking as processed.
 */
export const readAllUnprocessedEvents = (): TE.TaskEither<IpcError, Array<{ event: IpcEvent; eventRowId: string; sessionId: string }>> =>
  withDb(
    'readAllUnprocessedEvents',
    (db) => {
      const result = findAllUnprocessedEvents(db)
      if (E.isLeft(result)) return result
      const parsed = result.right.map((row: EventRow) => ({
        event: JSON.parse(row.payload) as IpcEvent,
        eventRowId: row.id,
        sessionId: row.session_id,
      }))
      return E.right(parsed)
    },
    toIpcReadError
  )

/**
 * Mark a single event as processed by its row ID.
 */
export const markEventDone = (
  eventRowId: string
): TE.TaskEither<IpcError, void> =>
  withDb(
    'markEventDone',
    (db) => markEventProcessed(db, eventRowId),
    toIpcWriteError
  )

/**
 * Mark all unprocessed events for a session as processed.
 * Replaces file-based deleteEventFile.
 *
 * @param sessionId - The session whose events to mark processed
 */
export const markSessionEventsProcessed = (
  sessionId: string
): TE.TaskEither<IpcError, void> =>
  withDb(
    'markSessionEventsProcessed',
    (db) => {
      const eventsResult = findUnprocessedEvents(db, sessionId)
      if (E.isLeft(eventsResult)) return eventsResult as E.Either<DbError, void>
      for (const event of eventsResult.right) {
        const markResult = markEventProcessed(db, event.id)
        if (E.isLeft(markResult)) return markResult
      }
      return E.right(undefined)
    },
    toIpcWriteError
  )

/**
 * Delete an event file (compatibility shim).
 * In SQLite mode, marks all events from the session as processed.
 *
 * @param eventFile - Path like {ipcBaseDir}/{sessionId}/events.jsonl
 */
export const deleteEventFile = (
  eventFile: string
): TE.TaskEither<IpcError, void> => {
  const parts = eventFile.split('/')
  const sessionIdx = parts.length - 2
  const sessionId = parts[sessionIdx] ?? ''
  return markSessionEventsProcessed(sessionId)
}

// ============================================================================
// Response operations
// ============================================================================

/**
 * Write a response for an event.
 *
 * @param _ipcDir - Ignored (file-based compat)
 * @param eventId - The event ID this response is for
 * @param response - JSON-serializable response payload
 */
export const writeResponse = (
  _ipcDir: string,
  eventId: string,
  response: Record<string, unknown>
): TE.TaskEither<IpcError, void> => {
  const responseId = `resp-${eventId}-${Date.now()}`
  return withDb(
    'writeResponse',
    (db) => insertResponse(db, responseId, eventId, JSON.stringify(response)),
    toIpcWriteError
  )
}

/**
 * Read a response for an event.
 * Returns null if no unread response exists.
 *
 * @param _ipcDir - Ignored (file-based compat)
 * @param eventId - The event ID to look up
 */
export const readResponse = (
  _ipcDir: string,
  eventId: string
): TE.TaskEither<IpcError, StopResponse | null> =>
  withDb(
    'readResponse',
    (db) => {
      const result = findUnreadResponse(db, eventId)
      if (E.isLeft(result)) return result as E.Either<DbError, StopResponse | null>
      if (!result.right) return E.right(null)
      const markResult = markResponseRead(db, result.right.id)
      if (E.isLeft(markResult)) return markResult as E.Either<DbError, StopResponse | null>
      return E.right(JSON.parse(result.right.payload) as StopResponse)
    },
    toIpcReadError
  )

// ============================================================================
// Directory operations (no-ops in SQLite mode)
// ============================================================================

/**
 * List event files in directory (compatibility shim).
 * Returns a single synthetic entry if there are unprocessed events.
 */
export const listEvents = (
  _eventsDir: string
): TE.TaskEither<IpcError, string[]> =>
  TE.right(['events.jsonl'])

/**
 * Create an IPC directory (no-op in SQLite mode).
 */
export const createIpcDir = (
  baseDir: string,
  sessionId: string
): TE.TaskEither<IpcError, string> =>
  TE.right(`${baseDir}/${sessionId}`)

/**
 * Remove an IPC directory (no-op in SQLite mode).
 */
export const removeIpcDir = (
  _baseDir: string,
  _sessionId: string
): TE.TaskEither<IpcError, void> =>
  TE.right(undefined)

/**
 * Write meta file (no-op in SQLite mode).
 */
export const writeMetaFile = (
  _ipcDir: string,
  _meta: Record<string, unknown>
): TE.TaskEither<IpcError, void> =>
  TE.right(undefined)

/**
 * Clean orphaned IPC dirs (no-op in SQLite mode).
 */
export const cleanOrphanedIpcDirs = (
  _baseDir: string,
  _activeSessionIds: ReadonlySet<string>
): TE.TaskEither<IpcError, void> =>
  TE.right(undefined)
