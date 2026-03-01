/**
 * @module hook/permission.test
 * Tests for permission request handling
 * Hook writes permission request to IPC, waits for daemon response, returns approval status
 */

import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { requestPermission, type PermissionResponse } from '../permission'
import { type HookArgs } from '../args'

// Helper to get request ID from per-event files
const getLastRequestId = async (sessionDir: string): Promise<string | null> => {
  try {
    const files = await fs.readdir(sessionDir)
    const eventFiles = files.filter(f => f.startsWith('event-') && f.endsWith('.jsonl')).sort()
    if (eventFiles.length === 0) return null

    const lastFile = eventFiles[eventFiles.length - 1]
    if (!lastFile) return null
    const eventFile = path.join(sessionDir, lastFile)
    const content = await fs.readFile(eventFile, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())
    if (lines.length === 0) return null

    const lastLine = lines[lines.length - 1]
    if (!lastLine) return null
    const lastEvent = JSON.parse(lastLine) as { requestId?: string }
    return lastEvent.requestId ?? null
  } catch {
    return null
  }
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
  })

  afterEach(async () => {
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
          const requestId = await getLastRequestId(sessionDir)
          if (requestId) {
            const responseFile = path.join(sessionDir, `response-${requestId}.json`)
            await fs.writeFile(responseFile, JSON.stringify({ approved: true }), 'utf-8')
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
          const requestId = await getLastRequestId(sessionDir)
          if (requestId) {
            const responseFile = path.join(sessionDir, `response-${requestId}.json`)
            await fs.writeFile(
              responseFile,
              JSON.stringify({ approved: true, reason: 'Safe script detected' }),
              'utf-8'
            )
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
          const requestId = await getLastRequestId(sessionDir)
          if (requestId) {
            const responseFile = path.join(sessionDir, `response-${requestId}.json`)
            await fs.writeFile(
              responseFile,
              JSON.stringify({ approved: false, reason: 'Dangerous command' }),
              'utf-8'
            )
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
      it('writes permission request to per-event file in session directory', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = await getLastRequestId(sessionDir)
          if (requestId) {
            const responseFile = path.join(sessionDir, `response-${requestId}.json`)
            await fs.writeFile(responseFile, JSON.stringify({ approved: true }), 'utf-8')
          }
        })()

        await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        // Events written as individual files in per-session directory
        const files = await fs.readdir(sessionDir)
        const eventFiles = files.filter(f => f.startsWith('event-') && f.endsWith('.jsonl'))
        expect(eventFiles.length).toBeGreaterThan(0)

        const firstEventFile = eventFiles[0]!
        const content = await fs.readFile(path.join(sessionDir, firstEventFile), 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())
        expect(lines.length).toBeGreaterThan(0)

        const lastLine = lines[lines.length - 1]
        expect(lastLine).toBeDefined()
        if (lastLine) {
          const event = JSON.parse(lastLine) as Record<string, unknown>
          expect(event._tag).toBe('PermissionRequest')
          expect(event.tool).toBe('Bash')
          expect(event.command).toBe('npm install')
          expect(event.requestId).toBeDefined()
          expect(event.slotNum).toBe(slotNum)
        }
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
      it('returns HookError when session IPC directory does not exist', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const result = await requestPermission(ipcBaseDir, 'nonexistent-session', slotNum, hookArgs, 1000)()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookError')
        }
      })

      it('returns HookError when response file has invalid JSON', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = await getLastRequestId(sessionDir)
          if (requestId) {
            const responseFile = path.join(sessionDir, `response-${requestId}.json`)
            await fs.writeFile(responseFile, 'invalid json {', 'utf-8')
          }
        })()

        const result = await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookError')
        }
      })

      it('returns HookError when response missing approved field', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = await getLastRequestId(sessionDir)
          if (requestId) {
            const responseFile = path.join(sessionDir, `response-${requestId}.json`)
            await fs.writeFile(responseFile, JSON.stringify({ reason: 'No approved field' }), 'utf-8')
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

    describe('response file cleanup', () => {
      it('deletes response file after reading', async () => {
        const hookArgs: HookArgs = {
          type: 'permission_request',
          tool: 'Bash',
          command: 'npm install',
        }

        let responseFile: string | null = null
        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
          const requestId = await getLastRequestId(sessionDir)
          if (requestId) {
            responseFile = path.join(sessionDir, `response-${requestId}.json`)
            await fs.writeFile(responseFile, JSON.stringify({ approved: true }), 'utf-8')
          }
        })()

        await requestPermission(ipcBaseDir, sessionId, slotNum, hookArgs, 5000)()
        await responsePromise

        if (responseFile) {
          const exists = await fs
            .access(responseFile)
            .then(() => true)
            .catch(() => false)
          expect(exists).toBe(false)
        }
      })
    })
  })
})
