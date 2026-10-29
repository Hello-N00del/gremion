import { describe, test, expect, vi } from 'vitest'
vi.mock('$app/paths', () => ({ base: '' }))
import { moduleOffPageResponse } from './module-off-response'

type Ev = Parameters<typeof moduleOffPageResponse>[0]
const ev = (o: { method?: string; data?: boolean; fetch?: () => Promise<Response> }) =>
  ({
    request: new Request('http://localhost/files', { method: o.method ?? 'GET', headers: { accept: 'text/html' } }),
    isDataRequest: o.data ?? false,
    fetch: o.fetch ?? (async () => new Response('<html>shell Modul nicht aktiv</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
  }) as unknown as Ev

describe('moduleOffPageResponse', () => {
  test('document request: 403 carrying the notice page body, never cached', async () => {
    const res = await moduleOffPageResponse(ev({}), 'files')
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toContain('Modul nicht aktiv')
  })

  test('fetches the notice route for the module id, url-encoded', async () => {
    const f = vi.fn(async (_u: string) => new Response('x'))
    await moduleOffPageResponse(ev({ fetch: f as never }), 'a/b')
    expect(f.mock.calls[0]![0]).toBe('/module-off/a%2Fb')
  })

  test('forwarded response keeps set-cookie, drops the stale content-length, stays no-store', async () => {
    const inner = new Response('<html>Modul nicht aktiv</html>', { status: 200, headers: { 'content-type': 'text/html', 'content-length': '999' } })
    inner.headers.append('set-cookie', 'a=1; Path=/; HttpOnly')
    inner.headers.append('set-cookie', 'b=2; Path=/')
    inner.headers.set('cache-control', 'public, max-age=600')
    const res = await moduleOffPageResponse(ev({ fetch: async () => inner }), 'files')
    expect(res.status).toBe(403)
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/'])
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('carries the edge host + proxy-trust headers to the in-process fetch, only when present', async () => {
    const f = vi.fn(async (_u: string, _init?: RequestInit) => new Response('x'))
    const withEdge = ev({ fetch: f as never })
    withEdge.request.headers.set('x-forwarded-host', 'tenant.example.org')
    withEdge.request.headers.set('x-proxy-trust', 'proof')
    await moduleOffPageResponse(withEdge, 'files')
    expect(f.mock.calls[0]![1]!.headers).toMatchObject({ 'x-forwarded-host': 'tenant.example.org', 'x-proxy-trust': 'proof', accept: 'text/html' })
    f.mockClear()
    await moduleOffPageResponse(ev({ fetch: f as never }), 'files')
    expect(f.mock.calls[0]![1]!.headers).toEqual({ accept: 'text/html' })
  })

  test('HEAD: 403 with the notice headers and no body', async () => {
    const res = await moduleOffPageResponse(ev({ method: 'HEAD' }), 'files')
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.body).toBeNull()
  })

  test('__data.json request: JSON 403 whose body is the message string, no module data', async () => {
    const f = vi.fn()
    const res = await moduleOffPageResponse(ev({ data: true, fetch: f as never }), 'files')
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toBe('module-disabled:files')
    expect(f).not.toHaveBeenCalled()
  })

  test('non-GET: bare 403', async () => {
    const res = await moduleOffPageResponse(ev({ method: 'POST' }), 'files')
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Module disabled')
  })

  test('notice route failing or throwing: still a 403, never a 200 or 500', async () => {
    const bad = await moduleOffPageResponse(ev({ fetch: async () => new Response('x', { status: 500 }) }), 'files')
    expect(bad.status).toBe(403)
    const boom = await moduleOffPageResponse(ev({ fetch: async () => { throw new Error('x') } }), 'files')
    expect(boom.status).toBe(403)
    expect(await boom.text()).toBe('Module disabled')
  })
})
