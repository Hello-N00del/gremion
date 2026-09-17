// Tenancy D1 HARDENING-3 — the gate on the leaf-callback ID path.
//
// leafCallbackClaim() is the ONLY thing standing between `x-tenant-id` (a plain
// request header) and element-0 tenant selection. Everything below is a
// statement about what it must REFUSE; the one acceptance case exists mainly to
// prove the refusals are not vacuous.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// internal-fetch (for constantTimeEqual) reads the private dynamic env at import.
vi.mock('$env/dynamic/private', () => ({ env: {} }))

const { leafCallbackClaim, LEAF_CALLBACK_ROUTES } = await import('./leaf-trust')

const NL_SECRET = 'newsletter-secret-32-bytes-of-padxx'
const CONTENT_SECRET = 'content-secret-32-bytes-of-padxxxx'
const TENANT = '11111111-2222-4333-8444-555555555555'

function headers(h: Record<string, string>): Headers {
  return new Headers(h)
}

/** The header set a newsletter leaf callback actually sends. */
function leafHeaders(over: Record<string, string> = {}): Headers {
  return headers({
    'x-internal-auth': NL_SECRET,
    'x-tenant-id': TENANT,
    'x-tenant-slug': 'rat-musterstadt',
    ...over,
  })
}

const saved = { nl: process.env.INTERNAL_NEWSLETTER_SECRET, ct: process.env.INTERNAL_CONTENT_SECRET }

beforeEach(() => {
  process.env.INTERNAL_NEWSLETTER_SECRET = NL_SECRET
  process.env.INTERNAL_CONTENT_SECRET = CONTENT_SECRET
})
afterEach(() => {
  if (saved.nl === undefined) delete process.env.INTERNAL_NEWSLETTER_SECRET
  else process.env.INTERNAL_NEWSLETTER_SECRET = saved.nl
  if (saved.ct === undefined) delete process.env.INTERNAL_CONTENT_SECRET
  else process.env.INTERNAL_CONTENT_SECRET = saved.ct
})

describe('leafCallbackClaim — accepts a proven leaf callback', () => {
  it('returns the asserted tenant id for a callback route with the right secret', () => {
    const claim = leafCallbackClaim('/api/internal/newsletter/render', leafHeaders())
    expect(claim).not.toBeNull()
    expect(claim!.tenantId).toBe(TENANT)
    expect(claim!.route).toBe('/api/internal/newsletter/render')
    expect(claim!.secretName).toBe('INTERNAL_NEWSLETTER_SECRET')
  })

  it('covers every route in the table, each with ITS OWN secret', () => {
    for (const [route, secretName] of Object.entries(LEAF_CALLBACK_ROUTES)) {
      const secret = secretName === 'INTERNAL_CONTENT_SECRET' ? CONTENT_SECRET : NL_SECRET
      expect(leafCallbackClaim(route, leafHeaders({ 'x-internal-auth': secret }))).not.toBeNull()
    }
  })

  it('one leaf’s secret does NOT open another leaf’s route', () => {
    // The content leaf holds INTERNAL_CONTENT_SECRET; presenting it on a
    // newsletter route must not select a tenant — the route's own handler would
    // 403 it anyway, and element-0 must not disagree with the handler.
    expect(
      leafCallbackClaim(
        '/api/internal/newsletter/render',
        leafHeaders({ 'x-internal-auth': CONTENT_SECRET }),
      ),
    ).toBeNull()
    expect(
      leafCallbackClaim(
        '/api/internal/content/portal-publish',
        leafHeaders({ 'x-internal-auth': NL_SECRET }),
      ),
    ).toBeNull()
  })

  it('tolerates exactly one trailing slash (same route, not a new one)', () => {
    expect(leafCallbackClaim('/api/internal/newsletter/render/', leafHeaders())?.route).toBe(
      '/api/internal/newsletter/render',
    )
  })
})

describe('leafCallbackClaim — refuses everything else', () => {
  it('a path that is not an allowlisted callback route, even with a valid secret', () => {
    for (const path of [
      '/', // an ordinary page
      '/api/news/abc',
      '/api/internal/push', // internalFetch's Bearer route — deliberately NOT a leaf route
      '/api/internal/newsletter', // the prefix itself
      '/api/internal/newsletter/render/extra', // a deeper path under it
      '/api/internal/newsletter/renderX',
      '/API/internal/newsletter/render', // case-sensitive, like the router
    ]) {
      expect(leafCallbackClaim(path, leafHeaders())).toBeNull()
    }
  })

  it('a WRONG or absent x-internal-auth', () => {
    expect(leafCallbackClaim('/api/internal/newsletter/render', headers({ 'x-tenant-id': TENANT })))
      .toBeNull()
    for (const bad of ['', 'wrong', NL_SECRET + 'x', NL_SECRET.slice(0, -1), NL_SECRET.toUpperCase()]) {
      expect(
        leafCallbackClaim('/api/internal/newsletter/render', leafHeaders({ 'x-internal-auth': bad })),
      ).toBeNull()
    }
  })

  it('an UNSET server secret — a kernel with no leaf secret trusts nobody', () => {
    delete process.env.INTERNAL_NEWSLETTER_SECRET
    expect(leafCallbackClaim('/api/internal/newsletter/render', leafHeaders())).toBeNull()
    // …and an empty-string secret is "unset", not "matches the empty header".
    process.env.INTERNAL_NEWSLETTER_SECRET = ''
    expect(
      leafCallbackClaim('/api/internal/newsletter/render', leafHeaders({ 'x-internal-auth': '' })),
    ).toBeNull()
  })

  it('an absent or non-UUID x-tenant-id — a slug is not an id', () => {
    const noId = headers({ 'x-internal-auth': NL_SECRET })
    expect(leafCallbackClaim('/api/internal/newsletter/render', noId)).toBeNull()
    for (const bad of [
      '',
      'rat-musterstadt', // the slug — the leaf sends this too, but it is not the selector
      'not-a-uuid',
      '11111111-2222-4333-8444-55555555555', // one char short
      '11111111-2222-4333-8444-5555555555555',
      "11111111-2222-4333-8444-555555555555' OR 1=1",
    ]) {
      expect(
        leafCallbackClaim('/api/internal/newsletter/render', leafHeaders({ 'x-tenant-id': bad })),
      ).toBeNull()
    }
  })

  it('proxy-trust is NOT a substitute — Traefik stamps it on every edge request', () => {
    // This is the whole reason the gate is the per-leaf secret and not the edge
    // one. A client that reached the app through the edge carries a VALID
    // x-proxy-trust; if that were enough, it could name any tenant it liked.
    const edgeShaped = headers({
      'x-proxy-trust': 'the-valid-edge-secret',
      'x-forwarded-host': 'rat-musterstadt.de',
      'x-tenant-id': TENANT,
    })
    expect(leafCallbackClaim('/api/internal/newsletter/render', edgeShaped)).toBeNull()
  })
})
