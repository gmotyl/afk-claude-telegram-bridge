import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import { Config } from '../types/config'

/**
 * Telegram update with message
 */
export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: {
    readonly message_id: number
    readonly chat: {
      readonly id: number
    }
    readonly message_thread_id?: number
    readonly text?: string
    readonly date: number
  }
  readonly callback_query?: {
    readonly id: string
    readonly from: { readonly id: number }
    readonly message?: {
      readonly message_id: number
      readonly chat: { readonly id: number }
      readonly message_thread_id?: number
    }
    readonly data?: string
  }
}

/**
 * Poller error
 */
export interface PollerError {
  readonly _tag: 'PollerError'
  readonly message: string
}

export const pollerError = (msg: string): PollerError => ({
  _tag: 'PollerError',
  message: msg
})

/**
 * Long poll Telegram for updates
 * Returns new updates since last offset
 */
export const pollTelegram = (
  config: Config,
  offset: number,
  timeoutSeconds: number = 2
): TE.TaskEither<PollerError, { updates: readonly TelegramUpdate[]; nextOffset: number }> => {
  return TE.tryCatch(
    async () => {
      const url = `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates`
      const params = new URLSearchParams({
        offset: String(offset),
        timeout: String(timeoutSeconds),
        allowed_updates: JSON.stringify(['message', 'callback_query'])
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), (timeoutSeconds + 5) * 1000)

      try {
        const response = await fetch(`${url}?${params}`, {
          method: 'GET',
          signal: controller.signal
        })

        const data = (await response.json()) as {
          ok: boolean
          result?: TelegramUpdate[]
          error_code?: number
          description?: string
        }

        if (!data.ok) {
          throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`)
        }

        const updates = data.result || []
        const lastUpdate = updates.length > 0 ? updates[updates.length - 1] : undefined
        const nextOffset = lastUpdate ? lastUpdate.update_id + 1 : offset

        return {
          updates: updates as readonly TelegramUpdate[],
          nextOffset
        }
      } finally {
        clearTimeout(timeoutId)
      }
    },
    (error) =>
      pollerError(
        `Failed to poll Telegram: ${error instanceof Error ? error.message : String(error)}`
      )
  )
}

/**
 * Extract instruction text from a message
 * Returns None if message is not an instruction
 */
export const extractInstruction = (
  update: TelegramUpdate,
  expectedGroupId: number,
  topicId: number
): E.Either<string, string> => {
  const msg = update.message
  if (!msg) {
    return E.left('No message in update')
  }

  if (msg.chat.id !== expectedGroupId) {
    return E.left('Message from wrong group')
  }

  if (msg.message_thread_id !== topicId) {
    return E.left('Message from wrong topic')
  }

  if (!msg.text || msg.text.trim().length === 0) {
    return E.left('Empty message')
  }

  return E.right(msg.text.trim())
}
