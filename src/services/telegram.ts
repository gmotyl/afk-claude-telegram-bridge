/**
 * @module services/telegram
 * Telegram Bot API client service using fp-ts TaskEither for async error handling.
 * Wraps Telegram Bot API calls with functional error handling.
 */

import * as TE from 'fp-ts/TaskEither'

// Module constants
const TELEGRAM_API_BASE_URL = 'https://api.telegram.org'
const CONTENT_TYPE_JSON = 'application/json'

/**
 * Convert an unknown error to a standardized Error instance
 * @param error - Any thrown error (can be Error, string, or unknown type)
 * @returns Standardized Error instance
 */
const convertError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }
  return new Error(String(error))
}

/**
 * Telegram inline button configuration
 */
export interface TelegramButton {
  readonly text: string
  readonly callback_data: string
}

/**
 * Telegram API response structure
 */
interface TelegramApiResponse {
  readonly ok: boolean
  readonly result?: unknown
  readonly error_code?: number
  readonly description?: string
}

/**
 * Build Telegram Bot API endpoint URL
 * @param botToken - The bot token from BotFather
 * @param method - The API method name (e.g. 'sendMessage')
 * @returns Full URL to the API endpoint
 */
const buildTelegramUrl = (botToken: string, method: string): string => {
  return `${TELEGRAM_API_BASE_URL}/bot${botToken}/${method}`
}

/**
 * Check if an HTTP response indicates an error
 * @param statusCode - HTTP status code
 * @param response - Parsed Telegram API response
 * @returns Error message if response is error, undefined if success
 */
const getResponseError = (
  statusCode: number,
  response: TelegramApiResponse
): string | undefined => {
  // Non-2xx HTTP status
  if (statusCode < 200 || statusCode >= 300) {
    return `Telegram API error: HTTP ${statusCode} - ${response.description || 'Unknown error'}`
  }

  // Telegram API returns ok: false
  if (!response.ok) {
    return `Telegram API error: ${response.description || 'Unknown error'}`
  }

  return undefined
}

/**
 * Send a simple text message via Telegram Bot API
 * Returns TaskEither for lazy async error handling
 *
 * @param botToken - The bot token from BotFather
 * @param chatId - The target chat ID (can be string or number)
 * @param text - The message text to send
 * @returns TaskEither<Error, TelegramApiResponse> - Left(error) or Right(response)
 * @throws Error if required parameters (botToken, chatId, text) are missing or empty
 *
 * @example
 * const result = await sendTelegramMessage('token', '-123456', 'Hello!')()
 * if (TE.isRight(result)) {
 *   console.log(result.right.result.message_id)
 * }
 */
export const sendTelegramMessage = (
  botToken: string,
  chatId: string,
  text: string
): TE.TaskEither<Error, TelegramApiResponse> => {
  // Validate required parameters
  if (!botToken || !chatId || !text) {
    const missing = [
      !botToken && 'botToken',
      !chatId && 'chatId',
      !text && 'text'
    ]
      .filter(Boolean)
      .join(', ')
    return TE.left(new Error(`Missing required parameters: ${missing}`))
  }

  return TE.tryCatch(
    async () => {
      const url = buildTelegramUrl(botToken, 'sendMessage')
      const body = JSON.stringify({
        chat_id: chatId,
        text: text
      })

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': CONTENT_TYPE_JSON
        },
        body: body
      })

      // Parse JSON response
      const data = (await response.json()) as TelegramApiResponse

      // Check for errors
      const error = getResponseError(response.status, data)
      if (error) {
        throw new Error(error)
      }

      return data
    },
    convertError
  )
}

/**
 * Send a message with inline reply buttons via Telegram Bot API
 * Returns TaskEither for lazy async error handling
 *
 * @param botToken - The bot token from BotFather
 * @param chatId - The target chat ID (can be string or number)
 * @param text - The message text to send
 * @param buttons - Array of buttons to display inline
 * @returns TaskEither<Error, TelegramApiResponse> - Left(error) or Right(response)
 * @throws Error if required parameters (botToken, chatId, text) are missing or empty
 *
 * @example
 * const buttons = [
 *   { text: 'Accept', callback_data: 'accept' },
 *   { text: 'Reject', callback_data: 'reject' }
 * ]
 * const result = await sendTelegramReplyWithButtons('token', '-123456', 'Please choose', buttons)()
 */
export const sendTelegramReplyWithButtons = (
  botToken: string,
  chatId: string,
  text: string,
  buttons: readonly TelegramButton[]
): TE.TaskEither<Error, TelegramApiResponse> => {
  // Validate required parameters
  if (!botToken || !chatId || !text) {
    const missing = [
      !botToken && 'botToken',
      !chatId && 'chatId',
      !text && 'text'
    ]
      .filter(Boolean)
      .join(', ')
    return TE.left(new Error(`Missing required parameters: ${missing}`))
  }

  return TE.tryCatch(
    async () => {
      const url = buildTelegramUrl(botToken, 'sendMessage')

      const body = JSON.stringify({
        chat_id: chatId,
        text: text,
        reply_markup: {
          inline_keyboard: [buttons]
        }
      })

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': CONTENT_TYPE_JSON
        },
        body: body
      })

      // Parse JSON response
      const data = (await response.json()) as TelegramApiResponse

      // Check for errors
      const error = getResponseError(response.status, data)
      if (error) {
        throw new Error(error)
      }

      return data
    },
    convertError
  )
}
