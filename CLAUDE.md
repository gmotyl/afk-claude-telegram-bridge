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
Claude Code ←→ hook.sh ←→ hook.js ←→ SQLite (bridge.db) ←→ bridge.js daemon ←→ Telegram API
```

**Three entry points** built by esbuild (`build.mjs`) into self-contained Node.js bundles with shebangs:

| Bundle | Entry | Role |
|--------|-------|------|
| `dist/hook.js` | `src/hook/index.ts` | Claude Code hook handler (PreToolUse, Stop, Notification) |
| `dist/bridge.js` | `src/bridge/daemon.ts` | Long-running daemon: polls IPC events + Telegram |
| `dist/cli.js` | `src/cli/index.ts` | Activate/deactivate commands |

**Layered architecture:**
- `src/core/` — Pure business logic, no I/O. State transformations return `Either<Error, State>`.
- `src/services/` — I/O operations (SQLite IPC, Telegram API, daemon lifecycle).
- `src/hook/`, `src/bridge/`, `src/cli/` — Orchestration layers that compose core + services.

**IPC mechanism:** SQLite database (`bridge.db`) with WAL mode. Hook writes events to `events` table, daemon reads and marks processed. Responses via `responses` table that hooks poll.

**Session isolation:** Multiple concurrent Claude sessions (up to 4 slots). Each session binds via `claude_session_id` column in `sessions` table on first hook event. All subsequent hooks route through that binding.

**Active listening loop (Stop hook):** When Claude finishes, the Stop hook enters a polling loop waiting for Telegram instructions. Daemon delivers instructions via SQLite responses. Loop continues until user clicks "Let it stop".

## Key Patterns

**Functional error handling with fp-ts:** All operations return `Either<Error, T>` (sync) or `TaskEither<Error, T>` (async). Use `pipe()` for composition. No thrown exceptions from business logic.

**Tagged discriminated unions:** Events (`src/types/events.ts`) and errors (`src/types/errors.ts`) use `_tag` field for exhaustive `switch` pattern matching. Smart constructors for all variants.

**Immutable state:** All types use `readonly`. State updates via spread operator. SQLite handles cross-process concurrency via WAL mode.

## TypeScript Config

Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` enabled. Target ES2022/CommonJS. Path alias `@/` maps to `src/`.

## Testing

Tests live in `__tests__/` directories adjacent to source. Uses `ts-jest` preset. Tests create isolated temp directories (`os.tmpdir()`) in `beforeEach` and clean up in `afterEach`. Test helpers in `src/__tests__/helpers/` provide fixtures, mock filesystem, and mock Telegram responses.

## Runtime Files

Installed to `~/.claude/hooks/telegram-bridge/`:
- `bridge.db` — SQLite database (sessions, events, responses, pending_stops, known_topics)
- `config.json` — Bot token, group ID, timeouts
- `daemon.pid` — Running daemon PID
- `daemon.heartbeat` — Daemon heartbeat timestamp
- `daemon.log` — Daemon debug logs
- `ipc/{sessionId}/` — Signal files (kill, force_clear)

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **afk-claude-telegram-bridge** (272 symbols, 700 relationships, 20 execution flows).

## Always Start Here

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
