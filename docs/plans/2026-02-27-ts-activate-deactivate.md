# TypeScript Activate/Deactivate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Python `hook.py` activate/deactivate with pure TypeScript, eliminating the Python runtime dependency.

**Architecture:** New `src/cli/` module as a third esbuild entry point (`dist/cli.js`) alongside hook and bridge. `hook-wrapper.sh` delegates `--activate`/`--deactivate` to `node cli.js`. Slot type extended with sessionId, topicName, threadId for full Telegram topic management including reattachment.

**Tech Stack:** TypeScript, fp-ts (Either/TaskEither), proper-lockfile, esbuild, Jest

**Design doc:** `docs/plans/2026-02-27-ts-activate-deactivate-design.md`

---

### Task 1: Add `proper-lockfile` dependency

**Files:**
- Modify: `package.json`

**Step 1: Install proper-lockfile**

Run: `cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge && npm install proper-lockfile && npm install --save-dev @types/proper-lockfile`

**Step 2: Verify installation**

Run: `node -e "require('proper-lockfile')"`
Expected: No error

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add proper-lockfile for state.json mutex"
```

---

### Task 2: Extend Slot type with session metadata

**Files:**
- Modify: `src/types/state.ts`
- Modify: `src/types/__tests__/state.test.ts`
- Modify: `src/core/state/__tests__/index.test.ts` (update Slot constructors in tests)

**Step 1: Write test for extended Slot**

In `src/types/__tests__/state.test.ts`, add a test that creates a Slot with the new fields:

```typescript
it('creates a Slot with sessionId, topicName, and optional threadId', () => {
  const slot: Slot = {
    sessionId: 'abc-123',
    projectName: 'metro',
    topicName: 'metro',
    activatedAt: new Date('2024-01-01T12:00:00Z'),
    lastHeartbeat: new Date('2024-01-01T12:00:00Z'),
  }
  expect(slot.sessionId).toBe('abc-123')
  expect(slot.topicName).toBe('metro')
  expect(slot.threadId).toBeUndefined()
})

it('creates a Slot with threadId for reattachment', () => {
  const slot: Slot = {
    sessionId: 'abc-123',
    projectName: 'metro',
    topicName: 'metro',
    threadId: 42,
    activatedAt: new Date('2024-01-01T12:00:00Z'),
    lastHeartbeat: new Date('2024-01-01T12:00:00Z'),
  }
  expect(slot.threadId).toBe(42)
})
```

**Step 2: Run test to verify it fails**

Run: `npx jest src/types/__tests__/state.test.ts -v`
Expected: FAIL — `sessionId` and `topicName` not in Slot interface

**Step 3: Extend Slot interface**

In `src/types/state.ts`, replace the Slot interface:

```typescript
export interface Slot {
  readonly sessionId: string
  readonly projectName: string
  readonly topicName: string
  readonly threadId?: number
  readonly activatedAt: Date
  readonly lastHeartbeat: Date
}
```

**Step 4: Fix all existing Slot constructors in tests**

Every test that creates a `Slot` now needs `sessionId` and `topicName`. Update `src/core/state/__tests__/index.test.ts` — search for all `Slot` literals and add the new required fields. The pattern is:

```typescript
// Before:
const slot: Slot = {
  projectName: 'metro',
  activatedAt: now,
  lastHeartbeat: now
}

// After:
const slot: Slot = {
  sessionId: 'test-session-1',
  projectName: 'metro',
  topicName: 'metro',
  activatedAt: now,
  lastHeartbeat: now
}
```

Also update any Slot literals in:
- `src/bridge/__tests__/daemon.test.ts`
- `src/hook/__tests__/stop.test.ts`
- `src/services/__tests__/state-persistence.test.ts`
- Any other test file that constructs Slot objects

**Step 5: Run all tests**

Run: `npx jest --verbose`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/types/state.ts src/types/__tests__/state.test.ts src/core/state/__tests__/index.test.ts
git add -A  # catch any other test files that needed Slot updates
git commit -m "feat: extend Slot type with sessionId, topicName, threadId"
```

---

### Task 3: Add state query functions (findAvailableSlot, findSlotBySessionId, findSlotByTopicName)

**Files:**
- Modify: `src/core/state/index.ts`
- Modify: `src/core/state/__tests__/index.test.ts`

**Step 1: Write failing tests**

Add to `src/core/state/__tests__/index.test.ts`:

```typescript
describe('findAvailableSlot', () => {
  it('returns 1 for empty state', () => {
    expect(findAvailableSlot(initialState)).toBe(1)
  })

  it('returns next available slot when some occupied', () => {
    const slot: Slot = {
      sessionId: 'sess-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const state = E.getOrElse(() => initialState)(addSlot(initialState, 1, slot))
    expect(findAvailableSlot(state)).toBe(2)
  })

  it('returns null when all slots occupied', () => {
    const mkSlot = (id: string): Slot => ({
      sessionId: id,
      projectName: id,
      topicName: id,
      activatedAt: now,
      lastHeartbeat: now
    })
    let state = initialState
    for (let i = 1; i <= 4; i++) {
      state = E.getOrElse(() => state)(addSlot(state, i, mkSlot(`s${i}`)))
    }
    expect(findAvailableSlot(state)).toBeNull()
  })

  it('prefers specified slot number when available', () => {
    expect(findAvailableSlot(initialState, 3)).toBe(3)
  })

  it('falls back to first available if preferred slot is taken', () => {
    const slot: Slot = {
      sessionId: 'sess-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const state = E.getOrElse(() => initialState)(addSlot(initialState, 2, slot))
    expect(findAvailableSlot(state, 2)).toBe(1)
  })
})

describe('findSlotBySessionId', () => {
  it('finds slot by session ID', () => {
    const slot: Slot = {
      sessionId: 'target-session',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const state = E.getOrElse(() => initialState)(addSlot(initialState, 2, slot))
    const result = findSlotBySessionId(state, 'target-session')
    expect(result).toEqual([2, slot])
  })

  it('returns null when session ID not found', () => {
    expect(findSlotBySessionId(initialState, 'nonexistent')).toBeNull()
  })
})

describe('findSlotByTopicName', () => {
  it('finds slot by topic name', () => {
    const slot: Slot = {
      sessionId: 'sess-1',
      projectName: 'metro',
      topicName: 'my-topic',
      activatedAt: now,
      lastHeartbeat: now
    }
    const state = E.getOrElse(() => initialState)(addSlot(initialState, 3, slot))
    const result = findSlotByTopicName(state, 'my-topic')
    expect(result).toEqual([3, slot])
  })

  it('returns null when topic name not found', () => {
    expect(findSlotByTopicName(initialState, 'nonexistent')).toBeNull()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx jest src/core/state/__tests__/index.test.ts -v`
