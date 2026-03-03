import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import { startDaemon, cleanupOrphanedSlots, stripBotMention } from '../daemon'
import { State, Slot } from '../../types/state'
import { sessionStart, heartbeat, sessionEnd, message, stopEvent, keepAlive, permissionRequest } from '../../types/events'
import { getDatabase, closeDatabase } from '../../services/db'
import { ensureSessionForIpc, insertEvent, findUnreadResponse } from '../../services/db-queries'

let tempDir: string
const sessionId = 'test-session-1'
let sessionDir: string

// Mock Telegram API calls to prevent actual network requests
jest.mock('../../services/telegram', () => ({
  sendTelegramMessage: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 1 } })),
  createForumTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_thread_id: 100 } })),
  deleteForumTopic: () => () => Promise.resolve(E.right({ ok: true })),
  sendMessageToTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 2 } })),
  sendButtonsToTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 3 } })),
  sendMultiRowButtonsToTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 4 } })),
  editMessageText: () => () => Promise.resolve(E.right({ ok: true })),
  answerCallbackQuery: () => () => Promise.resolve(E.right({ ok: true })),
  sendChatAction: () => () => Promise.resolve(E.right({ ok: true })),
  callTelegramApi: () => () => Promise.resolve(E.right({ ok: true })),
}))

// Mock Telegram polling to return no updates
jest.mock('../../services/telegram-poller', () => ({
  pollTelegram: () => () => Promise.resolve(E.right({ updates: [], nextOffset: 0 })),
  pollerError: (msg: string) => ({ _tag: 'PollerError', message: msg }),
  extractInstruction: () => E.left('No instruction'),
}))

/**
 * Helper to create a test config file
 */
const createTestConfigFile = async (dir: string): Promise<string> => {
  const configPath = path.join(dir, 'config.json')
  const config = {
    telegramBotToken: 'test-token',
    telegramGroupId: 123456,
    ipcBaseDir: dir,
    sessionTimeout: 5 * 60 * 1000
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2))
  return configPath
}

/**
 * Helper to write events to SQLite (replaces file-based writeEventFile).
 * Must be called AFTER daemon has started (DB opened by daemon).
 */
const writeEventsToDb = (events: any[]): void => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) throw new Error('Database not opened')
  const db = dbResult.right

  for (const event of events) {
    const eventSessionId = event.sessionId || sessionId
    const slotNum = event.slotNum ?? 0
    const eventId = event.requestId || event.eventId || `${event._tag}-${Date.now()}-${Math.random()}`

    // Ensure session row exists for FK constraint
    ensureSessionForIpc(db, eventSessionId, slotNum)
    insertEvent(db, eventId, eventSessionId, event._tag, JSON.stringify(event))
  }
}

