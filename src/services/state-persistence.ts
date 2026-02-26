/**
 * @module services/state-persistence
 * State persistence module for reading/writing state to JSON files.
 * Wraps the pure state functions with filesystem I/O operations.
 * Uses fs/promises for async operations and TaskEither for functional error handling.
 */

import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'
import { type State, initialState } from '../types/state'
import { type StateError, stateError } from '../types/errors'

/**
 * Create error handler for read operations
 * Distinguishes between missing file (returns default state) and actual read/parse errors
 * @param path - Path to the file being read
 * @returns Error handler function that returns properly typed StateError
 */
const readErrorHandler = (path: string) => (error: unknown): StateError => {
  // Check if it's a "file not found" error - these are expected and return default state via the main logic
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    return stateError(`File not found: ${path} - using default state`, error)
  }

  // Check if it's a JSON parse error
  if (error instanceof SyntaxError || (error instanceof Error && error.message.includes('JSON'))) {
    return stateError(`Failed to parse JSON in ${path}: ${(error as Error).message}`, error)
  }

  // Otherwise it's a generic read error (permissions, encoding, etc.)
  return stateError(`Failed to read state file ${path}: ${String(error)}`, error)
}

/**
 * Create error handler for write operations
 * @param path - Path to the file being written
 * @returns Error handler function that returns properly typed StateError
 */
const writeErrorHandler = (path: string) => (error: unknown): StateError =>
  stateError(`Failed to write state file ${path}: ${String(error)}`, error)

/**
 * Load state from a JSON file.
 * If the file doesn't exist, returns default empty state.
 * If the file exists but contains invalid JSON, returns a StateError.
 *
 * Process:
 * 1. Try to read file as UTF-8 text
 * 2. If file not found, return default initialState
 * 3. Parse content as JSON
 * 4. Return parsed State or StateError
 *
 * @param stateFile - Path to the state JSON file
 * @returns TaskEither<StateError, State> - Left(error) or Right(state)
 *
 * @example
 * const result = await loadState('/tmp/state.json')()
 * if (E.isRight(result)) {
 *   console.log(result.right) // State object
 * }
 */
export const loadState = (stateFile: string): TE.TaskEither<StateError, State> => {
  return TE.tryCatch(
    async () => {
      try {
        // Try to read file as UTF-8 text
        const content = await fs.readFile(stateFile, 'utf-8')

        // Parse content as JSON
        try {
          const parsed = JSON.parse(content) as State
          return parsed
        } catch (parseError) {
          // Re-throw JSON parse errors to be caught by outer try-catch
          throw parseError
        }
      } catch (error) {
        // Check if it's a "file not found" error - return default state instead of throwing
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return initialState
        }
        // For other errors (parse errors, permission denied, etc.), re-throw to be handled by error handler
        throw error
      }
    },
    readErrorHandler(stateFile)
  )
}

/**
 * Save state to a JSON file.
 * Overwrites existing file if present.
 * Parent directory must exist - returns error if directory doesn't exist.
 *
 * Process:
 * 1. Serialize State to JSON string
 * 2. Write to file (creates or overwrites)
 *
 * @param stateFile - Path to the state JSON file
 * @param state - State object to persist
 * @returns TaskEither<StateError, void> - Left(error) or Right(void)
 *
 * @example
 * const state: State = { slots: { 1: slot, 2: undefined, 3: undefined, 4: undefined } }
 * const result = await saveState('/tmp/state.json', state)()
 * if (E.isRight(result)) {
 *   console.log('State saved')
 * }
 */
export const saveState = (
  stateFile: string,
  state: State
): TE.TaskEither<StateError, void> => {
  return TE.tryCatch(
    async () => {
      // Serialize state to JSON string (2-space indentation for readability)
      const content = JSON.stringify(state, null, 2)

      // Write to file (creates if doesn't exist, overwrites if exists)
      await fs.writeFile(stateFile, content, 'utf-8')
    },
    writeErrorHandler(stateFile)
  )
}
