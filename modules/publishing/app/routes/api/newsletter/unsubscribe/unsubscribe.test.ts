// TASK-205c: /api/newsletter/unsubscribe is on the session guard's public list (hooks.server.ts PUBLIC_PATHS): the
// link in a sent newsletter is clicked by a recipient with no session. The single-use token is the only credential,
// so a request without a valid one must be refused and must change nothing. Pins the handler's side of that.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  consumeUnsubscribeToken: vi.fn(),
  resolveBackend: vi.fn(),
  rateLimit: vi.fn(),
  clientIp: vi.fn(),
}))

vi.mock('$lib/server/newsletter/backend/resolve', () => ({ resolveNewsletterBackendOr503: mocks.resolveBackend }))
vi.mock('$lib/server/rate-limit', () => ({ requireUnsubscribeRateLimit: mocks.rateLimit }))
vi.mock('$lib/server/client-ip', () => ({ clientIpWithReason: mocks.clientIp }))

const mod = await import('./+server')

function call(query: string) {
  return mod.GET({ url: new URL(`http://localhost/api/newsletter/unsubscribe${query}`) } as never)
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.rateLimit.mockReturnValue(null)
  mocks.clientIp.mockReturnValue({ ip: '203.0.113.7', reason: 'ok' })
  mocks.resolveBackend.mockReturnValue({ consumeUnsubscribeToken: mocks.consumeUnsubscribeToken })
})

describe('GET /api/newsletter/unsubscribe', () => {
  it('400 without a token, and the backend is never consulted', async () => {
    for (const q of ['', '?token=', '?other=1']) {
      const res = await call(q)
      expect(res.status, q).toBe(400)
      expect(await res.json()).toEqual({ ok: false })
    }
    expect(mocks.resolveBackend).not.toHaveBeenCalled()
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })

  it('404 for a token the backend does not know; the body does not say why', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: false, reason: 'invalid' })
    const res = await call('?token=forged')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false })
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledWith('forged')
  })

  it('410 for an expired token', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: false, reason: 'expired' })
    const res = await call('?token=old')
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ ok: false })
  })

  it('200 { ok: true } for a valid token, and the body never echoes the address', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: true, email: 'alice@example.org' })
    const res = await call('?token=good')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: true })
    expect(text).not.toContain('alice')
  })

  it('hands the token to the backend verbatim, once per request', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: false, reason: 'invalid' })
    await call(`?token=${encodeURIComponent('a b+c/../d')}`)
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledTimes(1)
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledWith('a b+c/../d')
  })

  it('the rate limit runs BEFORE the token lookup: a limited caller reaches nothing', async () => {
    const limited = new Response('{"error":"rate_limited"}', { status: 429 })
    mocks.rateLimit.mockReturnValue(limited)
    const res = await call('?token=good')
    expect(res).toBe(limited)
    expect(mocks.resolveBackend).not.toHaveBeenCalled()
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })

  it('a 503 from the backend resolver is passed through and consumes nothing', async () => {
    const down = new Response('unavailable', { status: 503 })
    mocks.resolveBackend.mockReturnValue(down)
    const res = await call('?token=good')
    expect(res.status).toBe(503)
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })

  it('exposes GET only (no second verb to reach the token)', () => {
    expect(Object.keys(mod)).toEqual(['GET'])
  })
})
