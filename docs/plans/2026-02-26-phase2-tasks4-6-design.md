# Design: Phase 2 Tasks 4-6 — Types Layer & Pure State Module

**Date:** 2026-02-26
**Branch:** `feature/ts-rewrite`
**Repo:** `git/prv/afk-claude-telegram-bridge`
**Phase:** Phase 2 of 5
**Status:** Design Approved

---

## Overview

Tasks 4-6 build the types layer and pure state module:

- **Task 4:** Either utilities module (thin wrapper)
- **Task 5:** Core domain types (Config, State, Events, Telegram)
- **Task 6:** State module with pure functions (business logic)

All use **Either-based error handling** and **immutable state** patterns.

---

## Architecture Decisions

### 1. Either Over Custom Result Type

**Decision:** Use fp-ts `Either` directly instead of custom Result type.

**Rationale:**
- Proven library, zero reimplementation
- Integrates with TaskEither, Validation, Reader (Phase 3-5)
- Pragmatic-functional-programming rule: don't overengineer
- Discriminated unions already built-in

**Task 4 provides thin utilities:**
```typescript
export const ok = E.right
export const err = E.left
export const isOk = E.isRight
export const isErr = E.isLeft
```

### 2. Immutable State via Spread Operator

**Decision:** State updates use spread operator (readonly records).

