import { describe, expect, it } from 'vitest'
import { safeDecodeAccessToken } from './decode'

/**
 * Build a structurally-valid JWT WITHOUT signing it.
 *
 * `jose.decodeJwt` validates JWT structure (3 base64url segments, valid JSON
 * header & claims) but never checks the signature. We construct the token
 * manually instead of using `SignJWT` because jose's signing path checks
 * `payload instanceof Uint8Array`, and jsdom's TextEncoder/Buffer produce
 * cross-realm Uint8Array instances that fail that guard in vitest's jsdom
 * environment.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature-not-verified`
}

describe('safeDecodeAccessToken (G-018)', () => {
  it('returns TokenDecodeFailed for a malformed JWT instead of silent fallback', () => {
    const result = safeDecodeAccessToken('not.a.jwt')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('TokenDecodeFailed')
    }
  })

  it('returns TokenDecodeFailed for an empty string', () => {
    const result = safeDecodeAccessToken('')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('TokenDecodeFailed')
    }
  })

  it('returns TokenDecodeFailed for a non-JWT string', () => {
    const result = safeDecodeAccessToken('Bearer abc123')
    expect('error' in result).toBe(true)
  })

  it('returns TokenDecodeFailed when payload is not valid base64url JSON', () => {
    // header.payload.signature shape but payload is junk
    const result = safeDecodeAccessToken('aaaa.!!!!.bbbb')
    expect('error' in result).toBe(true)
  })

  it('extracts realm roles, sub, groups, and preferred_username from a valid JWT', () => {
    const token = makeJwt({
      sub: 'user-uuid-123',
      preferred_username: 'alice',
      realm_access: { roles: ['member', 'finance', 'unknown-role'] },
      groups: ['stura', 'finance-team'],
    })
    const result = safeDecodeAccessToken(token)
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.sub).toBe('user-uuid-123')
      expect(result.preferredUsername).toBe('alice')
      expect(result.realmRoles).toEqual(['member', 'finance', 'unknown-role'])
      expect(result.groups).toEqual(['stura', 'finance-team'])
    }
  })

  it('returns empty arrays/undefineds (not error) when claims are missing', () => {
    const token = makeJwt({ sub: 'minimal-user' })
    const result = safeDecodeAccessToken(token)
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.sub).toBe('minimal-user')
      expect(result.realmRoles).toEqual([])
      expect(result.groups).toEqual([])
      expect(result.preferredUsername).toBeUndefined()
    }
  })

  it('extracts acr and authTime when present in a valid JWT', () => {
    const token = makeJwt({
      sub: 'user-uuid-456',
      realm_access: { roles: ['member'] },
      groups: [],
      acr: '2fa',
      auth_time: 1717430400,
    })
    const result = safeDecodeAccessToken(token)
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.acr).toBe('2fa')
      expect(result.authTime).toBe(1717430400)
    }
  })

  it('returns acr and authTime as undefined when absent from the token', () => {
    const token = makeJwt({
      sub: 'user-uuid-789',
      realm_access: { roles: ['member'] },
      groups: [],
    })
    const result = safeDecodeAccessToken(token)
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.acr).toBeUndefined()
      expect(result.authTime).toBeUndefined()
    }
  })

  it('does NOT silently return empty roles for a malformed token (regression for G-018 silent reset)', () => {
    // The previous implementation returned `{}` here and downstream
    // `extractRoles({})` produced `[]` — which the session callback then
    // turned into `[Role.Guest]`, silently downgrading the user. The new
    // contract is: caller MUST see the error branch and never treat a
    // decode failure as "user has no roles".
    const result = safeDecodeAccessToken('garbage.token.value')
    expect(result).toStrictEqual({ error: 'TokenDecodeFailed' })
    // Crucially, the result must NOT look like a successful empty decode.
    expect('realmRoles' in result).toBe(false)
  })
})

describe('safeDecodeAccessToken — captures iss (CR2)', () => {
  it('returns the token issuer', () => {
    // safeDecodeAccessToken uses jose.decodeJwt, which never verifies the
    // signature — so an unsigned, structurally-valid token via makeJwt proves
    // iss capture. (Real SignJWT trips jsdom's cross-realm Uint8Array guard,
    // which is exactly why this file uses makeJwt throughout.)
    const jwt = makeJwt({ iss: 'https://kc.example.org/realms/tenant-a', realm_access: { roles: ['member'] }, sub: 'u1' })
    const decoded = safeDecodeAccessToken(jwt)
    expect('error' in decoded).toBe(false)
    if (!('error' in decoded)) expect(decoded.iss).toBe('https://kc.example.org/realms/tenant-a')
  })
})

// P2.2-auth A3 (design §3.5(e), D-VOCAB): decode is the raw realm-role
// EXTRACTION that feeds the filter sites — it must be tenant-aware (accept and
// thread the tenant's vocabulary through to its callers) but is NOT itself a
// filter. Extraction semantics stay identical; the no-vocabulary default path
// is byte-identical (toStrictEqual-pinned below).
describe('safeDecodeAccessToken — tenant vocabulary threading (P2.2-auth A3)', () => {
  const vocab: readonly string[] = ['guest', 'buergermeister']

  it('threads a provided vocabulary through to the result verbatim (same reference)', () => {
    const token = makeJwt({ sub: 'u1', realm_access: { roles: ['member'] } })
    const result = safeDecodeAccessToken(token, vocab)
    expect('error' in result).toBe(false)
    if (!('error' in result)) expect(result.vocabulary).toBe(vocab)
  })

  it('does NOT filter realmRoles by the vocabulary (extraction semantics identical — it feeds the filters, it is not one)', () => {
    const token = makeJwt({ sub: 'u1', realm_access: { roles: ['member', 'not-in-vocab'] } })
    const result = safeDecodeAccessToken(token, vocab)
    expect('error' in result).toBe(false)
    if (!('error' in result)) expect(result.realmRoles).toEqual(['member', 'not-in-vocab'])
  })

  it('default no-vocabulary path is byte-identical: no vocabulary key in the result (golden pin)', () => {
    const token = makeJwt({
      sub: 'user-uuid-123',
      preferred_username: 'alice',
      realm_access: { roles: ['member'] },
      groups: ['stura'],
      acr: '2fa',
      auth_time: 1717430400,
      iss: 'https://kc.example.org/realms/sturaos',
    })
    const result = safeDecodeAccessToken(token)
    expect(result).toStrictEqual({
      realmRoles: ['member'],
      sub: 'user-uuid-123',
      groups: ['stura'],
      preferredUsername: 'alice',
      acr: '2fa',
      authTime: 1717430400,
      iss: 'https://kc.example.org/realms/sturaos',
    })
    expect('vocabulary' in result).toBe(false)
  })

  it('error branch stays exactly { error } even when a vocabulary is supplied (no vocabulary leak)', () => {
    expect(safeDecodeAccessToken('garbage.token.value', vocab)).toStrictEqual({ error: 'TokenDecodeFailed' })
    expect(safeDecodeAccessToken('', vocab)).toStrictEqual({ error: 'TokenDecodeFailed' })
  })
})
