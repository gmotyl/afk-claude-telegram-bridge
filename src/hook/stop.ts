/**
 * @module hook/stop
 * Stop hook handler — active listening loop.
 *
 * When Claude finishes a task, the Stop hook fires. This handler:
 * 1. Writes a Stop event to IPC (notifying the daemon)
 * 2. Polls for a response file containing the next instruction
 * 3. Sends KeepAlive events every 60s to prevent daemon timeout
 * 4. Returns the instruction to Claude for execution
 *
 * The loop is infinite — it only exits when:
 * - A response file is written (daemon delivers instruction)
 * - A kill file appears (force stop)
 * - A force_clear file appears (session terminated)
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { stopEvent, keepAlive } from '../types/events'
import { writeEvent } from '../services/ipc'
import { readResponse, type StopResponse } from '../services/ipc'
import { type HookError, hookError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

export interface StopDecision {
  readonly decision: 'block' | 'pass'
  readonly reason?: string
  readonly instruction?: string
}

// ============================================================================
// Constants
// ============================================================================

const KEEP_ALIVE_INTERVAL_MS = 60_000
const INITIAL_POLL_MS = 500
const MAX_POLL_MS = 2_000
const BACKOFF_MULTIPLIER = 1.5

// ============================================================================
// Stop Request Handler
// ============================================================================

/**
 * Handle a stop hook request with active listening polling loop.
 *
 * @param ipcDir - Path to IPC directory
 * @param slotNum - The slot number for this Claude session
 * @param lastMessage - The last message from Claude (for daemon context)
 * @returns TaskEither<HookError, StopDecision>
 */
export const handleStopRequest = (
  ipcDir: string,
  slotNum: number,
  lastMessage: string
): TE.TaskEither<HookError, StopDecision> =>
  TE.tryCatch(
    async () => {
      const eventId = randomUUID()
      const eventsFile = path.join(ipcDir, 'events.jsonl')

      // Write Stop event to IPC
      const event = stopEvent(eventId, slotNum, lastMessage)
      const writeResult = await writeEvent(eventsFile, event)()
      if (E.isLeft(writeResult)) {
        throw hookError(`Failed to write stop event: ${String(writeResult.left)}`)
      }

      // Enter polling loop
      return await pollForInstruction(ipcDir, eventId, slotNum, eventsFile)
    },
    (error: unknown): HookError => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        const e = error as { _tag?: string }
        if (e._tag === 'HookError') {
          return error as HookError
        }
      }
      return hookError(`Stop handler failed: ${String(error)}`)
    }
  )

// ============================================================================
// Polling Loop
// ============================================================================

const pollForInstruction = async (
  ipcDir: string,
  eventId: string,
  slotNum: number,
  eventsFile: string
): Promise<StopDecision> => {
  let pollIntervalMs = INITIAL_POLL_MS
  let lastKeepAlive = Date.now()

  while (true) {
    // Check for kill signal
    const killFile = path.join(ipcDir, 'kill')
    if (await fileExists(killFile)) {
      return { decision: 'pass', reason: 'kill signal received' }
    }

    // Check for force_clear signal
    const forceClearFile = path.join(ipcDir, 'force_clear')
    if (await fileExists(forceClearFile)) {
      return { decision: 'pass', reason: 'force clear signal received' }
    }

    // Check for response file
    const responseResult = await readResponse(ipcDir, eventId)()
    if (E.isRight(responseResult) && responseResult.right !== null) {
      const response = responseResult.right
      // Clean up response file
      const responseFile = path.join(ipcDir, `response-${eventId}.json`)
      await fs.unlink(responseFile).catch(() => {})

      return {
        decision: 'block',
        reason: 'instruction received',
        instruction: response.instruction
      }
    }

    // Send keep-alive if interval elapsed
    const now = Date.now()
    if (now - lastKeepAlive >= KEEP_ALIVE_INTERVAL_MS) {
      const kaEventId = randomUUID()
      const kaEvent = keepAlive(kaEventId, eventId, slotNum)
      await writeEvent(eventsFile, kaEvent)()
      lastKeepAlive = now
    }

    // Wait with backoff
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    pollIntervalMs = Math.min(pollIntervalMs * BACKOFF_MULTIPLIER, MAX_POLL_MS)
  }
}

// ============================================================================
// Helpers
// ============================================================================

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
