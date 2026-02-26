/**
 * @module services/telegram.test
 * Tests for Telegram API client service
 */

import * as E from 'fp-ts/Either'
import { sendTelegramMessage, sendTelegramReplyWithButtons } from '../telegram'

describe('sendTelegramMessage', () => {
  const mockFetch = jest.fn()

  beforeEach(() => {
    mockFetch.mockClear()
    global.fetch = mockFetch as any
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('sends a simple text message via Telegram API', async () => {
    const mockResponse = {
      ok: true,
      result: {
        message_id: 12345,
        chat: { id: -1001234567890 },
        text: 'Hello, World!'
      }
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
      status: 200,
      statusText: 'OK'
    })

    const result = await sendTelegramMessage(
      'test-bot-token',
      '-1001234567890',
      'Hello, World!'
    )()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.ok).toBe(true)
      expect((result.right.result as any).message_id).toBe(12345)
    }
  })

  it('makes POST request to correct Telegram API endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
      status: 200,
      statusText: 'OK'
    })

    await sendTelegramMessage('bot-token-123', '-100987654', 'Test')()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]

    expect(url).toBe('https://api.telegram.org/botbot-token-123/sendMessage')
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({
      'Content-Type': 'application/json'
    })
  })

  it('sends message text in JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
      status: 200,
      statusText: 'OK'
    })

    await sendTelegramMessage('token', 'chatId', 'Message text')()

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body)

    expect(body.chat_id).toBe('chatId')
    expect(body.text).toBe('Message text')
  })

  it('returns TaskEither that can be executed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
      status: 200,
      statusText: 'OK'
    })

    const task = sendTelegramMessage('token', 'chatId', 'text')

    expect(typeof task).toBe('function')

    const result = await task()
    expect(E.isRight(result)).toBe(true)
  })

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'))

    const result = await sendTelegramMessage('token', 'chatId', 'text')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left).toBeInstanceOf(Error)
      expect(result.left.message).toContain('Network timeout')
    }
  })

  it('treats failed HTTP responses (non-2xx) as errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ ok: false, description: 'Unauthorized' })
    })

    const result = await sendTelegramMessage('bad-token', 'chatId', 'text')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('401')
    }
  })

  it('treats failed responses with ok: false as errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat_id is invalid'
      })
    })

    const result = await sendTelegramMessage('token', 'invalid-id', 'text')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Bad Request')
    }
  })

  it('handles invalid JSON response gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error('Invalid JSON') }
    })

    const result = await sendTelegramMessage('token', 'chatId', 'text')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left).toBeInstanceOf(Error)
    }
  })

  it('returns the full API response on success', async () => {
    const expectedResponse = {
      ok: true,
      result: {
        message_id: 999,
        chat: { id: -100111, first_name: 'Test' },
        text: 'Hello',
        date: 1234567890
      }
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => expectedResponse
    })

    const result = await sendTelegramMessage('token', 'chatId', 'Hello')()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toEqual(expectedResponse)
    }
  })

  it('validates that botToken is provided', async () => {
    const result = await sendTelegramMessage('', 'chatId', 'text')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('botToken')
    }
  })

  it('validates that chatId is provided', async () => {
    const result = await sendTelegramMessage('token', '', 'text')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('chatId')
    }
  })

  it('validates that text is provided', async () => {
    const result = await sendTelegramMessage('token', 'chatId', '')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('text')
    }
  })

  it('validates multiple missing parameters', async () => {
    const result = await sendTelegramMessage('', '', '')()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('botToken')
      expect(result.left.message).toContain('chatId')
      expect(result.left.message).toContain('text')
    }
  })

  it('does not call fetch when validation fails', async () => {
    await sendTelegramMessage('', 'chatId', 'text')()

    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('sendTelegramReplyWithButtons', () => {
  const mockFetch = jest.fn()

  beforeEach(() => {
    mockFetch.mockClear()
    global.fetch = mockFetch as any
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('sends message with inline buttons via Telegram API', async () => {
    const buttons = [
      { text: 'Yes', callback_data: 'yes_response' },
      { text: 'No', callback_data: 'no_response' }
    ]

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 54321,
          chat: { id: -1001234567890 },
          text: 'Choose an option',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Yes', callback_data: 'yes_response' },
                { text: 'No', callback_data: 'no_response' }
              ]
            ]
          }
        }
      }),
      status: 200,
      statusText: 'OK'
    })

    const result = await sendTelegramReplyWithButtons(
      'token',
      'chatId',
      'Choose an option',
      buttons
    )()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.ok).toBe(true)
      expect((result.right.result as any).reply_markup.inline_keyboard[0]).toHaveLength(2)
    }
  })

  it('formats buttons as inline_keyboard in request body', async () => {
    const buttons = [
      { text: 'Option 1', callback_data: 'opt1' }
    ]

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
      status: 200,
      statusText: 'OK'
    })

    await sendTelegramReplyWithButtons('token', 'chatId', 'text', buttons)()

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body)

    expect(body.reply_markup).toBeDefined()
    expect(body.reply_markup.inline_keyboard).toBeDefined()
    expect(body.reply_markup.inline_keyboard[0][0].text).toBe('Option 1')
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('opt1')
  })

  it('returns TaskEither that can be executed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
      status: 200,
      statusText: 'OK'
    })

    const task = sendTelegramReplyWithButtons(
      'token',
      'chatId',
      'text',
      [{ text: 'btn', callback_data: 'data' }]
    )

    expect(typeof task).toBe('function')

    const result = await task()
    expect(E.isRight(result)).toBe(true)
  })

  it('handles empty buttons array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
      status: 200,
      statusText: 'OK'
    })

    const result = await sendTelegramReplyWithButtons(
      'token',
      'chatId',
      'text',
      []
    )()

    expect(E.isRight(result)).toBe(true)

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body)
    // Empty buttons array is wrapped in a row array: [[]]
    expect(body.reply_markup.inline_keyboard).toEqual([[]])
  })

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection failed'))

    const result = await sendTelegramReplyWithButtons(
      'token',
      'chatId',
      'text',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left).toBeInstanceOf(Error)
    }
  })

  it('treats failed HTTP responses (non-2xx) as errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ ok: false, description: 'Forbidden' })
    })

    const result = await sendTelegramReplyWithButtons(
      'bad-token',
      'chatId',
      'text',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('403')
    }
  })

  it('treats API responses with ok: false as errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error_code: 400,
        description: 'Bad Request: invalid chat ID'
      })
    })

    const result = await sendTelegramReplyWithButtons(
      'token',
      'chatId',
      'valid text',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Bad Request')
    }
  })

  it('returns the full API response on success', async () => {
    const expectedResponse = {
      ok: true,
      result: {
        message_id: 777,
        chat: { id: -100222 },
        text: 'Please choose',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Accept', callback_data: 'accept' }]
          ]
        }
      }
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => expectedResponse
    })

    const result = await sendTelegramReplyWithButtons(
      'token',
      'chatId',
      'Please choose',
      [{ text: 'Accept', callback_data: 'accept' }]
    )()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toEqual(expectedResponse)
    }
  })

  it('supports multiple buttons per row', async () => {
    const buttons = [
      { text: 'A', callback_data: 'a' },
      { text: 'B', callback_data: 'b' },
      { text: 'C', callback_data: 'c' }
    ]

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
      status: 200,
      statusText: 'OK'
    })

    await sendTelegramReplyWithButtons('token', 'chatId', 'Choose', buttons)()

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body)

    expect(body.reply_markup.inline_keyboard[0]).toHaveLength(3)
    expect(body.reply_markup.inline_keyboard[0][0].text).toBe('A')
    expect(body.reply_markup.inline_keyboard[0][1].text).toBe('B')
    expect(body.reply_markup.inline_keyboard[0][2].text).toBe('C')
  })

  it('validates that botToken is provided', async () => {
    const result = await sendTelegramReplyWithButtons(
      '',
      'chatId',
      'text',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('botToken')
    }
  })

  it('validates that chatId is provided', async () => {
    const result = await sendTelegramReplyWithButtons(
      'token',
      '',
      'text',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('chatId')
    }
  })

  it('validates that text is provided', async () => {
    const result = await sendTelegramReplyWithButtons(
      'token',
      'chatId',
      '',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('text')
    }
  })

  it('validates multiple missing parameters', async () => {
    const result = await sendTelegramReplyWithButtons(
      '',
      '',
      '',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.message).toContain('Missing required parameters')
      expect(result.left.message).toContain('botToken')
      expect(result.left.message).toContain('chatId')
      expect(result.left.message).toContain('text')
    }
  })

  it('does not call fetch when validation fails', async () => {
    await sendTelegramReplyWithButtons(
      '',
      'chatId',
      'text',
      [{ text: 'btn', callback_data: 'data' }]
    )()

    expect(mockFetch).not.toHaveBeenCalled()
  })
})
