import { isSlotActive, addSlot, removeSlot, heartbeatSlot, cleanupStaleSlots, addPendingStop, removePendingStop, findPendingStopBySlot, updatePendingStopMessageId, findAvailableSlot, findSlotBySessionId, findSlotByTopicName, StateError } from '../index'
import { State, Slot, PendingStop, initialState } from '../../../types/state'
import * as E from 'fp-ts/Either'

const now = new Date('2024-01-01T12:00:00Z')

describe('isSlotActive', () => {
  it('returns true if slot within timeout', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now)
    expect(result).toBe(true)
  })

  it('returns false if slot timed out (just beyond timeout)', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: new Date('2024-01-01T11:54:00Z')
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now)
    expect(result).toBe(false)
  })

  it('returns false if slot is at timeout boundary', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: new Date('2024-01-01T11:55:00Z')
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now)
    expect(result).toBe(false)
  })

  it('returns false if slot is undefined', () => {
    const result = isSlotActive(undefined, 5 * 60 * 1000, now)
    expect(result).toBe(false)
  })

  it('returns false if slot has zero lastHeartbeat', () => {
    const epoch = new Date('1970-01-01T00:00:00Z')
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: epoch,
      lastHeartbeat: epoch
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now)
    expect(result).toBe(false)
  })
})

describe('addSlot', () => {
  it('succeeds with valid slot number 1-4', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const result = addSlot(initialState, 1, slot)
    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.slots[1]).toEqual(slot)
      expect(result.right.slots[2]).toBeUndefined()
    }
  })

  it('fails if slot number out of range', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const result0 = addSlot(initialState, 0, slot)
    const result5 = addSlot(initialState, 5, slot)

    expect(E.isLeft(result0)).toBe(true)
    if (E.isLeft(result0)) {
      expect(result0.left._tag).toBe('InvalidSlotNumber')
      expect(result0.left.slotNum).toBe(0)
    }

    expect(E.isLeft(result5)).toBe(true)
  })

  it('fails if slot already active', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const state1 = E.getOrElse(() => initialState)(addSlot(initialState, 1, slot))
    const result = addSlot(state1, 1, slot)
    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe('SlotAlreadyActive')
      expect(result.left.slotNum).toBe(1)
    }
  })

  it('does not mutate original state', () => {
    const original = initialState
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const result = addSlot(original, 1, slot)

    if (E.isRight(result)) {
      expect(original.slots[1]).toBeUndefined()
      expect(result.right.slots[1]).toEqual(slot)
    }
  })
})

describe('removeSlot', () => {
  it('removes slot from state', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const result = removeSlot(state, 1)
    expect(result.slots[1]).toBeUndefined()
  })

  it('is idempotent (removing twice yields same state)', () => {
    const state1 = removeSlot(initialState, 1)
    const state2 = removeSlot(state1, 1)

    expect(state2).toEqual(state1)
  })

  it('does not affect other slots', () => {
    const slot1: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const slot2: Slot = {
      sessionId: 'test-session-2',
      projectName: 'alokai',
      topicName: 'alokai',
      activatedAt: now,
      lastHeartbeat: now
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot1))
    state = E.getOrElse(() => state)(addSlot(state, 2, slot2))

    const result = removeSlot(state, 1)
    expect(result.slots[1]).toBeUndefined()
    expect(result.slots[2]).toEqual(slot2)
  })

  it('does not mutate original state', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state1 = initialState
    state1 = E.getOrElse(() => state1)(addSlot(state1, 1, slot))
    const result = removeSlot(state1, 1)

    expect(state1.slots[1]).toEqual(slot)
    expect(result.slots[1]).toBeUndefined()
  })
})

describe('heartbeatSlot', () => {
  it('updates lastHeartbeat timestamp', () => {
    const oldTime = new Date('2024-01-01T12:00:00Z')
    const newTime = new Date('2024-01-01T12:01:00Z')

    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: oldTime,
      lastHeartbeat: oldTime
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const result = heartbeatSlot(state, 1, newTime)
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const updated = result.right.slots[1]
      expect(updated).toBeDefined()
      if (updated) {
        expect(updated.lastHeartbeat).toEqual(newTime)
        expect(updated.projectName).toBe('metro')
      }
    }
  })

  it('fails if slot does not exist', () => {
    const result = heartbeatSlot(initialState, 1, now)
    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe('SlotAlreadyActive')
    }
  })

  it('does not mutate original state', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const newTime = new Date(now.getTime() + 1000)
    const result = heartbeatSlot(state, 1, newTime)

    expect(state.slots[1]?.lastHeartbeat).toEqual(now)
    if (E.isRight(result)) {
      expect(result.right.slots[1]?.lastHeartbeat).toEqual(newTime)
    }
  })
})

