import { describe, it, expect } from 'vitest'
import { checkGuard, isHealthzPath } from '../src/http/guard.ts'

const SECRET = 'topsecret-shared-value'
/** A canonical lowercase UUIDv7 (kernel tenant ids are v7). */
const V7 = '01920000-0000-7000-8000-00000000000a'

function headers(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    'x-internal-auth': SECRET,
    'x-tenant-id': V7,
    'x-tenant-slug': 'alpha',
    ...over,
  }
}

describe('isHealthzPath — guard exemption', () => {
  it('treats /healthz as exempt', () => {
    expect(isHealthzPath('/healthz')).toBe(true)
  })
  it('treats /healthz/<sub> subpaths as exempt', () => {
    expect(isHealthzPath('/healthz/ready')).toBe(true)
  })
  it('does NOT treat an unrelated path as exempt', () => {
    expect(isHealthzPath('/api/v1/boards')).toBe(false)
    expect(isHealthzPath('/healthzzz')).toBe(false)
  })
})

describe('checkGuard — shared secret (timingSafeEqual)', () => {
  it('rejects a missing x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: headers({ 'x-internal-auth': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('rejects a wrong x-internal-auth with 403', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: headers({ 'x-internal-auth': 'wrong' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('rejects when the server secret itself is unset (fail-closed) with 403', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: headers(), secret: undefined })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })

  it('accepts the correct secret (and a valid tenant)', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: headers(), secret: SECRET })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.tenant).toEqual({ id: V7, slug: 'alpha' })
  })
})

describe('checkGuard — x-tenant-id must be a canonical lowercase UUIDv7 (A2)', () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ['a v4 uuid', '11111111-1111-4111-8111-111111111111'],
    ['a nil-ish non-v7 uuid', '11111111-1111-1111-1111-111111111111'],
    ['an uppercase v7', V7.toUpperCase()],
    ['a braced v7', `{${V7}}`],
    ['a v7 without hyphens', V7.replaceAll('-', '')],
    ['a v7 with a bad variant', '01920000-0000-7000-c000-00000000000a'],
    ['a slug-like id', 'tenant-a'],
    ['an empty id', ''],
  ]
  for (const [what, id] of rejected) {
    it(`rejects ${what} with 400`, () => {
      const r = checkGuard({ path: '/api/v1/boards', headers: headers({ 'x-tenant-id': id }), secret: SECRET })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.status).toBe(400)
    })
  }

  it('still checks the secret first: a v4 id with a wrong secret is 403, not 400', () => {
    const r = checkGuard({
      path: '/api/v1/boards',
      headers: headers({ 'x-internal-auth': 'wrong', 'x-tenant-id': '11111111-1111-4111-8111-111111111111' }),
      secret: SECRET,
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})

describe('checkGuard — tenant headers', () => {
  it('rejects a missing x-tenant-id with 400', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: headers({ 'x-tenant-id': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it('rejects a missing x-tenant-slug with 400', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: headers({ 'x-tenant-slug': undefined }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it('rejects an invalid slug grammar (uppercase) with 400', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: headers({ 'x-tenant-slug': 'Alpha' }), secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(400)
  })

  it('rejects an over-30-char slug with 400 and accepts exactly 30', () => {
    const thirtyOne = 'a'.repeat(31)
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': thirtyOne }), secret: SECRET }).ok).toBe(false)
    const thirty = 'a'.repeat(30)
    expect(checkGuard({ path: '/x', headers: headers({ 'x-tenant-slug': thirty }), secret: SECRET }).ok).toBe(true)
  })
})

describe('checkGuard — evaluation order', () => {
  it('checks the secret BEFORE tenant headers (no header oracle for unauthenticated callers)', () => {
    const r = checkGuard({ path: '/api/v1/boards', headers: { 'x-internal-auth': 'wrong' }, secret: SECRET })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.status).toBe(403)
  })
})
