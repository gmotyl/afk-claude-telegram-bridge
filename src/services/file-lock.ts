/**
 * @module services/file-lock
 * State file locking using proper-lockfile for safe concurrent access.
 */

import * as TE from 'fp-ts/TaskEither'
import * as lockfile from 'proper-lockfile'
import { type LockError, lockError } from '../types/errors'

/**
 * Execute a function while holding a file lock on the given path.
 * Uses proper-lockfile for cross-process mutex on state.json.
 *
 * @param filePath - Path to the file to lock
 * @param fn - Async function to execute while holding the lock
 * @returns TaskEither<LockError, A> - Result of fn or lock error
 */
export const withStateLock = <A>(
  filePath: string,
  fn: () => Promise<A>
): TE.TaskEither<LockError, A> =>
  TE.tryCatch(
    async () => {
      const release = await lockfile.lock(filePath, {
        retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
        stale: 10000,
      })
      try {
        return await fn()
      } finally {
        await release()
      }
    },
    (cause) => lockError(filePath, 'acquire', cause)
  )
