import { describe, it, expect } from 'vitest'
import { checkGuard, isHealthzPath } from '../src/http/guard.ts'

const SECRET = 'topsecret-shared-value'

function headers(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    'x-internal-auth': SECRET,
    'x-tenant-id': '11111111-1111-4111-8111-111111111111',
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
    expect(isHealthzPath('/api/v1/events')).toBe(false)
    expect(isHealthzPath('/healthzzz')).toBe(false)
  })
})

describe('checkGuard — shared secret (timingSafeEqual)', () => {
  it('rejects a missing x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/events', headers: headers({ 'x-internal-auth': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('rejects a wrong x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/events', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('rejects when the server secret itself is unset (fail-closed) with 403', () => {
    const r = checkGuard({ path: '/api/v1/events', headers: headers(), secret: undefined })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('accepts the correct secret (and a valid tenant)', () => {
    const r = checkGuard({ path: '/api/v1/events', headers: headers(), secret: SECRET })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.tenant).toEqual({ id: '11111111-1111-4111-8111-111111111111', slug: 'alpha' })
  })
})

describe('checkGuard — tenant headers', () => {
  it('rejects a missing x-tenant-id with 400', () => {
    const r = checkGuard({ path: '/api/v1/events', headers: headers({ 'x-tenant-id': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it.each([
    ['not a uuid', 'not-a-uuid'],
    ['uppercase', '11111111-1111-4111-8111-11111111111A'],
    ['no hyphens', '11111111111141118111111111111111'],
    ['trailing space', '11111111-1111-4111-8111-111111111111 '],
    ['a 37th character', '11111111-1111-4111-8111-1111111111111'],
    ['braces', '{11111111-1111-4111-8111-111111111111}'],
    ['the nil uuid (version 0)', '00000000-0000-0000-0000-000000000000'],
    ['version 9', '11111111-1111-9111-8111-111111111111'],
    ['variant 0', '11111111-1111-4111-0111-111111111111'],
    ['a sql fragment', "x'; drop table tenant_catalog;--"],
  ])('rejects an x-tenant-id that is not a canonical lowercase UUID (%s) with 400', (_why, id) => {
    const r = checkGuard({ path: '/api/v1/posts', headers: headers({ 'x-tenant-id': id }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
    expect(r.message).not.toContain(id.trim() || 'never-empty')
  })

  it('accepts a canonical lowercase uuid, a v4 (gen_random_uuid) and a v7 alike', () => {
    for (const id of ['3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f', '01920000-0000-7000-8000-00000000000a']) {
      expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-id': id }), secret: SECRET }).ok).toBe(true)
    }
  })

  it('checks the tenant id BEFORE the slug (the id keys the pool and the catalog binding)', () => {
    const r = checkGuard({
      path: '/x',
      headers: headers({ 'x-tenant-id': 'not-a-uuid', 'x-tenant-slug': 'Not A Slug' }),
      secret: SECRET,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.message).toMatch(/x-tenant-id/)
  })

  it('rejects a missing x-tenant-slug with 400', () => {
    const r = checkGuard({ path: '/api/v1/events', headers: headers({ 'x-tenant-slug': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it('rejects an invalid slug grammar (uppercase) with 400', () => {
    const r = checkGuard({ path: '/api/v1/events', headers: headers({ 'x-tenant-slug': 'Alpha' }), secret: SECRET })
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

  it("refuses a slug the store would refuse (leading/trailing hyphen, hyphen only) with 400, before any store call", () => {
    for (const slug of ['-a', 'a-', '--', '-', '-abc-']) {
      const r = checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': slug }), secret: SECRET })
      expect(r.ok, slug).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.status).toBe(400)
    }
    for (const slug of ['a', 'a-b', 'a--b', '0-9']) {
      expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': slug }), secret: SECRET }).ok, slug).toBe(true)
    }
  })
})

describe('checkGuard — evaluation order', () => {
  it('checks the secret BEFORE tenant headers (no header oracle for unauthenticated callers)', () => {
    // Wrong secret AND missing tenant headers → must be the 403, not the 400.
    const r = checkGuard({
      path: '/api/v1/events',
      headers: { 'x-internal-auth': 'wrong' },
      secret: SECRET,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})
