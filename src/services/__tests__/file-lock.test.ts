import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { withStateLock } from '../file-lock'

describe('withStateLock', () => {
  let tempDir: string
  let lockTarget: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'))
    lockTarget = path.join(tempDir, 'state.json')
    await fs.writeFile(lockTarget, '{}', 'utf-8')
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('executes function and returns result', async () => {
    const result = await withStateLock(lockTarget, async () => 42)()
    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toBe(42)
    }
  })

  it('releases lock after function completes', async () => {
    await withStateLock(lockTarget, async () => 'first')()
    const result = await withStateLock(lockTarget, async () => 'second')()
    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toBe('second')
    }
  })

  it('releases lock even when function throws', async () => {
    await withStateLock(lockTarget, async () => {
      throw new Error('boom')
    })()

    // Should be able to acquire lock again
    const result = await withStateLock(lockTarget, async () => 'recovered')()
    expect(E.isRight(result)).toBe(true)
  })

  it('returns Left for non-existent file', async () => {
    const result = await withStateLock('/tmp/nonexistent-lock-target-xyz', async () => 42)()
    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left._tag).toBe('LockError')
    }
  })
})
