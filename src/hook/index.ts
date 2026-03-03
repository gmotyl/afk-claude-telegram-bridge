#!/usr/bin/env node

/**
 * @module hook/index
 * Claude Code AFK Hook - Main Entry Point
 *
 * Orchestrates hook execution:
 * 1. Parse command-line arguments (or stdin JSON)
 * 2. Load configuration
 * 3. Resolve correct session via binding (multi-session isolation)
 * 4. Process hook based on type
 * 5. Return appropriate exit codes
 *
 * Session isolation:
 * - Claude Code sends session_id in stdin JSON for each hook call
 * - findBoundSession() looks up which AFK IPC dir is bound to that session
 * - If no binding exists, findUnboundSession() + bindSession() creates one
 * - All IPC operations use the resolved session, not env vars
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as path from 'path'
import { parseHookArgs, parseStdinInput, type HookArgs } from './args'
import { requestPermission, type PermissionResponse } from './permission'
import { handleStopRequest, type StopDecision } from './stop'
import { loadConfig } from '../core/config'
import { Config } from '../types/config'
import { loadState } from '../services/state-persistence'
import { findBoundSession, findUnboundSession, bindSession } from '../services/session-binding'
import { ensureDaemonAlive } from '../services/daemon-health'
import { openDatabase, closeDatabase } from '../services/db'
import { type HookError, hookError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

type ExitCode = number

/** Resolved session info for IPC routing */
interface ResolvedSession {
  readonly sessionId: string   // AFK session UUID (IPC dir name)
  readonly slotNum: number
}

// ============================================================================
// Session Resolution
// ============================================================================

/**
 * Resolve which AFK session this hook call belongs to.
 *
 * Uses session binding (bound_session files in IPC dirs) to map
 * Claude Code's session_id to the correct AFK session.
 *
 * @param ipcBaseDir - Base IPC directory
 * @param statePath - Path to state.json
 * @param claudeSessionId - Claude Code's session_id from stdin JSON
 * @returns ResolvedSession or null if no session found
 */
const resolveSession = async (
  ipcBaseDir: string,
  statePath: string,
  claudeSessionId: string | undefined
): Promise<ResolvedSession | null> => {
  // Load state to get current slots
  const stateResult = await loadState(statePath)()
  if (E.isLeft(stateResult)) return null

  const state = stateResult.right
  const slots = state.slots as Record<string, { sessionId: string } | undefined>

  // Check if ANY slots are active
  const hasActiveSlots = Object.values(slots).some(s => s !== undefined)
  if (!hasActiveSlots) return null

  // If we have Claude's session_id, use binding
  if (claudeSessionId) {
    // 1. Check for existing binding
    const bound = await findBoundSession(ipcBaseDir, claudeSessionId, slots)
    if (bound) return bound

    // 2. No existing binding — find an unbound session and create binding
    const unbound = await findUnboundSession(ipcBaseDir, slots)
    if (unbound) {
      await bindSession(ipcBaseDir, unbound.sessionId, claudeSessionId)
      return unbound
    }
  }

  // Fallback: if only one slot is active and no session_id available, use it
  // (backwards compatibility for CLI args mode)
  const activeSlots = Object.entries(slots).filter(([, s]) => s !== undefined)
  if (activeSlots.length === 1 && activeSlots[0]) {
    const [slotKey, slot] = activeSlots[0]
    return {
      sessionId: slot!.sessionId,
      slotNum: parseInt(slotKey, 10)
    }
  }

  // Multiple slots active but no session_id — can't route safely
  return null
}

// ============================================================================
// Main Hook Runner
// ============================================================================

/**
 * Run the hook and return exit code
 */