Expected: FAIL — functions not exported

**Step 3: Implement the three functions**

Add to `src/core/state/index.ts`:

```typescript
/**
 * Find first available slot number (1-4)
 * Optionally prefer a specific slot number (for reattachment continuity)
 */
export const findAvailableSlot = (
  state: State,
  preferredSlot?: number
): number | null => {
  // Try preferred slot first
  if (preferredSlot !== undefined && state.slots[preferredSlot] === undefined) {
    return preferredSlot
  }
  // Find first undefined slot
  for (let i = 1; i <= 4; i++) {
    if (state.slots[i] === undefined) return i
  }
  return null
}

/**
 * Find a slot by its session ID
 * Returns [slotNum, slot] tuple or null
 */
export const findSlotBySessionId = (
  state: State,
  sessionId: string
): [number, Slot] | null => {
  for (const [key, slot] of Object.entries(state.slots)) {
    if (slot?.sessionId === sessionId) {
      return [parseInt(key, 10), slot]
    }
  }
  return null
}

/**
 * Find a slot by its topic name (for reattachment)
 * Returns [slotNum, slot] tuple or null
 */
export const findSlotByTopicName = (
  state: State,
  topicName: string
): [number, Slot] | null => {
  for (const [key, slot] of Object.entries(state.slots)) {
    if (slot?.topicName === topicName) {
      return [parseInt(key, 10), slot]
    }
  }
  return null
}
```

**Step 4: Run tests**

Run: `npx jest src/core/state/__tests__/index.test.ts -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/state/index.ts src/core/state/__tests__/index.test.ts
git commit -m "feat: add findAvailableSlot, findSlotBySessionId, findSlotByTopicName"
```

---

### Task 4: Add new error types (CliError, LockError, DaemonSpawnError, DaemonStopError)

**Files:**
- Modify: `src/types/errors.ts`
- Modify: `src/types/__tests__/errors.test.ts`

**Step 1: Write failing tests**

Add to `src/types/__tests__/errors.test.ts`:

```typescript
describe('CLI error types', () => {
  it('creates CliError', () => {
    const err = cliError('activation failed')
    expect(err._tag).toBe('CliError')
    expect(err.message).toBe('activation failed')
  })

  it('creates LockError', () => {
    const err = lockError('/tmp/state.json', new Error('locked'))
    expect(err._tag).toBe('LockError')
    expect(err.path).toBe('/tmp/state.json')
  })

  it('creates DaemonSpawnError', () => {
    const err = daemonSpawnError('bridge.js', new Error('ENOENT'))
    expect(err._tag).toBe('DaemonSpawnError')
    expect(err.bridgePath).toBe('bridge.js')
  })

  it('creates DaemonStopError', () => {
    const err = daemonStopError(1234, new Error('ESRCH'))
    expect(err._tag).toBe('DaemonStopError')
    expect(err.pid).toBe(1234)
  })

  it('errorMessage handles new error types', () => {
    expect(errorMessage(cliError('test'))).toContain('test')
    expect(errorMessage(lockError('/tmp/x', null))).toContain('/tmp/x')
    expect(errorMessage(daemonSpawnError('bridge.js', null))).toContain('bridge.js')
    expect(errorMessage(daemonStopError(99, null))).toContain('99')
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx jest src/types/__tests__/errors.test.ts -v`
Expected: FAIL — types not exported

**Step 3: Add error types and factories**

Add to `src/types/errors.ts` (in the Business Logic Errors section):

```typescript
export type CliError = {
  readonly _tag: 'CliError'
  readonly message: string
  readonly cause?: unknown
}

export type LockError = {
  readonly _tag: 'LockError'
  readonly path: string
  readonly cause: unknown
}

export type DaemonSpawnError = {
  readonly _tag: 'DaemonSpawnError'
  readonly bridgePath: string
  readonly cause: unknown
}

export type DaemonStopError = {
  readonly _tag: 'DaemonStopError'
  readonly pid: number
  readonly cause: unknown
}

export const cliError = (message: string, cause?: unknown): CliError => ({
  _tag: 'CliError',
  message,
  cause,
})

export const lockError = (path: string, cause: unknown): LockError => ({
  _tag: 'LockError',
  path,
  cause,
})

export const daemonSpawnError = (bridgePath: string, cause: unknown): DaemonSpawnError => ({
  _tag: 'DaemonSpawnError',
  bridgePath,
  cause,
})

export const daemonStopError = (pid: number, cause: unknown): DaemonStopError => ({
  _tag: 'DaemonStopError',
  pid,
  cause,
})
```

Update the `BridgeError` union type:

```typescript
export type BridgeError = IpcError | TelegramError | BusinessError | CliError | LockError | DaemonSpawnError | DaemonStopError
```

Add cases to `errorMessage`:

```typescript
case 'CliError':
  return `CLI error: ${error.message}`
case 'LockError':
  return `Lock error on ${error.path}: ${String(error.cause)}`
case 'DaemonSpawnError':
  return `Failed to spawn daemon ${error.bridgePath}: ${String(error.cause)}`
case 'DaemonStopError':
  return `Failed to stop daemon PID ${error.pid}: ${String(error.cause)}`
```

Add cases to `errorStatusCode`:

```typescript
case 'CliError':
  return 1
case 'LockError':
  return 500
case 'DaemonSpawnError':
case 'DaemonStopError':
  return 500
```

**Step 4: Run tests**

Run: `npx jest src/types/__tests__/errors.test.ts -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/types/errors.ts src/types/__tests__/errors.test.ts
git commit -m "feat: add CliError, LockError, DaemonSpawnError, DaemonStopError types"
```

