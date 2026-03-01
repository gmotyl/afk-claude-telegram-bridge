/**
 * @module services/ipc
 * IPC (Inter-Process Communication) event queue module.
 * Handles reading/writing events to JSONL files for daemon-agent communication.
 * Uses fs/promises for async operations and TaskEither for functional error handling.
 */

import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'
import { type IpcEvent } from '../types/events'
import {
  type IpcError,
  ipcReadError,
  ipcWriteError,
  ipcParseError
} from '../types/errors'

/**
 * Create error handler for read operations that distinguishes parse errors from file read errors
 * @param path - Path to the file being read
 * @returns Error handler function that returns properly typed IpcError
 */
const readErrorHandler = (path: string) => (error: unknown): IpcError => {
  // If already an IpcError (from internal throw), return as-is
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const possibleError = error as { _tag?: string }
    if (
      possibleError._tag === 'IpcParseError' ||
      possibleError._tag === 'IpcReadError' ||
      possibleError._tag === 'IpcWriteError'
    ) {
      return error as IpcError
    }
  }

  // Otherwise, check if it's a JSON parse error
  if (error instanceof SyntaxError || (error instanceof Error && error.message.includes('JSON'))) {
    return ipcParseError(path, '', error)
  }
  return ipcReadError(path, error)
}

/**
 * Create error handler for write operations
 * @param path - Path to the file being written
 * @returns Error handler function that returns properly typed IpcError
 */
const writeErrorHandler = (path: string) => (error: unknown): IpcError =>
  ipcWriteError(path, error)

/**
 * Read all events from a JSONL file.
 * Each line is a separate JSON object (newline-delimited JSON format).
 * Empty lines are skipped. Returns array of parsed JSON objects.
 *
 * Process:
 * 1. Read file as UTF-8 text
 * 2. Split by newlines
 * 3. Filter empty lines
 * 4. Parse each line as JSON
 *
 * Distinguishes between read errors and parse errors:
 * - Parse errors: JSON.parse failures → IpcParseError
 * - Read errors: File system failures → IpcReadError
 *
 * @param eventsFile - Path to the JSONL events file
 * @returns TaskEither<IpcError, IpcEvent[]> - Left(error) or Right(array of typed events)
 *
 * @example
 * const result = await readEventQueue('/tmp/ipc/events.jsonl')()
 * if (E.isRight(result)) {
 *   console.log(result.right) // array of IpcEvent objects
 * }
 */
export const readEventQueue = (eventsFile: string): TE.TaskEither<IpcError, IpcEvent[]> => {
  return TE.tryCatch(
    async () => {
      // Read file as UTF-8 text
      const content = await fs.readFile(eventsFile, 'utf-8')

      // Split by newlines and filter empty lines
      const lines = content.split('\n').filter(line => line.trim().length > 0)

      // Parse each line as JSON - wrap in try-catch to distinguish parse errors
      try {
        const events: IpcEvent[] = lines.map(line => JSON.parse(line) as IpcEvent)
        return events
      } catch (parseError) {
        // Convert parse error to proper type for throw to be caught by TE.tryCatch
        throw ipcParseError(eventsFile, '', parseError)
      }
    },
    readErrorHandler(eventsFile)
  )
}

/**
 * Write a single event to a JSONL file by appending.
 * If file doesn't exist, creates it.
 * Appends the event as a JSON line (with newline terminator).
 *
 * @param eventsFile - Path to the JSONL events file
 * @param event - Typed IpcEvent object to write
 * @returns TaskEither<IpcError, void> - Left(error) or Right(void)
 *
 * @example
 * const event = heartbeat(1)
 * const result = await writeEvent('/tmp/ipc/events.jsonl', event)()
 * if (E.isRight(result)) {
 *   console.log('Event written')
 * }
 */
export const writeEvent = (
  eventsFile: string,
  event: IpcEvent
): TE.TaskEither<IpcError, void> => {
  return TE.tryCatch(
    async () => {
      // Serialize event to JSON and add newline
      const line = JSON.stringify(event) + '\n'

      // Append to file (creates if doesn't exist)
      await fs.appendFile(eventsFile, line, 'utf-8')
    },
    writeErrorHandler(eventsFile)
  )
}

/**
 * Delete a single event file.
 * Returns error if file doesn't exist or permission denied.
 *
 * @param eventFile - Path to the event file to delete
 * @returns TaskEither<IpcError, void> - Left(error) or Right(void)
 *
 * @example
 * const result = await deleteEventFile('/tmp/ipc/event-S1.jsonl')()
 * if (E.isRight(result)) {
 *   console.log('File deleted')
 * }
 */
export const deleteEventFile = (eventFile: string): TE.TaskEither<IpcError, void> => {
  return TE.tryCatch(
    async () => {
      await fs.unlink(eventFile)
    },
    writeErrorHandler(eventFile)
  )
}

