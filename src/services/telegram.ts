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
export interface TelegramApiResponse {
  readonly ok: boolean
  readonly result?: unknown
  readonly error_code?: number
  readonly description?: string
}

/**
 * Build Telegram Bot API endpoint URL
 */
const buildTelegramUrl = (botToken: string, method: string): string => {
  return `${TELEGRAM_API_BASE_URL}/bot${botToken}/${method}`
}

/**
 * Check if an HTTP response indicates an error
 */
const getResponseError = (
  statusCode: number,
  response: TelegramApiResponse
): string | undefined => {
  if (statusCode < 200 || statusCode >= 300) {
    return `Telegram API error: HTTP ${statusCode} - ${response.description || 'Unknown error'}`
  }
  if (!response.ok) {
    return `Telegram API error: ${response.description || 'Unknown error'}`
  }
  return undefined
}

/**
 * Generic Telegram Bot API caller
 */
export const callTelegramApi = (
  botToken: string,
  method: string,
  body: Record<string, unknown>
): TE.TaskEither<Error, TelegramApiResponse> => {
  return TE.tryCatch(
    async () => {
      const url = buildTelegramUrl(botToken, method)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
        body: JSON.stringify(body)
      })

      const data = (await response.json()) as TelegramApiResponse
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
 * Send a simple text message via Telegram Bot API
 */
export const sendTelegramMessage = (
  botToken: string,
  chatId: string,
  text: string
): TE.TaskEither<Error, TelegramApiResponse> => {
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

  return callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text: text
  })
}

/**
 * Send a message with inline reply buttons via Telegram Bot API
 */
export const sendTelegramReplyWithButtons = (
  botToken: string,
  chatId: string,
  text: string,
  buttons: readonly TelegramButton[]
): TE.TaskEither<Error, TelegramApiResponse> => {
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

  return callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text: text,
    reply_markup: {
      inline_keyboard: [buttons]
    }
  })
}

/**
 * Create a forum topic in a supergroup
 */
export const createForumTopic = (
  botToken: string,
  chatId: string,
  name: string
): TE.TaskEither<Error, TelegramApiResponse> => {
  return callTelegramApi(botToken, 'createForumTopic', {
    chat_id: chatId,
    name: name
  })
}

/**
 * Delete a forum topic in a supergroup
 */
export const deleteForumTopic = (
  botToken: string,
  chatId: string,
  threadId: number
): TE.TaskEither<Error, TelegramApiResponse> => {
  return callTelegramApi(botToken, 'deleteForumTopic', {
    chat_id: chatId,
    message_thread_id: threadId
  })
}

/**
 * Send a message to a specific forum topic
 */
export const sendMessageToTopic = (
  botToken: string,
  chatId: string,
  text: string,
  threadId: number,
  parseMode?: string
): TE.TaskEither<Error, TelegramApiResponse> => {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text,
    message_thread_id: threadId
  }
  if (parseMode) {
    body.parse_mode = parseMode
  }
  return callTelegramApi(botToken, 'sendMessage', body)
}

/**
 * Send a message with inline buttons to a specific forum topic
 */
export const sendButtonsToTopic = (
  botToken: string,
  chatId: string,
  text: string,
  buttons: readonly TelegramButton[],
  threadId: number
): TE.TaskEither<Error, TelegramApiResponse> => {
  return callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text: text,
    message_thread_id: threadId,
    reply_markup: {
      inline_keyboard: [buttons]
    }
  })
}

/**
 * Send a message with multi-row inline buttons to a specific forum topic
 */
export const sendMultiRowButtonsToTopic = (
  botToken: string,
  chatId: string,
  text: string,
  buttonRows: readonly (readonly TelegramButton[])[],
  threadId: number
): TE.TaskEither<Error, TelegramApiResponse> => {
  return callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text: text,
    message_thread_id: threadId,
    reply_markup: {
      inline_keyboard: buttonRows
    }
  })
}

/**
 * Edit the text of an existing message
 */
export const editMessageText = (
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: { inline_keyboard: readonly (readonly TelegramButton[])[] }
): TE.TaskEither<Error, TelegramApiResponse> => {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: text
  }
  if (replyMarkup) {
    body.reply_markup = replyMarkup
  }
  return callTelegramApi(botToken, 'editMessageText', body)
}

/**
 * Answer a callback query (dismiss loading spinner on button)
 */
export const answerCallbackQuery = (
  botToken: string,
  callbackQueryId: string,
  text?: string
): TE.TaskEither<Error, TelegramApiResponse> => {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId
  }
  if (text) {
    body.text = text
  }
  return callTelegramApi(botToken, 'answerCallbackQuery', body)
}

/**
 * Send a chat action (typing indicator, etc.)
 */
export const sendChatAction = (
  botToken: string,
  chatId: string,
  action: string,
  threadId?: number
): TE.TaskEither<Error, TelegramApiResponse> => {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    action: action
  }
  if (threadId !== undefined) {
    body.message_thread_id = threadId
  }
  return callTelegramApi(botToken, 'sendChatAction', body)
}
