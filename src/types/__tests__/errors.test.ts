// src/types/__tests__/errors.test.ts
import * as E from '../errors'

describe('IPC Errors', () => {
  it('creates IpcReadError with correct _tag', () => {
    const error = E.ipcReadError('path/to/file', new Error('ENOENT'))
    expect(error._tag).toBe('IpcReadError')
    expect(error.path).toBe('path/to/file')
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('creates IpcWriteError with correct _tag', () => {
    const error = E.ipcWriteError('path/to/file', new Error('EACCES'))
    expect(error._tag).toBe('IpcWriteError')
    expect(error.path).toBe('path/to/file')
  })

  it('creates IpcParseError with content', () => {
    const error = E.ipcParseError('path/file.json', '{bad json', new Error('Unexpected token'))
    expect(error._tag).toBe('IpcParseError')
    expect(error.path).toBe('path/file.json')
    expect(error.content).toBe('{bad json')
  })
})

describe('Telegram Errors', () => {
  it('creates TelegramApiError with status', () => {
    const error = E.telegramApiError(404, 'Chat not found')
    expect(error._tag).toBe('TelegramApiError')
    expect(error.status).toBe(404)
    expect(error.message).toBe('Chat not found')
  })

  it('creates TelegramTopicError', () => {
    const error = E.telegramTopicError(999, 'deleted')
    expect(error._tag).toBe('TelegramTopicError')
    expect(error.threadId).toBe(999)
    expect(error.reason).toBe('deleted')
  })
})

describe('Business Errors', () => {
  it('creates StateError', () => {
    const error = E.stateError('Invalid state transition', { current: 'active', next: 'pending' })
    expect(error._tag).toBe('StateError')
    expect(error.message).toBe('Invalid state transition')
    expect(error.details).toEqual({ current: 'active', next: 'pending' })
  })

  it('creates ValidationError', () => {
    const error = E.validationError('email', 'Invalid format')
    expect(error._tag).toBe('ValidationError')
    expect(error.field).toBe('email')
    expect(error.message).toBe('Invalid format')
  })

  it('creates SlotError', () => {
    const error = E.slotError('S1', 'Slot already occupied')
    expect(error._tag).toBe('SlotError')
    expect(error.slotNum).toBe('S1')
    expect(error.message).toBe('Slot already occupied')
  })
})

describe('Error Message Generation', () => {
  it('generates message for IpcReadError', () => {
    const error = E.ipcReadError('state.json', new Error('ENOENT: no such file'))
    const msg = E.errorMessage(error)
    expect(msg).toContain('Failed to read state.json')
    expect(msg).toContain('ENOENT')
  })

  it('generates message for TelegramApiError', () => {
    const error = E.telegramApiError(500, 'Internal server error')
    const msg = E.errorMessage(error)
    expect(msg).toContain('Telegram API error')
    expect(msg).toContain('(500)')
    expect(msg).toContain('Internal server error')
  })

  it('generates message for ValidationError', () => {
    const error = E.validationError('password', 'Too short')
    const msg = E.errorMessage(error)
    expect(msg).toContain('Validation failed')
    expect(msg).toContain('password')
    expect(msg).toContain('Too short')
  })
})

describe('Error Status Codes', () => {
  it('returns 400 for ValidationError', () => {
    const error = E.validationError('field', 'Invalid')
    expect(E.errorStatusCode(error)).toBe(400)
  })

  it('returns 404 for TelegramTopicError', () => {
    const error = E.telegramTopicError(123, 'deleted')
    expect(E.errorStatusCode(error)).toBe(404)
  })

  it('returns API status for TelegramApiError', () => {
    const error = E.telegramApiError(503, 'Service unavailable')
    expect(E.errorStatusCode(error)).toBe(503)
  })

  it('returns 500 for StateError', () => {
    const error = E.stateError('Invalid transition')
    expect(E.errorStatusCode(error)).toBe(500)
  })

  it('returns 500 for IpcWriteError', () => {
    const error = E.ipcWriteError('state.json', new Error('Write failed'))
    expect(E.errorStatusCode(error)).toBe(500)
  })
})

describe('BridgeError Union', () => {
  it('accepts all error types in BridgeError', () => {
    const errors: E.BridgeError[] = [
      E.ipcReadError('x', new Error()),
      E.telegramApiError(500, 'Error'),
      E.validationError('field', 'Invalid'),
      E.stateError('Bad'),
      E.slotError('S1', 'Busy'),
    ]

    expect(errors).toHaveLength(5)
    errors.forEach(err => {
      const msg = E.errorMessage(err)
      expect(msg).toBeTruthy()
      expect(E.errorStatusCode(err)).toBeGreaterThan(0)
    })
  })

  it('pattern matches with _tag', () => {
    const err: E.BridgeError = E.ipcReadError('file', new Error('test'))

    if (err._tag === 'IpcReadError') {
      expect(err.path).toBe('file')
    } else {
      throw new Error('Should be IpcReadError')
    }
  })
})
