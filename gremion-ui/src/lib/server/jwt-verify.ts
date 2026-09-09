import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { parseAudiences } from '$lib/auth/audience'
import type { TenantContext } from '$lib/server/tenant/context'

// D-JWKS (P2.1b T6): the ONE lazy JWKS cache, keyed by the CANONICAL tenant.id
// — not the issuer. Two tenants sharing a realm/issuer never share (or evict)
// each other's key set, and resolution never builds a JWKS eagerly: the first
// Bearer verify for a tenant creates it here.
const _jwksByTenantId = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksFor(tenant: Pick<TenantContext, 'id' | 'issuer' | 'kcInternal'>): ReturnType<typeof createRemoteJWKSet> {
  const existing = _jwksByTenantId.get(tenant.id)
  if (existing) return existing
  const base = (tenant.kcInternal ?? tenant.issuer).replace(/\/$/, '')
  const set = createRemoteJWKSet(new URL(`${base}/protocol/openid-connect/certs`))
  _jwksByTenantId.set(tenant.id, set)
  return set
}

/**
 * Verify a Bearer JWT against the RESOLVED TENANT's Keycloak JWKS and issuer.
 * Rejects (null) when the token's `iss` does not match the tenant's issuer —
 * the per-verify half of cross-tenant isolation.
 */
export async function verifyBearerJwt(
  token: string,
  tenant: Pick<TenantContext, 'id' | 'issuer' | 'kcInternal' | 'audiences'>,
): Promise<(JWTPayload & Record<string, unknown>) | null> {
  const issuer = (tenant.issuer ?? '').replace(/\/$/, '')
  if (!token || !issuer) return null
  const audience = tenant.audiences?.length ? Array.from(tenant.audiences) : parseAudiences(undefined)
  try {
    const { payload } = await jwtVerify(token, jwksFor(tenant), { issuer, audience, algorithms: ['RS256'] })
    return payload as JWTPayload & Record<string, unknown>
  } catch {
    return null
  }
}

/** Drop ONE tenant's cached JWKS (P2.1b T8 — wired by evictTenantRuntime on
 *  tenant suspend/delete). Other tenants' key sets are untouched. */
export function evictJwks(tenantId: string): void {
  _jwksByTenantId.delete(tenantId)
}

/** Test seam: clear the per-tenant JWKS cache. */
export function __resetJwksCache(): void {
  _jwksByTenantId.clear()
}
