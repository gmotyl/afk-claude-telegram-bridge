/**
 * @module services/state-persistence.test
 * Tests for state persistence module
 * Tests JSON file read/write operations for State objects using TaskEither for error handling
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  loadState,
  saveState
} from '../state-persistence'
import { State, initialState, type Slot } from '../../types/state'

describe('State Persistence Module', () => {
  let tempDir: string

  beforeEach(async () => {
    // Create temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-persistence-test-'))
  })

  afterEach(async () => {
    // Clean up temporary directory after each test
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('loadState', () => {
    it('loads valid state from JSON file', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const testState: State = {
        slots: {
          1: {
            sessionId: 'test-session-1',
            projectName: 'metro',
            topicName: 'metro',
            activatedAt: new Date('2026-02-26T10:00:00Z'),
            lastHeartbeat: new Date('2026-02-26T10:01:00Z')
          },
          2: undefined,
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }
      await fs.writeFile(stateFile, JSON.stringify(testState), 'utf-8')

      const result = await loadState(stateFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const state = result.right
        expect(state.slots[1]).toBeDefined()
        expect(state.slots[1]?.projectName).toBe('metro')
      }
    })

    it('returns default state if file does not exist', async () => {
      const stateFile = path.join(tempDir, 'nonexistent.json')

      const result = await loadState(stateFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const state = result.right
        expect(state).toEqual(initialState)
      }
    })

    it('returns Left error for invalid JSON', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      await fs.writeFile(stateFile, 'invalid json {', 'utf-8')

      const result = await loadState(stateFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('StateError')
      }
    })

    it('returns Left error for read permission denied', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      await fs.writeFile(stateFile, JSON.stringify(initialState), 'utf-8')
      await fs.chmod(stateFile, 0o000)

      const result = await loadState(stateFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('StateError')
      }

      // Cleanup - restore permissions to allow deletion
      await fs.chmod(stateFile, 0o644)
    })

    it('returns TaskEither that is lazy (async)', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      await fs.writeFile(stateFile, JSON.stringify(initialState), 'utf-8')

      const task = loadState(stateFile)
      expect(typeof task).toBe('function')

      const result = await task()
      expect(E.isRight(result)).toBe(true)
    })

    it('loads state with all slots populated', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const activatedAt1 = new Date('2026-02-26T10:00:00Z')
      const lastHeartbeat1 = new Date('2026-02-26T10:01:00Z')
      const activatedAt2 = new Date('2026-02-26T09:00:00Z')
      const lastHeartbeat2 = new Date('2026-02-26T09:30:00Z')
      const testState: State = {
        slots: {
          1: {
            sessionId: 'test-session-1',
            projectName: 'metro',
            topicName: 'metro',
            activatedAt: activatedAt1,
            lastHeartbeat: lastHeartbeat1
          },
          2: {
            sessionId: 'test-session-2',
            projectName: 'alokai',
            topicName: 'alokai',
            activatedAt: activatedAt2,
            lastHeartbeat: lastHeartbeat2
          },
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }
      await fs.writeFile(stateFile, JSON.stringify(testState), 'utf-8')

      const result = await loadState(stateFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        const state = result.right
        expect(state.slots[1]?.projectName).toBe('metro')
        expect(state.slots[1]?.activatedAt).toBe(activatedAt1.toISOString())
        expect(state.slots[2]?.projectName).toBe('alokai')
        expect(state.slots[2]?.activatedAt).toBe(activatedAt2.toISOString())
        expect(state.slots[3]).toBeUndefined()
      }
    })

    it('defaults pendingStops when loading old state format', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      // Old format: no pendingStops field
      const oldFormatState = {
        slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined }
      }
      await fs.writeFile(stateFile, JSON.stringify(oldFormatState), 'utf-8')

      const result = await loadState(stateFile)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right.pendingStops).toEqual({})
      }
    })

    it('handles empty file by returning default state', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      await fs.writeFile(stateFile, '', 'utf-8')

      const result = await loadState(stateFile)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('StateError')
      }
    })
  })

  describe('saveState', () => {
    it('saves state to new JSON file', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const testState: State = {
        slots: {
          1: {
            sessionId: 'test-session-1',
            projectName: 'metro',
            topicName: 'metro',
            activatedAt: new Date('2026-02-26T10:00:00Z'),
            lastHeartbeat: new Date('2026-02-26T10:01:00Z')
          },
          2: undefined,
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }

      const result = await saveState(stateFile, testState)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(stateFile, 'utf-8')
      const saved = JSON.parse(content)
      expect(saved.slots[1].projectName).toBe('metro')
    })

    it('overwrites existing state file', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const oldState: State = {
        slots: {
          1: {
            sessionId: 'test-session-1',
            projectName: 'old',
            topicName: 'old',
            activatedAt: new Date('2026-02-26T08:00:00Z'),
            lastHeartbeat: new Date('2026-02-26T08:00:00Z')
          },
          2: undefined,
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }
      await fs.writeFile(stateFile, JSON.stringify(oldState), 'utf-8')

      const newState: State = {
        slots: {
          1: {
            sessionId: 'test-session-2',
            projectName: 'new',
            topicName: 'new',
            activatedAt: new Date('2026-02-26T10:00:00Z'),
            lastHeartbeat: new Date('2026-02-26T10:01:00Z')
          },
          2: undefined,
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }
      const result = await saveState(stateFile, newState)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(stateFile, 'utf-8')
      const saved = JSON.parse(content)
      expect(saved.slots[1].projectName).toBe('new')
    })

    it('returns Left error for invalid directory path', async () => {
      const stateFile = path.join(tempDir, 'nonexistent-dir', 'state.json')
      const testState = initialState

      const result = await saveState(stateFile, testState)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('StateError')
      }
    })

    it('returns Left error for write permission denied', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const testState = initialState

      await fs.chmod(tempDir, 0o000)
      const result = await saveState(stateFile, testState)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        const error = result.left
        expect(error._tag).toBe('StateError')
      }

      // Cleanup - restore permissions
      await fs.chmod(tempDir, 0o755)
    })

    it('returns TaskEither that is lazy (async)', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const testState = initialState

      const task = saveState(stateFile, testState)
      expect(typeof task).toBe('function')

      const result = await task()
      expect(E.isRight(result)).toBe(true)
    })

    it('saves state with Dates serialized correctly', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const now = new Date('2026-02-26T10:00:00Z')
      const testState: State = {
        slots: {
          1: {
            sessionId: 'test-session-1',
            projectName: 'test',
            topicName: 'test',
            activatedAt: now,
            lastHeartbeat: now
          },
          2: undefined,
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }

      const result = await saveState(stateFile, testState)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(stateFile, 'utf-8')
      const saved = JSON.parse(content)
      expect(saved.slots[1].activatedAt).toBe(now.toISOString())
      expect(saved.slots[1].lastHeartbeat).toBe(now.toISOString())
    })

    it('saves empty state with all slots undefined', async () => {
      const stateFile = path.join(tempDir, 'state.json')

      const result = await saveState(stateFile, initialState)()

      expect(E.isRight(result)).toBe(true)
      const content = await fs.readFile(stateFile, 'utf-8')
      const saved = JSON.parse(content)
      expect(saved.slots[1]).toBeUndefined()
      expect(saved.slots[2]).toBeUndefined()
      expect(saved.slots[3]).toBeUndefined()
      expect(saved.slots[4]).toBeUndefined()
    })
  })

  describe('Load and Save Integration', () => {
    it('round-trips state through save and load', async () => {
      const stateFile = path.join(tempDir, 'state.json')
      const slot1: Slot = {
        sessionId: 'test-session-1',
        projectName: 'metro',
        topicName: 'metro',
        activatedAt: new Date('2026-02-26T10:00:00Z'),
        lastHeartbeat: new Date('2026-02-26T10:01:00Z')
      }
      const originalState: State = {
        slots: {
          1: slot1,
          2: undefined,
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }

      // Save the state
      const saveResult = await saveState(stateFile, originalState)()
      expect(E.isRight(saveResult)).toBe(true)

      // Load it back
      const loadResult = await loadState(stateFile)()
      expect(E.isRight(loadResult)).toBe(true)
      if (E.isRight(loadResult)) {
        const loadedState = loadResult.right
        expect(loadedState.slots[1]?.projectName).toBe('metro')
      }
    })

    it('preserves state integrity across multiple saves', async () => {
      const stateFile = path.join(tempDir, 'state.json')

      // First save
      const state1: State = {
        slots: {
          1: {
            sessionId: 'test-session-1',
            projectName: 'metro',
            topicName: 'metro',
            activatedAt: new Date('2026-02-26T10:00:00Z'),
            lastHeartbeat: new Date('2026-02-26T10:01:00Z')
          },
          2: undefined,
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }
      await saveState(stateFile, state1)()

      // Second save
      const state2: State = {
        slots: {
          1: undefined,
          2: {
            sessionId: 'test-session-2',
            projectName: 'alokai',
            topicName: 'alokai',
            activatedAt: new Date('2026-02-26T09:00:00Z'),
            lastHeartbeat: new Date('2026-02-26T09:30:00Z')
          },
          3: undefined,
          4: undefined
        },
        pendingStops: {}
      }
      await saveState(stateFile, state2)()

      // Load and verify
      const loadResult = await loadState(stateFile)()
      expect(E.isRight(loadResult)).toBe(true)
      if (E.isRight(loadResult)) {
        const loadedState = loadResult.right
        expect(loadedState.slots[1]).toBeUndefined()
        expect(loadedState.slots[2]?.projectName).toBe('alokai')
      }
    })
  })
})
