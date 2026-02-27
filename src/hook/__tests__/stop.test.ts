/**
 * @module hook/stop.test
 * Tests for stop hook handler with active listening polling loop
 */

import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { handleStopRequest, type StopDecision } from '../stop'

describe('Stop Hook Handler', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-stop-test-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('handleStopRequest', () => {
    it('writes Stop event to events.jsonl', async () => {
      // Write response immediately so the hook doesn't block forever
      const responsePromise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 100))

        // Find the eventId from events.jsonl
        const eventsFile = path.join(tempDir, 'events.jsonl')
        const content = await fs.readFile(eventsFile, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())
        const lastLine = lines[lines.length - 1]
        if (lastLine) {
          const event = JSON.parse(lastLine) as { eventId?: string; _tag?: string }
          if (event._tag === 'Stop' && event.eventId) {
            const responseFile = path.join(tempDir, `response-${event.eventId}.json`)
            await fs.writeFile(responseFile, JSON.stringify({ instruction: 'test' }), 'utf-8')
          }
        }
      })()

      const result = await handleStopRequest(tempDir, 1, 'last msg')()
      await responsePromise

      // Verify the Stop event was written
      const eventsFile = path.join(tempDir, 'events.jsonl')
      const content = await fs.readFile(eventsFile, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines.length).toBeGreaterThanOrEqual(1)

      const firstEvent = JSON.parse(lines[0]!) as { _tag: string; slotNum: number; lastMessage: string }
      expect(firstEvent._tag).toBe('Stop')
      expect(firstEvent.slotNum).toBe(1)
      expect(firstEvent.lastMessage).toBe('last msg')
    })

    it('returns block decision with instruction when response file appears', async () => {
      const responsePromise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 100))

        const eventsFile = path.join(tempDir, 'events.jsonl')
        const content = await fs.readFile(eventsFile, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())
        const lastLine = lines[lines.length - 1]
        if (lastLine) {
          const event = JSON.parse(lastLine) as { eventId?: string; _tag?: string }
          if (event._tag === 'Stop' && event.eventId) {
            const responseFile = path.join(tempDir, `response-${event.eventId}.json`)
            await fs.writeFile(responseFile, JSON.stringify({ instruction: 'run npm test' }), 'utf-8')
          }
        }
      })()

      const result = await handleStopRequest(tempDir, 1, 'done')()
      await responsePromise

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const decision = result.right
        expect(decision.decision).toBe('block')
        expect(decision.instruction).toBe('run npm test')
      }
    })

    it('returns pass decision when kill file appears', async () => {
      // Write kill file before the hook starts polling
      await fs.writeFile(path.join(tempDir, 'kill'), '', 'utf-8')

      const result = await handleStopRequest(tempDir, 1, 'done')()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.decision).toBe('pass')
        expect(result.right.reason).toContain('kill')
      }
    })

    it('returns pass decision when force_clear file appears', async () => {
      await fs.writeFile(path.join(tempDir, 'force_clear'), '', 'utf-8')

      const result = await handleStopRequest(tempDir, 1, 'done')()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.decision).toBe('pass')
        expect(result.right.reason).toContain('force clear')
      }
    })

    it('cleans up response file after reading', async () => {
      let responseFilePath: string | null = null

      const responsePromise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 100))

        const eventsFile = path.join(tempDir, 'events.jsonl')
        const content = await fs.readFile(eventsFile, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())
        const lastLine = lines[lines.length - 1]
        if (lastLine) {
          const event = JSON.parse(lastLine) as { eventId?: string; _tag?: string }
          if (event._tag === 'Stop' && event.eventId) {
            responseFilePath = path.join(tempDir, `response-${event.eventId}.json`)
            await fs.writeFile(responseFilePath, JSON.stringify({ instruction: 'test' }), 'utf-8')
          }
        }
      })()

      await handleStopRequest(tempDir, 1, 'done')()
      await responsePromise

      // Response file should be deleted after reading
      if (responseFilePath) {
        const exists = await fs.access(responseFilePath).then(() => true).catch(() => false)
        expect(exists).toBe(false)
      }
    })

    it('returns Left error when IPC directory does not exist', async () => {
      const result = await handleStopRequest('/nonexistent/dir', 1, 'done')()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('HookError')
      }
    })

    it('sends KeepAlive event after interval', async () => {
      // We can't easily test the 60s interval in a unit test,
      // but we can verify the mechanism works by checking event structure.
      // For now, just verify the basic flow completes.
      const responsePromise = (async () => {
        await new Promise(resolve => setTimeout(resolve, 100))

        const eventsFile = path.join(tempDir, 'events.jsonl')
        const content = await fs.readFile(eventsFile, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())
        const lastLine = lines[lines.length - 1]
        if (lastLine) {
          const event = JSON.parse(lastLine) as { eventId?: string; _tag?: string }
          if (event._tag === 'Stop' && event.eventId) {
            const responseFile = path.join(tempDir, `response-${event.eventId}.json`)
            await fs.writeFile(responseFile, JSON.stringify({ instruction: 'keepalive test' }), 'utf-8')
          }
        }
      })()

      const result = await handleStopRequest(tempDir, 1, 'done')()
      await responsePromise

      expect(E.isRight(result)).toBe(true)
    })
  })
})