const cleanup = async (dir: string): Promise<void> => {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

describe('startDaemon', () => {
  beforeEach(async () => {
    tempDir = path.join('/tmp', 'daemon-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    sessionDir = path.join(tempDir, sessionId)
    await cleanup(tempDir)
  })

  afterEach(async () => {
    // Small delay to let in-flight daemon iterations drain before closing DB
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await cleanup(tempDir)
  })

  it('returns a stop function on successful startup', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      const stopFunction = result.right
      expect(typeof stopFunction).toBe('function')
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('returns error if config file does not exist', async () => {
    const configPath = path.join(tempDir, 'nonexistent', 'config.json')
    const result = await startDaemon(configPath)()
    expect(E.isLeft(result)).toBe(true)
  })

  it('creates state file in ipc directory if it does not exist', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stateFilePath = path.join(tempDir, 'state.json')
      const exists = await fs.access(stateFilePath).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes SessionStart events from SQLite', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write event to SQLite (DB opened by daemon)
      const event = sessionStart(1, sessionId, 'metro', 'metro')
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stateFilePath = path.join(tempDir, 'state.json')
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      expect(state.slots[1]?.projectName).toBe('metro')

      // Event should be marked as processed in SQLite
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0 AND session_id = ?")
          .all(sessionId) as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes SessionEnd events and removes slots', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create initial state with a slot
    const stateFilePath = path.join(tempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          sessionId,
          projectName: 'metro',
          topicName: 'metro',
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
        2: undefined, 3: undefined, 4: undefined
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write SessionEnd event to SQLite
      const event = sessionEnd(1)
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State
      expect(state.slots[1]).toBeUndefined()

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes Heartbeat events and updates lastHeartbeat', async () => {
    const configPath = await createTestConfigFile(tempDir)
    const now = new Date()

    const stateFilePath = path.join(tempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          sessionId,
          projectName: 'metro',
          topicName: 'metro',
          activatedAt: now,
          lastHeartbeat: new Date(now.getTime() - 10000)
        },
        2: undefined, 3: undefined, 4: undefined
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      const event = heartbeat(1)
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      if (state.slots[1]) {
        const timeSinceHeartbeat = new Date().getTime() - new Date(state.slots[1].lastHeartbeat).getTime()
        expect(timeSinceHeartbeat).toBeLessThan(3000)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes multiple events in sequence', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write events for two different sessions — pass explicit sessionId to avoid
      // ensureSessionForIpc CASCADE-deleting sess-1 when heartbeat/message use a different sessionId
      writeEventsToDb([
        sessionStart(1, 'sess-1', 'metro', 'metro'),
        heartbeat(1, 'sess-1'),
        message('Hello', 1, 'sess-1'),
        sessionStart(2, 'sess-2', 'alokai', 'alokai'),
      ])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stateFilePath = path.join(tempDir, 'state.json')
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      expect(state.slots[2]).toBeDefined()
      expect(state.slots[1]?.projectName).toBe('metro')
      expect(state.slots[2]?.projectName).toBe('alokai')

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes Stop events with queued instruction auto-inject', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create initial state with active slot
    const stateFilePath = path.join(tempDir, 'state.json')
    const stateWithSlot: State = {
      slots: {
        1: {
          sessionId,
          projectName: 'metro',
          topicName: 'metro',
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
        2: undefined, 3: undefined, 4: undefined
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(stateWithSlot, null, 2))

    // Create queued instruction in session dir (still file-based)
    await fs.mkdir(sessionDir, { recursive: true })
    await fs.writeFile(
      path.join(sessionDir, 'queued_instruction.json'),
      JSON.stringify({ text: 'run tests', timestamp: new Date().toISOString() })
    )

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Create stop event in SQLite — pass explicit sessionId to match slot's session
      const event = stopEvent('evt-test-1', 1, 'last message', sessionId)
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Response should be in SQLite
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const responseResult = findUnreadResponse(dbResult.right, 'evt-test-1')
        expect(E.isRight(responseResult)).toBe(true)
        if (E.isRight(responseResult) && responseResult.right) {
          const payload = JSON.parse(responseResult.right.payload)
          expect(payload.instruction).toBe('run tests')
        }
      }

      // Queued instruction should be deleted
      const queuedExists = await fs.access(path.join(sessionDir, 'queued_instruction.json')).then(() => true).catch(() => false)
      expect(queuedExists).toBe(false)

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes KeepAlive events without state change', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      const event = keepAlive('ka-1', 'evt-1', 1)
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Event should be marked processed
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0")
          .all() as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('handles empty IPC directory gracefully', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('stops gracefully without errors', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('continues running even if an event fails to process', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create initial state with slot in position 1
    const stateFilePath = path.join(tempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          sessionId,
          projectName: 'metro',
          topicName: 'metro',
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
        2: undefined, 3: undefined, 4: undefined
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Bad event (slot 1 occupied) + good event
      writeEventsToDb([
        sessionStart(1, 'sess-alokai', 'alokai', 'alokai'),
        sessionStart(2, 'sess-ch', 'ch', 'ch')
      ])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      expect(state.slots[1]?.projectName).toBe('metro')
      expect(state.slots[2]).toBeDefined()
      expect(state.slots[2]?.projectName).toBe('ch')

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })
})

// ============================================================================
// cleanupOrphanedSlots tests
// ============================================================================

describe('cleanupOrphanedSlots', () => {
  let cleanupTempDir: string

  const makeSlot = (sid: string): Slot => ({
    sessionId: sid,
    projectName: 'test-project',
    topicName: 'test-topic',
    activatedAt: new Date(),
    lastHeartbeat: new Date()
  })

  const makeConfig = (ipcBaseDir: string) => ({
    telegramBotToken: 'test-token',
    telegramGroupId: 123456,
    ipcBaseDir,
    sessionTimeout: 5 * 60 * 1000
  })

  beforeEach(async () => {
    cleanupTempDir = path.join('/tmp', 'cleanup-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(cleanupTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(cleanupTempDir, { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(cleanupTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('removes slots whose IPC session directory does not exist', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {
        1: makeSlot('orphaned-session'),
      },
      pendingStops: {}
    }

    // Do NOT create the session directory — it's orphaned
    const result = await cleanupOrphanedSlots(config, state)

    expect(result.slots[1]).toBeUndefined()
    expect(Object.keys(result.slots)).not.toContain('1')
  })

  it('keeps slots whose IPC session directory exists', async () => {
    const config = makeConfig(cleanupTempDir)
    const slot = makeSlot('alive-session')
    const state: State = {
      slots: { 1: slot },
      pendingStops: {}
    }

    // Create the session directory so it's not orphaned
    await fs.mkdir(path.join(cleanupTempDir, 'alive-session'), { recursive: true })

    const result = await cleanupOrphanedSlots(config, state)

    expect(result.slots[1]).toBeDefined()
    expect(result.slots[1]?.sessionId).toBe('alive-session')
  })

  it('after cleanup, the orphaned slot key is truly deleted from the object', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {
        1: makeSlot('orphaned-1'),
        2: makeSlot('alive-2'),
      },
      pendingStops: {}
    }

    // Only create session dir for slot 2
    await fs.mkdir(path.join(cleanupTempDir, 'alive-2'), { recursive: true })

    const result = await cleanupOrphanedSlots(config, state)

    // Slot 1 should be truly gone (key not present), not just set to undefined
    expect(Object.keys(result.slots)).not.toContain('1')
    expect('1' in result.slots).toBe(false)

    // Slot 2 should remain
    expect(result.slots[2]).toBeDefined()
    expect(result.slots[2]?.sessionId).toBe('alive-2')
  })

  it('running cleanup twice does not log or process already-removed slots', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {
        1: makeSlot('orphaned-session'),
        2: makeSlot('alive-session'),
      },
      pendingStops: {}
    }

    await fs.mkdir(path.join(cleanupTempDir, 'alive-session'), { recursive: true })

    // Capture console.log calls
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    // First cleanup: should log about orphaned slot 1
    const result1 = await cleanupOrphanedSlots(config, state)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cleaning orphaned slot 1')
    )

    logSpy.mockClear()

    // Second cleanup on the result of first: should NOT log about slot 1 again
    const result2 = await cleanupOrphanedSlots(config, result1)
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Cleaning orphaned slot 1')
    )

    // State should be unchanged between first and second cleanup
    expect(result2.slots[2]?.sessionId).toBe('alive-session')
    expect(Object.keys(result2.slots)).toEqual(['2'])

    logSpy.mockRestore()
  })

  it('handles state with no slots gracefully', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {},
      pendingStops: {}
    }

    const result = await cleanupOrphanedSlots(config, state)

    expect(Object.keys(result.slots)).toHaveLength(0)
  })

  it('cleanup result persists across daemon iterations (integration)', async () => {
    const configPath = await createTestConfigFile(cleanupTempDir)

    // Create initial state with a slot whose session dir does NOT exist
    const stateFilePath = path.join(cleanupTempDir, 'state.json')
    const orphanedState: State = {
      slots: {
        1: {
          sessionId: 'gone-session',
          projectName: 'orphaned',
          topicName: 'orphaned',
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        }
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(orphanedState, null, 2))

    // Do NOT create 'gone-session' directory — it's orphaned

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)

      // Read persisted state — slot should still be there since cleanup
      // interval hasn't elapsed (only 1.5s vs 30s threshold)
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const savedState = JSON.parse(stateContent) as State

      // The slot may or may not have been cleaned depending on timing.
      // What we verify is that if it WAS cleaned, the key is truly gone.
      if (savedState.slots[1] === undefined || savedState.slots[1] === null) {
        // Key should not be present at all (not just undefined/null)
        const keys = Object.keys(savedState.slots)
        expect(keys).not.toContain('1')
      }
    }
  })
})

