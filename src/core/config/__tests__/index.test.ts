import { loadConfig, getConfigPath } from '../index'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as E from 'fp-ts/Either'
import { Config } from '../../../types/config'

describe('getConfigPath', () => {
  it('returns config.json path in the given base directory', () => {
    const basePath = '/app'
    const result = getConfigPath(basePath)
    expect(result).toBe(path.join(basePath, 'config.json'))
  })

  it('works with relative paths', () => {
    const result = getConfigPath('.')
    expect(result).toBe(path.join('.', 'config.json'))
  })
})

describe('loadConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-loader-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loads valid config from JSON file', () => {
    const configPath = path.join(tmpDir, 'config.json')
    const validConfig = {
      telegramBotToken: 'test-token-123',
      telegramGroupId: -1001234567890,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    fs.writeFileSync(configPath, JSON.stringify(validConfig))

    const result = loadConfig(configPath)

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.telegramBotToken).toBe('test-token-123')
      expect(result.right.telegramGroupId).toBe(-1001234567890)
      expect(result.right.ipcBaseDir).toBe('/tmp/ipc')
      expect(result.right.sessionTimeout).toBe(300000)
    }
  })

  it('returns Left error if file does not exist', () => {
    const configPath = path.join(tmpDir, 'nonexistent.json')

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left).toBeInstanceOf(Error)
    }
  })

  it('returns Left error if JSON is invalid', () => {
    const configPath = path.join(tmpDir, 'invalid.json')
    fs.writeFileSync(configPath, 'not valid json {invalid')

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SyntaxError)
    }
  })

  it('validates that config has telegramBotToken field', () => {
    const configPath = path.join(tmpDir, 'missing-token.json')
    const incompleteConfig = {
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
      // missing telegramBotToken
    }

    fs.writeFileSync(configPath, JSON.stringify(incompleteConfig))

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
  })

  it('validates that config has telegramGroupId field', () => {
    const configPath = path.join(tmpDir, 'missing-groupid.json')
    const incompleteConfig = {
      telegramBotToken: 'token',
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
      // missing telegramGroupId
    }

    fs.writeFileSync(configPath, JSON.stringify(incompleteConfig))

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
  })

  it('provides default ipcBaseDir when missing', () => {
    const configPath = path.join(tmpDir, 'missing-ipcdir.json')
    const incompleteConfig = {
      telegramBotToken: 'token',
      telegramGroupId: 12345,
      sessionTimeout: 300000
    }

    fs.writeFileSync(configPath, JSON.stringify(incompleteConfig))

    const result = loadConfig(configPath)

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.ipcBaseDir).toBe(path.join(tmpDir, 'ipc'))
    }
  })

  it('provides default sessionTimeout when missing', () => {
    const configPath = path.join(tmpDir, 'missing-timeout.json')
    const incompleteConfig = {
      telegramBotToken: 'token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc'
    }

    fs.writeFileSync(configPath, JSON.stringify(incompleteConfig))

    const result = loadConfig(configPath)

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.sessionTimeout).toBe(86400000)
    }
  })

  it('validates field types - telegramBotToken must be string', () => {
    const configPath = path.join(tmpDir, 'bad-token-type.json')
    const badConfig = {
      telegramBotToken: 12345, // should be string
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    fs.writeFileSync(configPath, JSON.stringify(badConfig))

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
  })

  it('validates field types - telegramGroupId must be number', () => {
    const configPath = path.join(tmpDir, 'bad-groupid-type.json')
    const badConfig = {
      telegramBotToken: 'token',
      telegramGroupId: '12345', // should be number
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    fs.writeFileSync(configPath, JSON.stringify(badConfig))

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
  })

  it('validates field types - ipcBaseDir must be string', () => {
    const configPath = path.join(tmpDir, 'bad-ipcdir-type.json')
    const badConfig = {
      telegramBotToken: 'token',
      telegramGroupId: 12345,
      ipcBaseDir: 123, // should be string
      sessionTimeout: 300000
    }

    fs.writeFileSync(configPath, JSON.stringify(badConfig))

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
  })

  it('validates field types - sessionTimeout must be number', () => {
    const configPath = path.join(tmpDir, 'bad-timeout-type.json')
    const badConfig = {
      telegramBotToken: 'token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: '300000' // should be number
    }

    fs.writeFileSync(configPath, JSON.stringify(badConfig))

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
  })

  it('returns Either type that can be pattern matched', () => {
    const configPath = path.join(tmpDir, 'config.json')
    const validConfig: Config = {
      telegramBotToken: 'token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    fs.writeFileSync(configPath, JSON.stringify(validConfig))

    const result = loadConfig(configPath)
    let matched = false

    if (E.isRight(result)) {
      matched = result.right.telegramBotToken === 'token'
    }

    expect(matched).toBe(true)
  })

  it('handles empty config file', () => {
    const configPath = path.join(tmpDir, 'empty.json')
    fs.writeFileSync(configPath, '')

    const result = loadConfig(configPath)

    expect(E.isLeft(result)).toBe(true)
  })

  it('ignores extra fields in config', () => {
    const configPath = path.join(tmpDir, 'extra-fields.json')
    const configWithExtra = {
      telegramBotToken: 'token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000,
      extraField: 'should be ignored',
      anotherExtra: 42
    }

    fs.writeFileSync(configPath, JSON.stringify(configWithExtra))

    const result = loadConfig(configPath)

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.telegramBotToken).toBe('token')
    }
  })
})
