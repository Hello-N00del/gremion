import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route pins its upstream to ELEMENT_CALL_INTERNAL_URL at module load, so the
// env mock must be hoisted above the dynamic import of the handler.
const UPSTREAM = 'http://element-call:8080'
vi.mock('$env/dynamic/private', () => ({ env: { ELEMENT_CALL_INTERNAL_URL: 'http://element-call:8080' } }))

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  // Default: a benign upstream reply, so a rejection test that WRONGLY reaches
  // fetch fails on the assertion (400 vs 200) rather than on a nullish response.
  fetchMock.mockResolvedValue(
    new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

async function call(path: string, search = '') {
  const { GET } = await import('./+server')
  return GET({
    params: { path },
    url: new URL(`http://localhost/element-call${search}`),
  } as never)
}

/** Every upstream URL this handler actually fetched, in call order. */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map(([target]) => String(target))
}

// audit #461 / netcup T03: this route is reachable PRE-AUTH and the container can
// reach 169.254.169.254. `new URL('/' + path, base)` lets a leading `/` or a
// backslash produce a protocol-relative URL that escapes the pinned origin.
describe('GET /element-call/[...path] — origin pin', () => {
  // SvelteKit hands the handler the DECODED rest parameter, so a request for
  // `/element-call/%5Cevil.com` arrives here as `\evil.com` — the first row
  // below IS the percent-encoded attack as the handler actually sees it.
  const hostile: Array<[label: string, path: string]> = [
    ['a backslash-prefixed authority', '\\evil.com'],
    ['a backslash-prefixed authority with a trailing slash', '\\\\evil.com/x'],
    ['a slash-prefixed authority (protocol-relative)', '/evil.com'],
    ['an embedded backslash', 'a\\b'],
    ['a parent-directory traversal', '../x'],
    ['a nested parent-directory traversal', 'assets/../../etc/passwd'],
  ]

  for (const [label, path] of hostile) {
    it(`rejects ${label} (${JSON.stringify(path)}) with 400 and never fetches`, async () => {
      const res = await call(path)
      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }

  // The pin is the LAST line of defence: whatever the path validator let past,
  // the outbound request must still carry the configured upstream's origin and
  // the whole supplied path must land in the URL's path component — never in
  // its authority, query or fragment.
  const pinned: Array<[label: string, path: string, expected: string]> = [
    ['a plain asset path', 'assets/app.js', `${UPSTREAM}/assets/app.js`],
    ['a path holding a literal question mark', 'a?b.js', `${UPSTREAM}/a%3Fb.js`],
    ['a path holding a literal hash', 'a#b.js', `${UPSTREAM}/a%23b.js`],
    ['a path holding a literal at-sign', 'a@evil.com', `${UPSTREAM}/a%40evil.com`],
    ['an inner double slash', 'a//evil.com', `${UPSTREAM}/a//evil.com`],
  ]

  for (const [label, path, expected] of pinned) {
    it(`pins ${label} (${JSON.stringify(path)}) to the configured upstream`, async () => {
      const res = await call(path)
      expect(res.status).toBe(200)
      expect(fetchedUrls()).toEqual([expected])
      for (const u of fetchedUrls()) expect(new URL(u).origin).toBe(UPSTREAM)
    })
  }

  it('proxies a normal asset path to the pinned upstream with redirect:manual', async () => {
    fetchMock.mockResolvedValue(
      new Response('console.log(1)', {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      }),
    )

    const res = await call('assets/app.js', '?v=1')

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined]
    expect(new URL(String(target)).origin).toBe(UPSTREAM)
    expect(String(target)).toBe(`${UPSTREAM}/assets/app.js?v=1`)
    // An upstream 3xx must NOT be auto-followed — that would re-open the escape
    // the origin pin just closed.
    expect(init?.redirect).toBe('manual')
  })
})

// SvelteKit has ALREADY percent-decoded params.path. Decoding it a second time
// rejects legitimate names that contain a literal '%' and invents a string the
// upstream never sees. Decode once; re-encode each segment on the way out.
describe('GET /element-call/[...path] — single decode', () => {
  it('proxies an asset name containing a literal percent sign', async () => {
    const res = await call('assets/100%.png')
    expect(res.status).toBe(200)
    expect(fetchedUrls()).toEqual([`${UPSTREAM}/assets/100%25.png`])
  })

  it('proxies an asset name containing a literal plus and space', async () => {
    const res = await call('assets/a b+c.png')
    expect(res.status).toBe(200)
    expect(fetchedUrls()).toEqual([`${UPSTREAM}/assets/a%20b%2Bc.png`])
  })

  // A DOUBLE-encoded backslash reaches the handler as the literal text
  // "%5Cevil.com" (SvelteKit decoded the outer layer). That is a file name, not
  // an authority: it must be re-encoded into the path, never decoded a second
  // time into a `\` that the URL parser would fold into an origin escape.
  it('treats a literal "%5C" as a file name, not an authority', async () => {
    const res = await call('%5Cevil.com')
    expect(res.status).toBe(200)
    expect(fetchedUrls()).toEqual([`${UPSTREAM}/%255Cevil.com`])
    expect(new URL(fetchedUrls()[0]).origin).toBe(UPSTREAM)
  })
})

describe('GET /element-call/[...path] — 3xx handling', () => {
  it('re-emits a same-origin upstream redirect under the proxy prefix', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: `${UPSTREAM}/room/` } }),
    )

    const res = await call('room')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/element-call/room/')
  })

  it('resolves a RELATIVE Location against the request path, not the origin root', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'z/' } }))

    const res = await call('assets/x/y')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/element-call/assets/x/z/')
  })

  it('refuses an upstream redirect that points off-origin', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    )

    const res = await call('room')

    expect(res.status).toBe(502)
    expect(res.headers.get('location')).toBeNull()
  })

  // 304 and a bodied 300 carry no Location: there is nothing to follow and
  // nothing to rewrite, so turning them into 502 breaks conditional requests
  // and content negotiation for no security gain.
  it('passes a 304 Not Modified through', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 304, headers: { etag: '"v1"' } }))

    const res = await call('assets/app.js')

    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"v1"')
  })

  it('passes a 300 Multiple Choices without a Location through', async () => {
    fetchMock.mockResolvedValue(
      new Response('choose', { status: 300, headers: { 'content-type': 'text/plain' } }),
    )

    const res = await call('room')

    expect(res.status).toBe(300)
    expect(await res.text()).toBe('choose')
  })
})

