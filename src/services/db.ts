import { DatabaseSync } from 'node:sqlite'
import * as E from 'fp-ts/Either'
import { DbError, connectionError } from '../types/db'

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed INTEGER DEFAULT 0,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  payload TEXT NOT NULL,
  read INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS permission_batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slot_num INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  flushed_at TEXT,
  telegram_message_id INTEGER,
  status TEXT DEFAULT 'buffering'
);

CREATE TABLE IF NOT EXISTS permission_batch_items (
  batch_id TEXT NOT NULL REFERENCES permission_batches(batch_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, event_id)
);

CREATE TABLE IF NOT EXISTS pending_stops (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  telegram_message_id INTEGER,
  queued_instruction TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS known_topics (
  thread_id INTEGER PRIMARY KEY,
  topic_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session_unprocessed
  ON events(session_id, processed) WHERE processed = 0;
CREATE INDEX IF NOT EXISTS idx_responses_event
  ON responses(event_id) WHERE read = 0;
CREATE INDEX IF NOT EXISTS idx_sessions_slot
  ON sessions(slot_num);
`

let db: DatabaseSync | null = null

export const openDatabase = (dbPath: string): E.Either<DbError, DatabaseSync> => {
  try {
    if (db) {
      db.close()
      db = null
    }
    const instance = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, timeout: 5000 })
    instance.exec('PRAGMA journal_mode = WAL')

    const version = (instance.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0
    if (version < SCHEMA_VERSION) {
      instance.exec(SCHEMA_SQL)
      instance.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }

    db = instance
    return E.right(instance)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}

export const closeDatabase = (): E.Either<DbError, void> => {
  try {
    if (db) {
      db.close()
      db = null
    }
    return E.right(undefined)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}

export const getDatabase = (): E.Either<DbError, DatabaseSync> =>
  db ? E.right(db) : E.left(connectionError('Database not opened'))

export const openMemoryDatabase = (): E.Either<DbError, DatabaseSync> => {
  try {
    if (db) {
      db.close()
      db = null
    }
    const instance = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
    instance.exec(SCHEMA_SQL)
    instance.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db = instance
    return E.right(instance)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}
