// services/kernel-api/src/tenancy/tokens.ts — Q7: a bearer access token is
// accepted only as an access token of the RESOLVED customer's realm
// (RFC 8725 s3.1/3.8/3.9; RFC 9068 s4):
//   * signature against THAT customer's realm JWKS, fetched from its
//     kc_internal (never a union of every realm's keys -- the cross-realm
//     replay a shared key set would admit);
//   * iss exactly the customer's issuer;
//   * aud contains gremion-kernel-api (TASK-077-b's audience mapper puts it
//     there). NOT tenant.audiences, which would admit gremion-ui-only tokens;
//   * alg RS256 only (no HS256 with a public key as secret, no `none`);
//   * exp / nbf, with a small clock tolerance.
// The JWKS cache is keyed by (customerId, issuer) and bounded (LRU), so a
// customer's issuer change gets a fresh key set and a flood of customers
// cannot grow it without limit.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { TenantRow, TokenVerifier } from '../app/deps.ts'

export const KERNEL_API_AUDIENCE = 'gremion-kernel-api'
export const ACCEPTED_ALGORITHMS = ['RS256'] as const
export const CLOCK_TOLERANCE_SECONDS = 30

export interface TokenVerifierOptions {
  /** Most key sets kept at once. Default 256. */
  maxKeySets?: number
  /** Test seam: the key-set factory (default jose createRemoteJWKSet on <kcInternal>/protocol/openid-connect/certs). */
  keySetFor?: (tenant: TenantRow) => JWTVerifyGetKey
}

const stripSlash = (s: string) => s.replace(/\/+$/, '')

export function jwksUrl(tenant: Pick<TenantRow, 'kcInternal'>): URL {
  const base = stripSlash(tenant.kcInternal)
  const u = new URL(`${base}/protocol/openid-connect/certs`)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('kc_internal is not an http(s) URL')
  return u
}

export function createTokenVerifier(o: TokenVerifierOptions = {}): TokenVerifier & { cacheSize(): number } {
  const max = o.maxKeySets ?? 256
  if (!Number.isInteger(max) || max < 1) throw new RangeError('maxKeySets must be a positive integer')
  const factory = o.keySetFor ?? ((t: TenantRow) => createRemoteJWKSet(jwksUrl(t), { timeoutDuration: 5000, cooldownDuration: 30_000 }))
  // Insertion order is recency order: a hit is re-inserted at the end.
  const cache = new Map<string, JWTVerifyGetKey>()
  const keySet = (tenant: TenantRow): JWTVerifyGetKey => {
    const key = `${tenant.customerId}\u0000${stripSlash(tenant.issuer)}`
    const hit = cache.get(key)
    if (hit) {
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const fresh = factory(tenant)
    cache.set(key, fresh)
    while (cache.size > max) cache.delete(cache.keys().next().value as string)
    return fresh
  }
  return {
    async verify(token, tenant) {
      const issuer = stripSlash(tenant.issuer)
      if (!issuer) throw new Error('the customer has no issuer')
      const { payload } = await jwtVerify(token, keySet(tenant), {
        issuer,
        audience: KERNEL_API_AUDIENCE,
        algorithms: [...ACCEPTED_ALGORITHMS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'iss', 'aud', 'sub'],
      })
      return payload as Record<string, unknown>
    },
    cacheSize: () => cache.size,
  }
}