describe('cleanupStaleSlots', () => {
  it('removes timed-out slots', () => {
    const activeTime = now
    const staleTime = new Date('2024-01-01T11:54:00Z')

    const activeSlot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: activeTime,
      lastHeartbeat: activeTime
    }
    const staleSlot: Slot = {
      sessionId: 'test-session-2',
      projectName: 'alokai',
      topicName: 'alokai',
      activatedAt: staleTime,
      lastHeartbeat: staleTime
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, activeSlot))
    state = E.getOrElse(() => state)(addSlot(state, 2, staleSlot))

    const timeout = 5 * 60 * 1000
    const result = cleanupStaleSlots(state, timeout, now)

    expect(result.slots[1]).toBeDefined()
    expect(result.slots[2]).toBeUndefined()
  })

  it('is idempotent (cleanup twice yields same state)', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const state1 = cleanupStaleSlots(state, 5 * 60 * 1000, now)
    const state2 = cleanupStaleSlots(state1, 5 * 60 * 1000, now)

    expect(state2).toEqual(state1)
  })

  it('does not mutate original state', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: new Date('2024-01-01T11:54:00Z')
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const result = cleanupStaleSlots(state, 5 * 60 * 1000, now)

    expect(state.slots[1]).toBeDefined()
    expect(result.slots[1]).toBeUndefined()
  })

  it('preserves multiple active slots', () => {
    const slot1: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const slot2: Slot = {
      sessionId: 'test-session-2',
      projectName: 'alokai',
      topicName: 'alokai',
      activatedAt: now,
      lastHeartbeat: now
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot1))
    state = E.getOrElse(() => state)(addSlot(state, 3, slot2))

    const result = cleanupStaleSlots(state, 5 * 60 * 1000, now)

    expect(result.slots[1]).toBeDefined()
    expect(result.slots[3]).toBeDefined()
  })
})

describe('addPendingStop', () => {
  const ps: PendingStop = {
    eventId: 'evt-1',
    slotNum: 1,
    lastMessage: 'test',
    timestamp: '2026-01-01T00:00:00.000Z'
  }

  it('adds a pending stop to state', () => {
    const result = addPendingStop(initialState, ps)
    expect(result.pendingStops['evt-1']).toEqual(ps)
  })

  it('preserves existing pending stops', () => {
    const ps2: PendingStop = { eventId: 'evt-2', slotNum: 2, lastMessage: 'x', timestamp: '2026-01-01T00:00:00.000Z' }
    const state1 = addPendingStop(initialState, ps)
    const state2 = addPendingStop(state1, ps2)
    expect(state2.pendingStops['evt-1']).toEqual(ps)
    expect(state2.pendingStops['evt-2']).toEqual(ps2)
  })

  it('preserves slots', () => {
    const result = addPendingStop(initialState, ps)
    expect(result.slots).toEqual(initialState.slots)
  })
})

describe('removePendingStop', () => {
  it('removes a pending stop by eventId', () => {
    const ps: PendingStop = { eventId: 'evt-1', slotNum: 1, lastMessage: 'test', timestamp: '2026-01-01T00:00:00.000Z' }
    const state1 = addPendingStop(initialState, ps)
    const state2 = removePendingStop(state1, 'evt-1')
    expect(state2.pendingStops['evt-1']).toBeUndefined()
  })

  it('is idempotent', () => {
    const state1 = removePendingStop(initialState, 'nonexistent')
    expect(state1.pendingStops).toEqual({})
  })
})

describe('findPendingStopBySlot', () => {
  it('finds pending stop by slot number', () => {
    const ps: PendingStop = { eventId: 'evt-1', slotNum: 2, lastMessage: 'test', timestamp: '2026-01-01T00:00:00.000Z' }
    const state = addPendingStop(initialState, ps)
    const found = findPendingStopBySlot(state, 2)
    expect(found).toEqual(ps)
  })

  it('returns undefined when no pending stop for slot', () => {
    const found = findPendingStopBySlot(initialState, 1)
    expect(found).toBeUndefined()
  })
})

