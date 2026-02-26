#!/usr/bin/env node

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as path from 'path'
import { Config } from '../types/config'
import { State, Slot, initialState } from '../types/state'
import { IpcEvent } from '../types/events'
import { BridgeError, stateError } from '../types/errors'
import { loadConfig } from '../core/config'
import {
  isSlotActive,
  addSlot,
  removeSlot,
  heartbeatSlot,
  cleanupStaleSlots,
  StateError
} from '../core/state'
import { loadState, saveState } from '../services/state-persistence'
import { readEventQueue, listEvents, deleteEventFile } from '../services/ipc'
import { sendTelegramMessage } from '../services/telegram'

/**
 * Daemon error type - all errors that can occur during daemon operation
 */
export type DaemonError = BridgeError | StateError

/**
 * Stop function type - async function that stops the daemon gracefully
 */
type StopFunction = () => TE.TaskEither<DaemonError, void>

/**
 * Process a single IPC event and update state accordingly
 * Returns updated state or error
 */
const processEvent = (
  config: Config,
  state: State,
  event: IpcEvent
): E.Either<StateError, State> => {
  const now = new Date()

  switch (event._tag) {
    case 'SessionStart': {
      // Create new slot
      const newSlot: Slot = {
        projectName: event.projectName,
        activatedAt: now,
        lastHeartbeat: now
      }
      return addSlot(state, event.slotNum, newSlot)
    }

    case 'SessionEnd': {
      // Remove slot
      return E.right(removeSlot(state, event.slotNum))
    }

    case 'Heartbeat': {
      // Update heartbeat timestamp for the slot
      return heartbeatSlot(state, event.slotNum, now)
    }

    case 'Message': {
      // Handle message - just return state unchanged for now
      // In a real implementation, this would send to Telegram
      return E.right(state)
    }
  }
}

/**
 * Process all events from the IPC queue
 * Reads all event files, processes them sequentially, and deletes processed files
 */
const processAllEvents = (
  config: Config,
  state: State
): TE.TaskEither<DaemonError, State> => {
  return TE.tryCatch(
    async () => {
      // Read all event files from the IPC directory
      const filesResult = await listEvents(config.ipcBaseDir)()

      if (E.isLeft(filesResult)) {
        // If directory doesn't exist or can't be read, return current state
        // This is OK - no events to process yet
        return state
      }

      const files = filesResult.right
      let currentState = state

      // Process only .jsonl event files (skip config.json, state.json, etc.)
      const eventFiles = files.filter((f) => f.endsWith('.jsonl'))

      // Process each event file sequentially
      for (const filename of eventFiles) {
        const filePath = path.join(config.ipcBaseDir, filename)

        // Read events from file
        const eventsResult = await readEventQueue(filePath)()

        if (E.isRight(eventsResult)) {
          const events = eventsResult.right

          // Process each event
          for (const event of events) {
            const processResult = processEvent(config, currentState, event)
            if (E.isRight(processResult)) {
              currentState = processResult.right
            } else {
              // Log error but continue processing
              console.error('Error processing event:', processResult.left)
            }
          }

          // Delete the event file after processing
          const deleteResult = await deleteEventFile(filePath)()
          if (E.isLeft(deleteResult)) {
            console.error('Error deleting event file:', deleteResult.left)
          }
        } else {
          // Log error but continue with next file
          console.error('Error reading event file:', eventsResult.left)
        }
      }

      return currentState
    },
    (error) => {
      // Convert any error to DaemonError
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        return error as DaemonError
      }
      return stateError(`Unexpected error processing events: ${String(error)}`, error)
    }
  )
}

/**
 * Run one iteration of the daemon loop:
 * 1. Process all IPC events
 * 2. Save updated state
 * 3. Cleanup stale slots (periodically)
 */
const runDaemonIteration = (
  config: Config,
  state: State,
  lastCleanupTime: Date,
  cleanupIntervalMs: number
): TE.TaskEither<DaemonError, { state: State; lastCleanupTime: Date }> => {
  return TE.flatMap(
    (updatedState: State) =>
      TE.tryCatch(
        async () => {
          const now = new Date()
          const timeSinceCleanup = now.getTime() - lastCleanupTime.getTime()

          // Cleanup stale slots every cleanupIntervalMs (default 30 seconds)
          if (timeSinceCleanup >= cleanupIntervalMs) {
            const cleanedState = cleanupStaleSlots(
              updatedState,
              config.sessionTimeout,
              now
            )

            // Save cleaned state
            const saveResult = await saveState(
              path.join(config.ipcBaseDir, 'state.json'),
              cleanedState
            )()

            if (E.isLeft(saveResult)) {
              console.error('Error saving state:', saveResult.left)
            }

            return { state: cleanedState, lastCleanupTime: now }
          } else {
            // Save state even if we didn't cleanup
            const saveResult = await saveState(
              path.join(config.ipcBaseDir, 'state.json'),
              updatedState
            )()

            if (E.isLeft(saveResult)) {
              console.error('Error saving state:', saveResult.left)
            }

            return { state: updatedState, lastCleanupTime }
          }
        },
        (error) => {
          if (typeof error === 'object' && error !== null && '_tag' in error) {
            return error as DaemonError
          }
          return stateError(`Error in daemon iteration: ${String(error)}`, error)
        }
      )
  )(processAllEvents(config, state))
}