/**
 * List all files in an IPC directory.
 * Returns filenames (not full paths), sorted alphabetically.
 * Includes only files, excludes subdirectories.
 *
 * @param eventsDir - Path to the IPC directory
 * @returns TaskEither<IpcError, string[]> - Left(error) or Right(sorted filename array)
 *
 * @example
 * const result = await listEvents('/tmp/ipc/')()
 * if (E.isRight(result)) {
 *   console.log(result.right) // ['event-S1.jsonl', 'event-S2.jsonl']
 * }
 */
/**
 * Response file structure for hook stop requests.
 */
export interface StopResponse {
  readonly instruction: string
}

/**
 * Write a response file for an event.
 * Used for both stop responses ({ instruction }) and permission responses ({ approved }).
 * The hook polls for this file to receive the response.
 *
 * @param ipcDir - Path to the IPC directory
 * @param eventId - The event ID from the event
 * @param response - JSON-serializable response payload
 * @returns TaskEither<IpcError, void>
 */
export const writeResponse = (
  ipcDir: string,
  eventId: string,
  response: Record<string, unknown>
): TE.TaskEither<IpcError, void> => {
  const responsePath = `${ipcDir}/response-${eventId}.json`
  return TE.tryCatch(
    async () => {
      await fs.writeFile(responsePath, JSON.stringify(response), 'utf-8')
    },
    writeErrorHandler(responsePath)
  )
}

/**
 * Read a response file for a stop event.
 * Returns null if the file does not exist.
 *
 * @param ipcDir - Path to the IPC directory
 * @param eventId - The event ID to look up
 * @returns TaskEither<IpcError, StopResponse | null>
 */
export const readResponse = (
  ipcDir: string,
  eventId: string
): TE.TaskEither<IpcError, StopResponse | null> => {
  const responsePath = `${ipcDir}/response-${eventId}.json`
  return TE.tryCatch(
    async () => {
      try {
        const content = await fs.readFile(responsePath, 'utf-8')
        return JSON.parse(content) as StopResponse
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT') {
          return null
        }
        throw error
      }
    },
    readErrorHandler(responsePath)
  )
}

/**
 * Create an IPC directory for a session.
 *
 * @param baseDir - Base IPC directory
 * @param sessionId - Session UUID for directory naming
 * @returns TaskEither<IpcError, string> - Path to the created directory
 */
export const createIpcDir = (
  baseDir: string,
  sessionId: string
): TE.TaskEither<IpcError, string> => {
  const dirPath = `${baseDir}/${sessionId}`
  return TE.tryCatch(
    async () => {
      await fs.mkdir(dirPath, { recursive: true })
      return dirPath
    },
    writeErrorHandler(dirPath)
  )
}

/**
 * Remove an IPC directory for a session.
 *
 * @param baseDir - Base IPC directory
 * @param sessionId - Session UUID for directory naming
 * @returns TaskEither<IpcError, void>
 */
export const removeIpcDir = (
  baseDir: string,
  sessionId: string
): TE.TaskEither<IpcError, void> => {
  const dirPath = `${baseDir}/${sessionId}`
  return TE.tryCatch(
    async () => {
      await fs.rm(dirPath, { recursive: true, force: true })
    },
    writeErrorHandler(dirPath)
  )
}

/**
 * Write a meta.json file inside an IPC directory.
 *
 * @param ipcDir - Path to the session's IPC directory
 * @param meta - Metadata object to write
 * @returns TaskEither<IpcError, void>
 */
export const writeMetaFile = (
  ipcDir: string,
  meta: Record<string, unknown>
): TE.TaskEither<IpcError, void> => {
  const metaPath = `${ipcDir}/meta.json`
  return TE.tryCatch(
    async () => {
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    },
    writeErrorHandler(metaPath)
  )
}

/**
 * Remove IPC directories that don't belong to any active session.
 *
 * @param baseDir - Base IPC directory
 * @param activeSessionIds - Set of session IDs that are still active
 * @returns TaskEither<IpcError, void>
 */
export const cleanOrphanedIpcDirs = (
  baseDir: string,
  activeSessionIds: ReadonlySet<string>
): TE.TaskEither<IpcError, void> =>
  TE.tryCatch(
    async () => {
      const entries = await fs.readdir(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !activeSessionIds.has(entry.name)) {
          await fs.rm(`${baseDir}/${entry.name}`, { recursive: true, force: true })
        }
      }
    },
    writeErrorHandler(baseDir)
  )

export const listEvents = (eventsDir: string): TE.TaskEither<IpcError, string[]> => {
  return TE.tryCatch(
    async () => {
      // Read directory contents
      const entries = await fs.readdir(eventsDir, { withFileTypes: true })

      // Filter to files only (exclude directories)
      const files = entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort()

      return files
    },
    readErrorHandler(eventsDir)
  )
}
