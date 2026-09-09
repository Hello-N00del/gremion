import { describe, it, expect } from 'vitest'
import { withUnitLock } from './mutex'

describe('withUnitLock', () => {
  it('serializes concurrent callers for the same key', async () => {
    const order: string[] = []
    const slow = (t: string) =>
      withUnitLock('A', async () => {
        order.push(`${t}:start`)
        await new Promise((r) => setTimeout(r, 20))
        order.push(`${t}:end`)
      })
    await Promise.all([slow('a'), slow('b')])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('does not serialize different keys', async () => {
    const order: string[] = []
    await Promise.all([
      withUnitLock('x', async () => {
        order.push('x:start')
        await new Promise((r) => setTimeout(r, 20))
        order.push('x:end')
      }),
      withUnitLock('y', async () => {
        order.push('y:start')
        await new Promise((r) => setTimeout(r, 20))
        order.push('y:end')
      }),
    ])
    expect(order.slice(0, 2).sort()).toEqual(['x:start', 'y:start'])
  })
})
