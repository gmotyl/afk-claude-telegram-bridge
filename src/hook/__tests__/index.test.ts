/**
 * @module hook/index.test
 * Tests for hook main entry point
 * Orchestrates arg parsing + permission handling + exit codes
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { runHook } from '../index'

describe('Hook Main Entry Point', () => {
  let tempDir: string
  let ipcDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-index-test-'))
    ipcDir = path.join(tempDir, 'ipc')
    await fs.mkdir(ipcDir, { recursive: true })

    // Create a valid config file
    const config = {
      telegramBotToken: 'test-bot-token',
      telegramGroupId: 12345,
      ipcBaseDir: ipcDir,
      sessionTimeout: 30000,
    }
    configPath = path.join(tempDir, 'config.json')
    await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('runHook', () => {
    describe('permission_request hook', () => {
      it('processes permission_request and returns 0 when approved', async () => {
        const args = ['permission_request', 'Bash', 'npm install']

        // Simulate daemon response
        const responsePromise = (async () => {
          // Wait a bit for request to be written
          await new Promise(resolve => setTimeout(resolve, 100))

          // Find the request ID from events.jsonl
          const eventsFile = path.join(ipcDir, 'events.jsonl')
          try {
            const content = await fs.readFile(eventsFile, 'utf-8')
            const lines = content.split('\n').filter(l => l.trim())
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1]
              const event = JSON.parse(lastLine!) as { requestId?: string }
              const requestId = event.requestId

              if (requestId) {
                const responseFile = path.join(ipcDir, `response-${requestId}.json`)
                await fs.writeFile(
                  responseFile,
                  JSON.stringify({ approved: true }),
                  'utf-8'
                )
              }
            }
          } catch {
            // Ignore errors
          }
        })()

        const result = await runHook(configPath, args)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('processes permission_request and returns 1 when denied', async () => {
        const args = ['permission_request', 'Bash', 'rm -rf /']

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 100))

          const eventsFile = path.join(ipcDir, 'events.jsonl')
          try {
            const content = await fs.readFile(eventsFile, 'utf-8')
            const lines = content.split('\n').filter(l => l.trim())
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1]
              const event = JSON.parse(lastLine!) as { requestId?: string }
              const requestId = event.requestId

              if (requestId) {
                const responseFile = path.join(ipcDir, `response-${requestId}.json`)
                await fs.writeFile(
                  responseFile,
                  JSON.stringify({ approved: false, reason: 'Dangerous command' }),
                  'utf-8'
                )
              }
            }
          } catch {
            // Ignore errors
          }
        })()

        const result = await runHook(configPath, args)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(1)
        }
      })

      it('returns error when permission request fails', async () => {
        // Use a very short timeout to cause timeout error
        const args = ['permission_request', 'Bash', 'npm install']

        const result = await runHook(configPath, args, 50)()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toMatch(/HookError|HookParseError/)
        }
      })
    })

    describe('stop hook', () => {
      it('processes stop hook and returns 0 when kill file exists', async () => {
        // Pre-create kill file so the stop handler exits immediately
        await fs.writeFile(path.join(ipcDir, 'kill'), '', 'utf-8')
        const args = ['stop']

        const result = await runHook(configPath, args)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('processes stop hook and returns 0 when response file appears', async () => {
        const args = ['stop']

        // Simulate daemon response
        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 100))

          const eventsFile = path.join(ipcDir, 'events.jsonl')
          try {
            const content = await fs.readFile(eventsFile, 'utf-8')
            const lines = content.split('\n').filter(l => l.trim())
            const lastLine = lines[lines.length - 1]
            if (lastLine) {
              const event = JSON.parse(lastLine) as { eventId?: string; _tag?: string }
              if (event._tag === 'Stop' && event.eventId) {
                const responseFile = path.join(ipcDir, `response-${event.eventId}.json`)
                await fs.writeFile(responseFile, JSON.stringify({ instruction: 'test' }), 'utf-8')
              }
            }
          } catch {
            // Ignore errors
          }
        })()

        const result = await runHook(configPath, args)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })
    })

    describe('notification hook', () => {
      it('processes notification hook and returns 0', async () => {
        const args = ['notification', 'Task completed']

        const result = await runHook(configPath, args)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('processes multi-word notification message', async () => {
        const args = ['notification', 'Build failed with error: timeout']

        const result = await runHook(configPath, args)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })
    })

    describe('error handling', () => {
      it('returns error for no arguments', async () => {
        const result = await runHook(configPath, [])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookParseError')
        }
      })

      it('returns error for invalid hook type', async () => {
        const result = await runHook(configPath, ['invalid_type'])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookParseError')
        }
      })

      it('returns error for invalid config path', async () => {
        const invalidConfigPath = path.join(tempDir, 'nonexistent.json')

        const result = await runHook(invalidConfigPath, ['stop'])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any).message).toMatch(/config|Config/)
        }
      })

      it('returns error for malformed config JSON', async () => {
        const badConfigPath = path.join(tempDir, 'bad-config.json')
        await fs.writeFile(badConfigPath, 'invalid json {', 'utf-8')

        const result = await runHook(badConfigPath, ['stop'])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any).message).toMatch(/parse|Parse|invalid|Invalid/)
        }
      })

      it('returns error for missing required config fields', async () => {
        const badConfigPath = path.join(tempDir, 'incomplete-config.json')
        const incompleteConfig = {
          telegramBotToken: 'test-token',
          // Missing other required fields
        }
        await fs.writeFile(badConfigPath, JSON.stringify(incompleteConfig), 'utf-8')

        const result = await runHook(badConfigPath, ['stop'])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any).message).toMatch(/config|invalid/)
        }
      })

      it('returns error for permission_request without tool', async () => {
        const result = await runHook(configPath, ['permission_request'])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookParseError')
        }
      })

      it('returns error for permission_request without command', async () => {
        const result = await runHook(configPath, ['permission_request', 'Bash'])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookParseError')
        }
      })

      it('returns error for notification without message', async () => {
        const result = await runHook(configPath, ['notification'])()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toBe('HookParseError')
        }
      })
    })

    describe('exit codes', () => {
      it('returns 0 for successful stop', async () => {
        // Pre-create kill file so stop handler exits immediately
        await fs.writeFile(path.join(ipcDir, 'kill'), '', 'utf-8')
        const result = await runHook(configPath, ['stop'])()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('returns 0 for successful notification', async () => {
        const result = await runHook(configPath, ['notification', 'Done'])()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('returns 0 for approved permission', async () => {
        const args = ['permission_request', 'Bash', 'echo hello']

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 100))

          const eventsFile = path.join(ipcDir, 'events.jsonl')
          try {
            const content = await fs.readFile(eventsFile, 'utf-8')
            const lines = content.split('\n').filter(l => l.trim())
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1]
              const event = JSON.parse(lastLine!) as { requestId?: string }
              const requestId = event.requestId

              if (requestId) {
                const responseFile = path.join(ipcDir, `response-${requestId}.json`)
                await fs.writeFile(
                  responseFile,
                  JSON.stringify({ approved: true }),
                  'utf-8'
                )
              }
            }
          } catch {
            // Ignore errors
          }
        })()

        const result = await runHook(configPath, args)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('returns 1 for denied permission', async () => {
        const args = ['permission_request', 'Bash', 'rm -rf /']

        const responsePromise = (async () => {
          await new Promise(resolve => setTimeout(resolve, 100))

          const eventsFile = path.join(ipcDir, 'events.jsonl')
          try {
            const content = await fs.readFile(eventsFile, 'utf-8')
            const lines = content.split('\n').filter(l => l.trim())
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1]
              const event = JSON.parse(lastLine!) as { requestId?: string }
              const requestId = event.requestId

              if (requestId) {
                const responseFile = path.join(ipcDir, `response-${requestId}.json`)
                await fs.writeFile(
                  responseFile,
                  JSON.stringify({ approved: false }),
                  'utf-8'
                )
              }
            }
          } catch {
            // Ignore errors
          }
        })()

        const result = await runHook(configPath, args)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(1)
        }
      })
    })

    describe('TaskEither pattern', () => {
      it('returns TaskEither type', async () => {
        await fs.writeFile(path.join(ipcDir, 'kill'), '', 'utf-8')
        const task = runHook(configPath, ['stop'])

        // Verify it's a function (TaskEither is T => Promise<Either>)
        expect(typeof task).toBe('function')

        // Execute the task
        const result = await task()

        expect(E.isRight(result) || E.isLeft(result)).toBe(true)
      })

      it('supports lazy evaluation', async () => {
        await fs.writeFile(path.join(ipcDir, 'kill'), '', 'utf-8')
        const task = runHook(configPath, ['stop'])

        // Can call it multiple times independently
        const result1 = await task()
        const result2 = await task()

        expect(E.isRight(result1)).toBe(true)
        expect(E.isRight(result2)).toBe(true)
      })
    })

    describe('custom timeout', () => {
      it('accepts optional timeout parameter', async () => {
        const args = ['permission_request', 'Bash', 'npm install']

        // With very short timeout, should timeout
        const result = await runHook(configPath, args, 50)()

        // Should get an error due to timeout
        expect(E.isLeft(result) || (E.isRight(result) && result.right !== 0)).toBe(true)
      })
    })
  })
})
