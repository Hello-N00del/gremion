// SvelteKit's built-in CSRF check only covers form content types, so a
// cross-site POST with no Content-Type (or text/plain) skips it while
// `request.json()` still parses the body. csrfOriginGuard closes that for every
// cookie-authenticated state-changing /api/ request.
import { describe, it, expect, vi } from 'vitest'
import { csrfOriginGuard } from './csrf-origin-guard'

const ORIGIN = 'https://tenant-a.example.org'

function run(opts: { method?: string; path?: string; headers?: Record<string, string>; decodedPath?: string } = {}) {
  const { method = 'POST', path = '/api/settings/reset', headers = { cookie: 'authjs.session-token=abc' } } = opts
  const resolve = vi.fn(async () => new Response('ok'))
  const url = new URL(`${ORIGIN}${path}`)
  const event = {
    url,
    request: new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' }),
    locals: { decodedPath: opts.decodedPath ?? decodeURI(url.pathname) },
  }
  return { resolve, res: csrfOriginGuard({ event, resolve } as never) as Promise<Response> }
}

const cookie = { cookie: 'authjs.session-token=abc' }

describe('csrfOriginGuard', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s with a cross-site Origin (403)', async (method) => {
    const { resolve, res } = run({ method, headers: { ...cookie, origin: 'https://evil.example.org' } })
    expect((await res).status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a sibling-tenant Origin on the same registrable domain', async () => {
    const { resolve, res } = run({ headers: { ...cookie, origin: 'https://tenant-b.example.org' } })
    expect((await res).status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses Origin: null', async () => {
    const { res } = run({ headers: { ...cookie, origin: 'null' } })
    expect((await res).status).toBe(403)
  })

  it('refuses a scheme or port mismatch', async () => {
    expect((await run({ headers: { ...cookie, origin: 'http://tenant-a.example.org' } }).res).status).toBe(403)
    expect((await run({ headers: { ...cookie, origin: `${ORIGIN}:8443` } }).res).status).toBe(403)
  })

  it('passes a same-origin Origin', async () => {
    const { resolve, res } = run({ headers: { ...cookie, origin: ORIGIN, 'content-type': 'application/json' } })
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('passes a same-origin multipart upload', async () => {
    const { res } = run({ path: '/api/files', headers: { ...cookie, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' } })
    expect((await res).status).toBe(200)
  })

  it('no Origin + Sec-Fetch-Site same-site -> 403', async () => {
    const { resolve, res } = run({ headers: { ...cookie, 'sec-fetch-site': 'same-site' } })
    expect((await res).status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('no Origin + Sec-Fetch-Site cross-site -> 403', async () => {
    expect((await run({ headers: { ...cookie, 'sec-fetch-site': 'cross-site' } }).res).status).toBe(403)
  })

  it('no Origin + Sec-Fetch-Site same-origin -> passes', async () => {
    expect((await run({ headers: { ...cookie, 'sec-fetch-site': 'same-origin' } }).res).status).toBe(200)
  })

  it('cookie request with neither Origin nor Sec-Fetch-Site -> 403', async () => {
    expect((await run({}).res).status).toBe(403)
  })

  it('Origin wins over Sec-Fetch-Site', async () => {
    const { res } = run({ headers: { ...cookie, origin: 'https://evil.example.org', 'sec-fetch-site': 'same-origin' } })
    expect((await res).status).toBe(403)
  })

  it('exempts Bearer requests (any Origin)', async () => {
    const { resolve, res } = run({ headers: { authorization: 'Bearer abc.def.ghi', origin: 'https://evil.example.org' } })
    expect((await res).status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('exempts the internal Bearer (no Origin, no cookie)', async () => {
    const { res } = run({ path: '/api/internal/evict', headers: { authorization: 'Bearer secret' } })
    expect((await res).status).toBe(200)
  })

  it('does not exempt a cookie request that merely sends a non-Bearer Authorization', async () => {
    const { res } = run({ headers: { ...cookie, authorization: 'Basic abc', origin: 'https://evil.example.org' } })
    expect((await res).status).toBe(403)
  })

  it('leaves a cookie-less request alone (no session to ride; e.g. the seed token endpoint)', async () => {
    const { res } = run({ path: '/api/setup/seed', headers: { 'x-seed-token': 't' } })
    expect((await res).status).toBe(200)
  })

  it.each(['GET', 'HEAD'])('leaves %s unaffected', async (method) => {
    const { res } = run({ method, headers: { ...cookie, origin: 'https://evil.example.org' } })
    expect((await res).status).toBe(200)
  })

  it('leaves non-/api/ paths to SvelteKit', async () => {
    const { res } = run({ path: '/auth/signin/keycloak', headers: { ...cookie, origin: 'https://evil.example.org' } })
    expect((await res).status).toBe(200)
  })

  it('matches on the decoded path (/api/fin%61nce is /api/finance)', async () => {
    const { res } = run({ path: '/api/fin%61nce/x', headers: { ...cookie, origin: 'https://evil.example.org' } })
    expect((await res).status).toBe(403)
  })

  it('answers the refusal as JSON with no body leak', async () => {
    const res = await run({ headers: { ...cookie, origin: 'https://evil.example.org' } }).res
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

describe('hook chain wiring', () => {
  it('csrfOriginGuard sits in handle = sequence(...) after requestPathHandle and before tenant resolution', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(`${process.cwd()}/src/hooks.server.ts`, 'utf8')
    const chain = src.slice(src.indexOf('export const handle = sequence('))
    const order = ['requestPathHandle', 'csrfOriginGuard', 'tenantResolveHandle', 'authGuard'].map((n) => chain.indexOf(n))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})
