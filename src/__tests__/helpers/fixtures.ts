// src/__tests__/helpers/fixtures.ts
import type { State, Slot, Config } from '../../types/state'
import type { IpcEvent } from '../../types/events'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  botToken: 'test-token',
  chatId: '-100123',
  maxSlots: 4,
  permissionTimeout: 300,
  ...overrides,
})

export const makeSlot = (sessionId: string, overrides: Partial<Slot> = {}): Slot => ({
  sessionId,
  project: 'test-project',
  topicName: 'S1 - test-project',
  started: '2026-02-26 10:00:00',
  ...overrides,
})

export const makeState = (overrides: Partial<State> = {}): State => ({
  slots: {},
  daemonPid: null,
  daemonHeartbeat: 0,
  ...overrides,
})

export const makeTmpDir = (): { dir: string; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridge-test-'))
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

export const writeIpcSession = (ipcDir: string, sessionId: string, opts: {
  meta?: boolean
  kill?: boolean
  events?: IpcEvent[]
} = {}): string => {
  const sessionDir = path.join(ipcDir, sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })

  if (opts.meta !== false) {
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
      sessionId,
      slot: '1',
      project: 'test-project',
      topicName: 'S1 - test-project',
      started: '2026-02-26T10:00:00',
    }))
  }

  if (opts.kill) {
    fs.writeFileSync(path.join(sessionDir, 'kill'), 'test kill reason')
  }

  if (opts.events) {
    // Write each event as a separate file (matching production behavior)
    opts.events.forEach((e, i) => {
      const line = JSON.stringify(e) + '\n'
      fs.writeFileSync(path.join(sessionDir, `event-fixture-${i}.jsonl`), line)
    })
  }

  return sessionDir
}
