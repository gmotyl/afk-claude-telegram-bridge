# node:sqlite Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `better-sqlite3` (native C++ addon) with Node.js built-in `node:sqlite` to eliminate version-dependent build failures across users.

**Architecture:** All DB access is centralized in `src/services/db.ts` (open/close/get) and `src/services/db-queries.ts` (~30 query functions). The API is nearly identical: both use synchronous `prepare/run/get/all`. The swap is mechanical in the core, plus shell script cleanup to remove `NODE_PATH` and add a marker file gate.

**Tech Stack:** `node:sqlite` (built-in since Node 22.5+), fp-ts, esbuild

**Design doc:** `docs/plans/2026-03-12-node-sqlite-migration-design.md`

---

## Task 1: Core DB Layer — Swap Driver

**Files:**
- Modify: `src/services/db.ts`
- Test: `src/services/__tests__/db.test.ts`

**Step 1: Update db.ts imports and constructor**

Replace the entire file. Key changes:
- `import Database from 'better-sqlite3'` → `import { DatabaseSync } from 'node:sqlite'`
- `new Database(path)` → `new DatabaseSync(path)`
- `instance.pragma('journal_mode = WAL')` → `instance.exec('PRAGMA journal_mode = WAL')`
- `instance.pragma('busy_timeout = 5000')` → constructor option `timeout: 5000`
- `instance.pragma('foreign_keys = ON')` → constructor option `enableForeignKeyConstraints: true`
- `instance.pragma('user_version', { simple: true })` → `instance.prepare('PRAGMA user_version').get()`
- `instance.pragma('user_version = N')` → `instance.exec('PRAGMA user_version = N')`
- Type: `Database.Database` → `DatabaseSync`

```typescript
import { DatabaseSync } from 'node:sqlite'
import * as E from 'fp-ts/Either'
import { DbError, connectionError } from '../types/db'

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
// ... same schema SQL, unchanged ...
`

let db: DatabaseSync | null = null

export const openDatabase = (dbPath: string): E.Either<DbError, DatabaseSync> => {
  try {
    if (db) {
      db.close()
      db = null
    }
    const instance = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    })
    instance.exec('PRAGMA journal_mode = WAL')

    const row = instance.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    const version = row?.user_version ?? 0
    if (version < SCHEMA_VERSION) {
      instance.exec(SCHEMA_SQL)
      instance.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }

    db = instance
    return E.right(instance)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}

export const closeDatabase = (): E.Either<DbError, void> => {
  try {
    if (db) {
      db.close()
      db = null
    }
    return E.right(undefined)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}

export const getDatabase = (): E.Either<DbError, DatabaseSync> =>
  db ? E.right(db) : E.left(connectionError('Database not opened'))

export const openMemoryDatabase = (): E.Either<DbError, DatabaseSync> => {
  try {
    if (db) {
      db.close()
      db = null
    }
    const instance = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: true,
    })
    instance.exec(SCHEMA_SQL)
    instance.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db = instance
    return E.right(instance)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}
```

**Step 2: Update db.test.ts**

The test file imports `Database from 'better-sqlite3'` directly for verification queries. Replace with `DatabaseSync from 'node:sqlite'`. Also update pragma assertions:

- `db.pragma('journal_mode')` → `db.prepare('PRAGMA journal_mode').get()`
- Assertions on pragma results may return `{ journal_mode: 'wal' }` object instead of string

Run: `cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge && npx jest src/services/__tests__/db.test.ts --verbose`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/services/db.ts src/services/__tests__/db.test.ts
git commit -m "refactor: replace better-sqlite3 with node:sqlite in db layer"
```

---

## Task 2: Query Layer — Update Type References

**Files:**
- Modify: `src/services/db-queries.ts`
- Modify: `src/services/__tests__/db-queries.test.ts`

**Step 1: Update db-queries.ts import**

Line 1: `import Database from 'better-sqlite3'` → `import { DatabaseSync } from 'node:sqlite'`

Then find-and-replace all occurrences of `Database.Database` with `DatabaseSync` in function parameters. There are ~30 functions with signature `(db: Database.Database, ...) => ...`.

Also check if `better-sqlite3` `Statement` type is used anywhere — replace with the node:sqlite equivalent if needed.

**Step 2: Update db-queries.test.ts**

Line 2: `import Database from 'better-sqlite3'` → `import { DatabaseSync } from 'node:sqlite'` (if directly imported)

