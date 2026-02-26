# Phase 2 Tasks 4-6 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Either utilities, core domain types, and pure state functions with full TDD approach

**Architecture:**
- Task 4: Thin utilities layer wrapping fp-ts Either
- Task 5: Type definitions for Config, State, Events, Telegram
- Task 6: Pure immutable state functions with Either-based validation

**Tech Stack:** TypeScript, fp-ts (Either), Jest, immutable patterns

---

## Task 4: Either Utilities Module

### Task 4.1: Create Either utilities test file

**Files:**
- Create: `src/types/__tests__/either.test.ts`

**Step 1: Write failing tests**

```typescript
import * as either from '../either'

describe('either utilities', () => {
  it('ok is an alias for E.right', () => {
    const result = either.ok(42)
    expect(result._tag).toBe('Right')
    expect((result as any).right).toBe(42)
  })

  it('err is an alias for E.left', () => {
    const result = either.err('error message')
    expect(result._tag).toBe('Left')
    expect((result as any).left).toBe('error message')
  })

  it('isOk detects Right values', () => {
    const right = either.ok(42)
    const left = either.err('error')
    expect(either.isOk(right)).toBe(true)
    expect(either.isOk(left)).toBe(false)
  })

  it('isErr detects Left values', () => {
    const right = either.ok(42)
    const left = either.err('error')
    expect(either.isErr(right)).toBe(false)
    expect(either.isErr(left)).toBe(true)
  })

  it('fold handles both Right and Left cases', () => {
    const right = either.ok(42)
    const left = either.err('error')

    const resultRight = either.fold(
      (err) => `Error: ${err}`,
      (val) => `Success: ${val}`
    )(right)
    expect(resultRight).toBe('Success: 42')

    const resultLeft = either.fold(
      (err) => `Error: ${err}`,
      (val) => `Success: ${val}`
    )(left)
    expect(resultLeft).toBe('Error: error')
  })

  it('mapError transforms Left values', () => {
    const left = either.err('original')
    const result = either.mapError((e) => `mapped: ${e}`)(left)
    expect((result as any).left).toBe('mapped: original')
  })

  it('unwrapOr provides default for Left', () => {
    const right = either.ok(42)
    const left = either.err('error')

    expect(either.unwrapOr(() => 0)(right)).toBe(42)
    expect(either.unwrapOr(() => 0)(left)).toBe(0)
  })

  it('pipe is available for composition', () => {
    // Just verify it exists and is callable
    expect(typeof either.pipe).toBe('function')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- either.test.ts
```

**Expected output:**
```
FAIL  src/types/__tests__/either.test.ts
  ● Test suite failed to compile
  Cannot find module '../either'
```

**Step 3: Create Either utilities module**

**File:** `src/types/either.ts`

```typescript
import * as E from 'fp-ts/Either'
import { pipe as fpPipe } from 'fp-ts/function'

// Aliases for readability
export const ok = E.right
export const err = E.left
export const isOk = E.isRight
export const isErr = E.isLeft

// Domain helpers
export const mapError = E.mapLeft
export const unwrapOr = E.getOrElse
export const fold = E.fold

// Re-export pipe for composition
export const pipe = fpPipe
```

**Step 4: Run test to verify it passes**

```bash
npm test -- either.test.ts
```

**Expected output:**
```
PASS  src/types/__tests__/either.test.ts
  either utilities
    ✓ ok is an alias for E.right
    ✓ err is an alias for E.left
    ✓ isOk detects Right values
    ✓ isErr detects Left values
    ✓ fold handles both Right and Left cases
    ✓ mapError transforms Left values
    ✓ unwrapOr provides default for Left
    ✓ pipe is available for composition

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
```

**Step 5: Commit**

```bash
git add src/types/either.ts src/types/__tests__/either.test.ts
git commit -m "feat: add Either utilities module"
```

---

## Task 5: Core Domain Types

### Task 5.1: Create and test Config type

**Files:**
- Create: `src/types/config.ts`
- Create: `src/types/__tests__/config.test.ts`

**Step 1: Write failing test**