// T03 round 3 — every EARLY return (304, rewritten redirect, refused redirect)
// answers without reading `res.body`. Under undici an un-consumed and
// un-cancelled body keeps its connection checked out of the pool until GC, and
// this route answers BEFORE the auth guard, so an attacker who can drive
// repeated 3xx replies pins sockets. Cancel the body on every one of them.
describe('GET /element-call/[...path] — upstream body is released on every early return', () => {
  /** An upstream reply whose body records whether the handler cancelled it. */
  function withCancellableBody(status: number, headers: Record<string, string> = {}) {
    // Built body-less (the Response constructor forbids a body on a 304) and
    // then given a stand-in body, so the same helper covers every early return.
    const response = new Response(null, { status, headers })
    const cancel = vi.fn(async () => {})
    Object.defineProperty(response, 'body', { value: { cancel }, configurable: true })
    return { response, cancel }
  }

  it('cancels the body when re-emitting a same-origin redirect', async () => {
    const { response, cancel } = withCancellableBody(302, { location: `${UPSTREAM}/room/` })
    fetchMock.mockResolvedValue(response)

    const res = await call('room')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/element-call/room/')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels the body when refusing an off-origin redirect', async () => {
    const { response, cancel } = withCancellableBody(302, {
      location: 'http://169.254.169.254/latest/meta-data/',
    })
    fetchMock.mockResolvedValue(response)

    const res = await call('room')

    expect(res.status).toBe(502)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels the body on a 304 that unexpectedly carries one', async () => {
    const { response, cancel } = withCancellableBody(304, { etag: '"v1"' })
    fetchMock.mockResolvedValue(response)

    const res = await call('assets/app.js')

    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('survives a body whose cancel() rejects', async () => {
    const response = new Response('x', { status: 302, headers: { location: `${UPSTREAM}/room/` } })
    Object.defineProperty(response, 'body', {
      value: { cancel: vi.fn(async () => { throw new Error('already locked') }) },
      configurable: true,
    })
    fetchMock.mockResolvedValue(response)

    const res = await call('room')

    expect(res.status).toBe(302)
  })
})

// A 300 Multiple Choices MAY carry a Location naming the preferred variant
// (RFC 9110 §15.4.1). When it does it is a redirect like any other and must go
// through the same origin pin and prefix rewrite as a 301.
describe('GET /element-call/[...path] — a 300 carrying a Location', () => {
  it('rewrites a same-origin 300 Location under the proxy prefix, like a 301', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 300, headers: { location: `${UPSTREAM}/room/index.html` } }),
    )

    const res = await call('room')

    expect(res.status).toBe(300)
    expect(res.headers.get('location')).toBe('/element-call/room/index.html')
  })

  it('refuses an off-origin 300 Location with 502', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 300, headers: { location: 'https://evil.example/x' } }),
    )

    const res = await call('room')

    expect(res.status).toBe(502)
    expect(res.headers.get('location')).toBeNull()
  })
})