export const runHook = (
  configPath: string,
  argsOrHookArgs: string[] | HookArgs,
  timeoutMs?: number
): TE.TaskEither<HookError, ExitCode> =>
  TE.tryCatch(
    async () => {
      // Step 1: Parse arguments (or use pre-parsed HookArgs)
      let hookArgs: HookArgs
      if (Array.isArray(argsOrHookArgs)) {
        const parseResult = parseHookArgs(argsOrHookArgs)
        if (E.isLeft(parseResult)) {
          throw parseResult.left
        }
        hookArgs = parseResult.right
      } else {
        hookArgs = argsOrHookArgs
      }

      // Step 2: Load config
      const configResult = loadConfig(configPath)

      if (E.isLeft(configResult)) {
        throw hookError(`Failed to load config: ${String(configResult.left.message)}`)
      }
      const config = configResult.right

      // Step 2b: Open SQLite database for IPC
      const configDir = path.dirname(configPath)
      const dbPath = path.join(configDir, 'bridge.db')
      const dbResult = openDatabase(dbPath)
      if (E.isLeft(dbResult)) {
        console.error(`[hook] Failed to open SQLite database: ${String(dbResult.left)}`)
        // Fall through — hook can still work without SQLite (auto-approve)
      }

      // Step 3: Resolve session via binding
      const statePath = path.join(configDir, 'state.json')

      // Use session_id from hookArgs (stdin JSON) or env fallback
      const claudeSessionId = hookArgs.sessionId || process.env.CLAUDE_SESSION_ID
      const resolved = await resolveSession(config.ipcBaseDir, statePath, claudeSessionId)

      // If no resolved session, auto-approve (no active AFK)
      if (!resolved) {
        if (hookArgs.type === 'permission_request') {
          // Auto-approve: output allow decision
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            }
          }))
        }
        // For stop: exit 0 without output → Claude stops normally
        return 0
      }

      // Step 4: Auto-approve deactivate commands (no Telegram approval needed
      // when user is clearly at the terminal running /back)
      if (hookArgs.type === 'permission_request' && isDeactivateCommand(hookArgs)) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          }
        }))
        return 0
      }

      // Step 5: Auto-approve non-destructive tools or config-whitelisted tools
      if (hookArgs.type === 'permission_request' && shouldAutoApprove(hookArgs, config)) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          }
        }))
        return 0
      }

      // Step 6: Ensure daemon is alive before dispatching
      const daemonAlive = await ensureDaemonAlive(configDir)
      if (!daemonAlive) {
        console.error('[hook] Daemon not alive and restart failed — falling back')
        if (hookArgs.type === 'permission_request') {
          // Auto-approve: safer than 350s hang on dead daemon
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            }
          }))
          return 0
        }
        // Stop/notification: let Claude stop normally
        return 0
      }

      // Step 7: Dispatch based on hook type
      switch (hookArgs.type) {
        case 'permission_request':
          return await handlePermissionRequest(hookArgs, config.ipcBaseDir, resolved, timeoutMs)

        case 'stop':
          return await handleStop(config.ipcBaseDir, resolved, hookArgs, configDir)

        case 'notification':
          return handleNotification(hookArgs)
      }
    },
    (error: unknown): HookError => {
      // Convert caught errors to HookError
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        const tagged = error as { _tag?: string }
        if (tagged._tag === 'HookError' || tagged._tag === 'HookParseError') {
          return error as HookError
        }
      }
      return hookError(`Hook execution failed: ${String(error)}`)
    }
  )

// ============================================================================
// Command Detection Helpers
// ============================================================================

/**
 * Tools that can modify files or execute arbitrary commands.
 * Only these require Telegram approval — everything else is auto-approved.
 */
const DESTRUCTIVE_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit'])

/**
 * Check if a tool is destructive (modifies files or runs commands).
 */
const isDestructiveTool = (tool: string | undefined): boolean =>
  tool !== undefined && DESTRUCTIVE_TOOLS.has(tool)

/**
 * Check if a destructive tool is whitelisted in config.autoApproveTools,
 * optionally filtered by config.autoApprovePaths.
 */
const isConfigWhitelisted = (hookArgs: HookArgs, config: Config): boolean => {
  const tool = hookArgs.tool
  if (!tool || !config.autoApproveTools) return false
  if (!config.autoApproveTools.includes(tool)) return false

  // If no path restrictions, tool whitelist alone is sufficient
  if (!config.autoApprovePaths || config.autoApprovePaths.length === 0) return true

  // Extract path from tool input (Write/Edit use file_path, Bash uses command)
  const targetPath = (hookArgs.toolInput?.['file_path'] as string | undefined) ?? hookArgs.command ?? ''
  return config.autoApprovePaths.some(prefix => targetPath.startsWith(prefix))
}