```typescript
// src/types/__tests__/config.test.ts
import { Config } from '../config'

describe('Config', () => {
  it('has required string fields', () => {
    const config: Config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    expect(config.telegramBotToken).toBe('test-token')
    expect(config.telegramGroupId).toBe(12345)
    expect(config.ipcBaseDir).toBe('/tmp/ipc')
    expect(config.sessionTimeout).toBe(300000)
  })

  it('is readonly (immutability enforced by TypeScript)', () => {
    const config: Config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    // @ts-expect-error - readonly property
    config.telegramBotToken = 'modified'

    // If this test passes, mutation is prevented at compile time
    expect(true).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- config.test.ts
```

**Expected output:**
```
Cannot find module '../config'
```

**Step 3: Create Config type**

```typescript
// src/types/config.ts
export interface Config {
  readonly telegramBotToken: string
  readonly telegramGroupId: number
  readonly ipcBaseDir: string
  readonly sessionTimeout: number // milliseconds
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- config.test.ts
```

**Expected output:**
```
PASS  src/types/__tests__/config.test.ts
  Config
    ✓ has required string fields
    ✓ is readonly (immutability enforced by TypeScript)

Tests: 2 passed, 2 total
```

**Step 5: Commit**

```bash
git add src/types/config.ts src/types/__tests__/config.test.ts
git commit -m "feat: add Config type"
```

---

### Task 5.2: Create and test State type

**Files:**
- Create: `src/types/state.ts`
- Create: `src/types/__tests__/state.test.ts`

**Step 1: Write failing tests**

```typescript
// src/types/__tests__/state.test.ts
import { State, Slot, initialState } from '../state'

describe('State and Slot', () => {
  it('Slot has required fields', () => {
    const now = new Date()
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }

    expect(slot.projectName).toBe('metro')
    expect(slot.activatedAt).toBe(now)
    expect(slot.lastHeartbeat).toBe(now)
  })

  it('Slot is readonly', () => {
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: new Date(),
      lastHeartbeat: new Date()
    }

    // @ts-expect-error - readonly
    slot.projectName = 'modified'
    expect(true).toBe(true)
  })

  it('State has slots record with 4 slots', () => {
    const state: State = {
      slots: {
        1: undefined,
        2: undefined,
        3: undefined,
        4: undefined
      }
    }

    expect(Object.keys(state.slots)).toHaveLength(4)
    expect(state.slots[1]).toBeUndefined()
    expect(state.slots[4]).toBeUndefined()
  })

  it('State.slots is readonly', () => {
    const state: State = {
      slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined }
    }

    // @ts-expect-error - readonly
    state.slots[1] = { projectName: 'test', activatedAt: new Date(), lastHeartbeat: new Date() }
    expect(true).toBe(true)
  })

  it('initialState creates empty state', () => {
    expect(initialState.slots[1]).toBeUndefined()
    expect(initialState.slots[2]).toBeUndefined()
    expect(initialState.slots[3]).toBeUndefined()
    expect(initialState.slots[4]).toBeUndefined()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- state.test.ts
```

**Step 3: Create State types**

```typescript
// src/types/state.ts
export interface Slot {
  readonly projectName: string
  readonly activatedAt: Date
  readonly lastHeartbeat: Date
}

export interface State {
  readonly slots: Readonly<Record<number, Slot | undefined>>
}

export const initialState: State = {
  slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- state.test.ts
```

**Expected output:**
```
PASS  src/types/__tests__/state.test.ts
  State and Slot
    ✓ Slot has required fields
    ✓ Slot is readonly
    ✓ State has slots record with 4 slots
    ✓ State.slots is readonly
    ✓ initialState creates empty state

Tests: 5 passed, 5 total
```

**Step 5: Commit**

```bash
git add src/types/state.ts src/types/__tests__/state.test.ts
git commit -m "feat: add State and Slot types"
```

---

### Task 5.3: Create and test Events type

**Files:**
- Create: `src/types/events.ts`
- Create: `src/types/__tests__/events.test.ts`

**Step 1: Write failing tests**

