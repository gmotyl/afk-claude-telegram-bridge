# TypeScript Rewrite Design

**Date:** 2026-02-26
**Status:** Approved
**Branch:** feature/ts-rewrite

## Problem

The bridge currently requires Python 3 at runtime, which is not guaranteed on macOS 15+, Windows, or many CI environments. Claude Code requires Node.js — making it the only safe guaranteed runtime. Silent failure mode (hook.sh exits 0, nothing bridges) is unacceptable for an AFK tool.

## Goals

- Eliminate Python dependency completely
- Source in TypeScript, compiled + minified to `dist/` (committed)
- `npx github:gmotyl/afk-claude-telegram-bridge-skill` installs via Node
- Husky pre-push hook builds `dist/` automatically
- Pragmatic FP style: pure functions, `Result<T,E>`, immutable state, no classes
- Identical IPC protocol (filesystem JSON) — zero migration for existing users
- All 106 existing Python tests ported 1:1 to Jest

---

## Build & Distribution

| Concern | Choice | Reason |
|---------|--------|--------|
| Build tool | **esbuild** (dev dep) | Bundles + minifies in ~100ms, single output file, handles TS natively |
| Runtime | **Node.js stdlib only** | Zero runtime deps, guaranteed by Claude Code |
| Distribution | Built `dist/*.js` committed to git | `npx` works without install step |
| Git hook | **Husky pre-push** | Auto-builds before every push, dist always in sync |
| File locking | **Atomic rename** | Write `.tmp` → rename; replaces `fcntl.flock`, cross-platform |
| Test runner | **Jest + ts-jest** | Runs TS directly, no compile step for tests |

**`hook.sh` becomes a thin wrapper:**
```bash
echo "$INPUT" | node "$BRIDGE_DIR/dist/hook.js" hook
```
All embedded Python inline scripts are removed. Routing/binding logic moves entirely into TypeScript.

---

## Repository Structure

```
src/
├── types/
│   ├── config.ts        # Config, BotConfig
│   ├── state.ts         # State, Slot (all readonly)
│   ├── events.ts        # IpcEvent union (Activation | Stop | Permission | ...)
│   ├── telegram.ts      # TgMessage, TgUpdate, TgResult<T>
│   └── result.ts        # Result<T,E>, Option<T>, pipe()
│
├── state/
│   ├── load.ts          # loadState, loadConfig
│   ├── save.ts          # saveState, atomicWrite
│   ├── slots.ts         # isSlotActive, findSlotBySession, assignSlot, removeSlot
│   └── cleanup.ts       # cleanupStaleSlots, cleanOrphanedIpc
│
├── ipc/
│   ├── read.ts          # readEvents, scanPosition tracking
│   ├── write.ts         # writeEvent, writeResponse, writeMeta
│   ├── files.ts         # killFile, forceFile, queuedInstruction, deactivationMarker
│   └── bind.ts          # findBoundSession, findUnboundSlots, bindSession
│
├── telegram/
│   ├── client.ts        # request() — single HTTPS function
│   ├── topics.ts        # createTopic, deleteTopic
│   ├── messages.ts      # sendMessage, editMessage, answerCallback, chatAction
│   ├── updates.ts       # getUpdates, parseUpdate
│   └── format.ts        # escapeHtml, formatPermission, formatStop, formatNotification
│
├── bridge/
│   ├── daemon.ts        # run() — main loop, wires everything (only side-effect orchestrator)
│   ├── events.ts        # processEvent() — pure dispatcher
│   ├── activation.ts    # handleActivation, handleDeactivation
│   ├── permissions.ts   # handlePermission, flushBatches, autoApprove
│   ├── messages.ts      # handleMessage, routeMessage
│   ├── callbacks.ts     # handleCallback — all button actions
│   ├── typing.ts        # updateTyping, trackTyping
│   └── stale.ts         # checkStaleEvents, heartbeat
│
└── hook/
    ├── activate.ts      # cmdActivate
    ├── deactivate.ts    # cmdDeactivate
    ├── status.ts        # cmdStatus
    ├── setup.ts         # cmdSetup (interactive)
    └── events.ts        # cmdHook — PermissionRequest / Stop / Notification

dist/                    # Committed compiled output
├── hook.js              # esbuild: src/hook/ → single bundled file
└── bridge.js            # esbuild: src/bridge/daemon.ts → single bundled file
```

### Test Structure (`__tests__` co-located with source)

```
src/__tests__/helpers/
├── mockTelegram.ts      # MockTelegramAPI — captures calls, configurable responses
├── mockFs.ts            # tmp dir helpers, writeIpc, makeSession
└── fixtures.ts          # makeState, makeSlot, makeEvent, makeConfig

src/state/__tests__/
├── load.test.ts
├── save.test.ts
├── slots.test.ts        # T-001–T-008, T-011–T-012
└── cleanup.test.ts      # T-009–T-012

src/ipc/__tests__/
├── read.test.ts         # T-052
├── write.test.ts
├── files.test.ts
└── bind.test.ts         # B-001–B-007

src/telegram/__tests__/
├── client.test.ts
├── topics.test.ts
├── messages.test.ts
├── updates.test.ts
└── format.test.ts       # T-054–T-059

src/bridge/__tests__/
├── events.test.ts       # T-020–T-030
├── activation.test.ts   # T-020–T-022, T-048–T-050
├── permissions.test.ts  # I-001–I-005, I-013
├── messages.test.ts     # T-031–T-035, T-038–T-039
├── callbacks.test.ts    # T-036–T-047
├── typing.test.ts       # I-006–I-008
└── stale.test.ts        # I-009–I-010

src/hook/__tests__/
├── activate.test.ts     # T-013–T-019, T-048
├── deactivate.test.ts   # D-001–D-007
├── status.test.ts
└── events.test.ts       # H-001–H-012
```

