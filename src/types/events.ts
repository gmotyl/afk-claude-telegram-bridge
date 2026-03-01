export type IpcEvent =
  | { readonly _tag: 'SessionStart'; readonly slotNum: number; readonly sessionId: string; readonly projectName: string; readonly topicName: string; readonly threadId?: number }
  | { readonly _tag: 'SessionEnd'; readonly slotNum: number }
  | { readonly _tag: 'Heartbeat'; readonly slotNum: number }
  | { readonly _tag: 'Message'; readonly text: string; readonly slotNum: number }
  | { readonly _tag: 'PermissionRequest'; readonly requestId: string; readonly tool: string; readonly command: string; readonly slotNum: number }
  | { readonly _tag: 'Stop'; readonly eventId: string; readonly slotNum: number; readonly lastMessage: string; readonly stopHookActive: boolean; readonly timestamp: string }
  | { readonly _tag: 'KeepAlive'; readonly eventId: string; readonly originalEventId: string; readonly slotNum: number; readonly timestamp: string }

// Smart constructors
export const sessionStart = (slotNum: number, sessionId: string, projectName: string, topicName: string, threadId?: number): IpcEvent =>
  ({ _tag: 'SessionStart', slotNum, sessionId, projectName, topicName, ...(threadId !== undefined ? { threadId } : {}) })

export const sessionEnd = (slotNum: number): IpcEvent =>
  ({ _tag: 'SessionEnd', slotNum })

export const heartbeat = (slotNum: number): IpcEvent =>
  ({ _tag: 'Heartbeat', slotNum })

export const message = (text: string, slotNum: number): IpcEvent =>
  ({ _tag: 'Message', text, slotNum })

export const permissionRequest = (requestId: string, tool: string, command: string, slotNum: number): IpcEvent =>
  ({ _tag: 'PermissionRequest', requestId, tool, command, slotNum })

export const stopEvent = (eventId: string, slotNum: number, lastMessage: string): IpcEvent =>
  ({ _tag: 'Stop', eventId, slotNum, lastMessage, stopHookActive: true, timestamp: new Date().toISOString() })

export const keepAlive = (eventId: string, originalEventId: string, slotNum: number): IpcEvent =>
  ({ _tag: 'KeepAlive', eventId, slotNum, originalEventId, timestamp: new Date().toISOString() })