**Rationale:**
- Simple, no external libraries
- Easy to trace mutations (they're explicit in code)
- TypeScript's `readonly` enforces immutability at compile time
- Performant for small structures (4 slots max)

**Example:**
```typescript
export const addSlot = (
  state: State,
  slotNum: number,
  slot: Slot
): E.Either<StateError, State> => {
  if (state.slots[slotNum] !== undefined) {
    return E.left({ _tag: 'SlotAlreadyActive', slotNum })
  }
  return E.right({
    slots: {
      ...state.slots,
      [slotNum]: slot
    }
  })
}
```

### 3. Pure Functions Accept Time as Parameter

**Decision:** No `new Date()` inside state functions. Time is injected.

**Rationale:**
- Fully deterministic (testable without mocks)
- Same inputs = same outputs always
- Type system documents dependency: `now: Date` parameter
- Example: `isSlotActive(slot, timeoutMs, now): boolean`

---

## Task 4: Either Utilities Module

### Scope

Thin wrapper around fp-ts Either with domain-specific helpers.

### Design

**File:** `src/types/either.ts` (20 lines)

```typescript
import * as E from 'fp-ts/Either'
import { pipe } from 'fp-ts/function'

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
export { pipe } from 'fp-ts/function'
```

### Testing

**File:** `src/types/__tests__/either.test.ts` (40 lines)

Test cases:
- `ok()` creates Right value
- `err()` creates Left value
- `isOk()` detects Right correctly
- `isErr()` detects Left correctly
- `fold()` handles both cases
- `mapError()` transforms error
- `unwrapOr()` provides default

### Metrics

- Lines of code: ~60
- Test coverage: 100%
- Dependencies: fp-ts only
- Status: ✅ Foundational

---

## Task 5: Core Domain Types

### Scope

Four type modules that define the system's data layer:

#### 5a. `src/types/config.ts` — Configuration (15 lines)

```typescript
export interface Config {
  readonly telegramBotToken: string
  readonly telegramGroupId: number
  readonly ipcBaseDir: string
  readonly sessionTimeout: number // milliseconds
}
```

**Why separate:** Configuration is a cross-cutting concern. Loaded once at startup (effect boundary), then used immutably throughout.

**Testing:** Verify interface structure and immutability.

---

#### 5b. `src/types/state.ts` — State & Slots (20 lines)

```typescript
export interface Slot {
  readonly projectName: string
  readonly activatedAt: Date
  readonly lastHeartbeat: Date // for timeout detection
}

export interface State {
  readonly slots: Readonly<Record<number, Slot | undefined>>
}

export const initialState: State = {
  slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined }
}
```

**Key design:**
- 4 slots exactly (S1-S4 for Claude bridge)
- Each slot is optional (can be undefined)
- `lastHeartbeat` for timeout tracking
- Minimal: only what's needed for session lifecycle

**Immutability:** Record uses `readonly` at both levels.

**Testing:**
- Verify initial state structure
- Test immutability violations (TypeScript errors)
- Verify slot access patterns

---

#### 5c. `src/types/events.ts` — IPC Events (35 lines)

```typescript
export type IpcEvent =
  | { _tag: 'SessionStart'; slotNum: number; projectName: string }
  | { _tag: 'SessionEnd'; slotNum: number }
  | { _tag: 'Heartbeat'; slotNum: number }
  | { _tag: 'Message'; text: string; slotNum: number }

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

**Why discriminated unions:** Type-safe pattern matching with exhaustiveness checking.

**Filesystem format:** JSONL (one event per line for streaming reads).

**Testing:**
- Verify each constructor creates correct shape
- Test discriminated union exhaustiveness
- Verify JSON round-trip (parse/stringify)

---

#### 5d. `src/types/telegram.ts` — Telegram Types (25 lines)

```typescript
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

// Helper: Generate topic name from slot
export const topicName = (slotNum: number, projectName: string): string =>
  `S${slotNum} - ${projectName}`
```

**Why separate:** Decouples from bot client implementation. Makes mocking/testing easier.

**Testing:**
- Verify topicName generates correct format
- Test immutability

### Task 5 Metrics

- Lines of code: ~95
- Files: 4 type files + 4 test files
- Test coverage: 100%
- Dependencies: None (pure types)

---

## Task 6: State Module (Pure Functions)

### Scope

Core business logic as pure functions. No I/O, no side effects, no time globals.

### Design

**File:** `src/core/state/index.ts` (100 lines)

#### Function: `isSlotActive`

```typescript
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

**Purpose:** Determine if a slot has exceeded timeout.

**Pure:** All inputs explicit, no global state.

**Testability:** Pass fixed dates, verify timeout logic.

---

#### Function: `addSlot`

```typescript
export type StateError =
  | { _tag: 'SlotAlreadyActive'; slotNum: number }
  | { _tag: 'InvalidSlotNumber'; slotNum: number }

export const addSlot = (
  state: State,
  slotNum: number,
  slot: Slot
): E.Either<StateError, State> => {
  if (slotNum < 1 || slotNum > 4) {
    return E.left({ _tag: 'InvalidSlotNumber', slotNum })
  }
  if (state.slots[slotNum] !== undefined) {
    return E.left({ _tag: 'SlotAlreadyActive', slotNum })
  }
  return E.right({
    slots: { ...state.slots, [slotNum]: slot }
  })
}
```

**Purpose:** Activate a new session slot.

**Validation:** Slot number 1-4 only. Reject duplicates.

**Returns:** Either<StateError, State> for composability.

---

#### Function: `removeSlot`

```typescript
export const removeSlot = (state: State, slotNum: number): State => ({
  slots: { ...state.slots, [slotNum]: undefined }
})
```

**Purpose:** Deactivate a session slot.

**Note:** Always succeeds (idempotent). Removing non-existent slot = same state.

---

#### Function: `heartbeatSlot`

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
      [slotNum]: { ...slot, lastHeartbeat: now }
    }
  })
}
```

**Purpose:** Update heartbeat timestamp (prevent timeout).

**Validation:** Slot must exist.

---

#### Function: `cleanupStaleSlots`

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

**Purpose:** Remove all slots that have timed out.

**Pure:** Entirely deterministic based on timeout and current time.

---

### Testing Strategy

**File:** `src/core/state/__tests__/index.test.ts` (120 lines)

Test structure:

```typescript
describe('isSlotActive', () => {
  it('returns true if slot within timeout', () => {
    const now = new Date('2024-01-01T12:00:00Z')
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }
    expect(isSlotActive(slot, 5 * 60 * 1000, now)).toBe(true)
  })

  it('returns false if slot timed out', () => {
    const now = new Date('2024-01-01T12:00:00Z')
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: new Date('2024-01-01T11:54:00Z') // 6 min ago
    }
    expect(isSlotActive(slot, 5 * 60 * 1000, now)).toBe(false)
  })

  it('returns false if slot is undefined', () => {
    expect(isSlotActive(undefined, 5 * 60 * 1000, new Date())).toBe(false)
  })
})

describe('addSlot', () => {
  it('succeeds with valid slot', () => {
    const state = initialState
    const slot: Slot = { projectName: 'metro', activatedAt: now, lastHeartbeat: now }
    const result = addSlot(state, 1, slot)
    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.slots[1]).toEqual(slot)
    }
  })

  it('fails if slot already active', () => {
    const state: State = {
      slots: { 1: { projectName: 'metro', activatedAt: now, lastHeartbeat: now }, ... }
    }
    const result = addSlot(state, 1, { ... })
    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe('SlotAlreadyActive')
    }
  })

  it('fails if invalid slot number', () => {
    const result = addSlot(initialState, 5, { ... })
    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe('InvalidSlotNumber')
    }
  })
})

