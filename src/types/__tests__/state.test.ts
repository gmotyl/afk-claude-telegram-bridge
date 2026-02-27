import { State, Slot, PendingStop, initialState } from '../state'

describe('State and Slot', () => {
  it('Slot has required fields', () => {
    const now = new Date()
    const slot: Slot = {
      sessionId: 'session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }

    expect(slot.sessionId).toBe('session-1')
    expect(slot.projectName).toBe('metro')
    expect(slot.topicName).toBe('metro')
    expect(slot.activatedAt).toBe(now)
    expect(slot.lastHeartbeat).toBe(now)
  })

  it('Slot supports optional threadId', () => {
    const now = new Date()
    const slot: Slot = {
      sessionId: 'session-1',
      projectName: 'metro',
      topicName: 'metro',
      threadId: 42,
      activatedAt: now,
      lastHeartbeat: now
    }

    expect(slot.threadId).toBe(42)
  })

  it('Slot threadId is undefined when not set', () => {
    const now = new Date()
    const slot: Slot = {
      sessionId: 'session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }

    expect(slot.threadId).toBeUndefined()
  })

  it('Slot is readonly', () => {
    const slot: Slot = {
      sessionId: 'session-1',
      projectName: 'metro',
      topicName: 'metro',
      activatedAt: new Date(),
      lastHeartbeat: new Date()
    }

    // @ts-expect-error - readonly
    slot.projectName = 'modified'
    // @ts-expect-error - readonly
    slot.sessionId = 'modified'
    // @ts-expect-error - readonly
    slot.topicName = 'modified'
    expect(true).toBe(true)
  })

  it('State has slots record with 4 slots', () => {
    const state: State = {
      slots: {
        1: undefined,
        2: undefined,
        3: undefined,
        4: undefined
      },
      pendingStops: {}
    }

    expect(Object.keys(state.slots)).toHaveLength(4)
    expect(state.slots[1]).toBeUndefined()
    expect(state.slots[4]).toBeUndefined()
  })

  it('State.slots is readonly', () => {
    const state: State = {
      slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined },
      pendingStops: {}
    }

    // @ts-expect-error - readonly
    state.slots[1] = { sessionId: 's1', projectName: 'test', topicName: 'test', activatedAt: new Date(), lastHeartbeat: new Date() }
    expect(true).toBe(true)
  })

  it('initialState creates empty state', () => {
    expect(initialState.slots[1]).toBeUndefined()
    expect(initialState.slots[2]).toBeUndefined()
    expect(initialState.slots[3]).toBeUndefined()
    expect(initialState.slots[4]).toBeUndefined()
    expect(initialState.pendingStops).toEqual({})
  })

  it('PendingStop has correct shape', () => {
    const ps: PendingStop = {
      eventId: 'evt-1',
      slotNum: 1,
      lastMessage: 'test',
      timestamp: '2026-01-01T00:00:00.000Z'
    }
    expect(ps.eventId).toBe('evt-1')
    expect(ps.slotNum).toBe(1)
    expect(ps.telegramMessageId).toBeUndefined()
  })

  it('PendingStop supports optional telegramMessageId', () => {
    const ps: PendingStop = {
      eventId: 'evt-1',
      slotNum: 1,
      lastMessage: 'test',
      timestamp: '2026-01-01T00:00:00.000Z',
      telegramMessageId: 42
    }
    expect(ps.telegramMessageId).toBe(42)
  })
})
