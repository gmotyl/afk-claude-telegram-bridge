/**
 * @module hook/args
 * Parses command-line arguments passed to the Claude Code hook.
 * Determines hook type and extracts type-specific data.
 */

import * as E from 'fp-ts/Either'
import { HookParseError, hookParseError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

export type HookType = 'permission_request' | 'stop' | 'notification'

export interface HookArgs {
  readonly type: HookType
  readonly tool?: string
  readonly command?: string
  readonly message?: string
  readonly sessionId?: string
  readonly stopHookActive?: boolean
  readonly lastMessage?: string
  readonly toolInput?: Record<string, unknown>
}

// ============================================================================
// Hook Argument Parser
// ============================================================================

/**
 * Parses command-line arguments passed to the hook.
 *
 * Valid invocations:
 * - ['permission_request', 'Bash', 'npm install']
 * - ['stop']
 * - ['notification', 'Task completed']
 *
 * @param args - Array of command-line arguments (typically process.argv.slice(2))
 * @returns Either<HookParseError, HookArgs>
 */
export const parseHookArgs = (args: string[]): E.Either<HookParseError, HookArgs> => {
  // Check for no arguments
  if (args.length === 0) {
    return E.left(hookParseError('No hook type provided'))
  }

  const [hookType, ...rest] = args

  // Check for empty hook type
  if (!hookType || hookType.trim() === '') {
    return E.left(hookParseError('Hook type cannot be empty'))
  }

  // Parse based on hook type
  switch (hookType) {
    case 'permission_request':
      return parsePermissionRequest(rest)

    case 'stop':
      return E.right({ type: 'stop' })

    case 'notification':
      return parseNotification(rest)

    default:
      return E.left(
        hookParseError(`Invalid hook type '${hookType}'. Expected 'permission_request', 'stop', or 'notification'`)
      )
  }
}

// ============================================================================
// Permission Request Parser
// ============================================================================

const parsePermissionRequest = (args: string[]): E.Either<HookParseError, HookArgs> => {
  if (args.length < 2) {
    return E.left(
      hookParseError('permission_request requires tool and command arguments')
    )
  }

  const [tool, ...commandParts] = args
  const command = commandParts.join(' ')

  // Validate tool is not empty
  if (!tool || tool.trim() === '') {
    return E.left(hookParseError('Tool name cannot be empty'))
  }

  // Validate command is not empty
  if (!command || command.trim() === '') {
    return E.left(hookParseError('Command cannot be empty'))
  }

  return E.right({
    type: 'permission_request',
    tool,
    command,
  })
}

// ============================================================================
// Notification Parser
// ============================================================================

const parseNotification = (args: string[]): E.Either<HookParseError, HookArgs> => {
  if (args.length < 1) {
    return E.left(
      hookParseError('notification requires a message argument')
    )
  }

  const message = args.join(' ')

  // Validate message is not empty
  if (!message || message.trim() === '') {
    return E.left(hookParseError('Message cannot be empty'))
  }

  return E.right({
    type: 'notification',
    message,
  })
}

// ============================================================================
// Tool Command Formatter
// ============================================================================

/**
 * Formats tool_input into a human-readable command string for display in Telegram.
 * Bash tools have a `command` field; other tools need their input summarized.
 */
const formatToolCommand = (toolName: string, toolInput: Record<string, unknown>): string => {
  // Bash: use the command directly
  if (typeof toolInput.command === 'string') {
    return toolInput.command
  }

  // Edit: show file path and a preview of the change
  if (toolName === 'Edit' && typeof toolInput.file_path === 'string') {
    const file = toolInput.file_path as string
    const oldStr = typeof toolInput.old_string === 'string' ? toolInput.old_string as string : ''
    const newStr = typeof toolInput.new_string === 'string' ? toolInput.new_string as string : ''
    const preview = oldStr.length > 80 ? oldStr.substring(0, 80) + '...' : oldStr
    const newPreview = newStr.length > 80 ? newStr.substring(0, 80) + '...' : newStr
    return `${file}\n- ${preview}\n+ ${newPreview}`
  }

  // Write: show file path
  if (toolName === 'Write' && typeof toolInput.file_path === 'string') {
    const content = typeof toolInput.content === 'string' ? toolInput.content as string : ''
    return `${toolInput.file_path} (${content.length} chars)`
  }

  // NotebookEdit: show notebook path
  if (toolName === 'NotebookEdit' && typeof toolInput.notebook_path === 'string') {
    return toolInput.notebook_path as string
  }

  // Fallback: serialize key fields (skip large values)
  const parts: string[] = []
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === 'string') {
      const display = value.length > 100 ? value.substring(0, 100) + '...' : value
      parts.push(`${key}: ${display}`)
    }
  }
  return parts.join('\n') || toolName
}