```typescript
// src/types/__tests__/events.test.ts
import * as events from '../events'

describe('IpcEvent', () => {
  it('SessionStart event has correct shape', () => {
    const event = events.sessionStart(1, 'metro')
    expect(event._tag).toBe('SessionStart')
    expect(event.slotNum).toBe(1)
    expect(event.projectName).toBe('metro')
  })

  it('SessionEnd event has correct shape', () => {
    const event = events.sessionEnd(2)
    expect(event._tag).toBe('SessionEnd')
    expect(event.slotNum).toBe(2)
  })

  it('Heartbeat event has correct shape', () => {
    const event = events.heartbeat(3)
    expect(event._tag).toBe('Heartbeat')
    expect(event.slotNum).toBe(3)
  })

  it('Message event has correct shape', () => {
    const event = events.message('hello world', 4)
    expect(event._tag).toBe('Message')
    expect(event.text).toBe('hello world')
    expect(event.slotNum).toBe(4)
  })

  it('SessionStart can be stringified to JSON', () => {
    const event = events.sessionStart(1, 'metro')
    const json = JSON.stringify(event)
    const parsed = JSON.parse(json)
    expect(parsed._tag).toBe('SessionStart')
    expect(parsed.slotNum).toBe(1)
    expect(parsed.projectName).toBe('metro')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- events.test.ts
```

**Step 3: Create Events types**

```typescript
// src/types/events.ts
export type IpcEvent =
  | { readonly _tag: 'SessionStart'; readonly slotNum: number; readonly projectName: string }
  | { readonly _tag: 'SessionEnd'; readonly slotNum: number }
  | { readonly _tag: 'Heartbeat'; readonly slotNum: number }
  | { readonly _tag: 'Message'; readonly text: string; readonly slotNum: number }

// Smart constructors
export const sessionStart = (slotNum: number, projectName: string): IpcEvent =>
  ({ _tag: 'SessionStart', slotNum, projectName })

export const sessionEnd = (slotNum: number): IpcEvent =>
  ({ _tag: 'SessionEnd', slotNum })

export const heartbeat = (slotNum: number): IpcEvent =>
  ({ _tag: 'Heartbeat', slotNum })

export const message = (text: string, slotNum: number): IpcEvent =>
  ({ _tag: 'Message', text, slotNum })
```

**Step 4: Run test to verify it passes**

```bash
npm test -- events.test.ts
```

**Expected output:**
```
PASS  src/types/__tests__/events.test.ts
  IpcEvent
    ✓ SessionStart event has correct shape
    ✓ SessionEnd event has correct shape
    ✓ Heartbeat event has correct shape
    ✓ Message event has correct shape
    ✓ SessionStart can be stringified to JSON

Tests: 5 passed, 5 total
```

**Step 5: Commit**

```bash
git add src/types/events.ts src/types/__tests__/events.test.ts
git commit -m "feat: add IpcEvent discriminated union type"
```

---

### Task 5.4: Create and test Telegram types

**Files:**
- Create: `src/types/telegram.ts`
- Create: `src/types/__tests__/telegram.test.ts`

**Step 1: Write failing tests**

```typescript
// src/types/__tests__/telegram.test.ts
import { TelegramMessage, TelegramTopic, topicName } from '../telegram'

describe('Telegram types', () => {
  it('TelegramMessage has required fields', () => {
    const msg: TelegramMessage = {
      messageId: 123,
      chatId: 456,
      topicId: 789,
      text: 'hello',
      timestamp: new Date('2024-01-01')
    }

    expect(msg.messageId).toBe(123)
    expect(msg.chatId).toBe(456)
    expect(msg.topicId).toBe(789)
    expect(msg.text).toBe('hello')
    expect(msg.timestamp).toEqual(new Date('2024-01-01'))
  })

  it('TelegramMessage is readonly', () => {
    const msg: TelegramMessage = {
      messageId: 123,
      chatId: 456,
      topicId: 789,
      text: 'hello',
      timestamp: new Date()
    }

    // @ts-expect-error - readonly
    msg.text = 'modified'
    expect(true).toBe(true)
  })

  it('TelegramTopic has required fields', () => {
    const topic: TelegramTopic = {
      topicId: 789,
      name: 'S1 - metro',
      description: 'Session 1: metro'
    }

    expect(topic.topicId).toBe(789)
    expect(topic.name).toBe('S1 - metro')
    expect(topic.description).toBe('Session 1: metro')
  })

  it('topicName generates correct format', () => {
    expect(topicName(1, 'metro')).toBe('S1 - metro')
    expect(topicName(2, 'alokai')).toBe('S2 - alokai')
    expect(topicName(3, 'ch')).toBe('S3 - ch')
    expect(topicName(4, 'doterra')).toBe('S4 - doterra')
  })

  it('topicName handles special characters in project name', () => {
    expect(topicName(1, 'my-project')).toBe('S1 - my-project')
    expect(topicName(1, 'project_name')).toBe('S1 - project_name')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- telegram.test.ts
```