---

## FP Architecture

### Core Contracts

```typescript
// types/result.ts
type Result<T, E = Error> =
  | { ok: true;  value: T }
  | { ok: false; error: E }

const ok  = <T>(value: T): Result<T, never> => ({ ok: true, value })
const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
const pipe = <T>(value: T, ...fns: Array<(v: any) => any>) =>
  fns.reduce((v, f) => f(v), value)
```

### Immutable State

```typescript
// types/state.ts
type Slot = Readonly<{
  sessionId: string
  project:   string
  topicName: string
  started:   string
  threadId?: number
}>

type State = Readonly<{
  slots:           Readonly<Record<string, Slot>>
  daemonPid:       number | null
  daemonHeartbeat: number
}>

// Pure state transitions — take State, return new State
const assignSlot  = (state: State, slotNum: string, slot: Slot): State => ({
  ...state, slots: { ...state.slots, [slotNum]: slot }
})
const removeSlot  = (state: State, slotNum: string): State => ({
  ...state,
  slots: Object.fromEntries(Object.entries(state.slots).filter(([k]) => k !== slotNum))
})
```

### Dependency Injection at Boundaries

Pure functions receive their I/O dependencies as arguments — easy to test without patching globals:

```typescript
// bridge/activation.ts
type Deps = {
  tg:       TelegramAPI
  ipcDir:   string
  saveState: (s: State) => void
}

const handleActivation = (event: ActivationEvent, state: State, deps: Deps): State => {
  // pure logic — returns new state
}
```

Only `bridge/daemon.ts` constructs `Deps` with real implementations and runs the loop.

### Key Differences from Python Version

| Concern | Python | TypeScript |
|---------|--------|-----------|
| State locking | `fcntl.flock` (POSIX only) | Atomic rename (cross-platform) |
| Telegram polling | Synchronous urllib blocks | `async/await`, concurrent with IPC scan |
| Error handling | `try/except` throughout | `Result<T,E>` at boundaries |
| Classes | `BridgeDaemon` class | Plain functions + `Deps` record |
| IPC protocol | Same | **Identical** — zero migration |

---

## IPC Protocol Compatibility

The filesystem JSON protocol is **unchanged**:
- `events.jsonl` — append-only event log
- `response-{id}.json` — permission/stop responses
- `meta.json` — session metadata
- `kill` — daemon kill marker
- `force_clear` — force /clear bypass
- `queued_instruction.json` — buffered message
- `bound_session` — session binding
- `deactivation_processed` — handoff marker

Existing sessions survive the upgrade transparently.

---

## Execution Plan

### Phase 1 — Branch + Tooling Setup
1. Rename branch `bugfix/tech-debt-unit-tests` → `feature/ts-rewrite`
2. Add `package.json`, `tsconfig.json`, `jest.config.ts`
3. Install dev deps: `typescript`, `esbuild`, `jest`, `ts-jest`, `@types/node`, `@types/jest`
4. Add `.husky/pre-push` build hook
5. Add `src/__tests__/helpers/` (mockTelegram, mockFs, fixtures)

### Phase 2 — Types + Core Modules + Tests (TDD)
For each module, write tests first then implementation:
6. `types/` — Result, State, Slot, IpcEvent, TgResult
7. `state/` — load, save, slots, cleanup (ports T-001–T-012)
8. `ipc/` — read, write, files, bind (ports B-001–B-011, T-052)
9. `telegram/` — client, format, topics, messages, updates (ports T-054–T-059)

### Phase 3 — Hook + Bridge + Tests (TDD)
10. `hook/` — activate, deactivate, status, events (ports T-013–T-019, D-001–D-007, H-001–H-012)
11. `bridge/` — events, activation, permissions, messages, callbacks, typing, stale (ports T-020–T-053, I-001–I-015)

### Phase 4 — Integration + Cleanup
12. Wire `bridge/daemon.ts` — main loop with real Deps
13. Update `hook.sh` — remove all Python inline scripts, single `node dist/hook.js` call
14. Build `dist/` via esbuild
15. Update `package.json` bin, `install.sh`, `README.md`
16. Remove Python files: `hook.py`, `bridge.py`, `poll.py`, `.venv/`, `pytest.ini`, `tests/*.py`
17. Final test run — all Jest tests green

---

## Success Criteria

- `python3` not referenced anywhere in the repo
- `npm test` → all ported tests green (106+ tests)
- `npx github:gmotyl/afk-claude-telegram-bridge-skill` installs without Python
- `dist/hook.js` and `dist/bridge.js` present and committed
- Existing AFK sessions work without any IPC migration