Run: `npx jest src/services/__tests__/db-queries.test.ts --verbose`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/services/db-queries.ts src/services/__tests__/db-queries.test.ts
git commit -m "refactor: update db-queries types from better-sqlite3 to node:sqlite"
```

---

## Task 3: Service Layer — Update Remaining Imports

**Files:**
- Modify: `src/services/ipc-sqlite.ts`
- Modify: `src/services/state-persistence-sqlite.ts`
- Modify: `src/services/session-binding-sqlite.ts`
- Modify: `src/services/queued-instruction-sqlite.ts`
- Modify: Any file that imports `Database` type from `better-sqlite3`

**Step 1: Search and replace**

In each file, check if they import `Database from 'better-sqlite3'` for types. If so, replace with `import { DatabaseSync } from 'node:sqlite'` and update parameter types.

Most of these files likely only import from `./db` and `./db-queries`, not directly from `better-sqlite3`. Verify each file.

**Step 2: Run all service tests**

```bash
npx jest src/services/__tests__/ --verbose
```
Expected: All pass

**Step 3: Commit**

```bash
git add src/services/
git commit -m "refactor: update service layer types to node:sqlite"
```

---

## Task 4: Entry Points — Update daemon, hook, cli

**Files:**
- Modify: `src/bridge/daemon.ts` (if it imports Database type directly)
- Modify: `src/hook/index.ts` (if it imports Database type directly)
- Modify: `src/cli/activate.ts` (if it imports Database type directly)
- Modify: `src/cli/deactivate.ts` (if it imports Database type directly)

**Step 1: Check each file for direct better-sqlite3 imports**

These files primarily use `openDatabase`, `closeDatabase`, `getDatabase` from `./services/db`. They may not import `better-sqlite3` directly. Verify and fix any that do.

**Step 2: Run full test suite**

```bash
npx jest --verbose
```
Expected: All tests pass — the entire TypeScript codebase is now on node:sqlite

**Step 3: Commit**

```bash
git add src/
git commit -m "refactor: update entry points to node:sqlite"
```

---

## Task 5: Marker File Gate

**Files:**
- Modify: `src/cli/activate.ts`
- Modify: `src/cli/deactivate.ts`
- Create: `src/services/marker.ts`

**Step 1: Create marker.ts**

Simple module to read/write the `active_count` marker file:

```typescript
import * as fs from 'fs'
import * as path from 'path'

const MARKER_FILE = 'active_count'

export const readActiveCount = (configDir: string): number => {
  try {
    const content = fs.readFileSync(path.join(configDir, MARKER_FILE), 'utf-8').trim()
    const n = parseInt(content, 10)
    return isNaN(n) ? 0 : n
  } catch {
    return 0
  }
}

