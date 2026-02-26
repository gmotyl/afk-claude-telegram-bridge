export interface Config {
  readonly telegramBotToken: string
  readonly telegramGroupId: number
  readonly ipcBaseDir: string
  readonly sessionTimeout: number // milliseconds
}
