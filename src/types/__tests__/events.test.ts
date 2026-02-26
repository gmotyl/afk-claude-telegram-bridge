import * as events from '../events'

describe('IpcEvent', () => {
  it('SessionStart event has correct shape', () => {
    const event = events.sessionStart(1, 'metro')
    expect(event._tag).toBe('SessionStart')
    expect(event.slotNum).toBe(1)
    if (event._tag === 'SessionStart') {
      expect(event.projectName).toBe('metro')
    }
  })

  it('SessionEnd event has correct shape', () => {
    const event = events.sessionEnd(2)
    expect(event._tag).toBe('SessionEnd')
    expect(event.slotNum).toBe(2)
  })

  it('Heartbeat event has correct shape', () => {
    const event = events.heartbeat(3)
    expect(event._tag).toBe('Heartbeat')
    expect(event.slotNum).toBe(3)
  })

  it('Message event has correct shape', () => {
    const event = events.message('hello world', 4)
    expect(event._tag).toBe('Message')
    expect(event.slotNum).toBe(4)
    if (event._tag === 'Message') {
      expect(event.text).toBe('hello world')
    }
  })

  it('SessionStart can be stringified to JSON', () => {
    const event = events.sessionStart(1, 'metro')
    const json = JSON.stringify(event)
    const parsed = JSON.parse(json)
    expect(parsed._tag).toBe('SessionStart')
    expect(parsed.slotNum).toBe(1)
    expect(parsed.projectName).toBe('metro')
  })
})
