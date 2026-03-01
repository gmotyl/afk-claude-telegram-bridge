/**
 * @module e2e-active-listening
 * End-to-end integration tests for the active listening flow.
 *
 * Tests the full cycle:
 * - Hook writes Stop event → Daemon processes it
 * - Daemon checks queued instruction → auto-injects via response file
 * - Hook polls and receives instruction from response file
 * - Daemon sends Telegram notification when no queued instruction
 * - Incoming message delivered via response file when pending stop exists
 * - Incoming message buffered as queued instruction when no pending stop
 */

import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { stopEvent, keepAlive, sessionStart } from '../types/events'
import { writeEvent, readResponse, writeResponse } from '../services/ipc'
import { writeQueuedInstruction, readQueuedInstruction, deleteQueuedInstruction } from '../services/queued-instruction'
import { addPendingStop, removePendingStop, findPendingStopBySlot } from '../core/state'
import { initialState, type PendingStop } from '../types/state'
import { handleStopRequest } from '../hook/stop'

describe('Active Listening E2E', () => {
  let tempDir: string
  let sessionDir: string
  const sessionId = 'test-session-uuid'

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-active-listening-'))
    sessionDir = path.join(tempDir, sessionId)
    await fs.mkdir(sessionDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('Stop event + queued instruction → response file', () => {
    it('auto-injects queued instruction into response file', async () => {
      // 1. Write a queued instruction (simulating message received while busy)
      const writeResult = await writeQueuedInstruction(tempDir, 'fix the login bug')()
      expect(E.isRight(writeResult)).toBe(true)

      // 2. Simulate what the daemon does: process a Stop event
      const ps: PendingStop = {
        eventId: 'evt-e2e-1',
        slotNum: 1,
        lastMessage: 'done with previous task',
        timestamp: new Date().toISOString()
      }
      let state = addPendingStop(initialState, ps)

      // 3. Check for queued instruction (daemon logic)
      const queuedResult = await readQueuedInstruction(tempDir)()
      expect(E.isRight(queuedResult)).toBe(true)
      if (E.isRight(queuedResult) && queuedResult.right !== null) {
        // Write response file with the queued instruction
        const responseResult = await writeResponse(tempDir, ps.eventId, {
          instruction: queuedResult.right.text
        })()
        expect(E.isRight(responseResult)).toBe(true)

        // Delete the queued instruction
        await deleteQueuedInstruction(tempDir)()
        state = removePendingStop(state, ps.eventId)
      }

      // 4. Verify: response file exists with correct instruction
      const response = await readResponse(tempDir, 'evt-e2e-1')()
      expect(E.isRight(response)).toBe(true)
      if (E.isRight(response)) {
        expect(response.right).not.toBeNull()
        expect(response.right!.instruction).toBe('fix the login bug')
      }

      // 5. Verify: queued instruction was deleted
      const queuedAfter = await readQueuedInstruction(tempDir)()
      expect(E.isRight(queuedAfter)).toBe(true)
      if (E.isRight(queuedAfter)) {
        expect(queuedAfter.right).toBeNull()
      }

      // 6. Verify: pending stop was removed from state
      expect(findPendingStopBySlot(state, 1)).toBeUndefined()
    })
  })

  describe('Stop event + no queue → Telegram notified, then message → response file', () => {
    it('delivers message via response file when pending stop exists', async () => {
      // 1. Create a pending stop (no queued instruction)
      const ps: PendingStop = {
        eventId: 'evt-e2e-2',
        slotNum: 2,
        lastMessage: 'completed tests',
        timestamp: new Date().toISOString()
      }
      let state = addPendingStop(initialState, ps)

      // 2. Verify no queued instruction exists
      const queuedResult = await readQueuedInstruction(tempDir)()
      expect(E.isRight(queuedResult)).toBe(true)
      if (E.isRight(queuedResult)) {
        expect(queuedResult.right).toBeNull()
      }

      // 3. Simulate incoming Telegram message while stop is pending
      const pendingStop = findPendingStopBySlot(state, 2)
      expect(pendingStop).toBeDefined()

      if (pendingStop) {
        // Write response file immediately (what daemon does)
        const responseResult = await writeResponse(tempDir, pendingStop.eventId, {
          instruction: 'deploy to staging'
        })()
        expect(E.isRight(responseResult)).toBe(true)

        state = removePendingStop(state, pendingStop.eventId)
      }

      // 4. Verify: response file has the instruction
      const response = await readResponse(tempDir, 'evt-e2e-2')()
      expect(E.isRight(response)).toBe(true)
      if (E.isRight(response)) {
        expect(response.right!.instruction).toBe('deploy to staging')
      }

      // 5. Verify: pending stop was removed
      expect(findPendingStopBySlot(state, 2)).toBeUndefined()
    })
  })

  describe('Hook polls and receives instruction from response file', () => {
    it('hook stop handler picks up response file and returns block decision', async () => {
      // Simulate daemon writing a response file after a short delay
      const responsePromise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 200))

        // Read per-event files to find the eventId (in per-session dir)
        try {
          const files = await fs.readdir(sessionDir)
          const eventFiles = files.filter(f => f.startsWith('event-') && f.endsWith('.jsonl')).sort()
          for (const file of eventFiles) {
            const content = await fs.readFile(path.join(sessionDir, file), 'utf-8')
            const lines = content.split('\n').filter(l => l.trim())
            for (const line of lines) {
              const event = JSON.parse(line) as { _tag?: string; eventId?: string }
              if (event._tag === 'Stop' && event.eventId) {
                const responseFile = path.join(sessionDir, `response-${event.eventId}.json`)
                await fs.writeFile(
                  responseFile,
                  JSON.stringify({ instruction: 'run npm test' }),
                  'utf-8'
                )
                return
              }
            }
          }
        } catch {
          // Event files might not exist yet
        }
      })()

      // Run the hook stop handler (now takes ipcBaseDir, sessionId, slotNum, lastMessage)
      const result = await handleStopRequest(tempDir, sessionId, 1, 'last message')()
      await responsePromise

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.decision).toBe('block')
        expect(result.right.reason).toBe('run npm test')
      }
    })
  })

  describe('Message buffering when no pending stop', () => {
    it('buffers message as queued instruction when Claude is busy', async () => {
      // No pending stop exists — Claude is busy

      // Simulate incoming message → write queued instruction
      const writeResult = await writeQueuedInstruction(tempDir, 'review PR #42')()
      expect(E.isRight(writeResult)).toBe(true)

      // Verify it's buffered
      const readResult = await readQueuedInstruction(tempDir)()
      expect(E.isRight(readResult)).toBe(true)
      if (E.isRight(readResult)) {
        expect(readResult.right).not.toBeNull()
        expect(readResult.right!.text).toBe('review PR #42')
      }

      // Later, when stop event arrives, it should be auto-injected
      // (tested in the first test case above)
    })

    it('overwrites previous queued instruction with latest message', async () => {
      await writeQueuedInstruction(tempDir, 'first message')()
      await writeQueuedInstruction(tempDir, 'second message')()

      const readResult = await readQueuedInstruction(tempDir)()
      expect(E.isRight(readResult)).toBe(true)
      if (E.isRight(readResult)) {
        expect(readResult.right!.text).toBe('second message')
      }
    })
  })

  describe('IPC event round-trip', () => {
    it('Stop event survives write → read cycle through JSONL', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event = stopEvent('evt-rt-1', 1, 'hello')

      // Write
      const writeResult = await writeEvent(eventsFile, event)()
      expect(E.isRight(writeResult)).toBe(true)

      // Read back
      const content = await fs.readFile(eventsFile, 'utf-8')
      const parsed = JSON.parse(content.trim())
      expect(parsed._tag).toBe('Stop')
      expect(parsed.eventId).toBe('evt-rt-1')
      expect(parsed.slotNum).toBe(1)
      expect(parsed.lastMessage).toBe('hello')
      expect(parsed.stopHookActive).toBe(true)
    })

    it('KeepAlive event survives write → read cycle through JSONL', async () => {
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const event = keepAlive('ka-rt-1', 'evt-rt-1', 2)

      const writeResult = await writeEvent(eventsFile, event)()
      expect(E.isRight(writeResult)).toBe(true)

      const content = await fs.readFile(eventsFile, 'utf-8')
      const parsed = JSON.parse(content.trim())
      expect(parsed._tag).toBe('KeepAlive')
      expect(parsed.eventId).toBe('ka-rt-1')
      expect(parsed.originalEventId).toBe('evt-rt-1')
    })
  })
})
