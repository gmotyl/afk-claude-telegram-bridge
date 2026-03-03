/**
 * @module hook/permission.test
 * Tests for permission request handling
 * Hook writes permission request to SQLite, waits for daemon response, returns approval status
 */

import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { requestPermission, type PermissionResponse } from '../permission'
import { type HookArgs } from '../args'
import { openMemoryDatabase, closeDatabase, getDatabase } from '../../services/db'
import { findUnprocessedEvents, insertResponse } from '../../services/db-queries'

// Helper to get request ID from SQLite events table
const getLastRequestId = (): string | null => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return null

  const eventsResult = findUnprocessedEvents(dbResult.right, 'test-session-uuid')
  if (E.isLeft(eventsResult) || eventsResult.right.length === 0) return null

  const lastEvent = eventsResult.right[eventsResult.right.length - 1]
  if (!lastEvent) return null
  const parsed = JSON.parse(lastEvent.payload) as { requestId?: string }
  return parsed.requestId ?? null
}

// Helper to write a response to SQLite
const writeResponseToDb = (eventId: string, payload: Record<string, unknown>): void => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return
  insertResponse(dbResult.right, `resp-${eventId}`, eventId, JSON.stringify(payload))
}

describe('Permission Request Handler', () => {
  let ipcBaseDir: string
  let sessionDir: string
  const sessionId = 'test-session-uuid'
  const slotNum = 1

  beforeEach(async () => {
    ipcBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-permission-test-'))
    sessionDir = path.join(ipcBaseDir, sessionId)
    await fs.mkdir(sessionDir, { recursive: true })

    // Open in-memory SQLite database
    const dbResult = openMemoryDatabase()
    expect(E.isRight(dbResult)).toBe(true)
  })

  afterEach(async () => {
    closeDatabase()
    try {
      await fs.rm(ipcBaseDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('requestPermission', () => {
    describe('successful permission approval', () => {
      it('writes permission request to IPC and returns approved response', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = getLastRequestId()
          if (requestId) {
            writeResponseToDb(requestId, { approved: true })
          }
        })()

        const result = await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect((result.right as PermissionResponse).approved).toBe(true)
        }
      })

      it('returns approved with reason when provided', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Node',
          command: 'node script.js',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = getLastRequestId()
          if (requestId) {
            writeResponseToDb(requestId, { approved: true, reason: 'Safe script detected' })
          }
        })()

        const result = await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          const response = result.right as PermissionResponse
          expect(response.approved).toBe(true)
          expect(response.reason).toBe('Safe script detected')
        }
      })
    })

    describe('permission denial', () => {
      it('returns denied response', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'rm -rf /',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = getLastRequestId()
          if (requestId) {
            writeResponseToDb(requestId, { approved: false, reason: 'Dangerous command' })
          }
        })()

        const result = await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          const response = result.right as PermissionResponse
          expect(response.approved).toBe(false)
          expect(response.reason).toBe('Dangerous command')
        }
      })
    })

    describe('IPC event writing', () => {
      it('writes permission request to SQLite events table', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = getLastRequestId()
          if (requestId) {
            writeResponseToDb(requestId, { approved: true })
          }
        })()

        await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        // Events written to SQLite
        const dbResult = getDatabase()
        expect(E.isRight(dbResult)).toBe(true)
        if (!E.isRight(dbResult)) return

        const eventsResult = findUnprocessedEvents(dbResult.right, sessionId)
        expect(E.isRight(eventsResult)).toBe(true)
        if (!E.isRight(eventsResult)) return

        // Event exists (may be marked read by now, check all)
        const allEvents = dbResult.right
          .prepare('SELECT * FROM events WHERE session_id = ?')
          .all(sessionId) as Array<{ payload: string }>

        expect(allEvents.length).toBeGreaterThan(0)
        const event = JSON.parse(allEvents[0]!.payload) as Record<string, unknown>
        expect(event._tag).toBe('PermissionRequest')
        expect(event.tool).toBe('Bash')
        expect(event.command).toBe('npm install')
        expect(event.requestId).toBeDefined()
        expect(event.slotNum).toBe(slotNum)
      })
    })

    describe('timeout handling', () => {
      it('returns HookError when timeout is exceeded', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const result = await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 50)()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookError')
          expect((result.left as any).message).toContain('timeout')
        }
      })
    })

    describe('error handling', () => {
      it('returns HookError when response missing approved field', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = getLastRequestId()
          if (requestId) {
            writeResponseToDb(requestId, { reason: 'No approved field' })
          }
        })()

        const result = await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookError')
        }
      })
    })
  })
})
