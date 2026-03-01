# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AFK Claude Telegram Bridge — remote-control Claude Code from Telegram when away from keyboard. Enables permission approvals, instruction delivery, and multi-session active listening via a daemon-based architecture.

## Commands

```bash
npm run build          # esbuild bundles: dist/hook.js, dist/bridge.js, dist/cli.js
npm test               # Jest test suite
npm run test:watch     # Jest watch mode
npm run typecheck      # tsc --noEmit
npm run deploy         # Build + install to ~/.claude/hooks/telegram-bridge/

# Run a single test file:
npx jest src/hook/__tests__/args.test.ts

# Run tests matching a pattern:
npx jest --testPathPattern="permission"
```

## Architecture

```
Claude Code ←→ hook.sh ←→ hook.js ←→ IPC (filesystem) ←→ bridge.js daemon ←→ Telegram API
```

**Three entry points** built by esbuild (`build.mjs`) into self-contained Node.js bundles with shebangs:

| Bundle | Entry | Role |
|--------|-------|------|
| `dist/hook.js` | `src/hook/index.ts` | Claude Code hook handler (PreToolUse, Stop, Notification) |
| `dist/bridge.js` | `src/bridge/daemon.ts` | Long-running daemon: polls IPC events + Telegram |
| `dist/cli.js` | `src/cli/index.ts` | Activate/deactivate commands |

**Layered architecture:**
- `src/core/` — Pure business logic, no I/O. State transformations return `Either<Error, State>`.
- `src/services/` — I/O operations (filesystem IPC, Telegram API, file locking, daemon lifecycle).
- `src/hook/`, `src/bridge/`, `src/cli/` — Orchestration layers that compose core + services.

**IPC mechanism:** File-based JSONL event queue (`ipc/{sessionId}/events.jsonl`). Hook writes events, daemon reads them. Async responses via `response-{eventId}.json` files that hooks poll for.

**Session isolation:** Multiple concurrent Claude sessions (up to 4 slots). Each session binds to an IPC directory via `bound_session` file on first hook event. All subsequent hooks route through that binding.

**Active listening loop (Stop hook):** When Claude finishes, the Stop hook enters a polling loop waiting for Telegram instructions. Daemon delivers instructions via response files. Loop continues until user clicks "Let it stop".

## Key Patterns

**Functional error handling with fp-ts:** All operations return `Either<Error, T>` (sync) or `TaskEither<Error, T>` (async). Use `pipe()` for composition. No thrown exceptions from business logic.

**Tagged discriminated unions:** Events (`src/types/events.ts`) and errors (`src/types/errors.ts`) use `_tag` field for exhaustive `switch` pattern matching. Smart constructors for all variants.

**Immutable state:** All types use `readonly`. State updates via spread operator. State file protected by `proper-lockfile` for cross-process safety.

## TypeScript Config

Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` enabled. Target ES2022/CommonJS. Path alias `@/` maps to `src/`.

## Testing

Tests live in `__tests__/` directories adjacent to source. Uses `ts-jest` preset. Tests create isolated temp directories (`os.tmpdir()`) in `beforeEach` and clean up in `afterEach`. Test helpers in `src/__tests__/helpers/` provide fixtures, mock filesystem, and mock Telegram responses.

## Runtime Files

Installed to `~/.claude/hooks/telegram-bridge/`:
- `state.json` — Slot allocations and pending stops (lockfile-protected)
- `config.json` — Bot token, group ID, timeouts
- `ipc/{sessionId}/` — Per-session event queues and response files
- `daemon.log` / `hook-debug.log` — Debug logs
