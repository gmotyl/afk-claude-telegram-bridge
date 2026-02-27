/**
 * @module services/daemon-launcher
 * Daemon lifecycle management: start, stop, and check if alive.
 */

import * as TE from 'fp-ts/TaskEither'
import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import { type DaemonSpawnError, type DaemonStopError, daemonSpawnError, daemonStopError } from '../types/errors'

/**
 * Start the bridge daemon as a detached background process.
 * Returns the PID of the spawned process.
 *
 * @param bridgePath - Path to bridge.js
 * @param configPath - Path to config directory (passed via TELEGRAM_BRIDGE_CONFIG env)
 * @param logPath - Path to write daemon stdout/stderr
 * @returns TaskEither<DaemonSpawnError, number> - PID of the daemon
 */
export const startDaemon = (
  bridgePath: string,
  configPath: string,
  logPath: string
): TE.TaskEither<DaemonSpawnError, number> =>
  TE.tryCatch(
    async () => {
      const logFd = await fs.open(logPath, 'a')
      const child = spawn('node', [bridgePath], {
        detached: true,
        stdio: ['ignore', logFd.fd, logFd.fd],
        env: { ...process.env, TELEGRAM_BRIDGE_CONFIG: configPath },
      })

      if (!child.pid) {
        await logFd.close()
        throw new Error('Failed to get PID from spawned process')
      }

      child.unref()
      await logFd.close()
      return child.pid
    },
    (cause) => daemonSpawnError(String(cause))
  )

/**
 * Stop a daemon by PID using SIGTERM.
 *
 * @param pid - Process ID to terminate
 * @returns TaskEither<DaemonStopError, void>
 */
export const stopDaemon = (pid: number): TE.TaskEither<DaemonStopError, void> =>
  TE.tryCatch(
    async () => {
      process.kill(pid, 'SIGTERM')
    },
    (cause) => daemonStopError(`Failed to stop daemon PID ${pid}: ${String(cause)}`)
  )

/**
 * Check if a process is alive by sending signal 0.
 *
 * @param pid - Process ID to check
 * @returns true if alive, false otherwise
 */
export const isDaemonAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