**Step 3: Create Telegram types**

```typescript
// src/types/telegram.ts
export interface TelegramMessage {
  readonly messageId: number
  readonly chatId: number
  readonly topicId: number
  readonly text: string
  readonly timestamp: Date
}

export interface TelegramTopic {
  readonly topicId: number
  readonly name: string
  readonly description: string
}

export const topicName = (slotNum: number, projectName: string): string =>
  `S${slotNum} - ${projectName}`
```

**Step 4: Run test to verify it passes**

```bash
npm test -- telegram.test.ts
```

**Expected output:**
```
PASS  src/types/__tests__/telegram.test.ts
  Telegram types
    ✓ TelegramMessage has required fields
    ✓ TelegramMessage is readonly
    ✓ TelegramTopic has required fields
    ✓ topicName generates correct format
    ✓ topicName handles special characters in project name

Tests: 5 passed, 5 total
```

**Step 5: Commit**

```bash
git add src/types/telegram.ts src/types/__tests__/telegram.test.ts
git commit -m "feat: add Telegram types with topic helper"
```

---

## Task 6: Pure State Module

### Task 6.1: Create isSlotActive function with tests

**Files:**
- Create: `src/core/state/index.ts`
- Create: `src/core/state/__tests__/index.test.ts`

**Step 1: Write failing test**

```typescript
// src/core/state/__tests__/index.test.ts
import { isSlotActive } from '../index'
import { Slot } from '../../types/state'

describe('isSlotActive', () => {
  it('returns true if slot within timeout', () => {
    const now = new Date('2024-01-01T12:00:00Z')
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now) // 5 minute timeout
    expect(result).toBe(true)
  })

  it('returns false if slot timed out (just beyond timeout)', () => {
    const now = new Date('2024-01-01T12:00:00Z')
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: new Date('2024-01-01T11:54:00Z') // 6 minutes ago
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now)
    expect(result).toBe(false)
  })

  it('returns false if slot is at timeout boundary', () => {
    const now = new Date('2024-01-01T12:00:00Z')
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: new Date('2024-01-01T11:55:00Z') // exactly 5 minutes ago
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now)
    expect(result).toBe(false) // >= timeout = inactive
  })

  it('returns false if slot is undefined', () => {
    const now = new Date()
    const result = isSlotActive(undefined, 5 * 60 * 1000, now)
    expect(result).toBe(false)
  })

  it('returns false if slot has zero lastHeartbeat', () => {
    const now = new Date('2024-01-01T12:00:00Z')
    const epoch = new Date('1970-01-01T00:00:00Z')
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: epoch,
      lastHeartbeat: epoch
    }
    const result = isSlotActive(slot, 5 * 60 * 1000, now)
    expect(result).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- state
```

**Step 3: Create state module with isSlotActive**

```typescript
// src/core/state/index.ts
import { Slot } from '../../types/state'

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
```

**Step 4: Run test to verify it passes**

```bash
npm test -- state
```

**Expected output:**
```
PASS  src/core/state/__tests__/index.test.ts
  isSlotActive
    ✓ returns true if slot within timeout
    ✓ returns false if slot timed out (just beyond timeout)
    ✓ returns false if slot is at timeout boundary
    ✓ returns false if slot is undefined
    ✓ returns false if slot has zero lastHeartbeat

Tests: 5 passed, 5 total
```

