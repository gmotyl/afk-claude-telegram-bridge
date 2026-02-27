#!/usr/bin/env node

/**
 * @module hook/index
 * Claude Code AFK Hook - Main Entry Point
 *
 * Orchestrates hook execution:
 * 1. Parse command-line arguments (task 4.1)
 * 2. Load configuration
 * 3. Process hook based on type (task 4.2 - permission_request)
 * 4. Return appropriate exit codes
 *
 * Supports three hook types:
 * - permission_request: Request daemon approval for tool execution
 * - stop: Clean daemon shutdown
 * - notification: Acknowledgement notification
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import { pipe } from 'fp-ts/function'
import { parseHookArgs, type HookArgs } from './args'
import { requestPermission, type PermissionResponse } from './permission'
import { handleStopRequest, type StopDecision } from './stop'
import { loadConfig } from '../core/config'
import { type HookError, hookError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

type ExitCode = number

// ============================================================================
// Main Hook Runner
// ============================================================================

/**
 * Run the hook and return exit code
 *
 * Process:
 * 1. Parse command-line arguments to determine hook type and args
 * 2. Load config from configPath
 * 3. Dispatch based on hook type:
 *    - permission_request: Use requestPermission, return 0 (approved) or 1 (denied)
 *    - stop: Return 0 (clean shutdown)
 *    - notification: Return 0 (acknowledged)
 * 4. On error, return exit code based on error type
 *
 * @param configPath - Path to config.json file
 * @param args - Command-line arguments (typically process.argv.slice(2))
 * @param timeoutMs - Optional timeout for permission request (default: 30000)
 * @returns TaskEither<HookError, ExitCode>
 *
 * @example
 * const task = runHook('/etc/config.json', ['permission_request', 'Bash', 'npm install'])
 * const result = await task()
 * if (E.isRight(result)) {
 *   process.exit(result.right)
 * }
 */
export const runHook = (
  configPath: string,
  args: string[],
  timeoutMs?: number
): TE.TaskEither<HookError, ExitCode> =>
  TE.tryCatch(
    async () => {
      // Step 1: Parse arguments
      const parseResult = parseHookArgs(args)
      if (E.isLeft(parseResult)) {
        throw parseResult.left
      }
      const hookArgs = parseResult.right

      // Step 2: Load config
      const configResult = loadConfig(configPath)

      if (E.isLeft(configResult)) {
        throw hookError(`Failed to load config: ${String(configResult.left.message)}`)
      }
      const config = configResult.right

      // Step 3: Dispatch based on hook type
      switch (hookArgs.type) {
        case 'permission_request':
          return await handlePermissionRequest(hookArgs, config.ipcBaseDir, timeoutMs)

        case 'stop':
          return await handleStop(config.ipcBaseDir)

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
// Hook Type Handlers
// ============================================================================

/**
 * Handle permission_request hook
 * - Request daemon approval
 * - Return 0 if approved, 1 if denied
 *
 * @param hookArgs - Hook arguments containing tool and command
 * @param ipcDir - IPC directory for communication with daemon
 * @param timeoutMs - Optional timeout for waiting for response
 * @returns Promise<ExitCode>
 * @throws HookError if permission request fails
 */
const handlePermissionRequest = async (
  hookArgs: HookArgs,
  ipcDir: string,
  timeoutMs?: number
): Promise<ExitCode> => {
  // Call permission handler
  const result = await requestPermission(ipcDir, hookArgs, timeoutMs)()

  if (E.isLeft(result)) {
    throw result.left
  }

  // Return exit code based on approval status
  const response = result.right as PermissionResponse
  return response.approved ? 0 : 1
}

/**
 * Handle stop hook — active listening loop
 * - Writes Stop event to IPC, polls for next instruction
 * - Returns 0 when instruction received (block decision)
 * - Returns 0 when kill/force_clear signal (pass decision)
 *
 * Output: JSON decision to stdout for Claude Code to read
 *
 * @param ipcDir - IPC directory for communication with daemon
 * @returns Promise<ExitCode>
 */
const handleStop = async (ipcDir: string): Promise<ExitCode> => {
  const slotNum = parseInt(process.env.AFK_SLOT_NUM ?? '1', 10)
  const lastMessage = process.env.CLAUDE_LAST_MESSAGE ?? ''

  const result = await handleStopRequest(ipcDir, slotNum, lastMessage)()

  if (E.isLeft(result)) {
    throw result.left
  }

  const decision = result.right
  // Output the decision as JSON to stdout for Claude Code
  process.stdout.write(JSON.stringify(decision))
  return 0
}

/**
 * Handle notification hook
 * - Acknowledgement of notification sent to user
 * - Always returns 0 (success)
 *
 * @param hookArgs - Hook arguments containing message
 * @returns ExitCode (always 0)
 */
const handleNotification = (hookArgs: HookArgs): ExitCode => {
  return 0
}

// ============================================================================
// CLI Entry Point (when run as script)
// ============================================================================

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)

  // Default config path in home directory
  const configPath = process.env.AFK_CONFIG_PATH || '/etc/afk-bridge/config.json'

  const result = await runHook(configPath, args)()

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
