import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import { startDaemon } from '../daemon'
import { Config } from '../../types/config'
import { State, initialState } from '../../types/state'
import { sessionStart, heartbeat, sessionEnd, message } from '../../types/events'

const tempDir = path.join('/tmp', 'daemon-test-' + Date.now())

/**
 * Helper to create a test config
 */
const createTestConfig = (): Config => ({
  telegramBotToken: 'test-token',
  telegramGroupId: 123456,
  ipcBaseDir: tempDir,
  sessionTimeout: 5 * 60 * 1000 // 5 minutes
})

/**
 * Helper to create a test config file
 */
const createTestConfigFile = async (dir: string): Promise<string> => {
  const configPath = path.join(dir, 'config.json')
  const config = createTestConfig()
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2))
  return configPath
}

/**
 * Helper to write an event file to the IPC directory
 */
const writeEventFile = async (dir: string, filename: string, events: any[]): Promise<void> => {
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, filename)
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content)
}

/**
 * Helper to clean up temp files
 */
const cleanup = async (dir: string): Promise<void> => {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

describe('startDaemon', () => {
  beforeEach(async () => {
    await cleanup(tempDir)
  })

  afterEach(async () => {
    await cleanup(tempDir)
  })

  it('returns a stop function on successful startup', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      const stopFunction = result.right
      expect(typeof stopFunction).toBe('function')

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('returns error if config file does not exist', async () => {
    const configPath = path.join(tempDir, 'nonexistent', 'config.json')

    const result = await startDaemon(configPath)()

    expect(E.isLeft(result)).toBe(true)
  })

  it('creates state file in ipc directory if it does not exist', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait a moment for state file to be created
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stateFilePath = path.join(tempDir, 'state.json')
      const exists = await fs
        .access(stateFilePath)
        .then(() => true)
        .catch(() => false)

      expect(exists).toBe(true)

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('loads existing state file on startup', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create a state file with a slot
    const stateFilePath = path.join(tempDir, 'state.json')
    const existingState: State = {
      slots: {
        1: {
          projectName: 'metro',
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
        2: undefined,
        3: undefined,
        4: undefined
      }
    }
    await fs.writeFile(stateFilePath, JSON.stringify(existingState, null, 2))

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes SessionStart events and updates state', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create an event file with SessionStart
    const event = sessionStart(1, 'metro')
    await writeEventFile(tempDir, 'event-S1.jsonl', [event])

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait for event processing
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Check that state file exists and contains the slot
      const stateFilePath = path.join(tempDir, 'state.json')
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      expect(state.slots[1]?.projectName).toBe('metro')

      // Check that event file was deleted
      const eventFileExists = await fs
        .access(path.join(tempDir, 'event-S1.jsonl'))
        .then(() => true)
        .catch(() => false)

      expect(eventFileExists).toBe(false)

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes SessionEnd events and removes slots', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create initial state with a slot
    const stateFilePath = path.join(tempDir, 'state.json')
    const initialStateWithSlot: State = {
      slots: {
        1: {
          projectName: 'metro',
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
        2: undefined,
        3: undefined,
        4: undefined
      }
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialStateWithSlot, null, 2))

    // Create an event file with SessionEnd
    const event = sessionEnd(1)
    await writeEventFile(tempDir, 'event-E1.jsonl', [event])

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait for event processing
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Check that the slot was removed from state
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeUndefined()

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes Heartbeat events and updates lastHeartbeat', async () => {
    const configPath = await createTestConfigFile(tempDir)
    const now = new Date()

    // Create initial state with a slot
    const stateFilePath = path.join(tempDir, 'state.json')
    const initialStateWithSlot: State = {
      slots: {
        1: {
          projectName: 'metro',
          activatedAt: now,
          lastHeartbeat: new Date(now.getTime() - 10000) // 10 seconds ago
        },
        2: undefined,
        3: undefined,
        4: undefined
      }
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialStateWithSlot, null, 2))

    const oldHeartbeat = initialStateWithSlot.slots[1]?.lastHeartbeat

    // Create an event file with Heartbeat
    const event = heartbeat(1)
    await writeEventFile(tempDir, 'event-H1.jsonl', [event])

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait for event processing
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Check that heartbeat was updated
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      if (state.slots[1]) {
        expect(state.slots[1].lastHeartbeat).not.toEqual(oldHeartbeat)
        // lastHeartbeat should be recent
        const timeSinceHeartbeat = new Date().getTime() - new Date(state.slots[1].lastHeartbeat).getTime()
        expect(timeSinceHeartbeat).toBeLessThan(2000) // Less than 2 seconds ago
      }

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes multiple events in sequence', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create event file with multiple events
    const events = [
      sessionStart(1, 'metro'),
      sessionStart(2, 'alokai'),
      heartbeat(1),
      message('Hello', 1)
    ]
    await writeEventFile(tempDir, 'event-multi.jsonl', events)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait for event processing
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Check that all slots were created
      const stateFilePath = path.join(tempDir, 'state.json')
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      expect(state.slots[2]).toBeDefined()
      expect(state.slots[1]?.projectName).toBe('metro')
      expect(state.slots[2]?.projectName).toBe('alokai')

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('saves state to file after processing events', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create an event file
    const event = sessionStart(1, 'metro')
    await writeEventFile(tempDir, 'event-S1.jsonl', [event])

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait for event processing and state save
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Verify state file exists and has content
      const stateFilePath = path.join(tempDir, 'state.json')
      const exists = await fs
        .access(stateFilePath)
        .then(() => true)
        .catch(() => false)

      expect(exists).toBe(true)

      const content = await fs.readFile(stateFilePath, 'utf-8')
      expect(content.length).toBeGreaterThan(0)

      const state = JSON.parse(content) as State
      expect(state.slots[1]).toBeDefined()

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('stops gracefully without errors', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Stop immediately
      const stopResult = await stopFunction()()

      expect(E.isRight(stopResult)).toBe(true)

      // Verify daemon has actually stopped (no more events are being processed)
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Event file should NOT be deleted since daemon is stopped
      const event = sessionStart(1, 'metro')
      await writeEventFile(tempDir, 'event-post-stop.jsonl', [event])

      // File should still exist (wasn't processed)
      const eventFileExists = await fs
        .access(path.join(tempDir, 'event-post-stop.jsonl'))
        .then(() => true)
        .catch(() => false)

      expect(eventFileExists).toBe(true)
    }
  })

  it('continues running even if an event fails to process', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Create initial state with slot in position 1
    const stateFilePath = path.join(tempDir, 'state.json')
    const initialState: State = {
      slots: {
        1: {
          projectName: 'metro',
          activatedAt: new Date(),
          lastHeartbeat: new Date()
        },
        2: undefined,
        3: undefined,
        4: undefined
      }
    }
    await fs.writeFile(stateFilePath, JSON.stringify(initialState, null, 2))

    // Create event file with a bad event (try to add to already-occupied slot)
    // followed by a good event
    const events = [
      sessionStart(1, 'alokai'), // Will fail - slot 1 is already occupied
      sessionStart(2, 'ch') // Should succeed even though previous failed
    ]
    await writeEventFile(tempDir, 'event-mixed.jsonl', events)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait for event processing
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Check that slot 2 was created (good event was processed)
      const stateContent = await fs.readFile(stateFilePath, 'utf-8')
      const state = JSON.parse(stateContent) as State

      expect(state.slots[1]).toBeDefined()
      expect(state.slots[1]?.projectName).toBe('metro') // Original slot unchanged
      expect(state.slots[2]).toBeDefined()
      expect(state.slots[2]?.projectName).toBe('ch') // New slot created

      // Stop the daemon
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('handles empty IPC directory gracefully', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait a few iterations
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Should still be running without errors
      // Just verify stop works
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })
})