describe('updatePendingStopMessageId', () => {
  it('updates telegramMessageId on a pending stop', () => {
    const ps: PendingStop = { eventId: 'evt-1', slotNum: 1, lastMessage: 'test', timestamp: '2026-01-01T00:00:00.000Z' }
    const state1 = addPendingStop(initialState, ps)
    const state2 = updatePendingStopMessageId(state1, 'evt-1', 42)
    expect(state2.pendingStops['evt-1']?.telegramMessageId).toBe(42)
  })

  it('returns state unchanged if eventId not found', () => {
    const result = updatePendingStopMessageId(initialState, 'nonexistent', 42)
    expect(result).toEqual(initialState)
  })
})

describe('findAvailableSlot', () => {
  it('returns preferred slot when it is available', () => {
    const result = findAvailableSlot(initialState, 3)
    expect(result).toBe(3)
  })

  it('returns first available slot (1) when no preference given', () => {
    const result = findAvailableSlot(initialState)
    expect(result).toBe(1)
  })

  it('skips occupied slots and returns next available', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const result = findAvailableSlot(state)
    expect(result).toBe(2)
  })

  it('returns null when all slots are occupied', () => {
    const makeSlot = (id: string): Slot => ({
      sessionId: id,
      projectName: `proj-${id}`,
      topicName: `topic-${id}`,
      activatedAt: now,
      lastHeartbeat: now
    })

    let state = initialState
    for (let i = 1; i <= 4; i++) {
      state = E.getOrElse(() => state)(addSlot(state, i, makeSlot(`s${i}`)))
    }

    const result = findAvailableSlot(state)
    expect(result).toBeNull()
  })

  it('falls back to first available when preferred slot is occupied', () => {
    const slot: Slot = {
      sessionId: 'test-session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 2, slot))

    const result = findAvailableSlot(state, 2)
    expect(result).toBe(1)
  })
})

describe('findSlotBySessionId', () => {
  it('finds slot by session ID', () => {
    const slot: Slot = {
      sessionId: 'abc-123',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 2, slot))

    const result = findSlotBySessionId(state, 'abc-123')
    expect(result).not.toBeNull()
    expect(result![0]).toBe(2)
    expect(result![1]).toEqual(slot)
  })

  it('returns null when session ID not found', () => {
    const result = findSlotBySessionId(initialState, 'nonexistent')
    expect(result).toBeNull()
  })

  it('finds correct slot when multiple slots are active', () => {
    const slot1: Slot = {
      sessionId: 'session-A',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const slot2: Slot = {
      sessionId: 'session-B',
      projectName: 'alokai',
      topicName: 'alokai',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot1))
    state = E.getOrElse(() => state)(addSlot(state, 3, slot2))

    const result = findSlotBySessionId(state, 'session-B')
    expect(result).not.toBeNull()
    expect(result![0]).toBe(3)
    expect(result![1].projectName).toBe('alokai')
  })
})

describe('findSlotByTopicName', () => {
  it('finds slot by topic name', () => {
    const slot: Slot = {
      sessionId: 'session-1',
      projectName: 'metro',
      topicName: 'metro-topic',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const result = findSlotByTopicName(state, 'metro-topic')
    expect(result).not.toBeNull()
    expect(result![0]).toBe(1)
    expect(result![1]).toEqual(slot)
  })

  it('returns null when topic name not found', () => {
    const result = findSlotByTopicName(initialState, 'nonexistent')
    expect(result).toBeNull()
  })

  it('finds correct slot when multiple slots have different topics', () => {
    const slot1: Slot = {
      sessionId: 'session-1',
      projectName: 'metro',
      topicName: 'topic-A',
      activatedAt: now,
      lastHeartbeat: now
    }
    const slot2: Slot = {
      sessionId: 'session-2',
      projectName: 'alokai',
      topicName: 'topic-B',
      activatedAt: now,
      lastHeartbeat: now
    }
    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 2, slot1))
    state = E.getOrElse(() => state)(addSlot(state, 4, slot2))

    const result = findSlotByTopicName(state, 'topic-B')
    expect(result).not.toBeNull()
    expect(result![0]).toBe(4)
    expect(result![1].projectName).toBe('alokai')
  })
})
