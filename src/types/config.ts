export interface Config {
  readonly telegramBotToken: string
  readonly telegramGroupId: number
  readonly ipcBaseDir: string
  readonly sessionTimeout: number // milliseconds
  readonly autoApproveTools?: readonly string[]
  readonly autoApprovePaths?: readonly string[]
  readonly permissionBatchWindowMs?: number     // default: 2000
  readonly sessionTrustThreshold?: number       // default: 3
}