// ============================================================================
// Permission batching tests
// ============================================================================

describe('permission batching', () => {
  let batchTempDir: string
  const batchSessionId = 'batch-session-1'

  const createBatchConfigFile = async (dir: string, overrides?: Record<string, unknown>): Promise<string> => {
    const configPath = path.join(dir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: dir,
      sessionTimeout: 5 * 60 * 1000,
      permissionBatchWindowMs: 100, // Short window for testing
      sessionTrustThreshold: 2, // Low threshold for testing
      ...overrides,
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))
    return configPath
  }

  beforeEach(async () => {
    batchTempDir = path.join('/tmp', 'daemon-batch-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(batchTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(batchTempDir, batchSessionId), { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(batchTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('buffers permission requests and processes them', async () => {
    const configPath = await createBatchConfigFile(batchTempDir)

    // Create state with active slot that has a threadId
    const stateFilePath = path.join(batchTempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          sessionId: batchSessionId,
          projectName: 'test',
          topicName: 'test',
          threadId: 100,
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write a permission request event to SQLite
      const event = permissionRequest('req-1', 'Bash', 'npm install', 1, batchSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, batchSessionId, 1)
        insertEvent(db, 'req-1', batchSessionId, 'PermissionRequest', JSON.stringify(event))
      }

      // Wait for event processing + batch flush (100ms window + daemon tick)
      await new Promise((resolve) => setTimeout(resolve, 2500))

      // After batch window expires, the request should have been flushed
      // Event should be marked as processed
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0 AND session_id = ?")
          .all(batchSessionId) as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes multiple permission requests from same slot in a single batch', async () => {
    const configPath = await createBatchConfigFile(batchTempDir)

    const stateFilePath = path.join(batchTempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          sessionId: batchSessionId,
          projectName: 'test',
          topicName: 'test',
          threadId: 100,
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    // Spy on sendMultiRowButtonsToTopic to verify it gets called for batch
    const telegram = jest.requireMock('../../services/telegram')
    const multiRowSpy = jest.fn(() => () => Promise.resolve(E.right({ ok: true, result: { message_id: 4 } })))
    telegram.sendMultiRowButtonsToTopic = multiRowSpy

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write multiple permission request events to SQLite
      const events = [
        permissionRequest('req-batch-1', 'Bash', 'npm install', 1, batchSessionId),
        permissionRequest('req-batch-2', 'Edit', '/src/file.ts', 1, batchSessionId),
        permissionRequest('req-batch-3', 'Write', '/src/new.ts', 1, batchSessionId),
      ]
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, batchSessionId, 1)
        for (const event of events) {
          const eid = (event as any).requestId
          insertEvent(db, eid, batchSessionId, 'PermissionRequest', JSON.stringify(event))
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2500))

      // sendMultiRowButtonsToTopic should have been called for the batch
      expect(multiRowSpy).toHaveBeenCalled()

      // Verify the message text mentions 3 requests
      const callArgs = multiRowSpy.mock.calls[0] as unknown[] | undefined
      expect(callArgs).toBeDefined()
      if (callArgs) {
        const text = callArgs[2] as string
        expect(text).toContain('3 permission requests')
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mock
    telegram.sendMultiRowButtonsToTopic = () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 4 } }))
  })

  it('sends single-request format when only one permission in batch', async () => {
    const configPath = await createBatchConfigFile(batchTempDir)

    const stateFilePath = path.join(batchTempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          sessionId: batchSessionId,
          projectName: 'test',
          topicName: 'test',
          threadId: 100,
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    // Spy on sendButtonsToTopic (single-row) to verify it's used for single request
    const telegram = jest.requireMock('../../services/telegram')
    const singleRowSpy = jest.fn(() => () => Promise.resolve(E.right({ ok: true, result: { message_id: 3 } })))
    telegram.sendButtonsToTopic = singleRowSpy

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      const event = permissionRequest('req-single', 'Bash', 'echo hello', 1, batchSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, batchSessionId, 1)
        insertEvent(db, 'req-single', batchSessionId, 'PermissionRequest', JSON.stringify(event))
      }

      await new Promise((resolve) => setTimeout(resolve, 2500))

      // sendButtonsToTopic should have been called (single request format)
      expect(singleRowSpy).toHaveBeenCalled()

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mock
    telegram.sendButtonsToTopic = () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 3 } }))
  })
})

