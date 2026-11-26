/**
 * askLinkBase: the link base of ONE send is the sending tenant's own host, asked of the kernel at
 * the start of that send. It is checked with the same rules as before (checkLinkBase) and never kept.
 */
import { describe, it, expect } from 'vitest'
import { askLinkBase, LINK_BASE_UNUSABLE_DETAIL } from '../src/link-base.ts'

function kernelAnswering(...answers: Array<string | null | Error>): {
  linkBase(): Promise<string | null>
  asked: () => number
} {
  let n = 0
  return {
    async linkBase() {
      const a = answers[Math.min(n, answers.length - 1)]
      n += 1
      if (a instanceof Error) throw a
      return a ?? null
    },
    asked: () => n,
  }
}

describe('askLinkBase', () => {
  it('returns the normalised origin the kernel answers', async () => {
    const kernel = kernelAnswering('https://a.example.org')
    expect(await askLinkBase(kernel)).toEqual({ usable: true, base: 'https://a.example.org' })
  })

  it('a tenant the kernel has no host for is unusable (missing), and the reason says so', async () => {
    const res = await askLinkBase(kernelAnswering(null))
    expect(res).toMatchObject({ usable: false, fault: 'missing' })
    expect(res.usable ? '' : res.reason).toMatch(/no public host/)
  })

  it('an answer that is not a bare origin is refused: malformed, loopback, unspecified', async () => {
    expect(await askLinkBase(kernelAnswering('https://a.example.org/app'))).toMatchObject({ usable: false, fault: 'malformed' })
    expect(await askLinkBase(kernelAnswering('http://localhost:3000'))).toMatchObject({ usable: false, fault: 'loopback' })
    expect(await askLinkBase(kernelAnswering('http://0.0.0.0'))).toMatchObject({ usable: false, fault: 'unspecified' })
  })

  it('a loopback answer is let through only when the caller says the local-development override is on', async () => {
    expect(await askLinkBase(kernelAnswering('http://localhost:3000'), { allowLoopback: true })).toEqual({
      usable: true,
      base: 'http://localhost:3000',
    })
  })

  it('a reason never blames PUBLIC_BASE_URL: the value did not come from there', async () => {
    const res = await askLinkBase(kernelAnswering('http://localhost:3000'))
    expect(res.usable ? '' : res.reason).not.toContain('PUBLIC_BASE_URL')
  })

  it('lets a kernel failure through as a failure: it is not a tenant without a host', async () => {
    await expect(askLinkBase(kernelAnswering(new Error('kernel link-base failed: 503')))).rejects.toThrow(/503/)
  })

  it('asks again on every call and keeps nothing: two tenants through one function get their own bases', async () => {
    const a = kernelAnswering('https://a.example.org')
    const b = kernelAnswering('https://b.example.org')
    expect(await askLinkBase(a)).toEqual({ usable: true, base: 'https://a.example.org' })
    expect(await askLinkBase(b)).toEqual({ usable: true, base: 'https://b.example.org' })

    const flipping = kernelAnswering('https://a.example.org', 'https://b.example.org')
    expect(await askLinkBase(flipping)).toMatchObject({ base: 'https://a.example.org' })
    expect(await askLinkBase(flipping)).toMatchObject({ base: 'https://b.example.org' })
    expect(flipping.asked()).toBe(2)
  })

  it('exports the detail string the unusable-base result carries, which the scheduler recognises', () => {
    expect(LINK_BASE_UNUSABLE_DETAIL).toBe('unusable public base URL')
  })
})
