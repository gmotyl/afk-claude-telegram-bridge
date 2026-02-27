/**
 * @module services/ipc.test
 * Tests for IPC (Inter-Process Communication) event queue module
 * Tests JSONL file read/write operations using TaskEither for error handling
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  readEventQueue,
  writeEvent,
  deleteEventFile,
  listEvents,
  writeResponse,
  readResponse,
  createIpcDir,
  removeIpcDir,
  writeMetaFile,
  cleanOrphanedIpcDirs
} from '../ipc'
import {
  sessionStart,
  heartbeat,
  message,
  sessionEnd,
  stopEvent,
  keepAlive
} from '../../types/events'

describe('IPC Event Queue Module', () => {
  let tempDir: string

  beforeEach(async () => {
    // Create temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-test-'))
  })

  afterEach(async () => {
    // Clean up temporary directory after each test
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('readEventQueue', () => {
    it('reads empty JSONL file and returns empty array', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      await fs.writeFile(eventsFile, '', 'utf-8')

      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const events = result.right as any[]
        expect(events).toEqual([])
      }
    })

    it('reads JSONL file with single event', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event = heartbeat(1)
      await fs.writeFile(eventsFile, JSON.stringify(event) + '\n', 'utf-8')

      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const events = result.right
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual(event)
      }
    })

    it('reads JSONL file with multiple events', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const events = [
        sessionStart(1, 'test-session', 'metro', 'metro'),
        heartbeat(1),
        message('Hello', 1),
        sessionEnd(1)
      ]
      const content = events.map(e => JSON.stringify(e)).join('\n') + '\n'
      await fs.writeFile(eventsFile, content, 'utf-8')

      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const parsedEvents = result.right
        expect(parsedEvents).toHaveLength(4)
        expect(parsedEvents).toEqual(events)
      }
    })

    it('returns Left error for missing file', async () => {
      const eventsFile = path.join(tempDir, 'nonexistent.jsonl')

      const result = await readEventQueue(eventsFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcReadError')
      }
    })

    it('returns Left error for invalid JSON on a line', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const content = '{"_tag":"Heartbeat","slotNum":1}\ninvalid json\n'
      await fs.writeFile(eventsFile, content, 'utf-8')

      const result = await readEventQueue(eventsFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcParseError')
      }
    })

    it('skips empty lines in JSONL file', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const events = [
        heartbeat(1),
        heartbeat(2)
      ]
      const content = `${JSON.stringify(events[0])}\n\n${JSON.stringify(events[1])}\n`
      await fs.writeFile(eventsFile, content, 'utf-8')

      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const parsedEvents = result.right
        expect(parsedEvents).toHaveLength(2)
        expect(parsedEvents).toEqual(events)
      }
    })

    it('handles trailing newlines correctly', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event = message('Test', 1)
      // Multiple trailing newlines
      await fs.writeFile(
        eventsFile,
        JSON.stringify(event) + '\n\n\n',
        'utf-8'
      )

      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const parsedEvents = result.right
        expect(parsedEvents).toHaveLength(1)
        expect(parsedEvents[0]).toEqual(event)
      }
    })

    it('returns TaskEither that is lazy (async)', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      await fs.writeFile(eventsFile, '', 'utf-8')

      const task = readEventQueue(eventsFile)
      expect(typeof task).toBe('function')

      const result = await task()
      expect(E.isRight(result)).toBe(true)
    })

    it('handles permission denied error', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      await fs.writeFile(eventsFile, '', 'utf-8')
      await fs.chmod(eventsFile, 0o000)

      const result = await readEventQueue(eventsFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcReadError')
      }

      // Cleanup - restore permissions to allow deletion
      await fs.chmod(eventsFile, 0o644)
    })

    it('parses complex event objects correctly', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const complexEvent = message('Multi\nline\ntext with "quotes"', 42)
      await fs.writeFile(eventsFile, JSON.stringify(complexEvent) + '\n', 'utf-8')

      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const parsedEvents = result.right
        expect(parsedEvents[0]).toEqual(complexEvent)
      }
    })
  })

  describe('writeEvent', () => {
    it('appends event to empty file', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      await fs.writeFile(eventsFile, '', 'utf-8')
      const event = heartbeat(1)

      const result = await writeEvent(eventsFile, event)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(eventsFile, 'utf-8')
      expect(content).toBe(JSON.stringify(event) + '\n')
    })

    it('appends event to file with existing events', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event1 = sessionStart(1, 'test-session', 'metro', 'metro')
      const event2 = heartbeat(1)

      await fs.writeFile(eventsFile, JSON.stringify(event1) + '\n', 'utf-8')
      const result = await writeEvent(eventsFile, event2)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(eventsFile, 'utf-8')
      const lines = content.split('\n').filter(line => line.length > 0)
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0] as string)).toEqual(event1)
      expect(JSON.parse(lines[1] as string)).toEqual(event2)
    })

    it('creates file if it does not exist', async () => {
      const eventsFile = path.join(tempDir, 'new-events.jsonl')
      const event = message('New', 1)

      const result = await writeEvent(eventsFile, event)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(eventsFile, 'utf-8')
      expect(content).toBe(JSON.stringify(event) + '\n')
    })

    it('returns Left error for invalid directory path', async () => {
      const eventsFile = path.join(tempDir, 'nonexistent-dir', 'events.jsonl')
      const event = heartbeat(1)

      const result = await writeEvent(eventsFile, event)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcWriteError')
      }
    })

    it('returns TaskEither that is lazy (async)', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event = heartbeat(1)

      const task = writeEvent(eventsFile, event)
      expect(typeof task).toBe('function')

      const result = await task()
      expect(E.isRight(result)).toBe(true)
    })

    it('handles complex event objects', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const complexEvent = message('Complex "quoted" text', 99)

      const result = await writeEvent(eventsFile, complexEvent)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(eventsFile, 'utf-8')
      const parsed = JSON.parse(content.trim())
      expect(parsed).toEqual(complexEvent)
    })

    it('handles permission denied error', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      await fs.writeFile(eventsFile, '', 'utf-8')
      await fs.chmod(tempDir, 0o000)

      const event = heartbeat(1)
      const result = await writeEvent(eventsFile, event)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcWriteError')
      }

      // Cleanup - restore permissions
      await fs.chmod(tempDir, 0o755)
    })
  })

  describe('deleteEventFile', () => {
    it('deletes an existing event file', async () => {
      const eventFile = path.join(tempDir, 'event.jsonl')
      await fs.writeFile(eventFile, '{}', 'utf-8')

      const result = await deleteEventFile(eventFile)()

      expect(E.isRight(result)).toBe(true)
      const exists = await fs
        .access(eventFile)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    })

    it('returns Left error for nonexistent file', async () => {
      const eventFile = path.join(tempDir, 'nonexistent.jsonl')

      const result = await deleteEventFile(eventFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcWriteError')
      }
    })

    it('returns TaskEither that is lazy (async)', async () => {
      const eventFile = path.join(tempDir, 'event.jsonl')
      await fs.writeFile(eventFile, '{}', 'utf-8')

      const task = deleteEventFile(eventFile)
      expect(typeof task).toBe('function')

      const result = await task()
      expect(E.isRight(result)).toBe(true)
    })

    it('handles permission denied error', async () => {
      const eventFile = path.join(tempDir, 'event.jsonl')
      await fs.writeFile(eventFile, '{}', 'utf-8')
      await fs.chmod(tempDir, 0o000)

      const result = await deleteEventFile(eventFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcWriteError')
      }

      // Cleanup - restore permissions
      await fs.chmod(tempDir, 0o755)
    })
  })

  describe('listEvents', () => {
    it('returns empty array for empty directory', async () => {
      const result = await listEvents(tempDir)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const files = result.right as string[]
        expect(files).toEqual([])
      }
    })

    it('lists all files in directory', async () => {
      const file1 = path.join(tempDir, 'event1.jsonl')
      const file2 = path.join(tempDir, 'event2.jsonl')
      const file3 = path.join(tempDir, 'event3.jsonl')

      await fs.writeFile(file1, '{}', 'utf-8')
      await fs.writeFile(file2, '{}', 'utf-8')
      await fs.writeFile(file3, '{}', 'utf-8')

      const result = await listEvents(tempDir)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const files = result.right as string[]
        expect(files).toHaveLength(3)
        expect(files).toContain('event1.jsonl')
        expect(files).toContain('event2.jsonl')
        expect(files).toContain('event3.jsonl')
      }
    })

    it('lists files with various extensions', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.jsonl'), '{}', 'utf-8')
      await fs.writeFile(path.join(tempDir, 'file2.json'), '{}', 'utf-8')
      await fs.writeFile(path.join(tempDir, 'file3.txt'), 'text', 'utf-8')

      const result = await listEvents(tempDir)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const files = result.right as string[]
        expect(files).toHaveLength(3)
      }
    })

    it('returns Left error for nonexistent directory', async () => {
      const nonexistentDir = path.join(tempDir, 'nonexistent')

      const result = await listEvents(nonexistentDir)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcReadError')
      }
    })

    it('returns TaskEither that is lazy (async)', async () => {
      const task = listEvents(tempDir)
      expect(typeof task).toBe('function')

      const result = await task()
      expect(E.isRight(result)).toBe(true)
    })

    it('excludes subdirectories, only lists files', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.jsonl'), '{}', 'utf-8')
      await fs.mkdir(path.join(tempDir, 'subdir'), { recursive: true })
      await fs.writeFile(path.join(tempDir, 'subdir', 'file2.jsonl'), '{}', 'utf-8')

      const result = await listEvents(tempDir)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const files = result.right as string[]
        expect(files).toHaveLength(1)
        expect(files[0]).toBe('file1.jsonl')
      }
    })

    it('handles permission denied error', async () => {
      await fs.chmod(tempDir, 0o000)

      const result = await listEvents(tempDir)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('IpcReadError')
      }

      // Cleanup - restore permissions
      await fs.chmod(tempDir, 0o755)
    })

    it('returns sorted file list', async () => {
      // Create files in non-alphabetical order
      await fs.writeFile(path.join(tempDir, 'z.jsonl'), '{}', 'utf-8')
      await fs.writeFile(path.join(tempDir, 'a.jsonl'), '{}', 'utf-8')
      await fs.writeFile(path.join(tempDir, 'm.jsonl'), '{}', 'utf-8')

      const result = await listEvents(tempDir)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const files = result.right as string[]
        expect(files).toEqual(['a.jsonl', 'm.jsonl', 'z.jsonl'])
      }
    })
  })

  describe('writeResponse', () => {
    it('writes a response file with instruction', async () => {
      const result = await writeResponse(tempDir, 'evt-123', { instruction: 'run tests' })()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(path.join(tempDir, 'response-evt-123.json'), 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.instruction).toBe('run tests')
    })

    it('returns Left error for invalid directory', async () => {
      const result = await writeResponse('/nonexistent/dir', 'evt-1', { instruction: 'test' })()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('IpcWriteError')
      }
    })
  })

  describe('readResponse', () => {
    it('reads an existing response file', async () => {
      await fs.writeFile(
        path.join(tempDir, 'response-evt-456.json'),
        JSON.stringify({ instruction: 'deploy' }),
        'utf-8'
      )

      const result = await readResponse(tempDir, 'evt-456')()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toEqual({ instruction: 'deploy' })
      }
    })

    it('returns null when response file does not exist', async () => {
      const result = await readResponse(tempDir, 'nonexistent')()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toBeNull()
      }
    })

    it('returns Left error for malformed JSON', async () => {
      await fs.writeFile(
        path.join(tempDir, 'response-evt-bad.json'),
        'not json',
        'utf-8'
      )

      const result = await readResponse(tempDir, 'evt-bad')()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('IpcParseError')
      }
    })
  })

  describe('Stop and KeepAlive events through IPC', () => {
    it('writes and reads Stop event via JSONL', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event = stopEvent('evt-1', 1, 'last message')

      await writeEvent(eventsFile, event)()
      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1)
        expect(result.right[0]!._tag).toBe('Stop')
      }
    })

    it('writes and reads KeepAlive event via JSONL', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event = keepAlive('ka-1', 'evt-1', 2)

      await writeEvent(eventsFile, event)()
      const result = await readEventQueue(eventsFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1)
        expect(result.right[0]!._tag).toBe('KeepAlive')
      }
    })
  })

  describe('createIpcDir', () => {
    it('creates session directory', async () => {
      const result = await createIpcDir(tempDir, 'session-abc')()
      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toBe(`${tempDir}/session-abc`)
        const stat = await fs.stat(result.right)
        expect(stat.isDirectory()).toBe(true)
      }
    })

    it('is idempotent (creating twice succeeds)', async () => {
      await createIpcDir(tempDir, 'session-abc')()
      const result = await createIpcDir(tempDir, 'session-abc')()
      expect(E.isRight(result)).toBe(true)
    })
  })

  describe('removeIpcDir', () => {
    it('removes session directory', async () => {
      await createIpcDir(tempDir, 'session-rm')()
      const result = await removeIpcDir(tempDir, 'session-rm')()
      expect(E.isRight(result)).toBe(true)
      const exists = await fs.access(`${tempDir}/session-rm`).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })

    it('succeeds even if directory does not exist', async () => {
      const result = await removeIpcDir(tempDir, 'nonexistent')()
      expect(E.isRight(result)).toBe(true)
    })
  })

  describe('writeMetaFile', () => {
    it('writes meta.json to IPC directory', async () => {
      const ipcDir = `${tempDir}/session-meta`
      await fs.mkdir(ipcDir, { recursive: true })
      const meta = { sessionId: 'abc', project: 'metro' }

      const result = await writeMetaFile(ipcDir, meta)()
      expect(E.isRight(result)).toBe(true)

      const content = JSON.parse(await fs.readFile(`${ipcDir}/meta.json`, 'utf-8'))
      expect(content.sessionId).toBe('abc')
      expect(content.project).toBe('metro')
    })
  })

  describe('cleanOrphanedIpcDirs', () => {
    it('removes directories not in active set', async () => {
      await fs.mkdir(`${tempDir}/active-session`, { recursive: true })
      await fs.mkdir(`${tempDir}/orphan-session`, { recursive: true })

      const result = await cleanOrphanedIpcDirs(tempDir, new Set(['active-session']))()
      expect(E.isRight(result)).toBe(true)

      const activeExists = await fs.access(`${tempDir}/active-session`).then(() => true).catch(() => false)
      const orphanExists = await fs.access(`${tempDir}/orphan-session`).then(() => true).catch(() => false)
      expect(activeExists).toBe(true)
      expect(orphanExists).toBe(false)
    })

    it('preserves files (only removes directories)', async () => {
      await fs.writeFile(`${tempDir}/some-file.json`, '{}', 'utf-8')
      await fs.mkdir(`${tempDir}/orphan`, { recursive: true })

      const result = await cleanOrphanedIpcDirs(tempDir, new Set())()
      expect(E.isRight(result)).toBe(true)

      const fileExists = await fs.access(`${tempDir}/some-file.json`).then(() => true).catch(() => false)
      expect(fileExists).toBe(true)
    })
  })
})
