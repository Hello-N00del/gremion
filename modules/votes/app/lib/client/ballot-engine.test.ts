import { describe, it, expect, vi, afterEach } from 'vitest'

describe('loadJsCrypto', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.querySelectorAll('script[data-jscrypto]').forEach((s) => s.remove())
    vi.resetModules()
  })

  it('appends script tags for each jscrypto file', async () => {
    const originalCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = originalCreate(tag)
      setTimeout(() => el.dispatchEvent(new Event('load')), 0)
      return el
    })
    const spy = vi.spyOn(document.head, 'appendChild')

    const { loadJsCrypto } = await import('./ballot-engine')
    await loadJsCrypto('http://helios:8000')

    const scriptCalls = spy.mock.calls.filter(
      ([el]) => el instanceof HTMLScriptElement,
    )
    const srcs = scriptCalls.map(([el]) => (el as HTMLScriptElement).src)
    expect(srcs.length).toBeGreaterThan(0)

    // Guard: Helios serves the booth assets under /booth, NOT /static/heliosbooth.
    // The latter 404s for every file, which left cryptoReady false forever.
    for (const src of srcs) {
      expect(src).toMatch(/^http:\/\/helios:8000\/booth\/js\/jscrypto\/[^/]+\.js$/)
    }

    // Guard: prng4.js and rng.js are not shipped by Helios (it uses sjcl.js +
    // random.js for entropy), so requesting them can only ever 404.
    expect(srcs.filter((s) => /\/(prng4|rng)\.js$/.test(s))).toEqual([])

    // ElGamal is defined by elgamal.js and needs class.js parsed before it.
    expect(srcs.some((s) => s.endsWith('/class.js'))).toBe(true)
    expect(srcs.some((s) => s.endsWith('/elgamal.js'))).toBe(true)
  })

  it('rejects if a script fails to load', async () => {
    const originalCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = originalCreate(tag)
      setTimeout(() => el.dispatchEvent(new Event('error')), 0)
      return el
    })

    const { loadJsCrypto } = await import('./ballot-engine')
    await expect(loadJsCrypto('http://helios:8000')).rejects.toThrow('Failed to load')
  })
})

describe('buildAnswerVector', () => {
  it('produces a binary vector with 1s at selected indices', async () => {
    const { buildAnswerVector } = await import('./ballot-engine')
    const question = { answers: ['Ja', 'Nein', 'Enthaltung'], min: 1, max: 1 }
    expect(buildAnswerVector(question, [0])).toEqual([1, 0, 0])
    expect(buildAnswerVector(question, [1])).toEqual([0, 1, 0])
    expect(buildAnswerVector(question, [2])).toEqual([0, 0, 1])
  })

  it('supports multiple selections', async () => {
    const { buildAnswerVector } = await import('./ballot-engine')
    const question = { answers: ['A', 'B', 'C', 'D'], min: 1, max: 2 }
    expect(buildAnswerVector(question, [0, 3])).toEqual([1, 0, 0, 1])
  })
})
