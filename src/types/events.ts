export type IpcEvent =
  | { readonly _tag: 'SessionStart'; readonly slotNum: number; readonly projectName: string }
  | { readonly _tag: 'SessionEnd'; readonly slotNum: number }
  | { readonly _tag: 'Heartbeat'; readonly slotNum: number }
  | { readonly _tag: 'Message'; readonly text: string; readonly slotNum: number }

// Smart constructors
export const sessionStart = (slotNum: number, projectName: string): IpcEvent =>
  ({ _tag: 'SessionStart', slotNum, projectName })

export const sessionEnd = (slotNum: number): IpcEvent =>
  ({ _tag: 'SessionEnd', slotNum })

export const heartbeat = (slotNum: number): IpcEvent =>
  ({ _tag: 'Heartbeat', slotNum })

export const message = (text: string, slotNum: number): IpcEvent =>
  ({ _tag: 'Message', text, slotNum })
