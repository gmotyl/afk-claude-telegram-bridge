/**
 * @module services/session-binding.test
 * Tests for session binding — maps Claude Code session_id to AFK IPC directories.
 * Critical for multi-session isolation.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { findBoundSession, findUnboundSession, bindSession } from '../session-binding'

describe('Session Binding', () => {
  let ipcBaseDir: string

  const slots = {
    1: { sessionId: 'uuid-A' },
    2: { sessionId: 'uuid-B' },
  }

  beforeEach(async () => {
    ipcBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-binding-test-'))
    await fs.mkdir(path.join(ipcBaseDir, 'uuid-A'), { recursive: true })
    await fs.mkdir(path.join(ipcBaseDir, 'uuid-B'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(ipcBaseDir, { recursive: true, force: true }).catch(() => {})
  })

  describe('findBoundSession', () => {
    it('returns null when no directories have bound_session files', async () => {
      const result = await findBoundSession(ipcBaseDir, 'claude-sess-1', slots)
      expect(result).toBeNull()
    })

    it('finds session bound to matching Claude session_id', async () => {
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), 'claude-sess-1', 'utf-8')

      const result = await findBoundSession(ipcBaseDir, 'claude-sess-1', slots)
      expect(result).toEqual({ sessionId: 'uuid-A', slotNum: 1 })
    })

    it('returns null when Claude session_id does not match any binding', async () => {
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), 'claude-sess-1', 'utf-8')

      const result = await findBoundSession(ipcBaseDir, 'claude-sess-UNKNOWN', slots)
      expect(result).toBeNull()
    })

    it('finds correct session among multiple bindings', async () => {
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), 'claude-sess-1', 'utf-8')
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-B', 'bound_session'), 'claude-sess-2', 'utf-8')

      const resultA = await findBoundSession(ipcBaseDir, 'claude-sess-1', slots)
      expect(resultA).toEqual({ sessionId: 'uuid-A', slotNum: 1 })

      const resultB = await findBoundSession(ipcBaseDir, 'claude-sess-2', slots)
      expect(resultB).toEqual({ sessionId: 'uuid-B', slotNum: 2 })
    })

    it('returns null when ipcBaseDir does not exist', async () => {
      const result = await findBoundSession('/nonexistent/path', 'claude-sess-1', slots)
      expect(result).toBeNull()
    })

    it('ignores bound_session for sessions not in state slots', async () => {
      await fs.mkdir(path.join(ipcBaseDir, 'uuid-orphan'), { recursive: true })
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-orphan', 'bound_session'), 'claude-sess-1', 'utf-8')

      const result = await findBoundSession(ipcBaseDir, 'claude-sess-1', slots)
      expect(result).toBeNull()
    })

    it('handles whitespace in bound_session file', async () => {
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), '  claude-sess-1\n', 'utf-8')

      const result = await findBoundSession(ipcBaseDir, 'claude-sess-1', slots)
      expect(result).toEqual({ sessionId: 'uuid-A', slotNum: 1 })
    })
  })

  describe('findUnboundSession', () => {
    it('returns first unbound slot by slot number order', async () => {
      const result = await findUnboundSession(ipcBaseDir, slots)
      expect(result).toEqual({ sessionId: 'uuid-A', slotNum: 1 })
    })

    it('returns second slot when first is already bound', async () => {
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), 'claude-sess-1', 'utf-8')

      const result = await findUnboundSession(ipcBaseDir, slots)
      expect(result).toEqual({ sessionId: 'uuid-B', slotNum: 2 })
    })

    it('returns null when all slots are bound', async () => {
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), 'claude-sess-1', 'utf-8')
      await fs.writeFile(path.join(ipcBaseDir, 'uuid-B', 'bound_session'), 'claude-sess-2', 'utf-8')

      const result = await findUnboundSession(ipcBaseDir, slots)
      expect(result).toBeNull()
    })

    it('returns null when no slots exist', async () => {
      const result = await findUnboundSession(ipcBaseDir, {})
      expect(result).toBeNull()
    })

    it('sorts by slot number (deterministic)', async () => {
      // Slots out of order in the object
      const slotsReversed = {
        3: { sessionId: 'uuid-C' },
        1: { sessionId: 'uuid-A' },
      }
      await fs.mkdir(path.join(ipcBaseDir, 'uuid-C'), { recursive: true })

      const result = await findUnboundSession(ipcBaseDir, slotsReversed)
      expect(result).toEqual({ sessionId: 'uuid-A', slotNum: 1 })
    })
  })

  describe('bindSession', () => {
    it('creates bound_session file with Claude session_id', async () => {
      await bindSession(ipcBaseDir, 'uuid-A', 'claude-sess-X')

      const content = await fs.readFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), 'utf-8')
      expect(content).toBe('claude-sess-X')
    })

    it('overwrites existing binding', async () => {
      await bindSession(ipcBaseDir, 'uuid-A', 'claude-sess-old')
      await bindSession(ipcBaseDir, 'uuid-A', 'claude-sess-new')

      const content = await fs.readFile(path.join(ipcBaseDir, 'uuid-A', 'bound_session'), 'utf-8')
      expect(content).toBe('claude-sess-new')
    })
  })

  describe('multi-session isolation scenario', () => {
    it('two sessions bind to different IPC dirs without cross-contamination', async () => {
      // Simulate two activations creating two IPC dirs
      // Session A comes first
      const unboundA = await findUnboundSession(ipcBaseDir, slots)
      expect(unboundA).not.toBeNull()
      await bindSession(ipcBaseDir, unboundA!.sessionId, 'claude-A')

      // Session B comes second
      const unboundB = await findUnboundSession(ipcBaseDir, slots)
      expect(unboundB).not.toBeNull()
      expect(unboundB!.sessionId).not.toBe(unboundA!.sessionId)
      await bindSession(ipcBaseDir, unboundB!.sessionId, 'claude-B')

      // Both can find their bound sessions
      const foundA = await findBoundSession(ipcBaseDir, 'claude-A', slots)
      const foundB = await findBoundSession(ipcBaseDir, 'claude-B', slots)
      expect(foundA).toEqual({ sessionId: 'uuid-A', slotNum: 1 })
      expect(foundB).toEqual({ sessionId: 'uuid-B', slotNum: 2 })

      // Cross lookup returns null (no leaking)
      const crossA = await findBoundSession(ipcBaseDir, 'claude-B', { 1: slots[1] } as any)
      expect(crossA).toBeNull() // uuid-A has claude-A bound, not claude-B

      // No more unbound sessions
      const noMore = await findUnboundSession(ipcBaseDir, slots)
      expect(noMore).toBeNull()
    })
  })
})
