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
  /**
   * The tenant's key set could not be fetched or read, so nothing was decided about the token. `code` is the
   * jose error code (or the error name). `detail` (errors that are not jose errors only) is a short reason for
   * the server log: the code of the error's cause, else its message; one line, cut short, never the token.
   */
  | { ok: false; reason: 'keys_unavailable'; code: string; detail?: string }

export interface BearerJwtOptions {
  /** Seconds of clock tolerance on `exp` (and `nbf`). Unset: none, which is what the request hook uses. */
  clockToleranceSeconds?: number
}

// jose codes of an error that says the KEY SET could not be had (not that the token is bad): the fetch
// timed out, or the body was no key set. A key endpoint that answers non-200, or whose body is no JSON,
// throws the generic JOSEError; a network failure is not a JOSEError at all (see keySetOutage).
const KEY_SET_ERROR_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'])

const DETAIL_MAX = 120

/** One line of at most DETAIL_MAX characters, with the token and anything shaped like one taken out. */
function boundedText(text: string, token: string): string {
  const withoutToken = token === '' ? text : text.split(token).join('[token]')
  return withoutToken
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX)
}

/** The reason for the log: the code of the error's cause (undici puts ECONNREFUSED, ENOTFOUND, TLS codes there), else its message. */
function outageDetail(err: unknown, token: string): string {
  const cause = err instanceof Error ? err.cause : undefined
  const causeCode = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : ''
  if (causeCode !== '') return boundedText(causeCode, token)
  return boundedText(err instanceof Error ? err.message : '', token)
}

/** Whether a non-jose error is the key request failing (network, DNS, TLS, abort) rather than a defect in our own code. */
function isFetchFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.message === 'fetch failed' || err.name === 'AbortError' || err.name === 'TimeoutError' || err.cause !== undefined
}

/** What to answer when `err` says the key set could not be had; null when it is a refusal of the token. */
function keySetOutage(err: unknown, token: string): { code: string; detail?: string } | null {
  if (err instanceof errors.JOSEError) return KEY_SET_ERROR_CODES.has(err.code) ? { code: err.code } : null
  // Not a jose error: the key request itself failed (network, DNS, abort), or our own code threw.
  const code = (err instanceof Error && err.name !== '' ? err.name : 'unknown').slice(0, 64)
  const detail = outageDetail(err, token)
  // A defect must not read as an ordinary outage: the caller logs the tenant and the cause of an outage,
  // so only the unexpected case is logged here.
  if (!isFetchFailure(err)) console.error(`[jwt-verify] unexpected ${code} while reading the key set: ${detail}`)
  return { code, detail }
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
    const outage = keySetOutage(err, token)
    return outage === null ? { ok: false, reason: 'rejected' } : { ok: false, reason: 'keys_unavailable', ...outage }
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