/**
 * Determine if a permission request should be auto-approved (no Telegram roundtrip).
 * Auto-approves when:
 * 1. Tool is not destructive (Read, Glob, etc.), OR
 * 2. Tool is destructive but whitelisted in config.autoApproveTools (optionally path-filtered)
 */
const shouldAutoApprove = (hookArgs: HookArgs, config: Config): boolean => {
  if (!isDestructiveTool(hookArgs.tool)) return true
  return isConfigWhitelisted(hookArgs, config)
}

/**
 * Detect if the Bash command being approved is a deactivate/reset command.
 * These should be auto-approved since the user is clearly at the terminal.
 */
const isDeactivateCommand = (hookArgs: HookArgs): boolean => {
  const cmd = hookArgs.command || ''
  return /--deactivate|--reset/.test(cmd)
}

// ============================================================================
// Hook Type Handlers
// ============================================================================

/**
 * Handle permission_request hook
 *
 * Output format (Claude Code PreToolUse hook schema):
 * - Allow: {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
 * - Deny:  {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}
 * Always exits 0 — decision is communicated via JSON stdout.
 */
const handlePermissionRequest = async (
  hookArgs: HookArgs,
  ipcBaseDir: string,
  session: ResolvedSession,
  timeoutMs?: number
): Promise<ExitCode> => {
  const result = await requestPermission(ipcBaseDir, session.sessionId, session.slotNum, hookArgs, timeoutMs)()

  if (E.isLeft(result)) {
    throw result.left
  }

  const response = result.right as PermissionResponse

  if (response.approved) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      }
    }))
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: response.reason || 'Denied via Telegram',
      }
    }))
  }

  return 0
}

/**
 * Handle stop hook — active listening loop
 *
 * Output format (Claude Code Stop hook schema):
 * - Block (inject instruction): {"decision": "block", "reason": "instruction text"}
 * - Pass (let stop proceed): exit 0 with no stdout output
 */
const handleStop = async (
  ipcBaseDir: string,
  session: ResolvedSession,
  hookArgs?: HookArgs,
  configDir?: string
): Promise<ExitCode> => {
  const lastMessage = hookArgs?.lastMessage ?? process.env.CLAUDE_LAST_MESSAGE ?? ''

  const result = await handleStopRequest(ipcBaseDir, session.sessionId, session.slotNum, lastMessage, configDir)()

  if (E.isLeft(result)) {
    throw result.left
  }

  const decision = result.right

  // Only output JSON when blocking (injecting instruction)
  // For pass-through (kill/force_clear), exit 0 with no output
  if (decision.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }))
  }
  return 0
}

/**
 * Handle notification hook
 */
const handleNotification = (_hookArgs: HookArgs): ExitCode => {
  return 0
}

// ============================================================================
// CLI Entry Point (when run as script)
// ============================================================================

/**
 * Read all data from stdin (non-blocking if no data available).
 */
const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    // If stdin is a TTY (interactive), there's no piped data
    if (process.stdin.isTTY) {
      resolve('')
      return
    }

    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', () => resolve(''))
    process.stdin.resume()
  })

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)

  // Default config path in home directory
  const configPath = process.env.AFK_CONFIG_PATH || '/etc/afk-bridge/config.json'

  let argsOrHookArgs: string[] | HookArgs = args

  // When no CLI args, try reading stdin JSON (Claude Code sends hook data on stdin)
  if (args.length === 0) {
    const stdinData = await readStdin()
    if (stdinData.trim()) {
      const parseResult = parseStdinInput(stdinData.trim())
      if (E.isLeft(parseResult)) {
        console.error(`Error: ${parseResult.left.message}`)
        process.exit(1)
        return
      }
      argsOrHookArgs = parseResult.right
    }
  }

  const result = await runHook(configPath, argsOrHookArgs)()

  if (E.isLeft(result)) {
    const error = result.left
    console.error(`Error: ${error.message}`)
    process.exit(1)
  } else {
    const exitCode = result.right
    process.exit(exitCode)
  }
}

// Only run main if this is the entry point
if (require.main === module) {
  main()
}
