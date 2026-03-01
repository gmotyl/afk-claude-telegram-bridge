/**
 * @module services/daemon-health.test
 * Tests for daemon health checking service
 */

import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { checkDaemonHealth, type DaemonHealthStatus } from '../daemon-health'

// Mock isDaemonAlive to control PID liveness without real processes
jest.mock('../daemon-launcher', () => ({
  isDaemonAlive: jest.fn(),
  startDaemon: jest.fn(),
}))

import { isDaemonAlive } from '../daemon-launcher'

const mockedIsDaemonAlive = isDaemonAlive as jest.MockedFunction<typeof isDaemonAlive>

describe('checkDaemonHealth', () => {
  let configDir: string

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-health-test-'))
    mockedIsDaemonAlive.mockReset()
  })

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => {})
  })

  const writeState = async (state: Record<string, unknown>): Promise<void> => {
    await fs.writeFile(
      path.join(configDir, 'state.json'),
      JSON.stringify(state),
      'utf-8'
    )
  }

  const writeHeartbeat = async (timestampMs: number): Promise<void> => {
    await fs.writeFile(
      path.join(configDir, 'daemon.heartbeat'),
      String(timestampMs),
      'utf-8'
    )
  }

  it('returns DaemonDead when no state.json exists (no PID)', async () => {
    const result = await checkDaemonHealth(configDir)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonDead')
      if (result.right._tag === 'DaemonDead') {
        expect(result.right.pid).toBeNull()
        expect(result.right.reason).toContain('No daemon PID')
      }
    }
  })

  it('returns DaemonDead when state.json has no daemon_pid', async () => {
    await writeState({ slots: {} })

    const result = await checkDaemonHealth(configDir)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonDead')
      if (result.right._tag === 'DaemonDead') {
        expect(result.right.pid).toBeNull()
      }
    }
  })

  it('returns DaemonDead when PID is not alive', async () => {
    await writeState({ daemon_pid: 99999 })
    mockedIsDaemonAlive.mockReturnValue(false)

    const result = await checkDaemonHealth(configDir)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonDead')
      if (result.right._tag === 'DaemonDead') {
        expect(result.right.pid).toBe(99999)
        expect(result.right.reason).toContain('not running')
      }
    }
  })

  it('returns DaemonDead when PID alive but no heartbeat file', async () => {
    await writeState({ daemon_pid: 12345 })
    mockedIsDaemonAlive.mockReturnValue(true)

    const result = await checkDaemonHealth(configDir)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonDead')
      if (result.right._tag === 'DaemonDead') {
        expect(result.right.pid).toBe(12345)
        expect(result.right.reason).toContain('No heartbeat file')
      }
    }
  })

  it('returns DaemonStale when heartbeat is older than threshold', async () => {
    const now = Date.now()
    const staleHeartbeat = now - 60_000 // 60s old

    await writeState({ daemon_pid: 12345 })
    mockedIsDaemonAlive.mockReturnValue(true)
    await writeHeartbeat(staleHeartbeat)

    const result = await checkDaemonHealth(configDir, now)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonStale')
      if (result.right._tag === 'DaemonStale') {
        expect(result.right.pid).toBe(12345)
        expect(result.right.staleForMs).toBeGreaterThanOrEqual(60_000)
      }
    }
  })

  it('returns DaemonHealthy when PID alive and heartbeat fresh', async () => {
    const now = Date.now()
    const freshHeartbeat = now - 5_000 // 5s old

    await writeState({ daemon_pid: 12345 })
    mockedIsDaemonAlive.mockReturnValue(true)
    await writeHeartbeat(freshHeartbeat)

    const result = await checkDaemonHealth(configDir, now)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonHealthy')
      if (result.right._tag === 'DaemonHealthy') {
        expect(result.right.pid).toBe(12345)
        expect(result.right.lastHeartbeatMs).toBe(freshHeartbeat)
      }
    }
  })

  it('returns DaemonHealthy when heartbeat is exactly at threshold boundary', async () => {
    const now = Date.now()
    // Heartbeat at exactly 29s ago (under 30s threshold)
    const heartbeat = now - 29_000

    await writeState({ daemon_pid: 12345 })
    mockedIsDaemonAlive.mockReturnValue(true)
    await writeHeartbeat(heartbeat)

    const result = await checkDaemonHealth(configDir, now)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonHealthy')
    }
  })

  it('handles corrupted heartbeat file gracefully', async () => {
    await writeState({ daemon_pid: 12345 })
    mockedIsDaemonAlive.mockReturnValue(true)
    await fs.writeFile(path.join(configDir, 'daemon.heartbeat'), 'not-a-number', 'utf-8')

    const result = await checkDaemonHealth(configDir)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      // NaN timestamp → treated as no heartbeat → Dead
      expect(result.right._tag).toBe('DaemonDead')
    }
  })

  it('handles corrupted state.json gracefully', async () => {
    await fs.writeFile(path.join(configDir, 'state.json'), 'not-json', 'utf-8')

    const result = await checkDaemonHealth(configDir)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right._tag).toBe('DaemonDead')
      if (result.right._tag === 'DaemonDead') {
        expect(result.right.pid).toBeNull()
      }
    }
  })
})
