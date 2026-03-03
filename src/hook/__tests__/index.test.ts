/**
 * @module hook/index.test
 * Tests for hook main entry point with session binding
 */

import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

// Mock ensureDaemonAlive to avoid real daemon health checks in hook tests
jest.mock('../../services/daemon-health', () => ({
  ...jest.requireActual('../../services/daemon-health'),
  ensureDaemonAlive: jest.fn().mockResolvedValue(true),
}))

import { runHook } from '../index'
import { closeDatabase, getDatabase } from '../../services/db'
import { insertResponse } from '../../services/db-queries'

// ============================================================================
// SQLite daemon simulation helpers
// ============================================================================

/** Get the last unprocessed event's ID and payload from SQLite */
const getLastUnprocessedEvent = (): { id: string; payload: Record<string, unknown> } | null => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return null

  const events = dbResult.right
    .prepare('SELECT * FROM events WHERE processed = 0 ORDER BY created_at DESC LIMIT 1')
    .all() as Array<{ id: string; payload: string }>

  if (events.length === 0) return null
  return {
    id: events[0]!.id,
    payload: JSON.parse(events[0]!.payload) as Record<string, unknown>,
  }
}

/** Count events for a session in SQLite */
const countEventsForSession = (sessionId: string): number => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return -1

  const result = dbResult.right
    .prepare('SELECT COUNT(*) as cnt FROM events WHERE session_id = ?')
    .get(sessionId) as { cnt: number }

  return result.cnt
}

/** Simulate daemon: wait, find event, write response to SQLite */
const simulateDaemonResponse = (delayMs: number, responsePayload: Record<string, unknown>) =>
  (async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    const event = getLastUnprocessedEvent()
    if (event) {
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        insertResponse(dbResult.right, `resp-${event.id}`, event.id, JSON.stringify(responsePayload))
      }
    }
  })()

/** Helper: create a test environment with config, state, and per-session IPC dir */
const createTestEnv = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-index-test-'))
  const ipcDir = path.join(tempDir, 'ipc')
  await fs.mkdir(ipcDir, { recursive: true })

  const sessionId = 'test-session-uuid'
  const sessionIpcDir = path.join(ipcDir, sessionId)
  await fs.mkdir(sessionIpcDir, { recursive: true })

  const config = {
    telegramBotToken: 'test-bot-token',
    telegramGroupId: 12345,
    ipcBaseDir: ipcDir,
    sessionTimeout: 30000,
  }
  const configPath = path.join(tempDir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

  // Create state.json with one active slot
  const state = {
    slots: {
      1: {
        sessionId,
        projectName: 'test-project',
        topicName: 'Test Project',
        activatedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      }
    },
    pendingStops: {}
  }
  const statePath = path.join(tempDir, 'state.json')
  await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')

  return { tempDir, ipcDir, sessionIpcDir, sessionId, configPath, statePath }
}

