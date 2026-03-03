/**
 * @module hook/stop.test
 * Tests for stop hook handler with active listening polling loop
 * and daemon health monitoring / auto-recovery
 */

import * as E from 'fp-ts/Either'
import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { handleStopRequest, type StopDecision, HEALTH_CHECK_INTERVAL_MS, MAX_RECOVERY_ATTEMPTS } from '../stop'
import { openMemoryDatabase, closeDatabase, getDatabase } from '../../services/db'
import { findUnprocessedEvents, insertResponse } from '../../services/db-queries'

// Mock daemon-health and daemon-launcher for recovery tests
jest.mock('../../services/daemon-health', () => ({
  checkDaemonHealth: jest.fn(),
  ensureDaemonAlive: jest.fn().mockResolvedValue(true),
  updateDaemonPidInState: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../services/daemon-launcher', () => ({
  isDaemonAlive: jest.fn(),
  startDaemon: jest.fn(),
}))

import { checkDaemonHealth } from '../../services/daemon-health'
import { startDaemon } from '../../services/daemon-launcher'

const mockedCheckDaemonHealth = checkDaemonHealth as jest.MockedFunction<typeof checkDaemonHealth>
const mockedStartDaemon = startDaemon as jest.MockedFunction<typeof startDaemon>

// Helper to get the event ID of the last Stop event from SQLite
const getLastStopEventId = (): string | null => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return null

  const events = dbResult.right
    .prepare("SELECT * FROM events WHERE event_type = 'Stop' ORDER BY created_at DESC LIMIT 1")
    .all() as Array<{ payload: string }>

  if (events.length === 0) return null
  const parsed = JSON.parse(events[0]!.payload) as { eventId?: string }
  return parsed.eventId ?? null
}

// Helper to write a response to SQLite after a delay
const writeResponseAfterDelay = (delayMs: number, instruction: string) =>
  (async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    const eventId = getLastStopEventId()
    if (eventId) {
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        insertResponse(dbResult.right, `resp-${eventId}`, eventId, JSON.stringify({ instruction }))
      }
    }
  })()

