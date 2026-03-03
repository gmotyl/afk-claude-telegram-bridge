/**
 * @module hook/permission
 * Permission request handling - hook writes to SQLite, waits for daemon approval.
 *
 * Flow:
 * 1. Generate unique request ID
 * 2. Write permission request event to SQLite events table
 * 3. Poll for response in SQLite responses table
 * 4. Parse response and validate
 * 5. Return PermissionResponse to Claude Code
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { type HookArgs } from './args'
import { permissionRequest } from '../types/events'
import { writeEvent, readResponse } from '../services/ipc-sqlite'
import { type HookError, hookError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

export interface PermissionResponse {
  readonly approved: boolean
  readonly reason?: string
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 350000
const POLLING_INTERVAL_MS = 100

// ============================================================================
// Permission Request Handler
// ============================================================================

/**
 * Request permission from daemon to execute a tool command.
 *
 * @param ipcBaseDir - Base IPC directory (used for path compat)
 * @param sessionId - Resolved AFK session UUID
 * @param slotNum - Resolved slot number
 * @param hookArgs - Hook arguments containing tool and command
 * @param timeoutMs - Maximum milliseconds to wait for response (default: 350000)
 * @returns TaskEither<HookError, PermissionResponse>
 */
export const requestPermission = (
  ipcBaseDir: string,
  sessionId: string,
  slotNum: number,
  hookArgs: HookArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): TE.TaskEither<HookError, PermissionResponse> =>
  TE.tryCatch(
    async () => {
      // Validate hook args
      if (hookArgs.type !== 'permission_request' || !hookArgs.tool) {
        throw hookError('Invalid hook arguments for permission request')
      }

      // Generate unique request ID
      const requestId = randomUUID()

      // Build event path (for compat — SQLite ignores the path)
      const sessionIpcDir = path.join(ipcBaseDir, sessionId)
      const eventsFile = path.join(sessionIpcDir, 'events.jsonl')

      const commandDisplay = hookArgs.command || hookArgs.tool
      const event = permissionRequest(requestId, hookArgs.tool, commandDisplay, slotNum, sessionId)

      const writeResult = await writeEvent(eventsFile, event)()
      if (E.isLeft(writeResult)) {
        throw hookError(`Failed to write permission request to IPC: ${String(writeResult.left)}`)
      }

      // Poll SQLite for response
      const response = await pollForResponse(sessionIpcDir, requestId, timeoutMs)
      return response
    },
    (error: unknown): HookError => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        const e = error as { _tag?: string; message?: string }
        if (e._tag === 'HookError') {
          return error as HookError
        }
      }
      return hookError(`Permission request failed: ${String(error)}`)
    }
  )

// ============================================================================
// Polling Helper
// ============================================================================

/**
 * Poll SQLite responses table until timeout.
 */
const pollForResponse = async (
  ipcDir: string,
  requestId: string,
  timeoutMs: number
): Promise<PermissionResponse> => {
  const startTime = Date.now()

  while (true) {
    const elapsed = Date.now() - startTime

    // Check SQLite for response
    const responseResult = await readResponse(ipcDir, requestId)()

    if (E.isRight(responseResult) && responseResult.right !== null) {
      // readResponse returns StopResponse ({ instruction }), but permission
      // responses have { approved, reason? }. Parse from the raw payload.
      const raw = responseResult.right as unknown as PermissionResponse

      // Validate response structure
      if (typeof raw.approved !== 'boolean') {
        throw hookError('Invalid response: missing or non-boolean "approved" field')
      }

      return raw
    }

    if (elapsed >= timeoutMs) {
      throw hookError(`Permission request timeout after ${timeoutMs}ms`)
    }

    // Continue polling
    await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS))
  }
}
