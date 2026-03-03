/**
 * @module hook/stop
 * Stop hook handler — active listening loop with daemon health monitoring.
 *
 * When Claude finishes a task, the Stop hook fires. This handler:
 * 1. Writes a Stop event to SQLite (notifying the daemon)
 * 2. Polls SQLite for a response containing the next instruction
 * 3. Sends KeepAlive events every 60s to prevent daemon timeout
 * 4. Checks daemon health every 30s and auto-restarts if dead
 * 5. Returns the instruction to Claude for execution
 *
 * The loop exits when:
 * - A response is found in SQLite (daemon delivers instruction)
 * - A kill file appears (force stop)
 * - A force_clear file appears (session terminated)
 * - Max recovery attempts exhausted (daemon unrecoverable)
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { stopEvent, keepAlive } from '../types/events'
import { writeEvent, readResponse } from '../services/ipc-sqlite'
import { checkDaemonHealth, ensureDaemonAlive } from '../services/daemon-health'
import { type HookError, hookError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

/**
 * Claude Code Stop hook output schema:
 * - decision: "block" → intercept stop, inject instruction via "reason" field
 * - null → exit 0 without output (let stop proceed normally)
 */
export interface StopDecision {
  readonly decision: 'block' | null
  readonly reason?: string
}

// ============================================================================
// Constants
// ============================================================================

const KEEP_ALIVE_INTERVAL_MS = 60_000
const INITIAL_POLL_MS = 500
const MAX_POLL_MS = 2_000
const BACKOFF_MULTIPLIER = 1.5

/** How often to check daemon health during polling (ms) */
export const HEALTH_CHECK_INTERVAL_MS = 30_000

/** Maximum number of daemon recovery attempts before giving up */
export const MAX_RECOVERY_ATTEMPTS = 3

// ============================================================================
// Stop Request Handler
// ============================================================================

/**
 * Handle a stop hook request with active listening polling loop.
 *
 * @param ipcBaseDir - Base IPC directory
 * @param sessionId - Resolved AFK session UUID (IPC directory name)
 * @param slotNum - The slot number for this Claude session
 * @param lastMessage - The last message from Claude (for daemon context)
 * @param configDir - Optional config directory for daemon health checks
 * @returns TaskEither<HookError, StopDecision>
 */
export const handleStopRequest = (
  ipcBaseDir: string,
  sessionId: string,
  slotNum: number,
  lastMessage: string,
  configDir?: string
): TE.TaskEither<HookError, StopDecision> =>
  TE.tryCatch(
    async () => {
      const eventId = randomUUID()

      // Resolve per-session IPC directory (for compat paths and kill/force_clear files)
      const sessionIpcDir = path.join(ipcBaseDir, sessionId)
      const eventsFile = path.join(sessionIpcDir, 'events.jsonl')

      // Ensure IPC directory exists (for kill/force_clear signal files)
      await fs.mkdir(sessionIpcDir, { recursive: true })

      // Write Stop event to SQLite
      const event = stopEvent(eventId, slotNum, lastMessage, sessionId)
      console.error(`[stop-hook] Writing Stop event ${eventId.slice(0,8)} to SQLite`)
      const writeResult = await writeEvent(eventsFile, event)()
      if (E.isLeft(writeResult)) {
        throw hookError(`Failed to write stop event: ${String(writeResult.left)}`)
      }

      // Enter polling loop
      console.error(`[stop-hook] Entering polling loop for response to ${eventId.slice(0,8)}`)
      return await pollForInstruction(sessionIpcDir, eventId, slotNum, eventsFile, configDir, sessionId)
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
// Daemon Recovery
// ============================================================================

/**
 * Attempt to recover a dead daemon by restarting it
 * and re-sending the Stop event.
 */
const attemptDaemonRecovery = async (
  configDir: string,
  eventsFile: string,
  eventId: string,
  slotNum: number,
  lastMessage: string,
  attemptNum: number
): Promise<boolean> => {
  console.error(`[stop-hook] Daemon recovery attempt ${attemptNum}/${MAX_RECOVERY_ATTEMPTS}`)

  const restarted = await ensureDaemonAlive(configDir)

  if (!restarted) {
    console.error(`[stop-hook] Failed to restart daemon`)
    return false
  }

  // Re-send the Stop event so the new daemon picks it up
  const event = stopEvent(eventId, slotNum, lastMessage)
  const writeResult = await writeEvent(eventsFile, event)()

  if (E.isLeft(writeResult)) {
    console.error(`[stop-hook] Failed to re-write stop event after recovery: ${String(writeResult.left)}`)
    return false
  }

  console.error(`[stop-hook] Re-sent Stop event ${eventId.slice(0,8)} after daemon recovery`)
  return true
}

// ============================================================================
// Polling Loop
// ============================================================================

const pollForInstruction = async (
  ipcDir: string,
  eventId: string,
  slotNum: number,
  eventsFile: string,
  configDir?: string,
  sessionId?: string
): Promise<StopDecision> => {
  let pollIntervalMs = INITIAL_POLL_MS
  let lastKeepAlive = Date.now()
  let lastHealthCheck = Date.now()
  let recoveryAttempts = 0

  while (true) {
    // Check for kill signal — exit without output (let stop proceed)
    const killFile = path.join(ipcDir, 'kill')
    if (await fileExists(killFile)) {
      return { decision: null, reason: 'kill signal received' }
    }

    // Check for force_clear signal — exit without output
    const forceClearFile = path.join(ipcDir, 'force_clear')
    if (await fileExists(forceClearFile)) {
      return { decision: null, reason: 'force clear signal received' }
    }

    // Check SQLite for response
    const responseResult = await readResponse(ipcDir, eventId)()
    if (E.isRight(responseResult) && responseResult.right !== null) {
      const response = responseResult.right
      console.error(`[stop-hook] Got response for ${eventId.slice(0,8)}: "${String(response.instruction).slice(0,50)}"`)

      // Block stop and inject instruction via "reason" field
      return {
        decision: 'block',
        reason: response.instruction
      }
    }

    const now = Date.now()

    // Check daemon health periodically (only if configDir is available)
    if (configDir && now - lastHealthCheck >= HEALTH_CHECK_INTERVAL_MS) {
      lastHealthCheck = now
      const healthResult = await checkDaemonHealth(configDir)()

      if (E.isRight(healthResult)) {
        const health = healthResult.right

        if (health._tag === 'DaemonDead' || health._tag === 'DaemonStale') {
          console.error(`[stop-hook] Daemon ${health._tag}: ${health._tag === 'DaemonDead' ? health.reason : `stale for ${health.staleForMs}ms`}`)

          if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
            console.error(`[stop-hook] Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) exhausted, letting stop proceed`)
            return { decision: null, reason: `Daemon unrecoverable after ${MAX_RECOVERY_ATTEMPTS} restart attempts` }
          }

          recoveryAttempts++
          const recovered = await attemptDaemonRecovery(
            configDir, eventsFile, eventId, slotNum, '', recoveryAttempts
          )

          if (recovered) {
            lastHealthCheck = Date.now()
          }
        } else {
          recoveryAttempts = 0
        }
      }
    }

    // Send keep-alive if interval elapsed
    if (now - lastKeepAlive >= KEEP_ALIVE_INTERVAL_MS) {
      const kaEventId = randomUUID()
      const kaEvent = keepAlive(kaEventId, eventId, slotNum, sessionId)
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