describe('Hook Main Entry Point', () => {
  let tempDir: string
  let ipcDir: string
  let sessionIpcDir: string
  let sessionId: string
  let configPath: string

  beforeEach(async () => {
    const env = await createTestEnv()
    tempDir = env.tempDir
    ipcDir = env.ipcDir
    sessionIpcDir = env.sessionIpcDir
    sessionId = env.sessionId
    configPath = env.configPath
  })

  afterEach(async () => {
    closeDatabase()
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('runHook', () => {
    describe('permission_request hook', () => {
      it('processes permission_request and returns 0 when approved (decision via JSON stdout)', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'npm install',
          sessionId: 'claude-sess-A',
        }

        // Simulate daemon response via SQLite
        const responsePromise = simulateDaemonResponse(100, { approved: true })

        const result = await runHook(configPath, hookArgs)()
        await responsePromise

        // Always exits 0 — decision communicated via JSON stdout
        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('processes permission_request and returns 0 when denied (decision via JSON stdout)', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'rm -rf /',
          sessionId: 'claude-sess-A',
        }

        const responsePromise = simulateDaemonResponse(100, { approved: false, reason: 'Dangerous' })

        const result = await runHook(configPath, hookArgs)()
        await responsePromise

        // Always exits 0 — deny decision communicated via JSON stdout
        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('returns error when permission request times out', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'npm install',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs, 50)()

        expect(E.isLeft(result)).toBe(true)
        if (E.isLeft(result)) {
          expect((result.left as any)._tag).toMatch(/HookError|HookParseError/)
        }
      })
    })

    describe('stop hook', () => {
      it('processes stop hook and returns 0 when kill file exists', async () => {
        // Pre-create kill file in per-session IPC dir
        await fs.writeFile(path.join(sessionIpcDir, 'kill'), '', 'utf-8')

        const hookArgs = {
          type: 'stop' as const,
          sessionId: 'claude-sess-A',
          lastMessage: 'Task done',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('processes stop hook and returns 0 when response appears in SQLite', async () => {
        const hookArgs = {
          type: 'stop' as const,
          sessionId: 'claude-sess-A',
          lastMessage: 'Task done',
        }

        const responsePromise = simulateDaemonResponse(100, { instruction: 'test' })

        const result = await runHook(configPath, hookArgs)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })
    })

    describe('notification hook', () => {
      it('processes notification hook and returns 0', async () => {
        const hookArgs = {
          type: 'notification' as const,
          message: 'Task completed',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })
    })

    describe('no active AFK session', () => {
      it('auto-approves permission_request when no active slots (outputs allow JSON)', async () => {
        // Overwrite state with empty slots
        const statePath = path.join(tempDir, 'state.json')
        await fs.writeFile(statePath, JSON.stringify({ slots: {}, pendingStops: {} }), 'utf-8')

        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'npm install',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('passes stop when no active slots (no JSON output)', async () => {
        const statePath = path.join(tempDir, 'state.json')
        await fs.writeFile(statePath, JSON.stringify({ slots: {}, pendingStops: {} }), 'utf-8')

        const hookArgs = {
          type: 'stop' as const,
          sessionId: 'claude-sess-A',
          lastMessage: 'Done',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })
    })

    describe('session binding', () => {
      it('creates bound_session file on first hook call', async () => {
        const hookArgs = {
          type: 'notification' as const,
          message: 'test',
          sessionId: 'claude-sess-X',
        }

        await runHook(configPath, hookArgs)()

        // Check that bound_session file was created
        const boundFile = path.join(sessionIpcDir, 'bound_session')
        const content = await fs.readFile(boundFile, 'utf-8')
        expect(content).toBe('claude-sess-X')
      })

      it('reuses existing binding on subsequent calls', async () => {
        // Pre-create binding
        const boundFile = path.join(sessionIpcDir, 'bound_session')
        await fs.writeFile(boundFile, 'claude-sess-Y', 'utf-8')

        // Kill file in session dir for quick stop exit
        await fs.writeFile(path.join(sessionIpcDir, 'kill'), '', 'utf-8')

        const hookArgs = {
          type: 'stop' as const,
          sessionId: 'claude-sess-Y',
          lastMessage: 'Done',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }

        // Verify binding wasn't changed
        const content = await fs.readFile(boundFile, 'utf-8')
        expect(content).toBe('claude-sess-Y')
      })

      it('isolates two sessions to different IPC directories', async () => {
        const sessionIdB = 'test-session-uuid-B'
        const sessionIpcDirB = path.join(ipcDir, sessionIdB)
        await fs.mkdir(sessionIpcDirB, { recursive: true })

        // Add second slot to state
        const statePath = path.join(tempDir, 'state.json')
        const state = {
          slots: {
            1: {
              sessionId,
              projectName: 'project-A',
              topicName: 'Project A',
              activatedAt: new Date().toISOString(),
              lastHeartbeat: new Date().toISOString(),
            },
            2: {
              sessionId: sessionIdB,
              projectName: 'project-B',
              topicName: 'Project B',
              activatedAt: new Date().toISOString(),
              lastHeartbeat: new Date().toISOString(),
            }
          },
          pendingStops: {}
        }
        await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')

        // Session A binds first
        const hookArgsA = {
          type: 'notification' as const,
          message: 'from A',
          sessionId: 'claude-sess-A',
        }
        await runHook(configPath, hookArgsA)()

        // Session B binds second
        const hookArgsB = {
          type: 'notification' as const,
          message: 'from B',
          sessionId: 'claude-sess-B',
        }
        await runHook(configPath, hookArgsB)()

        // Verify: A bound to first slot's IPC dir, B to second
        const boundA = await fs.readFile(path.join(sessionIpcDir, 'bound_session'), 'utf-8')
        const boundB = await fs.readFile(path.join(sessionIpcDirB, 'bound_session'), 'utf-8')
        expect(boundA).toBe('claude-sess-A')
        expect(boundB).toBe('claude-sess-B')
      })

      it('routes permission requests to correct session IPC dir', async () => {
        const sessionIdB = 'test-session-uuid-B'
        const sessionIpcDirB = path.join(ipcDir, sessionIdB)
        await fs.mkdir(sessionIpcDirB, { recursive: true })

        const statePath = path.join(tempDir, 'state.json')
        const state = {
          slots: {
            1: {
              sessionId,
              projectName: 'project-A',
              topicName: 'Project A',
              activatedAt: new Date().toISOString(),
              lastHeartbeat: new Date().toISOString(),
            },
            2: {
              sessionId: sessionIdB,
              projectName: 'project-B',
              topicName: 'Project B',
              activatedAt: new Date().toISOString(),
              lastHeartbeat: new Date().toISOString(),
            }
          },
          pendingStops: {}
        }
        await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')

        // Pre-bind session B
        await fs.writeFile(path.join(sessionIpcDirB, 'bound_session'), 'claude-sess-B', 'utf-8')

        // Session B sends permission request
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'echo hello',
          sessionId: 'claude-sess-B',
        }

        // Simulate daemon response via SQLite
        const responsePromise = simulateDaemonResponse(100, { approved: true })

        const result = await runHook(configPath, hookArgs)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0) // approved
        }

        // Verify: events were written to session B, NOT session A
        expect(countEventsForSession(sessionId)).toBe(0)
        expect(countEventsForSession(sessionIdB)).toBeGreaterThan(0)
      })

      it('falls back to single active slot when no session_id', async () => {
        // CLI args mode — no sessionId in HookArgs
        // Kill file in session dir for quick exit
        await fs.writeFile(path.join(sessionIpcDir, 'kill'), '', 'utf-8')

        const hookArgs = {
          type: 'stop' as const,
          lastMessage: 'Done',
          // No sessionId — fallback to single slot
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('auto-approves when multiple slots active but no session_id', async () => {
        const sessionIdB = 'test-session-uuid-B'
        const sessionIpcDirB = path.join(ipcDir, sessionIdB)
        await fs.mkdir(sessionIpcDirB, { recursive: true })

        const statePath = path.join(tempDir, 'state.json')
        const state = {
          slots: {
            1: {
              sessionId,
              projectName: 'project-A',
              topicName: 'Project A',
              activatedAt: new Date().toISOString(),
              lastHeartbeat: new Date().toISOString(),
            },
            2: {
              sessionId: sessionIdB,
              projectName: 'project-B',
              topicName: 'Project B',
              activatedAt: new Date().toISOString(),
              lastHeartbeat: new Date().toISOString(),
            }
          },
          pendingStops: {}
        }
        await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')

        // No sessionId + multiple slots = can't route safely → auto-approve
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'npm test',
          // No sessionId
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0) // auto-approve (can't route)
        }
      })
    })

    describe('auto-approve non-destructive tools', () => {
      it('auto-approves Read tool without Telegram roundtrip', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Read',
          command: '/path/to/file.ts',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }

        // Verify no events were written to SQLite (no Telegram roundtrip)
        expect(countEventsForSession(sessionId)).toBe(0)
      })

      it('auto-approves Glob tool without Telegram roundtrip', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Glob',
          command: '**/*.ts',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('auto-approves Grep tool without Telegram roundtrip', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Grep',
          command: 'pattern',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
      })

      it('auto-approves TaskUpdate without Telegram roundtrip', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'TaskUpdate',
          command: 'update task',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
      })

      it('auto-approves Agent tool without Telegram roundtrip', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Agent',
          command: 'explore codebase',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
      })

      it('still requires Telegram approval for Bash', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'npm install',
          sessionId: 'claude-sess-A',
        }

        // Simulate daemon response so it doesn't hang
        const responsePromise = simulateDaemonResponse(100, { approved: true })

        const result = await runHook(configPath, hookArgs)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)

        // Verify events WERE written to SQLite (Telegram roundtrip happened)
        expect(countEventsForSession(sessionId)).toBeGreaterThan(0)
      })

      it('still requires Telegram approval for Write', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Write',
          command: '/path/to/file.ts (100 chars)',
          sessionId: 'claude-sess-A',
        }

        // Will timeout without daemon response — that proves it's going through Telegram
        const result = await runHook(configPath, hookArgs, 50)()

        // Should timeout (meaning it tried to go through Telegram, not auto-approve)
        expect(E.isLeft(result)).toBe(true)
      })

      it('still requires Telegram approval for Edit', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Edit',
          command: '/path/to/file.ts',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs, 50)()
        expect(E.isLeft(result)).toBe(true) // timeout = went through Telegram
      })

      it('still requires Telegram approval for NotebookEdit', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'NotebookEdit',
          command: '/path/to/notebook.ipynb',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs, 50)()
        expect(E.isLeft(result)).toBe(true) // timeout = went through Telegram
      })
    })

    describe('config-based auto-approve (autoApproveTools)', () => {
      it('auto-approves Bash when whitelisted in autoApproveTools', async () => {
        // Rewrite config with autoApproveTools
        const config = {
          telegramBotToken: 'test-bot-token',
          telegramGroupId: 12345,
          ipcBaseDir: ipcDir,
          sessionTimeout: 30000,
          autoApproveTools: ['Bash'],
        }
        await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'npm install',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }

        // Verify no events were written (auto-approved, no Telegram roundtrip)
        expect(countEventsForSession(sessionId)).toBe(0)
      })

      it('auto-approves Write when whitelisted in autoApproveTools', async () => {
        const config = {
          telegramBotToken: 'test-bot-token',
          telegramGroupId: 12345,
          ipcBaseDir: ipcDir,
          sessionTimeout: 30000,
          autoApproveTools: ['Write'],
        }
        await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Write',
          command: '/path/to/file.ts',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('still requires Telegram approval for unlisted destructive tools', async () => {
        // Only Bash whitelisted, Edit is NOT
        const config = {
          telegramBotToken: 'test-bot-token',
          telegramGroupId: 12345,
          ipcBaseDir: ipcDir,
          sessionTimeout: 30000,
          autoApproveTools: ['Bash'],
        }
        await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Edit',
          command: '/path/to/file.ts',
          sessionId: 'claude-sess-A',
        }

        // Will timeout → proves it goes through Telegram
        const result = await runHook(configPath, hookArgs, 50)()
        expect(E.isLeft(result)).toBe(true)
      })

      it('auto-approves when path matches autoApprovePaths', async () => {
        const config = {
          telegramBotToken: 'test-bot-token',
          telegramGroupId: 12345,
          ipcBaseDir: ipcDir,
          sessionTimeout: 30000,
          autoApproveTools: ['Write'],
          autoApprovePaths: ['/allowed/'],
        }
        await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Write',
          command: '/allowed/file.ts',
          toolInput: { file_path: '/allowed/file.ts' },
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('requires Telegram approval when path does not match autoApprovePaths', async () => {
        const config = {
          telegramBotToken: 'test-bot-token',
          telegramGroupId: 12345,
          ipcBaseDir: ipcDir,
          sessionTimeout: 30000,
          autoApproveTools: ['Write'],
          autoApprovePaths: ['/allowed/'],
        }
        await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Write',
          command: '/forbidden/file.ts',
          toolInput: { file_path: '/forbidden/file.ts' },
          sessionId: 'claude-sess-A',
        }

        // Will timeout → proves it goes through Telegram
        const result = await runHook(configPath, hookArgs, 50)()
        expect(E.isLeft(result)).toBe(true)
      })

      it('auto-approves without path restriction when autoApprovePaths is empty', async () => {
        const config = {
          telegramBotToken: 'test-bot-token',
          telegramGroupId: 12345,
          ipcBaseDir: ipcDir,
          sessionTimeout: 30000,
          autoApproveTools: ['Edit'],
          // No autoApprovePaths → all paths allowed
        }
        await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')

        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Edit',
          command: '/any/path/file.ts',
          sessionId: 'claude-sess-A',
        }

        const result = await runHook(configPath, hookArgs)()

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
        await fs.writeFile(badConfigPath, JSON.stringify({ telegramBotToken: 'test-token' }), 'utf-8')

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

    describe('TaskEither pattern', () => {
      it('returns TaskEither type', async () => {
        await fs.writeFile(path.join(sessionIpcDir, 'kill'), '', 'utf-8')
        const hookArgs = { type: 'stop' as const, sessionId: 'claude-X', lastMessage: '' }
        const task = runHook(configPath, hookArgs)

        expect(typeof task).toBe('function')
        const result = await task()
        expect(E.isRight(result) || E.isLeft(result)).toBe(true)
      })
    })

    describe('stdin mode (pre-parsed HookArgs)', () => {
      it('processes stop with pre-parsed HookArgs and session_id', async () => {
        await fs.writeFile(path.join(sessionIpcDir, 'kill'), '', 'utf-8')

        const hookArgs = {
          type: 'stop' as const,
          lastMessage: 'Task done',
          stopHookActive: true,
          sessionId: 'sess-abc',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('processes PreToolUse with pre-parsed HookArgs and session_id', async () => {
        const hookArgs = {
          type: 'permission_request' as const,
          tool: 'Bash',
          command: 'npm test',
          toolInput: { command: 'npm test' },
          sessionId: 'claude-sess-A',
        }

        const responsePromise = simulateDaemonResponse(100, { approved: true })

        const result = await runHook(configPath, hookArgs)()
        await responsePromise

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })

      it('processes notification with pre-parsed HookArgs', async () => {
        const hookArgs = {
          type: 'notification' as const,
          message: 'Build complete',
        }

        const result = await runHook(configPath, hookArgs)()

        expect(E.isRight(result)).toBe(true)
        if (E.isRight(result)) {
          expect(result.right).toBe(0)
        }
      })
    })
  })
})
