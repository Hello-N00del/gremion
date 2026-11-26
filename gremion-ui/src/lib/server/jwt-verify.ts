import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'
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

export type BearerJwtPayload = JWTPayload & Record<string, unknown>

/** What verifyBearerJwtResult tells a caller that has to answer differently for an outage and a refusal. */
export type BearerJwtResult =
  | { ok: true; payload: BearerJwtPayload }
  /** The token itself was not accepted: signature, issuer, audience, expiry, algorithm or key id. */
  | { ok: false; reason: 'rejected' }
  /** The tenant's key set could not be fetched or read, so nothing was decided about the token. `code` is the jose error code (or the error name). */
  | { ok: false; reason: 'keys_unavailable'; code: string }

export interface BearerJwtOptions {
  /** Seconds of clock tolerance on `exp` (and `nbf`). Unset: none, which is what the request hook uses. */
  clockToleranceSeconds?: number
}

// jose codes of an error that says the KEY SET could not be had (not that the token is bad): the fetch
// timed out, or the body was no key set. A key endpoint that answers non-200, or whose body is no JSON,
// throws the generic JOSEError; a network failure is not a JOSEError at all (see keySetOutageCode).
const KEY_SET_ERROR_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'])

/** The bounded code to log when `err` says the key set could not be had; null when it is a refusal of the token. */
function keySetOutageCode(err: unknown): string | null {
  if (err instanceof errors.JOSEError) return KEY_SET_ERROR_CODES.has(err.code) ? err.code : null
  // Not a jose error: the key request itself failed (network, DNS, abort).
  const name = err instanceof Error && err.name !== '' ? err.name : 'unknown'
  return name.slice(0, 64)
}

/**
 * Verify a Bearer JWT against the RESOLVED TENANT's Keycloak JWKS and issuer, and say why it failed:
 * `rejected` when the token is not acceptable (the per-verify half of cross-tenant isolation: its `iss`
 * must be the tenant's issuer), `keys_unavailable` when the tenant's key set could not be fetched.
 */
export async function verifyBearerJwtResult(
  token: string,
  tenant: Pick<TenantContext, 'id' | 'issuer' | 'kcInternal' | 'audiences'>,
  options: BearerJwtOptions = {},
): Promise<BearerJwtResult> {
  const issuer = (tenant.issuer ?? '').replace(/\/$/, '')
  if (!token || !issuer) return { ok: false, reason: 'rejected' }
  const audience = tenant.audiences?.length ? Array.from(tenant.audiences) : parseAudiences(undefined)
  try {
    const { payload } = await jwtVerify(token, jwksFor(tenant), {
      issuer,
      audience,
      algorithms: ['RS256'],
      ...(options.clockToleranceSeconds ? { clockTolerance: options.clockToleranceSeconds } : {}),
    })
    return { ok: true, payload: payload as BearerJwtPayload }
  } catch (err) {
    const code = keySetOutageCode(err)
    return code === null ? { ok: false, reason: 'rejected' } : { ok: false, reason: 'keys_unavailable', code }
  }
}

/**
 * Verify a Bearer JWT against the RESOLVED TENANT's Keycloak JWKS and issuer.
 * Rejects (null) when the token's `iss` does not match the tenant's issuer —
 * the per-verify half of cross-tenant isolation. An unreachable key set is null too;
 * a caller that must tell the two apart uses verifyBearerJwtResult.
 */
export async function verifyBearerJwt(
  token: string,
  tenant: Pick<TenantContext, 'id' | 'issuer' | 'kcInternal' | 'audiences'>,
): Promise<BearerJwtPayload | null> {
  const result = await verifyBearerJwtResult(token, tenant)
  return result.ok ? result.payload : null
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
