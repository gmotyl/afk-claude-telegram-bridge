import { isDaemonAlive } from '../daemon-launcher'

describe('isDaemonAlive', () => {
  it('returns true for current process', () => {
    expect(isDaemonAlive(process.pid)).toBe(true)
  })

  it('returns false for non-existent PID', () => {
    // PID 99999999 is almost certainly not running
    expect(isDaemonAlive(99999999)).toBe(false)
  })
})
