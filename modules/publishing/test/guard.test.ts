import { describe, it, expect } from 'vitest'
import { checkGuard, isHealthzPath } from '../src/http/guard.ts'

const SECRET = 'topsecret-shared-value'

function headers(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    'x-internal-auth': SECRET,
    'x-tenant-id': '11111111-1111-1111-1111-111111111111',
    'x-tenant-slug': 'alpha',
    ...over,
  }
}

describe('isHealthzPath — guard exemption', () => {
  it('treats /healthz as exempt', () => {
    expect(isHealthzPath('/healthz')).toBe(true)
  })
  it('treats /healthz/tenants subpaths as exempt', () => {
    expect(isHealthzPath('/healthz/tenants')).toBe(true)
  })
  it('does NOT treat an unrelated path as exempt', () => {
    expect(isHealthzPath('/api/v1/newsletters')).toBe(false)
    expect(isHealthzPath('/healthzzz')).toBe(false)
  })
})

describe('checkGuard — shared secret (timingSafeEqual)', () => {
  it('rejects a missing x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/lists', headers: headers({ 'x-internal-auth': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('rejects a wrong x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/lists', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('rejects when the server secret itself is unset (fail-closed) with 403', () => {
    const r = checkGuard({ path: '/api/v1/lists', headers: headers(), secret: undefined })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('accepts the correct secret (and a valid tenant)', () => {
    const r = checkGuard({ path: '/api/v1/lists', headers: headers(), secret: SECRET })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.tenant).toEqual({ id: '11111111-1111-1111-1111-111111111111', slug: 'alpha' })
  })
})

describe('checkGuard — tenant headers', () => {
  it('rejects a missing x-tenant-id with 400', () => {
    const r = checkGuard({ path: '/api/v1/lists', headers: headers({ 'x-tenant-id': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it('rejects a missing x-tenant-slug with 400', () => {
    const r = checkGuard({ path: '/api/v1/lists', headers: headers({ 'x-tenant-slug': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it('rejects an invalid slug grammar (uppercase) with 400', () => {
    const r = checkGuard({ path: '/api/v1/lists', headers: headers({ 'x-tenant-slug': 'Alpha' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it('rejects an invalid slug grammar (underscore/dot) with 400', () => {
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': 'a_b' }), secret: SECRET }).ok).toBe(false)
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': 'a.b' }), secret: SECRET }).ok).toBe(false)
  })

  it('rejects an over-30-char slug with 400 and accepts exactly 30', () => {
    const thirtyOne = 'a'.repeat(31)
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': thirtyOne }), secret: SECRET }).ok).toBe(false)
    const thirty = 'a'.repeat(30)
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': thirty }), secret: SECRET }).ok).toBe(true)
  })

  it('accepts digits and internal hyphens (grammar parity with the kernel slug rule)', () => {
    const r = checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': 'gemeinde-musterstadt-2' }), secret: SECRET })
    expect(r.ok).toBe(true)
  })
})

describe('checkGuard — evaluation order', () => {
  it('checks the secret BEFORE tenant headers (no header oracle for unauthenticated callers)', () => {
    // Wrong secret AND missing tenant headers → must be the 403, not the 400.
    const r = checkGuard({
      path: '/api/v1/lists',
      headers: { 'x-internal-auth': 'wrong' },
      secret: SECRET,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})

// ── Tenancy D1 HARDENING-3: there is no host header ───────────────────────
// The kernel used to thread the tenant's REGISTERED primary host down as
// `x-tenant-host` so this leaf could echo it back on its own callbacks (the
// kernel selected the tenant by looking the whole `x-forwarded-host` up in
// `tenant_domain`). The kernel now selects a callback's tenant from
// `x-tenant-id` instead, so the leaf holds no hostname and the guard reads none.
//
// What must hold now is that the guard's output is CLOSED over the two identity
// headers: an inbound host header is not merely unused, it must not reappear as
// tenant state that some later call site could pick up.
describe('checkGuard — the tenant shape is closed (HARDENING-3)', () => {
  it('yields id + slug and NOTHING else', () => {
    const r = checkGuard({ path: '/x', headers: headers(), secret: SECRET })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(Object.keys(r.tenant).sort()).toEqual(['id', 'slug'])
  })

  it('an x-tenant-host header from an OLDER kernel is inert — not read, not stored, not rejected', () => {
    // Rolling deploy: a kernel that predates this change still sends the header.
    // It must neither become tenant state here nor 400 the request, or every
    // callback from the new leaf to the old kernel would fail on a header the
    // kernel itself sent.
    const r = checkGuard({
      path: '/x',
      headers: headers({ 'x-tenant-host': 'rat-musterstadt.de' }),
      secret: SECRET,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(Object.keys(r.tenant).sort()).toEqual(['id', 'slug'])
    expect(JSON.stringify(r.tenant)).not.toContain('rat-musterstadt.de')
  })

  it('a MALFORMED x-tenant-host is inert too — an unread header is not an attack surface', () => {
    for (const bad of [
      'evil.com:80@rat-musterstadt.de', // ambiguous authority
      'a.example, b.example',           // comma-joined list
      'rat..de',                        // empty label
      '*.sturaos.com',                  // wildcard
      'München.de',                     // raw Unicode (punycode required)
      '',                               // present but empty
    ]) {
      const r = checkGuard({ path: '/x', headers: headers({ 'x-tenant-host': bad }), secret: SECRET })
      expect(r.ok, `expected pass-through for ${JSON.stringify(bad)}`).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(Object.keys(r.tenant).sort()).toEqual(['id', 'slug'])
    }
  })

  it('still checks the secret FIRST', () => {
    const r = checkGuard({
      path: '/x',
      headers: { 'x-internal-auth': 'wrong', 'x-tenant-id': 't', 'x-tenant-slug': 'alpha' },
      secret: SECRET,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})