// ============================================================================
// Stdin JSON Parser (Claude Code sends hook data as JSON on stdin)
// ============================================================================

/**
 * Maps Claude Code's hook_event_name to our internal HookType.
 */
const mapEventName = (eventName: string): HookType | null => {
  switch (eventName) {
    case 'Stop': return 'stop'
    case 'PreToolUse': return 'permission_request'
    case 'Notification': return 'notification'
    default: return null
  }
}

/**
 * Parses JSON input from Claude Code stdin.
 *
 * Claude Code sends hook data as JSON on stdin with fields like:
 * - hook_event_name: "Stop" | "PreToolUse" | "Notification"
 * - tool_name, tool_input (for PreToolUse)
 * - stop_hook_active, last_assistant_message, session_id (for Stop)
 * - message (for Notification)
 *
 * @param json - Raw JSON string from stdin
 * @returns Either<HookParseError, HookArgs>
 */
export const parseStdinInput = (json: string): E.Either<HookParseError, HookArgs> => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json)
  } catch {
    return E.left(hookParseError(`Invalid JSON on stdin: ${json.slice(0, 100)}`))
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return E.left(hookParseError('Stdin JSON must be an object'))
  }

  const eventName = parsed.hook_event_name
  if (typeof eventName !== 'string' || !eventName) {
    return E.left(hookParseError('Missing or invalid hook_event_name in stdin JSON'))
  }

  const hookType = mapEventName(eventName)
  if (hookType === null) {
    return E.left(
      hookParseError(`Unknown hook_event_name '${eventName}'. Expected 'Stop', 'PreToolUse', or 'Notification'`)
    )
  }

  switch (hookType) {
    case 'stop':
      return E.right({
        type: 'stop' as const,
        ...(typeof parsed.session_id === 'string' && { sessionId: parsed.session_id }),
        ...(typeof parsed.stop_hook_active === 'boolean' && { stopHookActive: parsed.stop_hook_active }),
        ...(typeof parsed.last_assistant_message === 'string' && { lastMessage: parsed.last_assistant_message }),
      })

    case 'permission_request': {
      const toolInput = typeof parsed.tool_input === 'object' && parsed.tool_input !== null
        ? parsed.tool_input as Record<string, unknown>
        : null
      const command = toolInput ? formatToolCommand(typeof parsed.tool_name === 'string' ? parsed.tool_name : '', toolInput) : undefined

      return E.right({
        type: 'permission_request' as const,
        ...(typeof parsed.session_id === 'string' && { sessionId: parsed.session_id }),
        ...(typeof parsed.tool_name === 'string' && { tool: parsed.tool_name }),
        ...(toolInput && { toolInput }),
        ...(command !== undefined && { command }),
      })
    }

    case 'notification':
      return E.right({
        type: 'notification' as const,
        ...(typeof parsed.session_id === 'string' && { sessionId: parsed.session_id }),
        ...(typeof parsed.message === 'string' && { message: parsed.message }),
      })
  }
}

