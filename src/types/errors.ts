/**
 * @module errors
 * Structured, tagged error types for the bridge.
 * All errors use discriminated unions with _tag field for type-safe pattern matching.
 */

// ============================================================================
// IPC Errors (Filesystem operations)
// ============================================================================

export type IpcReadError = {
  readonly _tag: 'IpcReadError'
  readonly path: string
  readonly cause: unknown
}

export type IpcWriteError = {
  readonly _tag: 'IpcWriteError'
  readonly path: string
  readonly cause: unknown
}

export type IpcParseError = {
  readonly _tag: 'IpcParseError'
  readonly path: string
  readonly content: string
  readonly cause: unknown
}

export type IpcError = IpcReadError | IpcWriteError | IpcParseError

export const ipcReadError = (path: string, cause: unknown): IpcReadError => ({
  _tag: 'IpcReadError',
  path,
  cause,
})

export const ipcWriteError = (path: string, cause: unknown): IpcWriteError => ({
  _tag: 'IpcWriteError',
  path,
  cause,
})

export const ipcParseError = (path: string, content: string, cause: unknown): IpcParseError => ({
  _tag: 'IpcParseError',
  path,
  content,
  cause,
})

// ============================================================================
// Telegram Errors
// ============================================================================

export type TelegramApiError = {
  readonly _tag: 'TelegramApiError'
  readonly status: number
  readonly message: string
}

export type TelegramTopicError = {
  readonly _tag: 'TelegramTopicError'
  readonly threadId: number
  readonly reason: 'deleted' | 'not_found' | 'forbidden'
}

export type TelegramError = TelegramApiError | TelegramTopicError

export const telegramApiError = (status: number, message: string): TelegramApiError => ({
  _tag: 'TelegramApiError',
  status,
  message,
})

export const telegramTopicError = (
  threadId: number,
  reason: 'deleted' | 'not_found' | 'forbidden'
): TelegramTopicError => ({
  _tag: 'TelegramTopicError',
  threadId,
  reason,
})

// ============================================================================
// State/Business Logic Errors
// ============================================================================

export type StateError = {
  readonly _tag: 'StateError'
  readonly message: string
  readonly details?: unknown
}

export type ValidationError = {
  readonly _tag: 'ValidationError'
  readonly field: string
  readonly message: string
}

export type SlotError = {
  readonly _tag: 'SlotError'
  readonly slotNum: string
  readonly message: string
}

export type HookParseError = {
  readonly _tag: 'HookParseError'
  readonly message: string
}

export type HookError = {
  readonly _tag: 'HookError'
  readonly message: string
}

export type CliError = {
  readonly _tag: 'CliError'
  readonly message: string
  readonly command: string
}

export type LockError = {
  readonly _tag: 'LockError'
  readonly path: string
  readonly operation: string
  readonly cause: unknown
}

export type DaemonSpawnError = {
  readonly _tag: 'DaemonSpawnError'
  readonly message: string
  readonly exitCode?: number
}

export type DaemonStopError = {
  readonly _tag: 'DaemonStopError'
  readonly message: string
}

export type BusinessError = StateError | ValidationError | SlotError | HookParseError | HookError | CliError | LockError | DaemonSpawnError | DaemonStopError

export const stateError = (message: string, details?: unknown): StateError => ({
  _tag: 'StateError',
  message,
  details,
})

export const validationError = (field: string, message: string): ValidationError => ({
  _tag: 'ValidationError',
  field,
  message,
})

export const slotError = (slotNum: string, message: string): SlotError => ({
  _tag: 'SlotError',
  slotNum,
  message,
})

export const hookParseError = (message: string): HookParseError => ({
  _tag: 'HookParseError',
  message,
})

export const hookError = (message: string): HookError => ({
  _tag: 'HookError',
  message,
})

export const cliError = (message: string, command: string): CliError => ({
  _tag: 'CliError',
  message,
  command,
})

export const lockError = (path: string, operation: string, cause: unknown): LockError => ({
  _tag: 'LockError',
  path,
  operation,
  cause,
})

export const daemonSpawnError = (message: string, exitCode?: number): DaemonSpawnError => ({
  _tag: 'DaemonSpawnError',
  message,
  ...(exitCode !== undefined ? { exitCode } : {}),
})

export const daemonStopError = (message: string): DaemonStopError => ({
  _tag: 'DaemonStopError',
  message,
})

// ============================================================================
// Bridge Error (Union of all error types)
// ============================================================================

export type BridgeError = IpcError | TelegramError | BusinessError

// ============================================================================
// Error Message Generation (for logging/response)
// ============================================================================

export const errorMessage = (error: BridgeError): string => {
  switch (error._tag) {
    case 'IpcReadError':
      return `Failed to read ${error.path}: ${String(error.cause)}`
    case 'IpcWriteError':
      return `Failed to write ${error.path}: ${String(error.cause)}`
    case 'IpcParseError':
      return `Failed to parse ${error.path}: ${String(error.cause)}`
    case 'TelegramApiError':
      return `Telegram API error (${error.status}): ${error.message}`
    case 'TelegramTopicError':
      return `Topic ${error.threadId} ${error.reason}`
    case 'StateError':
      return `State error: ${error.message}`
    case 'ValidationError':
      return `Validation failed on ${error.field}: ${error.message}`
    case 'SlotError':
      return `Slot ${error.slotNum} error: ${error.message}`
    case 'HookParseError':
      return `Hook parse error: ${error.message}`
    case 'HookError':
      return `Hook error: ${error.message}`
    case 'CliError':
      return `CLI error (${error.command}): ${error.message}`
    case 'LockError':
      return `Lock ${error.operation} failed on ${error.path}: ${String(error.cause)}`
    case 'DaemonSpawnError':
      return `Daemon spawn error: ${error.message}`
    case 'DaemonStopError':
      return `Daemon stop error: ${error.message}`
  }
}

export const errorStatusCode = (error: BridgeError): number => {
  switch (error._tag) {
    case 'IpcReadError':
    case 'IpcWriteError':
    case 'IpcParseError':
      return 500  // Internal error
    case 'TelegramApiError':
      return error.status
    case 'TelegramTopicError':
      return 404  // Topic deleted or not found
    case 'StateError':
      return 500
    case 'ValidationError':
      return 400
    case 'SlotError':
      return 400
    case 'HookParseError':
      return 400
    case 'HookError':
      return 500
    case 'CliError':
      return 400
    case 'LockError':
      return 500
    case 'DaemonSpawnError':
      return 500
    case 'DaemonStopError':
      return 500
  }
}
