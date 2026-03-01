/**
 * @module config
 * Configuration loader for the Telegram bridge daemon.
 * Reads and validates config from JSON files using functional error handling.
 */

import * as E from 'fp-ts/Either'
import * as fs from 'fs'
import * as path from 'path'
import { Config } from '../../types/config'

/**
 * Construct the standard config file path for a given base directory
 * @param baseDir - Base directory path
 * @returns Path to config.json within the base directory
 */
export const getConfigPath = (baseDir: string): string => {
  return path.join(baseDir, 'config.json')
}

/**
 * Type guard to validate config structure
 * Checks that all required fields exist and have correct types
 */
const isValidConfig = (value: unknown): value is Config => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const obj = value as Record<string, unknown>

  // Check all required fields exist
  if (
    !('telegramBotToken' in obj) ||
    !('telegramGroupId' in obj) ||
    !('ipcBaseDir' in obj) ||
    !('sessionTimeout' in obj)
  ) {
    return false
  }

  // Check field types
  if (typeof obj.telegramBotToken !== 'string') {
    return false
  }

  if (typeof obj.telegramGroupId !== 'number') {
    return false
  }

  if (typeof obj.ipcBaseDir !== 'string') {
    return false
  }

  if (typeof obj.sessionTimeout !== 'number') {
    return false
  }

  return true
}

/**
 * Load configuration from a JSON file
 * Returns Either<Error, Config> for functional error handling
 *
 * Process:
 * 1. Read file (may fail if not found)
 * 2. Parse JSON (may fail if invalid JSON)
 * 3. Validate structure (may fail if missing/wrong type fields)
 *
 * @param configPath - Path to the config.json file
 * @returns Either<Error, Config> - Left(error) or Right(config)
 */
/**
 * Normalize legacy Python-format config to TS format.
 * Handles: bot_token → telegramBotToken, chat_id → telegramGroupId
 * Fills in defaults for ipcBaseDir and sessionTimeout if missing.
 */
const normalizeConfig = (obj: Record<string, unknown>, configPath: string): Record<string, unknown> => {
  const result = { ...obj }

  // Migrate Python field names
  if ('bot_token' in result && !('telegramBotToken' in result)) {
    result['telegramBotToken'] = result['bot_token']
  }
  if ('chat_id' in result && !('telegramGroupId' in result)) {
    const chatId = result['chat_id']
    result['telegramGroupId'] = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId
  }

  // Default ipcBaseDir to sibling ipc/ directory
  if (!('ipcBaseDir' in result)) {
    result['ipcBaseDir'] = path.join(path.dirname(configPath), 'ipc')
  }

  // Default sessionTimeout to 24 hours
  if (!('sessionTimeout' in result)) {
    result['sessionTimeout'] = 86400000
  }

  return result
}

export const loadConfig = (configPath: string): E.Either<Error, Config> => {
  return E.tryCatch(
    () => {
      // Read file from filesystem
      const content = fs.readFileSync(configPath, 'utf-8')

      // Parse JSON and normalize legacy format
      const raw = JSON.parse(content) as Record<string, unknown>
      const parsed = normalizeConfig(raw, configPath)

      // Validate structure
      if (!isValidConfig(parsed)) {
        throw new Error('Invalid config: missing or incorrect fields')
      }

      return parsed as Config
    },
    (error) => {
      // Convert any error to Error type
      if (error instanceof Error) {
        return error
      }
      return new Error(String(error))
    }
  )
}
