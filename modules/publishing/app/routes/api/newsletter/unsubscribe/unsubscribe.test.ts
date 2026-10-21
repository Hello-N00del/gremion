// TASK-205c: /api/newsletter/unsubscribe is on the session guard's public list (hooks.server.ts PUBLIC_PATHS): the
// link in a sent newsletter is clicked by a recipient with no session. The single-use token is the only credential,
// so a request without a valid one must be refused and must change nothing. Pins the handler's side of that.
//
// The token is consumed by a POST only (token in a JSON body, never in the query). Mail-security scanners and
// prefetchers GET every link in a message; the mailed link opens the confirm page, and a GET of this API answers 405
// without touching the token. The route module exports POST only, so SvelteKit answers every other method 405 with
// `Allow: POST` (and its origin check on form-typed cross-site POSTs stays in front of the handler, untouched).
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

const URL_BASE = 'http://localhost/api/newsletter/unsubscribe'

function post(body: unknown, opts: { query?: string; contentType?: string | null } = {}) {
  const headers: Record<string, string> = {}
  const contentType = opts.contentType === undefined ? 'application/json' : opts.contentType
  if (contentType) headers['content-type'] = contentType
  const request = new Request(`${URL_BASE}${opts.query ?? ''}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { request, url: new URL(request.url) }
}

function callPost(body: unknown, opts: { query?: string; contentType?: string | null } = {}) {
  return mod.POST(post(body, opts) as never)
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.rateLimit.mockReturnValue(null)
  mocks.clientIp.mockReturnValue({ ip: '203.0.113.7', reason: 'ok' })
  mocks.resolveBackend.mockReturnValue({ consumeUnsubscribeToken: mocks.consumeUnsubscribeToken })
})

describe('POST /api/newsletter/unsubscribe', () => {
  it('400 without a token in the body, and the backend is never consulted', async () => {
    const bodies: Array<[string, unknown, string | null | undefined]> = [
      ['empty object', {}, undefined],
      ['empty token', { token: '' }, undefined],
      ['other field', { other: 1 }, undefined],
      ['non-string token', { token: 42 }, undefined],
      ['null token', { token: null }, undefined],
      ['array body', ['good'], undefined],
      ['not JSON', 'token=good', undefined],
      ['empty body', '', undefined],
      ['token as text/plain JSON (cross-site simple request shape)', { token: 'good' }, 'text/plain'],
      ['token as a form body', 'token=good', 'application/x-www-form-urlencoded'],
      ['no content type', { token: 'good' }, null],
    ]
    for (const [label, body, contentType] of bodies) {
      const res = await callPost(body, { contentType })
      expect(res.status, label).toBe(400)
      expect(await res.json(), label).toEqual({ ok: false })
    }
    expect(mocks.resolveBackend).not.toHaveBeenCalled()
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })

  it('a token in the query is not a token: 400, nothing consumed', async () => {
    const res = await callPost({}, { query: '?token=good' })
    expect(res.status).toBe(400)
    expect(mocks.resolveBackend).not.toHaveBeenCalled()
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })

  it('the body token wins over a query token: only the body token reaches the backend', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: false, reason: 'invalid' })
    await callPost({ token: 'from-body' }, { query: '?token=from-query' })
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledTimes(1)
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledWith('from-body')
  })

  it('404 for a token the backend does not know; the body does not say why', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: false, reason: 'invalid' })
    const res = await callPost({ token: 'forged' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false })
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledWith('forged')
  })

  it('410 for an expired token', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: false, reason: 'expired' })
    const res = await callPost({ token: 'old' })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ ok: false })
  })

  it('200 { ok: true } for a valid token, and the body never echoes the address', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: true, email: 'alice@example.org' })
    const res = await callPost({ token: 'good' })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: true })
    expect(text).not.toContain('alice')
  })

  it('a token is single-use: the backend consumes it once, the second POST gets the backend refusal (404)', async () => {
    mocks.consumeUnsubscribeToken
      .mockResolvedValueOnce({ ok: true, email: 'alice@example.org' })
      .mockResolvedValueOnce({ ok: false, reason: 'invalid' })
    const first = await callPost({ token: 'good' })
    const second = await callPost({ token: 'good' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(404)
    expect(await second.json()).toEqual({ ok: false })
  })

  it('hands the token to the backend verbatim, once per request', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: false, reason: 'invalid' })
    await callPost({ token: 'a b+c/../d' })
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledTimes(1)
    expect(mocks.consumeUnsubscribeToken).toHaveBeenCalledWith('a b+c/../d')
  })

  it('accepts a JSON content type with parameters', async () => {
    mocks.consumeUnsubscribeToken.mockResolvedValue({ ok: true, email: 'alice@example.org' })
    const res = await callPost({ token: 'good' }, { contentType: 'application/json; charset=utf-8' })
    expect(res.status).toBe(200)
  })

  it('the rate limit runs BEFORE the body is read and the token looked up: a limited caller reaches nothing', async () => {
    const limited = new Response('{"error":"rate_limited"}', { status: 429 })
    mocks.rateLimit.mockReturnValue(limited)
    const event = post({ token: 'good' })
    const res = await mod.POST(event as never)
    expect(res).toBe(limited)
    expect(event.request.bodyUsed).toBe(false)
    expect(mocks.resolveBackend).not.toHaveBeenCalled()
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })

  it('failed attempts count: a request without a token still passes through the rate limit first', async () => {
    await callPost({})
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1)
  })

  it('a 503 from the backend resolver is passed through and consumes nothing', async () => {
    const down = new Response('unavailable', { status: 503 })
    mocks.resolveBackend.mockReturnValue(down)
    const res = await callPost({ token: 'good' })
    expect(res.status).toBe(503)
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })
})

describe('other methods on /api/newsletter/unsubscribe', () => {
  it('exports POST only: GET (and HEAD, PUT, DELETE ...) get SvelteKit\'s 405 and never reach the token', () => {
    expect(Object.keys(mod)).toEqual(['POST'])
    expect(mocks.consumeUnsubscribeToken).not.toHaveBeenCalled()
  })
})
