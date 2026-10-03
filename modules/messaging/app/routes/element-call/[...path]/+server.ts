import type { RequestHandler } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'

// Internal Docker hostname for element-call. Set ELEMENT_CALL_INTERNAL_URL in
// docker-compose.override.yml; falls back to localhost:8085 for bare local dev.
const ELEMENT_CALL_INTERNAL = env.ELEMENT_CALL_INTERNAL_URL ?? 'http://localhost:8085'

// audit #461 / netcup T03 — this route answers BEFORE the auth guard and the
// container it runs in can reach the cloud metadata service (169.254.169.254).
// `new URL('/' + path, base)` is NOT origin-safe: for special schemes the WHATWG
// parser folds a backslash into `/`, so a path beginning `/` or `\` resolves
// protocol-relative and silently retargets the fetch at an attacker-chosen host.
//
// `params.path` has ALREADY been percent-decoded by SvelteKit. Decoding it a
// second time (T03 round 1) rejected legitimate names carrying a literal `%`
// and reasoned about a string the upstream never sees, so validate the decoded
// form ONCE and re-encode each segment on the way out — that keeps `?`, `#`,
// `@` and friends inside the path component instead of letting the parser read
// them as query, fragment or userinfo.
function isSafeProxyPath(decoded: string): boolean {
  if (decoded.startsWith('/') || decoded.startsWith('\\')) return false
  if (decoded.includes('\\')) return false
  if (/(^|\/)\.\.(\/|$)/.test(decoded)) return false
  return true
}

export const GET: RequestHandler = async ({ params, url }) => {
  const path = params.path ?? ''

  if (!isSafeProxyPath(path)) {
    return new Response('invalid path', { status: 400 })
  }

  // Build upstream URL, strip any /element-call prefix and re-attach query params.
  let base: URL
  let targetUrl: URL
  try {
    base = new URL(ELEMENT_CALL_INTERNAL)
    // Assign the PATH COMPONENT of a URL already fixed to the upstream origin,
    // rather than re-parsing a string: the origin cannot be rewritten by
    // anything the path contains. Each segment is encoded individually so a
    // literal `?`/`#`/`@`/`%` in a filename survives as part of the path.
    targetUrl = new URL(base.toString())
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    targetUrl.pathname = `${base.pathname.replace(/\/+$/, '')}/${encoded}`
  } catch {
    return new Response('invalid path', { status: 400 })
  }
  // Origin pin, belt-and-braces behind the construction above: whatever the
  // parser did with the path, the fetch only ever leaves for the upstream.
  if (targetUrl.origin !== base.origin) {
    return new Response('invalid path', { status: 400 })
  }
  targetUrl.search = url.search

  let res: Response
  try {
    // redirect:'manual' — an upstream 3xx must not be auto-followed, or the
    // upstream (or anything impersonating it) could bounce this server-side
    // fetch straight back off-origin, re-opening the hole the pin just closed.
    res = await fetch(targetUrl.toString(), { redirect: 'manual' })
  } catch {
    return new Response('element-call upstream unavailable', { status: 502 })
  }

  // Every EARLY return below answers without reading the upstream body. Under
  // undici an un-consumed, un-cancelled body keeps its connection checked out
  // of the pool until GC, and this route answers BEFORE the auth guard — so an
  // attacker who can drive repeated 3xx replies would pin sockets. Release it.
  const release = () => {
    void res.body?.cancel().catch(() => {})
  }

  // 304 Not Modified carries no body and no Location — there is nothing to
  // follow and nothing to rewrite, and it MUST stay body-less, so hand the
  // validators straight back. Turning it into a 502 (T03 round 1) broke every
  // conditional asset request through the proxy.
  if (res.status === 304) {
    release()
    const notModified = new Headers()
    for (const h of ['etag', 'last-modified', 'cache-control', 'expires', 'vary']) {
      const v = res.headers.get(h)
      if (v) notModified.set(h, v)
    }
    return new Response(null, { status: 304, headers: notModified })
  }

  // Because redirects are no longer followed, re-emit a SAME-ORIGIN redirect to
  // the client under the proxy prefix (element-call's own trailing-slash and
  // path redirects keep working); refuse anything pointing elsewhere. This is
  // keyed on the Location, not on the status: a 300 Multiple Choices that names
  // a preferred variant (RFC 9110 §15.4.1) is a redirect and is treated exactly
  // like a 301, while any 3xx WITHOUT a Location is not a redirect at all and
  // falls through to the normal body handling below.
  const loc = res.headers.get('location')
  if (res.status >= 300 && res.status < 400 && loc) {
    let rewritten: string | null = null
    try {
      // Resolve against the REQUEST url, not the origin root: a relative
      // Location ("z/") is defined relative to the resource that returned it,
      // so resolving it against `base` silently moved it to the wrong path.
      const locUrl = new URL(loc, targetUrl)
      if (locUrl.origin === base.origin) {
        rewritten = `/element-call${locUrl.pathname}${locUrl.search}`
      }
    } catch {
      rewritten = null
    }
    release()
    if (!rewritten) {
      return new Response('element-call upstream redirect refused', { status: 502 })
    }
    return new Response(null, { status: res.status, headers: { location: rewritten } })
  }

  const ct = res.headers.get('content-type') ?? ''

  if (ct.includes('text/html')) {
    let html = await res.text()
    // Rewrite absolute-path asset references in the HTML so they continue to
    // resolve through this proxy.  JS dynamic imports use relative paths and
    // survive the proxy without modification.
    // Handles href="/" src="/" and similar attributes.
    html = html.replace(/="\/(?!element-call\/)/g, '="/element-call/')
    return new Response(html, {
      status: res.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  if (ct.includes('text/css')) {
    let css = await res.text()
    // Rewrite absolute url() references in CSS (e.g. @font-face src).
    // CSS files are not processed by the HTML rewrite above, so font and
    // image assets with absolute paths would otherwise resolve against
    // the host's own /assets/ directory and fail.
    css = css.replace(/url\((['"]?)\/(?!element-call\/)/g, 'url($1/element-call/')
    return new Response(css, {
      status: res.status,
      headers: { 'content-type': 'text/css; charset=utf-8' },
    })
  }

  if (ct.includes('application/javascript') || ct.includes('text/javascript')) {
    let js = await res.text()
    // Element Call's bundle hard-codes absolute /assets/ URLs in backtick
    // strings (locale JSON, sound effects, WASM, workers) and fetch()es them
    // at runtime. Without this rewrite they resolve against the bare origin,
    // bypass this proxy, hit the SvelteKit auth guard, and 302 to the login
    // page — so i18next gets HTML instead of JSON and shows raw keys.
    js = js.replace(/`\/assets\//g, '`/element-call/assets/')
    return new Response(js, {
      status: res.status,
      headers: { 'content-type': ct },
    })
  }

  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': ct || 'application/octet-stream' },
  })
}