describe('removeSlot', () => {
  it('removes slot from state', () => {
    // Create state with slot, remove it, verify undefined
  })

  it('is idempotent (removing twice = same state)', () => {
    // Remove non-existent slot, verify state unchanged
  })
})

describe('heartbeatSlot', () => {
  it('updates lastHeartbeat', () => {
    // Create state, heartbeat, verify timestamp updated
  })

  it('fails if slot does not exist', () => {
    // Attempt heartbeat on undefined slot, verify error
  })
})

describe('cleanupStaleSlots', () => {
  it('removes only timed-out slots', () => {
    // Create state with mixed active/stale slots
    // Clean and verify only active slots remain
  })

  it('is idempotent (cleanup twice = same state)', () => {
    // Clean once, clean again, verify state unchanged
  })
})
```

### Task 6 Metrics

- Lines of code: ~220 (functions + tests)
- Test cases: 12+
- Test coverage: 100%
- Dependencies: fp-ts (Either)

---

## Integration with Phase 3 (Preview)

These pure functions will be orchestrated by the daemon:

```typescript
// Phase 3: Bridge Daemon
const handleHeartbeat = (state: State, slotNum: number, now: Date): State =>
  pipe(
    heartbeatSlot(state, slotNum, now),
    E.fold(
      (error) => logStateError(error),
      (newState) => newState
    )
  )

const handleTimeout = (state: State, timeoutMs: number, now: Date): State =>
  cleanupStaleSlots(state, timeoutMs, now)
```

---

## Files to Create

```
afk-claude-telegram-bridge/
├── src/
│   ├── types/
│   │   ├── either.ts (20 lines) [NEW]
│   │   ├── config.ts (15 lines) [NEW]
│   │   ├── state.ts (20 lines) [NEW]
│   │   ├── events.ts (35 lines) [NEW]
│   │   ├── telegram.ts (25 lines) [NEW]
│   │   └── __tests__/
│   │       ├── either.test.ts (40 lines) [NEW]
│   │       ├── config.test.ts (20 lines) [NEW]
│   │       ├── state.test.ts (25 lines) [NEW]
│   │       ├── events.test.ts (30 lines) [NEW]
│   │       └── telegram.test.ts (20 lines) [NEW]
│   └── core/
│       └── state/
│           ├── index.ts (100 lines) [NEW]
│           └── __tests__/
│               └── index.test.ts (120 lines) [NEW]
└── docs/
    └── plans/
        └── 2026-02-26-phase2-tasks4-6-design.md [THIS FILE]
```

---

## Implementation Strategy

### TDD Approach

1. **Task 4:** Write tests first (error cases), implement Either utilities
2. **Task 5:** Write type tests (immutability, structure), implement types
3. **Task 6:** Write state function tests (pure logic), implement functions

### Testing Commands

```bash
# During Task 4
npm test -- either

# During Task 5
npm test -- types

# During Task 6
npm test -- state

# All together
npm test
npm run typecheck
npm run build
```

### Commit Strategy

- Task 4: `feat: add Either utilities module`
- Task 5: `feat: add core domain types (Config, State, Events, Telegram)`
- Task 6: `feat: add pure state module with immutable functions`

---

## Metrics Summary

| Task | Files | LoC | Tests | Complexity |
|------|-------|-----|-------|-----------|
| 4 | 2 | 60 | 7 | 🟢 Low |
| 5 | 8 | 95 | 35+ | 🟢 Low |
| 6 | 2 | 220 | 12+ | 🟡 Medium |
| **Total** | **12** | **~375** | **50+** | — |

---

## Acceptance Criteria

✅ Task 4:
- [ ] Either utilities module created
- [ ] All helpers tested
- [ ] Build succeeds
- [ ] 100% test coverage

✅ Task 5:
- [ ] All 4 type modules created
- [ ] All tests passing
- [ ] Immutability enforced
- [ ] 100% test coverage

✅ Task 6:
- [ ] All 5 state functions implemented
- [ ] All tests passing
- [ ] Pure (no I/O, no globals)
- [ ] Functions composable with Either
- [ ] 100% test coverage

---

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| Type errors in complex immutability | Use `readonly` keyword, TypeScript strict mode |
| State mutation bugs | All tests verify immutability, no mutations in code |
| Either composition unfamiliar | Tests show patterns, Phase 3 uses them extensively |
| Timeout logic edge cases | Test with fixed dates, verify boundary conditions |

---

## How to Resume

```bash
cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge

# Check current state
git status
npm test

# Start with Task 4
# See implementation plan for step-by-step tasks
```

---

**Status:** ✅ Design Approved
**Next:** Invoke `writing-plans` skill to create implementation plan