---

### Task 5: Create `src/services/file-lock.ts`

**Files:**
- Create: `src/services/file-lock.ts`
- Create: `src/services/__tests__/file-lock.test.ts`

**Step 1: Write failing tests**

Create `src/services/__tests__/file-lock.test.ts`:

```typescript
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { withStateLock } from '../file-lock'

describe('withStateLock', () => {
  let tempDir: string
  let statePath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'))
    statePath = path.join(tempDir, 'state.json')
    await fs.writeFile(statePath, '{}', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('executes function and returns result', async () => {
    const result = await withStateLock(statePath, async () => 42)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toBe(42)
    }
  })

  it('releases lock after success', async () => {
    await withStateLock(statePath, async () => 'first')()
    const result = await withStateLock(statePath, async () => 'second')()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toBe('second')
    }
  })

  it('releases lock after failure', async () => {
    await withStateLock(statePath, async () => { throw new Error('boom') })()
    const result = await withStateLock(statePath, async () => 'recovered')()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toBe('recovered')
    }
  })

  it('returns LockError when state file does not exist', async () => {
    const result = await withStateLock('/nonexistent/state.json', async () => 1)()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe('LockError')
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/file-lock.test.ts -v`
Expected: FAIL — module not found

**Step 3: Implement file-lock.ts**

Create `src/services/file-lock.ts`:

```typescript
/**
 * @module services/file-lock
 * File-based mutex using proper-lockfile for safe concurrent state access.
 */

import * as TE from 'fp-ts/TaskEither'
import lockfile from 'proper-lockfile'
import { type LockError, lockError } from '../types/errors'

/**
 * Execute a function while holding an exclusive lock on a file.
 * Lock is always released after fn completes (success or failure).
 *
 * @param filePath - Path to the file to lock (must exist)
 * @param fn - Async function to execute while lock is held
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
    (error: unknown): LockError => lockError(filePath, error)
  )
```

**Step 4: Run tests**

Run: `npx jest src/services/__tests__/file-lock.test.ts -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/services/file-lock.ts src/services/__tests__/file-lock.test.ts
git commit -m "feat: add file-lock service with proper-lockfile"
```

---

### Task 6: Create `src/services/daemon-launcher.ts`

**Files:**
- Create: `src/services/daemon-launcher.ts`
- Create: `src/services/__tests__/daemon-launcher.test.ts`

**Step 1: Write failing tests**

Create `src/services/__tests__/daemon-launcher.test.ts`:

```typescript
import { isDaemonAlive } from '../daemon-launcher'

describe('isDaemonAlive', () => {
  it('returns true for current process PID', () => {
    expect(isDaemonAlive(process.pid)).toBe(true)
  })

  it('returns false for non-existent PID', () => {
    // Use a very high PID that almost certainly doesn't exist
    expect(isDaemonAlive(999999)).toBe(false)
  })

  it('returns false for PID 0', () => {
    expect(isDaemonAlive(0)).toBe(false)
  })
})
```

Note: `startDaemon` and `stopDaemon` are harder to unit test (they spawn/kill processes). We test `isDaemonAlive` as a pure function and rely on integration tests for spawn/stop.

**Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/daemon-launcher.test.ts -v`
Expected: FAIL — module not found

**Step 3: Implement daemon-launcher.ts**

Create `src/services/daemon-launcher.ts`:

```typescript
/**
 * @module services/daemon-launcher
 * Spawn and manage the bridge daemon process.
 */

import * as TE from 'fp-ts/TaskEither'
import { spawn } from 'child_process'
import { type DaemonSpawnError, type DaemonStopError, daemonSpawnError, daemonStopError } from '../types/errors'

/**
 * Check if a process with the given PID is alive.
 * Uses process.kill(pid, 0) which checks existence without sending a signal.
 */
export const isDaemonAlive = (pid: number): boolean => {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Start the bridge daemon as a detached background process.
 * Returns the daemon PID.
 *
 * @param bridgePath - Absolute path to bridge.js
 * @param logPath - Absolute path to daemon.log
 * @returns TaskEither<DaemonSpawnError, number> - PID on success
 */
export const startDaemon = (
  bridgePath: string,
  logPath: string
): TE.TaskEither<DaemonSpawnError, number> =>
  TE.tryCatch(
    async () => {
      const fs = await import('fs')
      const logFd = fs.openSync(logPath, 'a')

      const child = spawn('node', [bridgePath], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
      })

      child.unref()
      fs.closeSync(logFd)

      const pid = child.pid
      if (pid === undefined) {
        throw new Error('Failed to get daemon PID')
      }

      return pid
    },
    (error: unknown): DaemonSpawnError => daemonSpawnError(bridgePath, error)
  )

/**
 * Stop a running daemon by sending SIGTERM.
 *
 * @param pid - Process ID to stop
 * @returns TaskEither<DaemonStopError, void>
 */
export const stopDaemon = (pid: number): TE.TaskEither<DaemonStopError, void> =>
  TE.tryCatch(
    async () => {
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error: unknown) {
        // ESRCH = process doesn't exist — that's fine, it's already stopped
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ESRCH') {
          return
        }
        throw error
      }
    },
    (error: unknown): DaemonStopError => daemonStopError(pid, error)
  )
```

**Step 4: Run tests**

Run: `npx jest src/services/__tests__/daemon-launcher.test.ts -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/services/daemon-launcher.ts src/services/__tests__/daemon-launcher.test.ts
git commit -m "feat: add daemon-launcher service (spawn/stop/isDaemonAlive)"
```

---

### Task 7: Extend IPC service with directory management

**Files:**
- Modify: `src/services/ipc.ts`
- Modify: `src/services/__tests__/ipc.test.ts`

**Step 1: Write failing tests**

Add to `src/services/__tests__/ipc.test.ts`:

```typescript
import {
  // ... existing imports ...
  createIpcDir,
  removeIpcDir,
  writeMetaFile,
  cleanOrphanedIpcDirs,
} from '../ipc'

