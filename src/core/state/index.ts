import * as E from 'fp-ts/Either'
import { State, Slot, PendingStop } from '../../types/state'

export type StateError =
  | { readonly _tag: 'SlotAlreadyActive'; readonly slotNum: number }
  | { readonly _tag: 'InvalidSlotNumber'; readonly slotNum: number }

/**
 * Check if a slot is still active (not timed out)
 * Pure function: returns boolean based on slot, timeout, and current time
 */
export const isSlotActive = (
  slot: Slot | undefined,
  timeoutMs: number,
  now: Date
): boolean => {
  if (!slot) return false
  const elapsed = now.getTime() - slot.lastHeartbeat.getTime()
  return elapsed < timeoutMs
}

/**
 * Add a new slot to state
 * Returns Either<StateError, State> for validation failures
 */
export const addSlot = (
  state: State,
  slotNum: number,
  slot: Slot
): E.Either<StateError, State> => {
  // Validate slot number
  if (slotNum < 1 || slotNum > 4) {
    return E.left({ _tag: 'InvalidSlotNumber', slotNum })
  }

  // Check if slot already active
  if (state.slots[slotNum] !== undefined) {
    return E.left({ _tag: 'SlotAlreadyActive', slotNum })
  }

  // Create new state (immutable)
  return E.right({
    ...state,
    slots: {
      ...state.slots,
      [slotNum]: slot
    }
  })
}

/**
 * Remove a slot from state
 * Always succeeds (idempotent)
 */
export const removeSlot = (state: State, slotNum: number): State => ({
  ...state,
  slots: {
    ...state.slots,
    [slotNum]: undefined
  }
})

/**
 * Update heartbeat timestamp for a slot
 */
export const heartbeatSlot = (
  state: State,
  slotNum: number,
  now: Date
): E.Either<StateError, State> => {
  const slot = state.slots[slotNum]
  if (!slot) {
    return E.left({ _tag: 'SlotAlreadyActive', slotNum })
  }

  return E.right({
    ...state,
    slots: {
      ...state.slots,
      [slotNum]: {
        ...slot,
        lastHeartbeat: now
      }
    }
  })
}

/**
 * Remove all slots that have timed out
 */
export const cleanupStaleSlots = (
  state: State,
  timeoutMs: number,
  now: Date
): State => {
  const cleaned: Record<number, Slot | undefined> = {}

  Object.entries(state.slots).forEach(([key, slot]) => {
    const slotNum = parseInt(key, 10)
    cleaned[slotNum] = isSlotActive(slot, timeoutMs, now) ? slot : undefined
  })

  return { ...state, slots: cleaned }
}

/**
 * Add a pending stop to state
 */
export const addPendingStop = (state: State, pendingStop: PendingStop): State => ({
  ...state,
  pendingStops: {
    ...state.pendingStops,
    [pendingStop.eventId]: pendingStop
  }
})

/**
 * Remove a pending stop from state by eventId
 */
export const removePendingStop = (state: State, eventId: string): State => {
  const { [eventId]: _, ...rest } = state.pendingStops
  return { ...state, pendingStops: rest }
}

/**
 * Find a pending stop by slot number
 * Returns the first pending stop for this slot, or undefined
 */
export const findPendingStopBySlot = (state: State, slotNum: number): PendingStop | undefined => {
  return Object.values(state.pendingStops).find(ps => ps.slotNum === slotNum)
}

/**
 * Update the Telegram message ID on a pending stop
 */
export const updatePendingStopMessageId = (
  state: State,
  eventId: string,
  telegramMessageId: number
): State => {
  const existing = state.pendingStops[eventId]
  if (!existing) return state
  return {
    ...state,
    pendingStops: {
      ...state.pendingStops,
      [eventId]: { ...existing, telegramMessageId }
    }
  }
}

/**
 * Find the first available slot number (1-4)
 * If preferredSlot is given and available, returns it; otherwise first available.
 * Returns null if all slots are occupied.
 */
export const findAvailableSlot = (state: State, preferredSlot?: number): number | null => {
  if (preferredSlot !== undefined && state.slots[preferredSlot] === undefined) {
    return preferredSlot
  }
  for (let i = 1; i <= 4; i++) {
    if (state.slots[i] === undefined) return i
  }
  return null
}

/**
 * Find a slot by its sessionId
 * Returns [slotNum, Slot] tuple or null
 */
export const findSlotBySessionId = (state: State, sessionId: string): [number, Slot] | null => {
  for (const [key, slot] of Object.entries(state.slots)) {
    if (slot && slot.sessionId === sessionId) {
      return [parseInt(key, 10), slot]
    }
  }
  return null
}

/**
 * Find a slot by its topicName
 * Returns [slotNum, Slot] tuple or null
 */
export const findSlotByTopicName = (state: State, topicName: string): [number, Slot] | null => {
  for (const [key, slot] of Object.entries(state.slots)) {
    if (slot && slot.topicName === topicName) {
      return [parseInt(key, 10), slot]
    }
  }
  return null
}
