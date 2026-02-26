import { Config } from '../config'

describe('Config', () => {
  it('has required string fields', () => {
    const config: Config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    expect(config.telegramBotToken).toBe('test-token')
    expect(config.telegramGroupId).toBe(12345)
    expect(config.ipcBaseDir).toBe('/tmp/ipc')
    expect(config.sessionTimeout).toBe(300000)
  })

  it('is readonly (immutability enforced by TypeScript)', () => {
    const config: Config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 12345,
      ipcBaseDir: '/tmp/ipc',
      sessionTimeout: 300000
    }

    // @ts-expect-error - readonly property
    config.telegramBotToken = 'modified'

    // If this test passes, mutation is prevented at compile time
    expect(true).toBe(true)
  })
})