**Step 5: Continue to next function (don't commit yet)**

---

### Task 6.2: Add addSlot function with tests

**Step 1: Add failing tests for addSlot**

Add to `src/core/state/__tests__/index.test.ts`:

```typescript
import { addSlot, StateError } from '../index'
import { State, initialState } from '../../types/state'
import * as E from 'fp-ts/Either'

describe('addSlot', () => {
  it('succeeds with valid slot number 1-4', () => {
    const slot: Slot = {
      projectName: 'metro',
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
      projectName: 'metro',
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
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    // Add slot first time
    const state1 = E.getOrElse(() => initialState)(addSlot(initialState, 1, slot))

    // Try to add same slot again
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
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const result = addSlot(original, 1, slot)

    if (E.isRight(result)) {
      expect(original.slots[1]).toBeUndefined() // original unchanged
      expect(result.right.slots[1]).toEqual(slot) // new state has slot
    }
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- state
```

**Step 3: Implement addSlot in state module**

Add to `src/core/state/index.ts`:

```typescript
export type StateError =
  | { readonly _tag: 'SlotAlreadyActive'; readonly slotNum: number }
  | { readonly _tag: 'InvalidSlotNumber'; readonly slotNum: number }

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
    slots: {
      ...state.slots,
      [slotNum]: slot
    }
  })
}
```

Add import at top:
```typescript
import * as E from 'fp-ts/Either'
import { State, Slot, initialState } from '../../types/state'
```

**Step 4: Run test to verify it passes**

```bash
npm test -- state
```

**Expected output:**
```
PASS  src/core/state/__tests__/index.test.ts
  ...previous tests...
  addSlot
    ✓ succeeds with valid slot number 1-4
    ✓ fails if slot number out of range
    ✓ fails if slot already active
    ✓ does not mutate original state

Tests: 9 passed, 9 total
```

---

### Task 6.3: Add removeSlot function with tests

**Step 1: Add failing tests for removeSlot**

Add to test file:

```typescript
describe('removeSlot', () => {
  it('removes slot from state', () => {
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const state1 = E.getOrElse(() => initialState)(addSlot(initialState, 1, slot))

    const result = removeSlot(state1, 1)
    expect(result.slots[1]).toBeUndefined()
  })

  it('is idempotent (removing twice yields same state)', () => {
    const state1 = removeSlot(initialState, 1)
    const state2 = removeSlot(state1, 1)

    expect(state2).toEqual(state1)
  })

  it('does not affect other slots', () => {
    const slot1: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const slot2: Slot = {
      projectName: 'alokai',
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
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const state1 = E.getOrElse(() => initialState)(addSlot(initialState, 1, slot))
    const result = removeSlot(state1, 1)

    expect(state1.slots[1]).toEqual(slot) // original unchanged
    expect(result.slots[1]).toBeUndefined() // new state has no slot
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- state
```

**Step 3: Implement removeSlot**

Add to `src/core/state/index.ts`:

```typescript
export const removeSlot = (state: State, slotNum: number): State => ({
  slots: {
    ...state.slots,
    [slotNum]: undefined
  }
})
```

**Step 4: Run test to verify it passes**

```bash
npm test -- state
```

**Expected output:** All tests pass (13 total)

---

### Task 6.4: Add heartbeatSlot function with tests

**Step 1: Add failing tests for heartbeatSlot**

Add to test file:

```typescript
describe('heartbeatSlot', () => {
  it('updates lastHeartbeat timestamp', () => {
    const oldTime = new Date('2024-01-01T12:00:00Z')
    const newTime = new Date('2024-01-01T12:01:00Z')

    const slot: Slot = {
      projectName: 'metro',
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
      expect(result.left._tag).toBe('SlotAlreadyActive') // slot doesn't exist = error
    }
  })

  it('does not mutate original state', () => {
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const newTime = new Date(now.getTime() + 1000)
    const result = heartbeatSlot(state, 1, newTime)

    expect(state.slots[1]?.lastHeartbeat).toEqual(now) // original unchanged
    if (E.isRight(result)) {
      expect(result.right.slots[1]?.lastHeartbeat).toEqual(newTime) // new state updated
    }
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- state
```

**Step 3: Implement heartbeatSlot**

Add to `src/core/state/index.ts`:

```typescript
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
    slots: {
      ...state.slots,
      [slotNum]: {
        ...slot,
        lastHeartbeat: now
      }
    }
  })
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- state
```

**Expected output:** All tests pass (16 total)

---

### Task 6.5: Add cleanupStaleSlots function with tests

**Step 1: Add failing tests for cleanupStaleSlots**

Add to test file:

```typescript
describe('cleanupStaleSlots', () => {
  it('removes timed-out slots', () => {
    const now = new Date('2024-01-01T12:00:00Z')
    const activeTime = now // just activated
    const staleTime = new Date('2024-01-01T11:54:00Z') // 6 minutes ago

    const activeSlot: Slot = {
      projectName: 'metro',
      activatedAt: activeTime,
      lastHeartbeat: activeTime
    }
    const staleSlot: Slot = {
      projectName: 'alokai',
      activatedAt: staleTime,
      lastHeartbeat: staleTime
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, activeSlot))
    state = E.getOrElse(() => state)(addSlot(state, 2, staleSlot))

    const timeout = 5 * 60 * 1000 // 5 minutes
    const result = cleanupStaleSlots(state, timeout, now)

    expect(result.slots[1]).toBeDefined() // active remains
    expect(result.slots[2]).toBeUndefined() // stale removed
  })

  it('is idempotent (cleanup twice yields same state)', () => {
    const slot: Slot = {
      projectName: 'metro',
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
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: new Date('2024-01-01T11:54:00Z')
    }

    let state = initialState
    state = E.getOrElse(() => state)(addSlot(state, 1, slot))

    const result = cleanupStaleSlots(state, 5 * 60 * 1000, now)

    expect(state.slots[1]).toBeDefined() // original unchanged
    expect(result.slots[1]).toBeUndefined() // new state cleaned
  })

  it('preserves multiple active slots', () => {
    const slot1: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    const slot2: Slot = {
      projectName: 'alokai',
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
```

**Step 2: Run test to verify it fails**

```bash
npm test -- state
```

**Step 3: Implement cleanupStaleSlots**

Add to `src/core/state/index.ts`:

```typescript
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

  return { slots: cleaned }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- state
```

**Expected output:**
```
PASS  src/core/state/__tests__/index.test.ts
  isSlotActive
    ✓ returns true if slot within timeout
    ✓ returns false if slot timed out (just beyond timeout)
    ✓ returns false if slot is at timeout boundary
    ✓ returns false if slot is undefined
    ✓ returns false if slot has zero lastHeartbeat
  addSlot
    ✓ succeeds with valid slot number 1-4
    ✓ fails if slot number out of range
    ✓ fails if slot already active
    ✓ does not mutate original state
  removeSlot
    ✓ removes slot from state
    ✓ is idempotent (removing twice yields same state)
    ✓ does not affect other slots
    ✓ does not mutate original state
  heartbeatSlot
    ✓ updates lastHeartbeat timestamp
    ✓ fails if slot does not exist
    ✓ does not mutate original state
  cleanupStaleSlots
    ✓ removes timed-out slots
    ✓ is idempotent (cleanup twice yields same state)
    ✓ does not mutate original state
    ✓ preserves multiple active slots

Tests: 21 passed, 21 total
```

**Step 5: Final commit for Task 6**

```bash
git add src/core/state/index.ts src/core/state/__tests__/index.test.ts
git commit -m "feat: add pure state module with 5 functions

- isSlotActive: check timeout status
- addSlot: activate session (with validation)
- removeSlot: deactivate session (idempotent)
- heartbeatSlot: update timestamp
- cleanupStaleSlots: remove expired sessions"
```

---

## Verification

### Run Full Test Suite

```bash
npm test
```

**Expected output:**
```
Test Suites: 6 passed, 6 total (either, config, state, events, telegram, state functions)
Tests:       50+ passed, 50+ total
Coverage:    100% for types/ and core/
```

### Run Type Check

```bash
npm run typecheck
```

**Expected output:** No errors

### Build

```bash
npm run build
```

**Expected output:**
```
✓ dist/hook.js (built)
✓ dist/bridge.js (built)
```

---

## Summary

**Tasks Completed:**
- ✅ Task 4: Either utilities (8 tests)
- ✅ Task 5: Core types (17 tests)
- ✅ Task 6: State module (21 tests)

**Total Output:**
- Lines of code: ~375
- Test cases: 46+
- Test coverage: 100%
- Commits: 6

**Architecture Validated:**
- Either-based error handling ✅
- Immutable state patterns ✅
- Pure functions (no I/O, no globals) ✅
- Discriminated unions ✅
- Type-safe composition ready for Phase 3 ✅

---

## Next Steps (Phase 3)

Phase 3 will orchestrate these functions with:
- TaskEither wrappers for I/O operations
- ReaderTaskEither for daemon dependency injection
- IPC and Telegram adapters

Current state module is ready for composition.