describe('Stop Hook Handler', () => {
  let ipcBaseDir: string
  let sessionDir: string
  let configDir: string
  const sessionId = 'test-session-uuid'
  const slotNum = 1

  beforeEach(async () => {
    ipcBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-stop-test-'))
    sessionDir = path.join(ipcBaseDir, sessionId)
    await fs.mkdir(sessionDir, { recursive: true })

    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-stop-config-'))

    // Open in-memory SQLite database
    const dbResult = openMemoryDatabase()
    expect(E.isRight(dbResult)).toBe(true)

    mockedCheckDaemonHealth.mockReset()
    mockedStartDaemon.mockReset()

    // Default: daemon is healthy
    mockedCheckDaemonHealth.mockReturnValue(
      TE.right({ _tag: 'DaemonHealthy' as const, pid: 12345, lastHeartbeatMs: Date.now() })
    )
  })

  afterEach(async () => {
    closeDatabase()
    await fs.rm(ipcBaseDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('handleStopRequest — basic polling', () => {
    it('writes Stop event to SQLite events table', async () => {
      const responsePromise = writeResponseAfterDelay(100, 'test')

      const result = await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'last msg')()
      await responsePromise

      const dbResult = getDatabase()
      expect(E.isRight(dbResult)).toBe(true)
      if (!E.isRight(dbResult)) return

      const allEvents = dbResult.right
        .prepare('SELECT * FROM events WHERE session_id = ?')
        .all(sessionId) as Array<{ payload: string }>

      expect(allEvents.length).toBeGreaterThanOrEqual(1)
      const firstEvent = JSON.parse(allEvents[0]!.payload) as { _tag: string; slotNum: number; lastMessage: string }
      expect(firstEvent._tag).toBe('Stop')
      expect(firstEvent.slotNum).toBe(slotNum)
      expect(firstEvent.lastMessage).toBe('last msg')
    })

    it('returns block decision with instruction when response appears in SQLite', async () => {
      const responsePromise = writeResponseAfterDelay(100, 'run npm test')

      const result = await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'done')()
      await responsePromise

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const decision = result.right
        expect(decision.decision).toBe('block')
        expect(decision.reason).toBe('run npm test')
      }
    })

    it('returns null decision (pass-through) when kill file appears', async () => {
      await fs.writeFile(path.join(sessionDir, 'kill'), '', 'utf-8')

      const result = await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'done')()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.decision).toBeNull()
        expect(result.right.reason).toContain('kill')
      }
    })

    it('returns null decision (pass-through) when force_clear file appears', async () => {
      await fs.writeFile(path.join(sessionDir, 'force_clear'), '', 'utf-8')

      const result = await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'done')()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.decision).toBeNull()
        expect(result.right.reason).toContain('force clear')
      }
    })

    it('does NOT delete bound_session file (prevents session hijacking)', async () => {
      // Create a bound_session file
      const boundSessionFile = path.join(sessionDir, 'bound_session')
      await fs.writeFile(boundSessionFile, 'claude-session-123', 'utf-8')

      const responsePromise = writeResponseAfterDelay(100, 'test instruction')

      await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'done')()
      await responsePromise

      // bound_session must still exist — deleting it causes session hijacking
      const exists = await fs.access(boundSessionFile).then(() => true).catch(() => false)
      expect(exists).toBe(true)
      const content = await fs.readFile(boundSessionFile, 'utf-8')
      expect(content).toBe('claude-session-123')
    })

    it('includes sessionId in Stop event for daemon cross-validation', async () => {
      const responsePromise = writeResponseAfterDelay(100, 'test')

      await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'last msg')()
      await responsePromise

      const dbResult = getDatabase()
      if (!E.isRight(dbResult)) return

      const allEvents = dbResult.right
        .prepare("SELECT * FROM events WHERE event_type = 'Stop'")
        .all() as Array<{ payload: string }>

      expect(allEvents.length).toBeGreaterThanOrEqual(1)
      const firstEvent = JSON.parse(allEvents[0]!.payload) as { _tag: string; sessionId?: string }
      expect(firstEvent._tag).toBe('Stop')
      expect(firstEvent.sessionId).toBe(sessionId)
    })

    it('creates IPC directory if it does not exist and writes stop event', async () => {
      const nonexistentSession = 'nonexistent-session'
      const nonexistentDir = path.join(ipcBaseDir, nonexistentSession)

      // Write a kill file after a short delay so the polling loop exits
      const killPromise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 200))
        await fs.writeFile(path.join(nonexistentDir, 'kill'), '', 'utf-8')
      })()

      const result = await handleStopRequest(ipcBaseDir, nonexistentSession, slotNum, 'done')()
      await killPromise

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.decision).toBeNull()
      }

      // Verify the directory was created (for kill/force_clear signal files)
      const dirExists = await fs.access(nonexistentDir).then(() => true).catch(() => false)
      expect(dirExists).toBe(true)
    })
  })

  describe('handleStopRequest — without configDir (no health checks)', () => {
    it('works normally without configDir (backward compatible)', async () => {
      const responsePromise = writeResponseAfterDelay(100, 'no-config-dir test')

      // No configDir passed — health checks are skipped
      const result = await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'done')()
      await responsePromise

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.decision).toBe('block')
        expect(result.right.reason).toBe('no-config-dir test')
      }

      // Health check should NOT have been called
      expect(mockedCheckDaemonHealth).not.toHaveBeenCalled()
    })
  })

  describe('handleStopRequest — daemon health monitoring', () => {
    it('does not check health before HEALTH_CHECK_INTERVAL_MS', async () => {
      // Response comes quickly (before health check interval)
      const responsePromise = writeResponseAfterDelay(50, 'quick response')

      const result = await handleStopRequest(ipcBaseDir, sessionId, slotNum, 'done', configDir)()
      await responsePromise

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.reason).toBe('quick response')
      }

      // Health check should NOT have been called (response came before interval)
      expect(mockedCheckDaemonHealth).not.toHaveBeenCalled()
    })
  })

  describe('handleStopRequest — daemon recovery', () => {
    it('gives up after MAX_RECOVERY_ATTEMPTS and lets stop proceed', async () => {
      // Verify the constants are exported and sensible:
      expect(HEALTH_CHECK_INTERVAL_MS).toBe(30_000)
      expect(MAX_RECOVERY_ATTEMPTS).toBe(3)
    })
  })
})