export const writeActiveCount = (configDir: string, count: number): void => {
  const filePath = path.join(configDir, MARKER_FILE)
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, String(Math.max(0, count)), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

export const incrementActiveCount = (configDir: string): void => {
  writeActiveCount(configDir, readActiveCount(configDir) + 1)
}

export const decrementActiveCount = (configDir: string): void => {
  writeActiveCount(configDir, readActiveCount(configDir) - 1)
}
```

**Step 2: Update activate.ts**

After successful session insertion (after the `insertSession` call succeeds), add:

```typescript
import { incrementActiveCount } from '../services/marker'
// ... after session created successfully:
incrementActiveCount(configDir)
```

**Step 3: Update deactivate.ts**

After successful session deletion, add:

```typescript
import { decrementActiveCount } from '../services/marker'
// ... after session deleted successfully:
decrementActiveCount(configDir)
```

**Step 4: Run activate/deactivate tests**

```bash
npx jest src/cli/ --verbose
```

**Step 5: Commit**

```bash
git add src/services/marker.ts src/cli/activate.ts src/cli/deactivate.ts
git commit -m "feat: add active_count marker file for pure-bash gate check"
```

---

## Task 6: Update hook.sh — Marker File Gate + Remove NODE_PATH

**Files:**
- Modify: `hook.sh` (installed version at `~/.claude/hooks/telegram-bridge/hook.sh`)
- Modify: `scripts/hook-wrapper.sh` (source version)

**Step 1: Replace the gate check (lines 25-33)**

Replace the node+better-sqlite3 gate with the marker file check:

```bash
# Fast gate: marker file (no node needed)
if [ -f "$CONFIG_DIR/active_count" ] && [ "$(cat "$CONFIG_DIR/active_count" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
  if [ -f "$CONFIG_DIR/daemon.pid" ]; then
    _PID=$(cat "$CONFIG_DIR/daemon.pid" 2>/dev/null)
    if [ -n "$_PID" ] && kill -0 "$_PID" 2>/dev/null; then
      export AFK_ACTIVE=1
    elif [ -f "$CONFIG_DIR/daemon.heartbeat" ]; then
      _HB=$(cat "$CONFIG_DIR/daemon.heartbeat" 2>/dev/null)
      _NOW=$(date +%s)
      # Heartbeat is in epoch milliseconds; convert to seconds
      if [ $((_NOW - ${_HB:-0} / 1000)) -lt 900 ]; then
        export AFK_ACTIVE=1
      else
        echo "0" > "$CONFIG_DIR/active_count"  # Reset stale marker
      fi
    fi
  else
    export AFK_ACTIVE=1  # No PID file but marker says active — let hook.js decide
  fi
fi
```

**Step 2: Remove all NODE_PATH references**

- Remove `export NODE_PATH="$CONFIG_DIR/node_modules"` (line 168 and any others)
- In `--status` command: replace the node+better-sqlite3 inline script with a simpler check using the marker file + `node cli.js status` (or keep a simple node -e using node:sqlite)
- In `--reset` command: replace the node+better-sqlite3 inline scripts for reading thread IDs. Use `node -e 'const { DatabaseSync } = require("node:sqlite"); ...'`

**Step 3: Test manually**

```bash
# Verify gate check works
echo "1" > ~/.claude/hooks/telegram-bridge/active_count
bash ~/.claude/hooks/telegram-bridge/hook.sh --status

# Verify reset still works
bash ~/.claude/hooks/telegram-bridge/hook.sh --reset
```

**Step 4: Commit**

```bash
git add hook.sh scripts/hook-wrapper.sh
git commit -m "refactor: hook.sh uses marker file gate, remove NODE_PATH"
```

---

## Task 7: Build & Package Cleanup

**Files:**
- Modify: `package.json`
- Modify: `build.mjs`
- Modify: `install.sh`

**Step 1: Update package.json**

Remove from dependencies:
```json
"better-sqlite3": "^12.6.2"
```

Remove from devDependencies:
```json
"@types/better-sqlite3": "^7.6.13"
```

**Step 2: Update build.mjs**

Remove `'better-sqlite3'` from the `external` array. Since `node:sqlite` is a built-in module, esbuild handles it automatically (or add `'node:sqlite'` to external if esbuild doesn't recognize built-in protocol).

**Step 3: Update install.sh**

- Remove the entire "Install native dependency" section (lines 67-83 that symlink/install better-sqlite3)
- Remove any `node_modules` directory creation
- Add Node version check at the top:

```bash
# Check Node.js version (>= 22.5.0 required for node:sqlite)
NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
if [ -z "$NODE_VERSION" ]; then
  echo "ERROR: Node.js is required. Install Node.js >= 22.5.0" >&2
  exit 1
fi
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "ERROR: Node.js >= 22.5.0 required (found v${NODE_VERSION}). node:sqlite is not available in older versions." >&2
  exit 1
fi
echo "Node.js v${NODE_VERSION} ✓"
```

**Step 4: Run build**

```bash
cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge
npm run build
```
Expected: Build succeeds without errors

**Step 5: Commit**

```bash
git add package.json build.mjs install.sh
git commit -m "chore: remove better-sqlite3 dependency, add Node 22.5+ check"
```

---

## Task 8: Full Validation

**Step 1: Clean install and test**

```bash
cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge
rm -rf node_modules
npm install
npx jest --verbose
```
Expected: All tests pass without better-sqlite3 installed

**Step 2: Build and deploy**

```bash
npm run build
bash install.sh
```
Expected: Install succeeds, no native module errors

**Step 3: End-to-end test**

```bash
# Activate
~/.claude/hooks/telegram-bridge/hook.sh --activate test-session test-project test-topic
# Check marker
cat ~/.claude/hooks/telegram-bridge/active_count  # Should show "1"
# Check status
~/.claude/hooks/telegram-bridge/hook.sh --status
# Deactivate
~/.claude/hooks/telegram-bridge/hook.sh --deactivate test-session
# Check marker
cat ~/.claude/hooks/telegram-bridge/active_count  # Should show "0"
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "test: validate node:sqlite migration end-to-end"
```

---

## Task Summary

| Task | Description | Estimated Steps |
|------|-------------|-----------------|
| 1 | Core DB layer — swap driver | 3 |
| 2 | Query layer — update types | 3 |
| 3 | Service layer — update imports | 3 |
| 4 | Entry points — update daemon/hook/cli | 3 |
| 5 | Marker file gate — new module + cli integration | 5 |
| 6 | hook.sh — marker gate + remove NODE_PATH | 4 |
| 7 | Build & package cleanup | 5 |
| 8 | Full validation | 4 |

**Total: 8 tasks, ~30 steps**

## Notes for Implementer

- `node:sqlite` uses `DatabaseSync` not `Database` — the class name is different
- Constructor option `readOnly` (camelCase) not `readonly` (lowercase)
- Pragmas are not methods — use `db.exec('PRAGMA ...')` or `db.prepare('PRAGMA ...').get()`
- `node:sqlite` is CommonJS-compatible via `require('node:sqlite')` — our tsconfig uses CommonJS
- The `timeout` constructor option replaces `busy_timeout` pragma
- `enableForeignKeyConstraints` constructor option replaces `PRAGMA foreign_keys = ON`
- Tests use `openMemoryDatabase()` — this works identically with `new DatabaseSync(':memory:')`
- esbuild may need `'node:sqlite'` in `external` array since it's a `node:` protocol import