/**
 * Start the daemon and return a stop function
 *
 * Process:
 * 1. Load config from configPath
 * 2. Load initial state from state file (or use default)
 * 3. Enter main loop that:
 *    - Reads events from IPC queue
 *    - Processes each event (add/remove slots, handle messages)
 *    - Updates state after each operation
 *    - Cleanup stale slots every 30 seconds
 *    - Saves state back to file
 *    - Waits 1 second, repeat
 * 4. Return stop function that can shut down daemon gracefully
 *
 * @param configPath - Path to the config.json file
 * @returns TaskEither<DaemonError, StopFunction> - Returns stop function on success
 */
export const startDaemon = (configPath: string): TE.TaskEither<DaemonError, StopFunction> => {
  return TE.tryCatch(
    async () => {
      // Load config
      const configResult = loadConfig(configPath)
      if (E.isLeft(configResult)) {
        throw stateError(`Failed to load config: ${configResult.left.message}`)
      }
      const config = configResult.right

      // Load initial state
      const stateFilePath = path.join(config.ipcBaseDir, 'state.json')
      const stateResult = await loadState(stateFilePath)()

      let state: State = initialState
      if (E.isRight(stateResult)) {
        state = stateResult.right
      } else {
        console.warn('Failed to load state, using default:', stateResult.left)
      }

      console.log('Bridge Daemon started with config:', {
        sessionTimeout: config.sessionTimeout,
        ipcBaseDir: config.ipcBaseDir
      })
      console.log('Initial slots:', Object.values(state.slots).filter(Boolean).length)

      let running = true
      let currentState = state
      let lastCleanupTime = new Date()

      // Main loop interval
      const loopInterval = setInterval(async () => {
        if (!running) {
          clearInterval(loopInterval)
          return
        }

        try {
          const result = await runDaemonIteration(
            config,
            currentState,
            lastCleanupTime,
            30 * 1000 // Cleanup every 30 seconds
          )()

          if (E.isRight(result)) {
            currentState = result.right.state
            lastCleanupTime = result.right.lastCleanupTime
          } else {
            console.error('Error in daemon iteration:', result.left)
            // Continue running on error
          }
        } catch (error) {
          console.error('Unexpected error in daemon loop:', error)
          // Continue running on error
        }
      }, 1000) // Loop every 1 second

      // Return stop function
      const stopFunction: StopFunction = (): TE.TaskEither<DaemonError, void> => {
        return TE.tryCatch(
          async () => {
            running = false
            clearInterval(loopInterval)

            // Final state save
            const finalResult = await saveState(
              path.join(config.ipcBaseDir, 'state.json'),
              currentState
            )()

            if (E.isLeft(finalResult)) {
              throw finalResult
            }

            console.log('Bridge Daemon stopped gracefully')
          },
          (error) => {
            if (typeof error === 'object' && error !== null && '_tag' in error) {
              return error as DaemonError
            }
            return stateError(`Error stopping daemon: ${String(error)}`)
          }
        )
      }

      return stopFunction
    },
    (error) => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        return error as DaemonError
      }
      return stateError(`Failed to start daemon: ${String(error)}`, error)
    }
  )
}

/**
 * CLI entry point - starts daemon and keeps process alive
 * Gracefully handles SIGTERM and SIGINT signals
 * Only runs if this module is executed directly (not imported)
 */
const main = async (): Promise<void> => {
  const configPath = process.argv[2] || './config.json'

  try {
    const result = await startDaemon(configPath)()

    if (E.isLeft(result)) {
      console.error('Failed to start daemon:', result.left)
      process.exit(1)
    }

    const stopFunction = result.right

    // Handle graceful shutdown
    const handleShutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`)
      const stopResult = await stopFunction()()

      if (E.isLeft(stopResult)) {
        console.error('Error during shutdown:', stopResult.left)
        process.exit(1)
      }

      process.exit(0)
    }

    process.on('SIGTERM', () => handleShutdown('SIGTERM'))
    process.on('SIGINT', () => handleShutdown('SIGINT'))

    console.log('Daemon is running. Press Ctrl+C to stop.')

    // Keep process alive
    await new Promise(() => {})
  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

// Only run CLI entry point if this is the main module
if (require.main === module) {
  main()
}
