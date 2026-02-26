import * as either from '../either'

describe('either utilities', () => {
  it('ok is an alias for E.right', () => {
    const result = either.ok(42)
    expect(result._tag).toBe('Right')
    expect((result as any).right).toBe(42)
  })

  it('err is an alias for E.left', () => {
    const result = either.err('error message')
    expect(result._tag).toBe('Left')
    expect((result as any).left).toBe('error message')
  })

  it('isOk detects Right values', () => {
    const right = either.ok(42)
    const left = either.err('error')
    expect(either.isOk(right)).toBe(true)
    expect(either.isOk(left)).toBe(false)
  })

  it('isErr detects Left values', () => {
    const right = either.ok(42)
    const left = either.err('error')
    expect(either.isErr(right)).toBe(false)
    expect(either.isErr(left)).toBe(true)
  })

  it('fold handles both Right and Left cases', () => {
    const right = either.ok(42)
    const left = either.err('error')

    const resultRight = either.fold(
      (err: string) => `Error: ${err}`,
      (val: number) => `Success: ${val}`
    )(right)
    expect(resultRight).toBe('Success: 42')

    const resultLeft = either.fold(
      (err: string) => `Error: ${err}`,
      (val: number) => `Success: ${val}`
    )(left)
    expect(resultLeft).toBe('Error: error')
  })

  it('mapError transforms Left values', () => {
    const left = either.err('original')
    const result = either.mapError((e: string) => `mapped: ${e}`)(left)
    expect((result as any).left).toBe('mapped: original')
  })

  it('unwrapOr provides default for Left', () => {
    const right = either.ok(42)
    const left = either.err('error')

    expect(either.unwrapOr(() => 0)(right)).toBe(42)
    expect(either.unwrapOr(() => 0)(left)).toBe(0)
  })

  it('pipe is available for composition', () => {
    // Just verify it exists and is callable
    expect(typeof either.pipe).toBe('function')
  })
})