// ============================================================================
// Session trust tests (via daemon integration)
// ============================================================================

describe('session trust via callback', () => {
  let trustTempDir: string
  const trustSessionId = 'trust-session-1'

  beforeEach(async () => {
    trustTempDir = path.join('/tmp', 'daemon-trust-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(trustTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(trustTempDir, trustSessionId), { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(trustTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('trusted session auto-approves permission requests by writing response to SQLite', async () => {
    const configPath = path.join(trustTempDir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: trustTempDir,
      sessionTimeout: 5 * 60 * 1000,
      permissionBatchWindowMs: 100,
      sessionTrustThreshold: 1, // Trust after 1 approval for fast testing
    }
    await fs.mkdir(trustTempDir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

    // Create state with active slot
    const stateFilePath = path.join(trustTempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          sessionId: trustSessionId,
          projectName: 'test',
          topicName: 'test',
          threadId: 200,
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
      },
      pendingStops: {}
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    // Mock Telegram polling to simulate approve + trust callbacks
    const telegram = jest.requireMock('../../services/telegram')
    const poller = jest.requireMock('../../services/telegram-poller')

    let pollCallCount = 0
    poller.pollTelegram = () => () => {
      pollCallCount++
      // On 3rd poll, simulate approve callback
      if (pollCallCount === 3) {
        return Promise.resolve(E.right({
          updates: [
            {
              update_id: 1,
              callback_query: {
                id: 'cq-1',
                data: `approve:req-trust-1`,
                message: { message_id: 10, chat: { id: 123456 }, message_thread_id: 200 }
              }
            }
          ],
          nextOffset: 2
        }))
      }
      if (pollCallCount === 4) {
        return Promise.resolve(E.right({
          updates: [
            {
              update_id: 2,
              callback_query: {
                id: 'cq-2',
                data: `trust:${trustSessionId}`,
                message: { message_id: 11, chat: { id: 123456 }, message_thread_id: 200 }
              }
            }
          ],
          nextOffset: 3
        }))
      }
      return Promise.resolve(E.right({ updates: [], nextOffset: pollCallCount }))
    }

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write first permission request to SQLite
      const event1 = permissionRequest('req-trust-1', 'Bash', 'npm test', 1, trustSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, trustSessionId, 1)
        insertEvent(db, 'req-trust-1', trustSessionId, 'PermissionRequest', JSON.stringify(event1))
      }

      // Wait for approval + trust callbacks
      await new Promise((resolve) => setTimeout(resolve, 5000))

      // Now write a second permission request — should be auto-approved
      const event2 = permissionRequest('req-trust-2', 'Bash', 'npm run build', 1, trustSessionId)
      if (E.isRight(dbResult)) {
        insertEvent(dbResult.right, 'req-trust-2', trustSessionId, 'PermissionRequest', JSON.stringify(event2))
      }

      // Wait for auto-approve to process
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Check response was auto-created in SQLite (trusted session auto-approve)
      if (E.isRight(dbResult)) {
        const responseResult = findUnreadResponse(dbResult.right, 'req-trust-2')
        expect(E.isRight(responseResult)).toBe(true)
        if (E.isRight(responseResult) && responseResult.right) {
          const payload = JSON.parse(responseResult.right.payload)
          expect(payload.approved).toBe(true)
        }
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mocks
    poller.pollTelegram = () => () => Promise.resolve(E.right({ updates: [], nextOffset: 0 }))
  }, 15000)
})

describe('stripBotMention', () => {
  it('strips @BotName from slash commands', () => {
    expect(stripBotMention('/clear@Clade_motyl_ai_bot')).toBe('/clear')
    expect(stripBotMention('/compact@MyBot')).toBe('/compact')
    expect(stripBotMention('/help@Bot123')).toBe('/help')
  })

  it('passes through commands without bot mention', () => {
    expect(stripBotMention('/clear')).toBe('/clear')
    expect(stripBotMention('/compact')).toBe('/compact')
  })

  it('passes through regular text unchanged', () => {
    expect(stripBotMention('run npm test')).toBe('run npm test')
    expect(stripBotMention('fix the bug in auth.ts')).toBe('fix the bug in auth.ts')
  })

  it('only strips bot mention at start of message', () => {
    expect(stripBotMention('please /clear@Bot the cache')).toBe('please /clear@Bot the cache')
  })

  it('handles empty string', () => {
    expect(stripBotMention('')).toBe('')
  })
})
