import * as E from 'fp-ts/Either'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, closeDatabase, getDatabase, openMemoryDatabase } from '../db'

describe('db', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'))
  })

  afterEach(() => {
    closeDatabase()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('openDatabase', () => {
    it('creates bridge.db at given path', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      expect(fs.existsSync(dbPath)).toBe(true)
    })

    it('creates schema tables on first open', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const tables = result.right
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
      const tableNames = tables.map((t) => t.name)

      expect(tableNames).toContain('sessions')
      expect(tableNames).toContain('events')
      expect(tableNames).toContain('responses')
      expect(tableNames).toContain('permission_batches')
      expect(tableNames).toContain('permission_batch_items')
      expect(tableNames).toContain('pending_stops')
      expect(tableNames).toContain('known_topics')
    })

    it('does not recreate tables on second open', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      openDatabase(dbPath)
      closeDatabase()

      // Insert a row before reopening
      const raw = new DatabaseSync(dbPath)
      raw.exec(
        "INSERT INTO sessions (id, slot_num, activated_at) VALUES ('s1', 1, '2024-01-01')"
      )
      raw.close()

      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const count = result.right
        .prepare('SELECT COUNT(*) as cnt FROM sessions')
        .get() as { cnt: number }
      expect(count.cnt).toBe(1)
    })

    it('sets WAL mode', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const mode = (result.right.prepare('PRAGMA journal_mode').get() as any)?.journal_mode
      expect(mode).toBe('wal')
    })

    it('sets busy_timeout', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const timeout = (result.right.prepare('PRAGMA busy_timeout').get() as any)?.timeout
      expect(timeout).toBe(5000)
    })

    it('sets foreign_keys', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const fk = (result.right.prepare('PRAGMA foreign_keys').get() as any)?.foreign_keys
      expect(fk).toBe(1)
    })

    it('sets user_version to 1 after migration', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const version = (result.right.prepare('PRAGMA user_version').get() as any)?.user_version
      expect(version).toBe(1)
    })

    it('returns ConnectionError for invalid path', () => {
      const result = openDatabase('/nonexistent/deeply/nested/path/bridge.db')
      expect(E.isLeft(result)).toBe(true)
      if (!E.isLeft(result)) return
      expect(result.left._tag).toBe('ConnectionError')
    })

    it('creates expected indexes', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      const result = openDatabase(dbPath)
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const indexes = result.right
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
        .all() as Array<{ name: string }>
      const indexNames = indexes.map((i) => i.name)

      expect(indexNames).toContain('idx_events_session_unprocessed')
      expect(indexNames).toContain('idx_responses_event')
      expect(indexNames).toContain('idx_sessions_slot')
    })
  })

  describe('closeDatabase', () => {
    it('closes connection', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      openDatabase(dbPath)
      const result = closeDatabase()
      expect(E.isRight(result)).toBe(true)

      // getDatabase should fail after close
      const dbResult = getDatabase()
      expect(E.isLeft(dbResult)).toBe(true)
    })

    it('is safe to call when no database is open', () => {
      const result = closeDatabase()
      expect(E.isRight(result)).toBe(true)
    })
  })

  describe('getDatabase', () => {
    it('returns connection after open', () => {
      const dbPath = path.join(tmpDir, 'bridge.db')
      openDatabase(dbPath)
      const result = getDatabase()
      expect(E.isRight(result)).toBe(true)
    })

    it('returns ConnectionError when not opened', () => {
      const result = getDatabase()
      expect(E.isLeft(result)).toBe(true)
      if (!E.isLeft(result)) return
      expect(result.left._tag).toBe('ConnectionError')
      if (result.left._tag === 'ConnectionError') {
        expect(result.left.message).toBe('Database not opened')
      }
    })
  })

  describe('openMemoryDatabase', () => {
    it('creates in-memory database with schema', () => {
      const result = openMemoryDatabase()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const tables = result.right
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
      const tableNames = tables.map((t) => t.name)

      expect(tableNames).toContain('sessions')
      expect(tableNames).toContain('events')
      expect(tableNames).toContain('responses')
    })

    it('has foreign_keys enabled', () => {
      const result = openMemoryDatabase()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const fk = (result.right.prepare('PRAGMA foreign_keys').get() as any)?.foreign_keys
      expect(fk).toBe(1)
    })
  })
})