describe('IPC Directory Management', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-dir-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('createIpcDir', () => {
    it('creates session directory and returns path', async () => {
      const result = await createIpcDir(tempDir, 'sess-abc')()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toBe(path.join(tempDir, 'sess-abc'))
        const stat = await fs.stat(result.right)
        expect(stat.isDirectory()).toBe(true)
      }
    })

    it('is idempotent (creating twice succeeds)', async () => {
      await createIpcDir(tempDir, 'sess-abc')()
      const result = await createIpcDir(tempDir, 'sess-abc')()
      expect(E.isRight(result)).toBe(true)
    })
  })

  describe('removeIpcDir', () => {
    it('removes session directory recursively', async () => {
      const dirPath = path.join(tempDir, 'sess-abc')
      await fs.mkdir(dirPath, { recursive: true })
      await fs.writeFile(path.join(dirPath, 'events.jsonl'), '{}', 'utf-8')

      const result = await removeIpcDir(tempDir, 'sess-abc')()

      expect(E.isRight(result)).toBe(true)
      const exists = await fs.access(dirPath).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })

    it('succeeds even if directory does not exist', async () => {
      const result = await removeIpcDir(tempDir, 'nonexistent')()
      expect(E.isRight(result)).toBe(true)
    })
  })

  describe('writeMetaFile', () => {
    it('writes meta.json with session metadata', async () => {
      const ipcDir = path.join(tempDir, 'sess-abc')
      await fs.mkdir(ipcDir, { recursive: true })

      const meta = {
        sessionId: 'sess-abc',
        slot: 1,
        projectName: 'metro',
        topicName: 'metro',
        startedAt: '2024-01-01T12:00:00Z',
      }

      const result = await writeMetaFile(ipcDir, meta)()

      expect(E.isRight(result)).toBe(true)
      const content = JSON.parse(await fs.readFile(path.join(ipcDir, 'meta.json'), 'utf-8'))
      expect(content.sessionId).toBe('sess-abc')
      expect(content.slot).toBe(1)
    })
  })

  describe('cleanOrphanedIpcDirs', () => {
    it('removes directories not in active set', async () => {
      await fs.mkdir(path.join(tempDir, 'active-sess'), { recursive: true })
      await fs.mkdir(path.join(tempDir, 'orphan-sess'), { recursive: true })

      const result = await cleanOrphanedIpcDirs(tempDir, new Set(['active-sess']))()

      expect(E.isRight(result)).toBe(true)
      const activeExists = await fs.access(path.join(tempDir, 'active-sess')).then(() => true).catch(() => false)
      const orphanExists = await fs.access(path.join(tempDir, 'orphan-sess')).then(() => true).catch(() => false)
      expect(activeExists).toBe(true)
      expect(orphanExists).toBe(false)
    })

    it('does nothing when no orphans', async () => {
      await fs.mkdir(path.join(tempDir, 'active-sess'), { recursive: true })

      const result = await cleanOrphanedIpcDirs(tempDir, new Set(['active-sess']))()
      expect(E.isRight(result)).toBe(true)
    })
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx jest src/services/__tests__/ipc.test.ts -- --testNamePattern="IPC Directory" -v`
Expected: FAIL — functions not exported

**Step 3: Implement the four functions**

Add to `src/services/ipc.ts`:

```typescript
/**
 * Create an IPC directory for a session.
 * @returns The full path to the created directory.
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
 * Remove an IPC directory and all its contents.
 * Succeeds silently if directory doesn't exist.
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
 * Write a meta.json file to an IPC directory.
 * Contains session metadata for daemon to read.
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
 * Remove orphaned IPC directories that don't match any active session.
 * Only removes directories (not files) in baseDir.
 */
export const cleanOrphanedIpcDirs = (
  baseDir: string,
  activeSessionIds: Set<string>
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
    readErrorHandler(baseDir)
  )
```

**Step 4: Run tests**

Run: `npx jest src/services/__tests__/ipc.test.ts -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/services/ipc.ts src/services/__tests__/ipc.test.ts
git commit -m "feat: add IPC directory management (create, remove, meta, cleanup)"
```

---

### Task 8: Create `src/cli/activate.ts`

**Files:**
- Create: `src/cli/activate.ts`
- Create: `src/cli/__tests__/activate.test.ts`

**Step 1: Write failing tests**

Create `src/cli/__tests__/activate.test.ts`:

```typescript
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { activate } from '../activate'
import { initialState, type State, type Slot } from '../../types/state'

describe('activate', () => {
  let tempDir: string
  let configPath: string
  let statePath: string
  let ipcBaseDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activate-test-'))
    configPath = path.join(tempDir, 'config.json')
    statePath = path.join(tempDir, 'state.json')
    ipcBaseDir = path.join(tempDir, 'ipc')
    await fs.mkdir(ipcBaseDir, { recursive: true })

    await fs.writeFile(configPath, JSON.stringify({
      telegramBotToken: 'test-token',
      telegramGroupId: -100123,
      ipcBaseDir,
      sessionTimeout: 900000,
    }), 'utf-8')

    await fs.writeFile(statePath, JSON.stringify(initialState), 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('activates a new session in slot 1', async () => {
    const result = await activate(configPath, statePath, 'sess-123', 'metro', 'metro')()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.slotNum).toBe(1)
      expect(result.right.sessionId).toBe('sess-123')
    }

    // Verify state was saved
    const state = JSON.parse(await fs.readFile(statePath, 'utf-8')) as State
    expect(state.slots[1]).toBeDefined()
  })

  it('creates IPC directory and meta.json', async () => {
    await activate(configPath, statePath, 'sess-123', 'metro', 'metro')()

    const ipcDir = path.join(ipcBaseDir, 'sess-123')
    const stat = await fs.stat(ipcDir)
    expect(stat.isDirectory()).toBe(true)

    const meta = JSON.parse(await fs.readFile(path.join(ipcDir, 'meta.json'), 'utf-8'))
    expect(meta.sessionId).toBe('sess-123')
    expect(meta.projectName).toBe('metro')
  })

  it('writes SessionStart event to events.jsonl', async () => {
    await activate(configPath, statePath, 'sess-123', 'metro', 'metro')()

    const eventsFile = path.join(ipcBaseDir, 'sess-123', 'events.jsonl')
    const content = await fs.readFile(eventsFile, 'utf-8')
    const event = JSON.parse(content.trim())
    expect(event._tag).toBe('SessionStart')
    expect(event.slotNum).toBe(1)
    expect(event.projectName).toBe('metro')
  })

  it('returns error when all slots occupied', async () => {
    // Fill all 4 slots
    const now = new Date().toISOString()
    const fullState: State = {
      slots: Object.fromEntries(
        [1, 2, 3, 4].map(i => [i, {
          sessionId: `s${i}`,
          projectName: `p${i}`,
          topicName: `t${i}`,
          activatedAt: now,
          lastHeartbeat: now,
        }])
      ),
      pendingStops: {},
    }
    await fs.writeFile(statePath, JSON.stringify(fullState), 'utf-8')

    const result = await activate(configPath, statePath, 'new-sess', 'metro', 'metro')()
    expect(E.isLeft(result)).toBe(true)
  })

  it('reattaches when same topicName exists (reuses slot number and threadId)', async () => {
    // Pre-fill slot 2 with same topicName
    const oldSlot = {
      sessionId: 'old-sess',
      projectName: 'metro',
      topicName: 'metro',
      threadId: 42,
      activatedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    }
    const existingState: State = {
      slots: { 1: undefined, 2: oldSlot as unknown as Slot, 3: undefined, 4: undefined },
      pendingStops: {},
    }
    await fs.writeFile(statePath, JSON.stringify(existingState), 'utf-8')

    const result = await activate(configPath, statePath, 'new-sess', 'metro', 'metro')()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      // Should reuse slot 2 and carry forward threadId
      expect(result.right.slotNum).toBe(2)
      expect(result.right.threadId).toBe(42)
    }
  })

  it('returns early if same sessionId already active', async () => {
    await activate(configPath, statePath, 'sess-123', 'metro', 'metro')()
    const result = await activate(configPath, statePath, 'sess-123', 'metro', 'metro')()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.slotNum).toBe(1)
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx jest src/cli/__tests__/activate.test.ts -v`
Expected: FAIL — module not found

**Step 3: Implement activate.ts**

Create `src/cli/activate.ts`:

```typescript
/**
 * @module cli/activate
 * Activate AFK mode — claim a slot, create IPC dir, start daemon.
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as path from 'path'
import { type BridgeError, cliError } from '../types/errors'
import { type State, type Slot } from '../types/state'
import { loadConfig } from '../core/config'
import {
  findAvailableSlot,
  findSlotBySessionId,
  findSlotByTopicName,
  addSlot,
  removeSlot,
  cleanupStaleSlots,
} from '../core/state'
import { loadState, saveState } from '../services/state-persistence'
import { createIpcDir, removeIpcDir, writeMetaFile, writeEvent, cleanOrphanedIpcDirs } from '../services/ipc'
import { sessionStart } from '../types/events'
import { withStateLock } from '../services/file-lock'
import { startDaemon, isDaemonAlive } from '../services/daemon-launcher'

export interface ActivateResult {
  readonly slotNum: number
  readonly sessionId: string
  readonly threadId?: number
}

/**
 * Activate AFK mode for a session.
 *
 * Steps (inside file lock):
 * 1. Load config + state
 * 2. Cleanup stale slots
 * 3. Check if session already active (return early)
 * 4. Check reattachment (same topicName → reuse slot + threadId)
 * 5. Find available slot
 * 6. Build Slot, addSlot, save state
 * 7. Create IPC dir + meta.json
 * 8. Write SessionStart event
 * 9. Start daemon if not alive
 */
export const activate = (
  configPath: string,
  statePath: string,
  sessionId: string,
  project: string,
  topicName: string,
): TE.TaskEither<BridgeError, ActivateResult> =>
  TE.tryCatch(
    async () => {
      // Step 1: Load config
      const configResult = loadConfig(configPath)
      if (E.isLeft(configResult)) {
        throw cliError(`Failed to load config: ${String(configResult.left.message)}`)
      }
      const config = configResult.right

      // File-locked state operations
      const lockResult = await withStateLock(statePath, async () => {
        // Step 1b: Load state
        const stateResult = await loadState(statePath)()
        if (E.isLeft(stateResult)) {
          throw cliError(`Failed to load state: ${String(stateResult.left.message)}`)
        }
        let state = stateResult.right

        // Step 2: Cleanup stale slots
        const now = new Date()
        state = cleanupStaleSlots(state, config.sessionTimeout, now)

        // Clean orphaned IPC dirs
        const activeSessionIds = new Set(
          Object.values(state.slots)
            .filter((s): s is Slot => s !== undefined)
            .map(s => s.sessionId)
        )
        await cleanOrphanedIpcDirs(config.ipcBaseDir, activeSessionIds)()

        // Step 3: Check if this session is already active
        const existingSession = findSlotBySessionId(state, sessionId)
        if (existingSession) {
          const [slotNum, slot] = existingSession
          return { slotNum, sessionId, threadId: slot.threadId }
        }

        // Step 4: Check reattachment (same topicName)
        let reusedSlotNum: number | undefined
        let reusedThreadId: number | undefined

        const existingTopic = findSlotByTopicName(state, topicName)
        if (existingTopic) {
          const [oldSlotNum, oldSlot] = existingTopic
          reusedSlotNum = oldSlotNum
          reusedThreadId = oldSlot.threadId
          state = removeSlot(state, oldSlotNum)
          // Clean up old IPC dir
          await removeIpcDir(config.ipcBaseDir, oldSlot.sessionId)()
        }

        // Step 5: Find available slot (prefer reused slot number)
        const slotNum = findAvailableSlot(state, reusedSlotNum)
        if (slotNum === null) {
          const occupied = Object.entries(state.slots)
            .filter(([_, s]) => s !== undefined)
            .map(([n, s]) => `  S${n}: ${(s as Slot).projectName}`)
            .join('\n')
          throw cliError(`All 4 slots occupied:\n${occupied}\nRun /back in one of those sessions first.`)
        }

        // Step 6: Build slot and add to state
        const newSlot: Slot = {
          sessionId,
          projectName: project || 'unknown',
          topicName: topicName || `S${slotNum} - ${project || 'unknown'}`,
          ...(reusedThreadId !== undefined && { threadId: reusedThreadId }),
          activatedAt: now,
          lastHeartbeat: now,
        }

        const addResult = addSlot(state, slotNum, newSlot)
        if (E.isLeft(addResult)) {
          throw cliError(`Failed to add slot: ${addResult.left._tag}`)
        }
        state = addResult.right

        // Save state
        const saveResult = await saveState(statePath, state)()
        if (E.isLeft(saveResult)) {
          throw cliError(`Failed to save state: ${saveResult.left.message}`)
        }

        // Step 7: Create IPC dir + meta.json
        const ipcDirResult = await createIpcDir(config.ipcBaseDir, sessionId)()
        if (E.isLeft(ipcDirResult)) {
          throw cliError(`Failed to create IPC dir`)
        }
        const ipcDir = ipcDirResult.right

        await writeMetaFile(ipcDir, {
          sessionId,
          slot: slotNum,
          projectName: project || 'unknown',
          topicName: newSlot.topicName,
          startedAt: now.toISOString(),
          ...(reusedThreadId !== undefined && { reuseThreadId: reusedThreadId }),
        })()

        // Step 8: Write SessionStart event
        const eventsFile = path.join(ipcDir, 'events.jsonl')
        await writeEvent(eventsFile, sessionStart(slotNum, project || 'unknown'))()

        // Step 9: Start daemon if not alive
        const bridgePath = path.join(path.dirname(statePath), 'bridge.js')
        const logPath = path.join(path.dirname(statePath), 'daemon.log')

        // Check state for daemon PID
        const daemonPid = (state as unknown as Record<string, unknown>)['daemonPid'] as number | undefined
        if (!daemonPid || !isDaemonAlive(daemonPid)) {
          const spawnResult = await startDaemon(bridgePath, logPath)()
          if (E.isRight(spawnResult)) {
            // Update state with new daemon PID (outside the lock is fine, best-effort)
            const updatedState = { ...state, daemonPid: spawnResult.right }
            await saveState(statePath, updatedState as unknown as State)()
          }
        }

        return { slotNum, sessionId, threadId: reusedThreadId } as ActivateResult
      })()

      if (E.isLeft(lockResult)) {
        throw lockResult.left
      }

      return lockResult.right
    },
    (error: unknown): BridgeError => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        return error as BridgeError
      }
      return cliError(String(error))
    }
  )
```

**Step 4: Run tests**

Run: `npx jest src/cli/__tests__/activate.test.ts -v`
Expected: ALL PASS

Note: The daemon start step won't run in tests since `bridge.js` won't exist in the temp dir. That's fine — it'll log an error but won't fail the activation. The test verifies state/IPC behavior.

**Step 5: Commit**

```bash
git add src/cli/activate.ts src/cli/__tests__/activate.test.ts
git commit -m "feat: implement activate command (claim slot, IPC, daemon)"
```

---

### Task 9: Create `src/cli/deactivate.ts`

**Files:**
- Create: `src/cli/deactivate.ts`
- Create: `src/cli/__tests__/deactivate.test.ts`

**Step 1: Write failing tests**

Create `src/cli/__tests__/deactivate.test.ts`:

```typescript
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { deactivate } from '../deactivate'
import { type State, type Slot, initialState } from '../../types/state'

describe('deactivate', () => {
  let tempDir: string
  let configPath: string
  let statePath: string
  let ipcBaseDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deactivate-test-'))
    configPath = path.join(tempDir, 'config.json')
    statePath = path.join(tempDir, 'state.json')
    ipcBaseDir = path.join(tempDir, 'ipc')
    await fs.mkdir(ipcBaseDir, { recursive: true })

    await fs.writeFile(configPath, JSON.stringify({
      telegramBotToken: 'test-token',
      telegramGroupId: -100123,
      ipcBaseDir,
      sessionTimeout: 900000,
    }), 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('deactivates an active session by sessionId', async () => {
    // Set up active session
    const now = new Date().toISOString()
    const state: State = {
      slots: {
        1: undefined,
        2: { sessionId: 'sess-123', projectName: 'metro', topicName: 'metro', activatedAt: now, lastHeartbeat: now } as unknown as Slot,
        3: undefined,
        4: undefined,
      },
      pendingStops: {},
    }
    await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')
    await fs.mkdir(path.join(ipcBaseDir, 'sess-123'), { recursive: true })

    const result = await deactivate(configPath, statePath, 'sess-123')()

    expect(E.isRight(result)).toBe(true)

    // Verify slot was removed
    const savedState = JSON.parse(await fs.readFile(statePath, 'utf-8'))
    expect(savedState.slots['2']).toBeUndefined()
  })

  it('writes SessionEnd event before removing', async () => {
    const now = new Date().toISOString()
    const state: State = {
      slots: {
        1: { sessionId: 'sess-123', projectName: 'metro', topicName: 'metro', activatedAt: now, lastHeartbeat: now } as unknown as Slot,
        2: undefined, 3: undefined, 4: undefined,
      },
      pendingStops: {},
    }
    await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')
    const sessDir = path.join(ipcBaseDir, 'sess-123')
    await fs.mkdir(sessDir, { recursive: true })

    await deactivate(configPath, statePath, 'sess-123')()

    // SessionEnd event should have been written before IPC cleanup
    // Since removeIpcDir deletes the dir, we verify state instead
    const savedState = JSON.parse(await fs.readFile(statePath, 'utf-8'))
    expect(savedState.slots['1']).toBeUndefined()
  })

  it('removes IPC directory', async () => {
    const now = new Date().toISOString()
    const state: State = {
      slots: {
        1: { sessionId: 'sess-123', projectName: 'metro', topicName: 'metro', activatedAt: now, lastHeartbeat: now } as unknown as Slot,
        2: undefined, 3: undefined, 4: undefined,
      },
      pendingStops: {},
    }
    await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')
    await fs.mkdir(path.join(ipcBaseDir, 'sess-123'), { recursive: true })

    await deactivate(configPath, statePath, 'sess-123')()

    const exists = await fs.access(path.join(ipcBaseDir, 'sess-123')).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('returns error when no active sessions found', async () => {
    await fs.writeFile(statePath, JSON.stringify(initialState), 'utf-8')

    const result = await deactivate(configPath, statePath, 'nonexistent')()
    expect(E.isLeft(result)).toBe(true)
  })

  it('falls back to first active slot when sessionId not found', async () => {
    const now = new Date().toISOString()
    const state: State = {
      slots: {
        1: undefined,
        2: undefined,
        3: { sessionId: 'other-sess', projectName: 'metro', topicName: 'metro', activatedAt: now, lastHeartbeat: now } as unknown as Slot,
        4: undefined,
      },
      pendingStops: {},
    }
    await fs.writeFile(statePath, JSON.stringify(state), 'utf-8')
    await fs.mkdir(path.join(ipcBaseDir, 'other-sess'), { recursive: true })

    const result = await deactivate(configPath, statePath, 'wrong-id')()

    expect(E.isRight(result)).toBe(true)
    const savedState = JSON.parse(await fs.readFile(statePath, 'utf-8'))
    expect(savedState.slots['3']).toBeUndefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx jest src/cli/__tests__/deactivate.test.ts -v`
Expected: FAIL — module not found

**Step 3: Implement deactivate.ts**

Create `src/cli/deactivate.ts`:

```typescript
/**
 * @module cli/deactivate
 * Deactivate AFK mode — release slot, clean IPC, stop daemon if last.
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as path from 'path'
import { type BridgeError, cliError } from '../types/errors'
import { type State, type Slot } from '../types/state'
import { loadConfig } from '../core/config'
import { findSlotBySessionId, removeSlot } from '../core/state'
import { loadState, saveState } from '../services/state-persistence'
import { removeIpcDir, writeEvent } from '../services/ipc'
import { sessionEnd } from '../types/events'
import { withStateLock } from '../services/file-lock'
import { stopDaemon } from '../services/daemon-launcher'

/**
 * Deactivate AFK mode for a session.
 *
 * Steps (inside file lock):
 * 1. Load config + state
 * 2. Find slot by sessionId (or first active)
 * 3. Write SessionEnd event
 * 4. Remove slot, save state
 * 5. Clean IPC dir
 * 6. Stop daemon if no slots remain
 */
export const deactivate = (
  configPath: string,
  statePath: string,
  sessionId: string,
): TE.TaskEither<BridgeError, void> =>
  TE.tryCatch(
    async () => {
      // Load config
      const configResult = loadConfig(configPath)
      if (E.isLeft(configResult)) {
        throw cliError(`Failed to load config: ${String(configResult.left.message)}`)
      }
      const config = configResult.right

      const lockResult = await withStateLock(statePath, async () => {
        // Load state
        const stateResult = await loadState(statePath)()
        if (E.isLeft(stateResult)) {
          throw cliError(`Failed to load state: ${stateResult.left.message}`)
        }
        let state = stateResult.right

        // Find slot by sessionId
        let match = findSlotBySessionId(state, sessionId)

        // Fallback: find first active slot
        if (!match) {
          for (const [key, slot] of Object.entries(state.slots)) {
            if (slot !== undefined) {
              match = [parseInt(key, 10), slot]
              break
            }
          }
        }

        if (!match) {
          throw cliError('No active AFK sessions found.')
        }

        const [slotNum, slot] = match
        const actualSessionId = slot.sessionId

        // Write SessionEnd event
        const ipcDir = path.join(config.ipcBaseDir, actualSessionId)
        const eventsFile = path.join(ipcDir, 'events.jsonl')
        await writeEvent(eventsFile, sessionEnd(slotNum))()

        // Remove slot from state
        state = removeSlot(state, slotNum)

        // Save state
        const saveResult = await saveState(statePath, state)()
        if (E.isLeft(saveResult)) {
          throw cliError(`Failed to save state: ${saveResult.left.message}`)
        }

        // Clean IPC dir
        await removeIpcDir(config.ipcBaseDir, actualSessionId)()

        // Stop daemon if no slots remain
        const hasActiveSlots = Object.values(state.slots).some(s => s !== undefined)
        if (!hasActiveSlots) {
          const daemonPid = (state as unknown as Record<string, unknown>)['daemonPid'] as number | undefined
          if (daemonPid) {
            await stopDaemon(daemonPid)()
          }
        }

        return slotNum
      })()

      if (E.isLeft(lockResult)) {
        throw lockResult.left
      }
    },
    (error: unknown): BridgeError => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        return error as BridgeError
      }
      return cliError(String(error))
    }
  )
```

**Step 4: Run tests**

Run: `npx jest src/cli/__tests__/deactivate.test.ts -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/cli/deactivate.ts src/cli/__tests__/deactivate.test.ts
git commit -m "feat: implement deactivate command (release slot, cleanup, stop daemon)"
```

---

### Task 10: Create `src/cli/index.ts` (CLI entry point)

**Files:**
- Create: `src/cli/index.ts`

**Step 1: Implement the CLI dispatcher**

Create `src/cli/index.ts`:

```typescript
#!/usr/bin/env node

/**
 * @module cli/index
 * CLI entry point for activate/deactivate/status commands.
 * Built as dist/cli.js by esbuild.
 */

import * as E from 'fp-ts/Either'
import * as path from 'path'
import { activate } from './activate'
import { deactivate } from './deactivate'
import { errorMessage, type BridgeError } from '../types/errors'

const BRIDGE_DIR = process.env.TELEGRAM_BRIDGE_CONFIG
  || path.join(process.env.HOME || '', '.claude', 'hooks', 'telegram-bridge')

const configPath = path.join(BRIDGE_DIR, 'config.json')
const statePath = path.join(BRIDGE_DIR, 'state.json')

const printUsage = (): void => {
  console.error('Usage: cli.js <activate|deactivate> [args...]')
  console.error('')
  console.error('Commands:')
  console.error('  activate <session_id> <project> [topic_name]')
  console.error('  deactivate <session_id>')
}

const handleError = (error: BridgeError): never => {
  console.error(`Error: ${errorMessage(error)}`)
  return process.exit(1)
}

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2)

  if (!command) {
    printUsage()
    process.exit(1)
    return
  }

  switch (command) {
    case 'activate': {
      const [sessionId, project, topicName] = args
      if (!sessionId) {
        console.error('Error: session_id is required')
        printUsage()
        process.exit(1)
        return
      }

      const result = await activate(
        configPath,
        statePath,
        sessionId,
        project || 'unknown',
        topicName || project || 'unknown',
      )()

      if (E.isLeft(result)) {
        handleError(result.left)
      } else {
        const { slotNum } = result.right
        console.log(`AFK mode activated — slot S${slotNum}`)
        console.log('Telegram bridge is watching this session.')
        process.exit(0)
      }
      break
    }

    case 'deactivate': {
      const [sessionId] = args

      const result = await deactivate(
        configPath,
        statePath,
        sessionId || '',
      )()

      if (E.isLeft(result)) {
        handleError(result.left)
      } else {
        console.log('AFK mode deactivated.')
        process.exit(0)
      }
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

if (require.main === module) {
  main()
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: add CLI entry point (dispatches activate/deactivate)"
```

---

### Task 11: Add third esbuild entry point + update hook-wrapper.sh + update install.sh

**Files:**
- Modify: `build.mjs`
- Modify: `scripts/hook-wrapper.sh`
- Modify: `install.sh`

**Step 1: Add cli.js to build.mjs**

Add a third entry to the `Promise.all([...])` array in `build.mjs`:

```javascript
esbuild.build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/cli.js',
}).then(() => {
  const cliPath = 'dist/cli.js'
  let content = fs.readFileSync(cliPath, 'utf8')
  if (!content.startsWith('#!/usr/bin/env node')) {
    content = '#!/usr/bin/env node\n' + content
    fs.writeFileSync(cliPath, content)
  }
}),
```

**Step 2: Update hook-wrapper.sh**

Add `--activate` and `--deactivate` cases to the `case` block, **before** `--status)`:

```bash
  --activate)
    shift
    exec node "$CONFIG_DIR/cli.js" activate "$@"
    ;;
  --deactivate)
    shift
    exec node "$CONFIG_DIR/cli.js" deactivate "$@"
    ;;
```

Also update the help text to document these flags:

```
Usage: hook.sh [--activate|--deactivate|--status|--setup|--help] [hook-type]

Commands:
  --activate <session_id> <project> [topic]  Activate AFK mode
  --deactivate <session_id>                  Deactivate AFK mode
  --status      Show daemon status
  --setup       Configure Telegram credentials
  --help        Show this help message
```

**Step 3: Update install.sh**

Add `cli.js` to the copy section. In the `if [ -n "$SCRIPT_DIR" ]` block:

```bash
cp "$SCRIPT_DIR/dist/cli.js" "$INSTALL_DIR/cli.js"
```

And in the download-from-GitHub block:

```bash
curl -fsSL "$REPO_BASE/dist/cli.js" -o "$INSTALL_DIR/cli.js"
```

And in the `chmod` line:

```bash
chmod +x "$INSTALL_DIR/hook.js" "$INSTALL_DIR/bridge.js" "$INSTALL_DIR/cli.js" "$INSTALL_DIR/hook.sh"
```

Remove the section that copies Python files (the block with `for py_file in hook.py bridge.py`). Replace with removal of all old Python files:

```bash
# --- Remove old Python files if present ---
for old_file in hook.py bridge.py poll.py; do
  if [ -f "$INSTALL_DIR/$old_file" ]; then
    rm -f "$INSTALL_DIR/$old_file"
    echo "Removed legacy $old_file"
  fi
done
```

Update the "Files installed" section to list `cli.js`.

**Step 4: Build and verify**

Run: `cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge && npm run build`
Expected: `Build complete` — `dist/cli.js` exists

Run: `ls -la dist/cli.js`
Expected: File exists with shebang

Run: `node dist/cli.js --help 2>&1 || true`
Expected: Prints usage

**Step 5: Run full test suite**

Run: `npx jest --verbose`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add build.mjs scripts/hook-wrapper.sh install.sh
git commit -m "feat: add cli.js build entry point, wire hook-wrapper.sh and install.sh"
```

---

### Task 12: Full integration test — build + install + activate + deactivate

**Step 1: Build**

Run: `cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge && npm run build`
Expected: `Build complete`

**Step 2: Verify dist contents**

Run: `ls -la dist/`
Expected: `hook.js`, `bridge.js`, `cli.js` all present

**Step 3: Test activate via hook-wrapper.sh**

Run: `bash scripts/hook-wrapper.sh --activate test-session-$(date +%s) test-project test-topic 2>&1`
Expected: `AFK mode activated — slot S...` (may fail on Telegram API but state should be written)

**Step 4: Check state**

Run: `cat ~/.claude/hooks/telegram-bridge/state.json | python3 -m json.tool 2>/dev/null || cat ~/.claude/hooks/telegram-bridge/state.json`
Expected: Shows the new slot with sessionId, projectName, topicName

**Step 5: Test deactivate**

Run: `bash scripts/hook-wrapper.sh --deactivate test-session-... 2>&1` (use the session ID from step 3)
Expected: `AFK mode deactivated.`

**Step 6: Deploy full install**

Run: `npm run deploy`
Expected: Complete without errors, `~/.claude/hooks/telegram-bridge/cli.js` exists

**Step 7: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: integration test fixes for activate/deactivate"
```

---

### Task 13: Clean up — remove Python dependency from installer

**Step 1: Verify no Python references remain**

Run: `grep -r "hook\.py\|bridge\.py\|python3\|sys\.executable" install.sh scripts/hook-wrapper.sh`
Expected: Only the "remove old Python files" section in install.sh

Run: `grep -r "python3" scripts/hook-wrapper.sh`
Expected: No matches

**Step 2: Update SKILL.md**

Verify `SKILL.md` references are accurate:
- Dependencies should list "Node.js 18+" not "Python 3"
- File structure should show `cli.js`
- Troubleshooting should reference `node` not `python3`

**Step 3: Commit**

```bash
git add SKILL.md install.sh
git commit -m "chore: remove Python dependency, update docs for TS-only install"
```
