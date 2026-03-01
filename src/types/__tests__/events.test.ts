import * as events from '../events'

describe('IpcEvent', () => {
  it('SessionStart event has correct shape', () => {
    const event = events.sessionStart(1, 'sess-1', 'metro', 'metro')
    expect(event._tag).toBe('SessionStart')
    if (event._tag === 'SessionStart') {
      expect(event.slotNum).toBe(1)
      expect(event.sessionId).toBe('sess-1')
      expect(event.projectName).toBe('metro')
      expect(event.topicName).toBe('metro')
    }
  })

  it('SessionEnd event has correct shape', () => {
    const event = events.sessionEnd(2)
    expect(event._tag).toBe('SessionEnd')
    if (event._tag === 'SessionEnd') {
      expect(event.slotNum).toBe(2)
    }
  })

  it('Heartbeat event has correct shape', () => {
    const event = events.heartbeat(3)
    expect(event._tag).toBe('Heartbeat')
    if (event._tag === 'Heartbeat') {
      expect(event.slotNum).toBe(3)
    }
  })

  it('Message event has correct shape', () => {
    const event = events.message('hello world', 4)
    expect(event._tag).toBe('Message')
    if (event._tag === 'Message') {
      expect(event.slotNum).toBe(4)
      expect(event.text).toBe('hello world')
    }
  })

  it('PermissionRequest event has correct shape', () => {
    const event = events.permissionRequest('uuid-123', 'Bash', 'npm install', 2)
    expect(event._tag).toBe('PermissionRequest')
    if (event._tag === 'PermissionRequest') {
      expect(event.requestId).toBe('uuid-123')
      expect(event.tool).toBe('Bash')
      expect(event.command).toBe('npm install')
      expect(event.slotNum).toBe(2)
    }
  })

  it('Stop event has correct shape', () => {
    const event = events.stopEvent('evt-1', 1, 'last msg')
    expect(event._tag).toBe('Stop')
    if (event._tag === 'Stop') {
      expect(event.eventId).toBe('evt-1')
      expect(event.slotNum).toBe(1)
      expect(event.lastMessage).toBe('last msg')
      expect(event.stopHookActive).toBe(true)
      expect(typeof event.timestamp).toBe('string')
    }
  })

  it('KeepAlive event has correct shape', () => {
    const event = events.keepAlive('ka-1', 'evt-1', 2)
    expect(event._tag).toBe('KeepAlive')
    if (event._tag === 'KeepAlive') {
      expect(event.eventId).toBe('ka-1')
      expect(event.originalEventId).toBe('evt-1')
      expect(event.slotNum).toBe(2)
      expect(typeof event.timestamp).toBe('string')
    }
  })

  it('SessionStart can be stringified to JSON', () => {
    const event = events.sessionStart(1, 'sess-1', 'metro', 'metro')
    const json = JSON.stringify(event)
    const parsed = JSON.parse(json)
    expect(parsed._tag).toBe('SessionStart')
    expect(parsed.slotNum).toBe(1)
    expect(parsed.projectName).toBe('metro')
  })

  it('Stop event can be stringified to JSON', () => {
    const event = events.stopEvent('evt-1', 1, 'test message')
    const json = JSON.stringify(event)
    const parsed = JSON.parse(json)
    expect(parsed._tag).toBe('Stop')
    expect(parsed.eventId).toBe('evt-1')
    expect(parsed.slotNum).toBe(1)
    expect(parsed.lastMessage).toBe('test message')
    expect(parsed.stopHookActive).toBe(true)
    expect(parsed.timestamp).toBeDefined()
  })
})
