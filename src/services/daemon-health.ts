/**
 * @module services/daemon-health
 * Daemon health checking for the Stop hook.
 * Reads heartbeat file + PID to determine if daemon is alive, stale, or dead.
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import { type HookError, hookError } from '../types/errors'
import { isDaemonAlive } from './daemon-launcher'

// ============================================================================
// Types
// ============================================================================

export type DaemonHealthy = {
  readonly _tag: 'DaemonHealthy'
  readonly pid: number
  readonly lastHeartbeatMs: number
}

export type DaemonStale = {
  readonly _tag: 'DaemonStale'
  readonly pid: number
  readonly lastHeartbeatMs: number
  readonly staleForMs: number
}

export type DaemonDead = {
  readonly _tag: 'DaemonDead'
  readonly pid: number | null
  readonly reason: string
}

export type DaemonHealthStatus = DaemonHealthy | DaemonStale | DaemonDead

// Smart constructors
export const daemonHealthy = (pid: number, lastHeartbeatMs: number): DaemonHealthy => ({
  _tag: 'DaemonHealthy',
  pid,
  lastHeartbeatMs,
})

export const daemonStale = (pid: number, lastHeartbeatMs: number, staleForMs: number): DaemonStale => ({
  _tag: 'DaemonStale',
  pid,
  lastHeartbeatMs,
  staleForMs,
})

export const daemonDead = (pid: number | null, reason: string): DaemonDead => ({
  _tag: 'DaemonDead',
  pid,
  reason,
})

// ============================================================================
// Constants
// ============================================================================

/** Heartbeat older than this is considered stale (daemon may be hung) */
const HEARTBEAT_STALE_THRESHOLD_MS = 30_000

// ============================================================================
// Health check
// ============================================================================

/**
 * Read daemon PID from state.json.
 * Returns null if not found or unreadable.
 */
const readDaemonPid = async (configDir: string): Promise<number | null> => {
  try {
    const statePath = path.join(configDir, 'state.json')
    const content = await fs.readFile(statePath, 'utf-8')
    const state = JSON.parse(content) as Record<string, unknown>
    const pid = state['daemon_pid']
    return typeof pid === 'number' ? pid : null
  } catch {
    return null
  }
}

/**
 * Read daemon heartbeat timestamp from daemon.heartbeat file.
 * Returns null if not found or unreadable.
 */
const readHeartbeat = async (configDir: string): Promise<number | null> => {
  try {
    const heartbeatPath = path.join(configDir, 'daemon.heartbeat')
    const content = await fs.readFile(heartbeatPath, 'utf-8')
    const timestamp = parseInt(content.trim(), 10)
    return isNaN(timestamp) ? null : timestamp
  } catch {
    return null
  }
}

/**
 * Check daemon health by reading heartbeat file and verifying PID.
 *
 * Decision logic:
 * 1. No PID in state → Dead (never started or state corrupted)
 * 2. PID not alive (kill -0 fails) → Dead
 * 3. No heartbeat file → Dead (daemon started but never wrote heartbeat)
 * 4. Heartbeat older than threshold → Stale (daemon may be hung)
 * 5. Otherwise → Healthy
 *
 * @param configDir - Path to config directory containing state.json and daemon.heartbeat
 * @param now - Current timestamp in ms (injectable for testing)
 * @returns TaskEither<HookError, DaemonHealthStatus>
 */
export const checkDaemonHealth = (
  configDir: string,
  now: number = Date.now()
): TE.TaskEither<HookError, DaemonHealthStatus> =>
  TE.tryCatch(
    async () => {
      const pid = await readDaemonPid(configDir)

      if (pid === null) {
        return daemonDead(null, 'No daemon PID found in state')
      }

      if (!isDaemonAlive(pid)) {
        return daemonDead(pid, `Process ${pid} is not running`)
      }

      const heartbeat = await readHeartbeat(configDir)

      if (heartbeat === null) {
        return daemonDead(pid, 'No heartbeat file found (daemon may have just started)')
      }

      const age = now - heartbeat

      if (age > HEARTBEAT_STALE_THRESHOLD_MS) {
        return daemonStale(pid, heartbeat, age)
      }

      return daemonHealthy(pid, heartbeat)
    },
    (error: unknown) => hookError(`Daemon health check failed: ${String(error)}`)
  )
