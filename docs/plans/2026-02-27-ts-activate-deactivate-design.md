# Design: TypeScript Activate/Deactivate Commands

Replace Python `hook.py` activate/deactivate with pure TypeScript, eliminating the Python runtime dependency.

## Problem

`hook.sh --activate` and `--deactivate` fall through to `hook.js` which only handles runtime hook events (permission_request, stop, notification). The Python `hook.py` has full activate/deactivate logic but we want zero Python dependency.

## Architecture

New `src/cli/` module as a third entry point alongside hook and bridge:

```
src/cli/index.ts       → dist/cli.js   (CLI commands: activate, deactivate, status)
src/hook/index.ts      → dist/hook.js  (runtime hooks: permission, stop, notification)
src/bridge/daemon.ts   → dist/bridge.js (background daemon)
```

All three built and installed by `npm run deploy`.

## Type Changes

### `src/types/state.ts` — Extend Slot

```typescript
export interface Slot {
  readonly sessionId: string       // UUID for IPC directory naming
  readonly projectName: string
  readonly topicName: string       // Telegram topic name
  readonly threadId?: number       // Telegram thread ID (set by daemon)
  readonly activatedAt: Date
  readonly lastHeartbeat: Date
}
```

### `src/types/errors.ts` — New error variants

- `CliError` — activate/deactivate failures
- `LockError` — file lock acquisition failures
- `DaemonSpawnError` / `DaemonStopError` — daemon lifecycle failures

## Core State Changes

### `src/core/state/index.ts` — New pure functions

- `findAvailableSlot(state): number | null` — first undefined slot (1-4)
- `findSlotBySessionId(state, sessionId): [number, Slot] | null`
- `findSlotByTopicName(state, topicName): [number, Slot] | null` — for reattachment

## Services Layer

### `src/services/daemon-launcher.ts`

- `startDaemon(bridgePath, logPath): TaskEither<DaemonSpawnError, number>` — spawn detached, return PID
- `stopDaemon(pid): TaskEither<DaemonStopError, void>` — SIGTERM
- `isDaemonAlive(pid): boolean` — process.kill(pid, 0)

### `src/services/file-lock.ts`

- `withStateLock<A>(statePath, fn: () => Promise<A>): TaskEither<LockError, A>` — proper-lockfile mutex

### `src/services/ipc.ts` — Extensions

- `createIpcDir(baseDir, sessionId): TaskEither<IpcError, string>` — mkdir ipc/{sessionId}
- `removeIpcDir(baseDir, sessionId): TaskEither<IpcError, void>` — rm -rf
- `writeMetaFile(ipcDir, meta): TaskEither<IpcError, void>` — writes meta.json
- `cleanOrphanedIpcDirs(baseDir, activeSessionIds): TaskEither<IpcError, void>`

## CLI Module

### `src/cli/activate.ts`

```
activate(configPath, sessionId, project, topicName) → TaskEither<CliError, ActivateResult>
```

Inside withStateLock:
1. Load config + state
2. Cleanup stale slots
3. Check reattachment (findSlotByTopicName → capture threadId, remove old slot/IPC)
4. Find available slot (prefer reused slot number)
5. Build Slot, addSlot to state, save state
6. Create IPC dir + meta.json
7. Write SessionStart event
8. Start daemon if not alive
9. Print confirmation

### `src/cli/deactivate.ts`

```
deactivate(configPath, sessionId) → TaskEither<CliError, void>
```

Inside withStateLock:
1. Load config + state
2. Find slot by sessionId (or first active)
3. Write SessionEnd event
4. Remove slot, save state
5. Clean IPC dir
6. Stop daemon if no slots remain
7. Print confirmation

### `src/cli/index.ts`

CLI dispatcher — parses argv, delegates to activate/deactivate, handles errors with process.exit.

## Build + Install Changes

### `build.mjs`

Third entry point: `src/cli/index.ts → dist/cli.js` (with shebang).

### `scripts/hook-wrapper.sh`

```bash
--activate)  shift; exec node "$CONFIG_DIR/cli.js" activate "$@" ;;
--deactivate) shift; exec node "$CONFIG_DIR/cli.js" deactivate "$@" ;;
```

### `install.sh`

- Copy `dist/cli.js` alongside hook.js and bridge.js
- Remove old Python files (hook.py, bridge.py, poll.py)
- No more Python files copied

### `package.json`

- Add `proper-lockfile` to dependencies (bundled by esbuild)
- Add `@types/proper-lockfile` to devDependencies

## One-command install

`npm run deploy` builds all three bundles and installs everything. Zero Python dependency.
