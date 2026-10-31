import { SvelteKitAuth, type SvelteKitAuthConfig } from '@auth/sveltekit'
import Keycloak from '@auth/core/providers/keycloak'
import type { RequestEvent } from '@sveltejs/kit'
import { Role, type SessionUser } from '$lib/auth/types'
import { safeDecodeAccessToken } from '$lib/auth/decode'
import { acrToLoa, LOA } from '$lib/auth/step-up'
import { authRedirect } from '$lib/safe-redirect'
import { env } from '$env/dynamic/private'
import { resolveSecret } from '$lib/server/tenant/secrets'
import { getTenant, getTenantOrNull, type TenantContext } from '$lib/server/tenant/context'
import { DEFAULT_ROLE_VOCABULARY, roleVocabularyForTenant } from '$lib/server/tenant/role-vocabulary'

/**
 * Filter raw realm role strings down to the subset in the tenant's role
 * vocabulary (P2.2-auth A2, D-VOCAB). `vocabulary` is the CURRENT tenant's
 * resolved vocabulary, threaded from the decode result (one tenant-resolved
 * source — see currentRoleVocabulary()); absent (no tenant context, the unit
 * harness) it falls back to the default vocabulary, byte-identical to the
 * previous Role-enum-values literal.
 */
function filterValidRoles(realmRoles: string[], vocabulary?: readonly string[]): Role[] {
  const validRoles = vocabulary ?? DEFAULT_ROLE_VOCABULARY
  return realmRoles.filter((r) => validRoles.includes(r)) as Role[]
}

/**
 * P2.2-auth A3 (design §3.5(e), D-VOCAB): the CURRENT tenant's role vocabulary
 * for threading into safeDecodeAccessToken. Decode stays extraction-only — the
 * vocabulary rides through to its result so the filter sites consume one
 * tenant-resolved source; it never changes what decode extracts. In production
 * the jwt callback always runs inside the request's ALS scope (element-0
 * tenantResolveHandle precedes Auth.js), so the tenant is present; outside a
 * tenant context (unit harness) this returns undefined and decode's default
 * path stays byte-identical. The non-throwing read is safe here precisely
 * because the vocabulary is threading-only — fail-closed FILTERING stays with
 * the filter sites (filterValidRoles, A2 seam), never with this carrier.
 */
function currentRoleVocabulary(): readonly string[] | undefined {
  const tenant = getTenantOrNull()
  return tenant ? roleVocabularyForTenant(tenant) : undefined
}

// Keycloak 25+ reports iss without the --http-relative-path prefix.
// The issuer, the external endpoint base and the internal (Docker) base all come
// from the resolved tenant (tenant.issuer / authExternalBase / kcInternal), never
// from process env: AUTH_KEYCLOAK_ISSUER and AUTH_KEYCLOAK_BASE are not read.

/**
 * The Keycloak() factory files a caller-supplied `issuer` under `provider.options`
 * and leaves the provider's top-level `issuer` unset. Auth.js's setEnvDefaults then
 * runs `provider.issuer ??= env.AUTH_KEYCLOAK_ISSUER`, and assertConfig reads
 * `provider.issuer ?? provider.options?.issuer`, so an env value (even the empty
 * string) shadows the tenant issuer and every page behind auth answers 500
 * (issue #87). Setting `issuer` at the top level makes the `??=` a no-op: the
 * per-tenant issuer is the only source, whatever the process env carries.
 */
function withTopLevelIssuer<P extends object>(issuer: string, provider: P): P & { issuer: string } {
  return { ...provider, issuer }
}

/**
 * Per-request Auth.js config. @auth/sveltekit@1.11.2 re-runs this factory on
 * every handle/signIn/signOut (dist/index.js:302/323/334) AFTER element-0
 * tenantResolveHandle has populated event.locals.tenant. Each tenant gets its
 * own realm issuer / client / OIDC endpoints. AUTH_SECRET is read per-request
 * (was an import-time throw) so module load never fails before a tenant exists.
 */
export async function buildAuthConfig(event: RequestEvent): Promise<SvelteKitAuthConfig> {
  const tenant = event.locals.tenant as TenantContext | undefined
  if (!tenant) throw new Error('buildAuthConfig: no tenant resolved (tenantResolveHandle must run first)')
  const authSecret = env.AUTH_SECRET
  if (!authSecret) throw new Error('AUTH_SECRET must be set')
  const externalBase = tenant.authExternalBase.replace(/\/$/, '')
  const internalBase = tenant.kcInternal.replace(/\/$/, '')
  return {
    secret: authSecret,
    trustHost: true,
    providers: [
      withTopLevelIssuer(tenant.issuer, Keycloak({
        clientId: tenant.authClientId,
        clientSecret: resolveSecret(tenant.authClientSecretRef),
        issuer: tenant.issuer,
        // PKCE S256 + state, explicit: the realm enforces pkce.code.challenge.method=S256
        // on this client, so this must never silently fall back to a library default.
        checks: ['pkce', 'state'],
        // authorization must be set explicitly — Auth.js calls discoveryRequest(issuer)
        // when authorization.url is absent, which hits localhost:8082 (unreachable in Docker).
        // Use the external URL here so the browser redirect goes to the public Keycloak.
        authorization: `${externalBase}/protocol/openid-connect/auth`,
        // Server-to-server calls use the internal Docker hostname.
        token: `${internalBase}/protocol/openid-connect/token`,
        userinfo: `${internalBase}/protocol/openid-connect/userinfo`,
        jwks_endpoint: `${internalBase}/protocol/openid-connect/certs`,
      })),
    ],
    // ASVS 4.0.3 V3.3.2 / NIST SP 800-63B AAL2. Auth.js re-issues the cookie on
    // every session read, so maxAge is a backstop (sliding); the 12 h absolute
    // (ssoSessionMaxLifespan 43200 s) and 30 min idle are enforced by Keycloak.
    session: { strategy: 'jwt', maxAge: 43200 },
    // redirect: the callbackUrl travels in a cookie and the query, so the server re-checks it
    // with the shared same-origin guard instead of the library's prefix test.
    callbacks: { jwt: jwtCallback, session: sessionCallback, redirect: authRedirect },
    pages: { signIn: '/auth/login' },
  }
}

/** A transient refresh failure keeps the expired access token for this long (ms). */
const REFRESH_GRACE_MS = 60_000
/** 429 back-off: Retry-After as delta-seconds or HTTP-date; default 5 s when
 *  missing/unparseable/non-positive; capped at 60 s (the refresh grace). */
function retryAfterMs(header: string | null): number {
  const DEFAULT_MS = 5_000
  const CAP_MS = 60_000
  let ms = DEFAULT_MS
  const v = header?.trim()
  if (v) {
    if (/^\d+$/.test(v)) ms = Number(v) * 1000
    else {
      const t = Date.parse(v)
      if (Number.isFinite(t)) ms = t - Date.now()
    }
  }
  if (!(ms > 0)) ms = DEFAULT_MS
  return Math.min(ms, CAP_MS)
}

function withinRefreshGrace(token: Record<string, unknown>): boolean {
  return Date.now() < ((token.accessTokenExpires as number | undefined) ?? 0) + REFRESH_GRACE_MS
}

const jwtCallback: NonNullable<NonNullable<SvelteKitAuthConfig['callbacks']>['jwt']> =
  async ({ token, account, profile }) => {
      // First login — store tokens and roles
      if (account) {
        token.accessToken = account.access_token
        token.idToken = account.id_token
        token.accessTokenExpires = (account.expires_at ?? 0) * 1000
        token.refreshToken = account.refresh_token
        // realm_access.roles is in the access token, not the ID token (profile).
        // Decode the access token directly to extract roles and groups.
        if (account.access_token) {
          // P2.2-auth A3: thread the tenant's role vocabulary into the decode
          // (extraction-side tenant-awareness — see currentRoleVocabulary()).
          const vocabulary = currentRoleVocabulary()
          const decoded = safeDecodeAccessToken(account.access_token, vocabulary)
          if ('error' in decoded) {
            // G-018: do NOT silently fall back to empty claims — surface the
            // decode failure so the session is marked errored and NextAuth
            // forces a re-login instead of degrading the user to Guest.
            return { ...token, error: 'TokenDecodeFailed' }
          }
          // P2.2-auth A2: the filter consumes the vocabulary the decode carried.
          token.roles = filterValidRoles(decoded.realmRoles, decoded.vocabulary)
          token.groups = decoded.groups
          token.preferredUsername = decoded.preferredUsername ?? token.email
          token.tokenIss = decoded.iss // CR2: the realm that minted the access token
          // Canonical user id = the ACCESS-token sub. The gremion-ui client has a
          // `sub` mapper (user.attribute=id) that puts the real Keycloak UUID in
          // the access token, but the ID token (which drives token.sub below)
          // carries a pairwise sub. Nextcloud, org_unit_members, finance, matrix
          // and audit all key by the real UUID, so derive user.id from here.
          // TASK-033-a / TRD-147: NO fallback to token.sub (the pairwise ID-token
          // sub): an access token without `sub` leaves uid undefined, the session
          // gets no id and authGuard refuses it -- the same rule as a Bearer token.
          token.uid = decoded.sub
          // #164: carry the LoA (acr) + auth_time for step-up freshness. Prefer the
          // access token; fall back to the id token if the claim landed only there.
          const idDecoded = account.id_token ? safeDecodeAccessToken(account.id_token, vocabulary) : null
          const idClaims = idDecoded && !('error' in idDecoded) ? idDecoded : null
          token.acr = decoded.acr ?? idClaims?.acr
          token.authTime = decoded.authTime ?? idClaims?.authTime
          // #164: Keycloak does NOT reliably emit `auth_time` (it is absent from
          // both tokens unless the request carried `max_age`), so freshness cannot
          // depend on it. Anchor step-up freshness to the SERVER time of THIS
          // authentication instead. `account` is only present on a real (re-)login,
          // so a fresh OTP step-up stamps a new value here; a normal LoA-1 login
          // clears it; a token refresh below preserves it (ages out correctly).
          token.stepUpAt =
            acrToLoa(token.acr as string | undefined) >= LOA.STEP_UP
              ? Math.floor(Date.now() / 1000)
              : undefined
        } else {
          // No access token at all (provider misconfig) — fall back to the
          // id_token-derived profile so the user gets at least basic claims.
          const profilePayload = (profile as Record<string, unknown>) ?? {}
          // P2.2-auth A2: no decode on this fallback path — resolve the
          // tenant's vocabulary directly from the request's ALS scope.
          token.roles = filterValidRoles(
            (profilePayload.realm_access as { roles?: string[] } | undefined)?.roles ?? [],
            currentRoleVocabulary()
          )
          token.groups = (profilePayload.groups as string[]) ?? []
          token.preferredUsername =
            (profilePayload.preferred_username as string | undefined) ?? token.email
          token.tokenIss = profilePayload.iss as string | undefined // CR2: id-token issuer fallback
          // No access token: there is no access-token sub to take, and the
          // profile / id-token sub is the pairwise one (see above), so NO id
          // (TRD-147): the session is refused rather than keyed by a wrong actor.
          token.uid = undefined
          // #164: acr/auth_time from the id-token-derived profile.
          token.acr = profilePayload.acr as string | undefined
          token.authTime = typeof profilePayload.auth_time === 'number' ? (profilePayload.auth_time as number) : undefined
          // #164: server-side step-up anchor (see access-token branch above).
          token.stepUpAt =
            acrToLoa(token.acr as string | undefined) >= LOA.STEP_UP
              ? Math.floor(Date.now() / 1000)
              : undefined
        }
        return token
      }

      // Token still valid
      if (Date.now() < (token.accessTokenExpires as number ?? 0)) {
        return token
      }

      // Access token expired — try to refresh
      if (!token.refreshToken) {
        // No refresh token available — force re-login
        return { ...token, error: 'RefreshTokenMissing' }
      }

      // 429 back-off: Keycloak asked us to wait; do not hammer it while the
      // grace window still holds the (expired) access token usable.
      if (Date.now() < ((token.refreshRetryAt as number | undefined) ?? 0) && withinRefreshGrace(token)) {
        return token
      }

      let tenantId = 'unknown'
      try {
        // ALS tenant — set by tenantResolveHandle for this request. The refresh
        // must hit the SAME realm's token endpoint and use the same UI client.
        const tenant = getTenant()
        tenantId = tenant.id
        const refreshBase = tenant.kcInternal.replace(/\/$/, '')
        const response = await fetch(
          `${refreshBase}/protocol/openid-connect/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: tenant.authClientId,
              client_secret: resolveSecret(tenant.authClientSecretRef),
              refresh_token: token.refreshToken as string
            }).toString()
          }
        )

        if (!response.ok) {
          // Log status + Keycloak's OAuth `error` only (never tokens/secrets).
          let oauthError = 'n/a'
          try {
            const body = JSON.parse(await response.text()) as { error?: unknown }
            if (typeof body?.error === 'string') oauthError = body.error.slice(0, 64)
          } catch { /* non-JSON body */ }
          console.warn(`[auth] token refresh rejected tenant=${tenantId} status=${String(response.status).slice(0, 64)} error=${oauthError}`)
          // 5xx = Keycloak unavailable, not a dead session: retry on the next
          // request while the access token is within the grace window.
          // 429 = rate limited, also transient (honour Retry-After).
          // Trade-off: during grace the session carries an EXPIRED bearer, so
          // leaf calls may 401 for up to REFRESH_GRACE_MS. Forcing a re-login
          // on every Keycloak 503 is the worse alternative.
          const transient = response.status >= 500 || response.status === 429
          if (transient && withinRefreshGrace(token)) {
            if (response.status === 429) {
              return { ...token, refreshRetryAt: Date.now() + retryAfterMs(response.headers.get('Retry-After')) }
            }
            return token
          }
          return { ...token, error: transient ? 'RefreshTokenFailed' : 'RefreshTokenExpired' }
        }

        const tokens = await response.json() as {
          access_token: string
          expires_in: number
          refresh_token?: string
          id_token?: string
        }

        // P2.2-auth A3: same threading on refresh — the tenant is already in
        // scope (getTenant() above), so resolve its vocabulary directly.
        const decoded = safeDecodeAccessToken(tokens.access_token, roleVocabularyForTenant(tenant))
        if ('error' in decoded) {
          // G-018: refresh succeeded at the network level but the new access
          // token is malformed — surface a typed error so the session goes
          // through re-login instead of silently dropping the user to Guest.
          return { ...token, error: 'TokenDecodeFailed' }
        }
        return {
          ...token,
          accessToken: tokens.access_token,
          accessTokenExpires: Date.now() + tokens.expires_in * 1000,
          refreshToken: tokens.refresh_token ?? token.refreshToken,
          // Keep the ID token fresh across refreshes: logout passes
          // token.idToken as the RP-initiated-logout id_token_hint, and a stale
          // hint can make Keycloak skip terminating the SSO session. Keycloak
          // returns a new id_token on the refresh grant when the openid scope
          // is present; fall back to the prior hint if this response omits it.
          idToken: tokens.id_token ?? (token.idToken as string | undefined),
          roles: filterValidRoles(decoded.realmRoles, decoded.vocabulary),
          groups: decoded.groups.length ? decoded.groups : (token.groups as string[] | undefined) ?? [],
          // Keep the canonical real-UUID id fresh across refreshes. Only the
          // ACCESS-token sub counts (TRD-147): no fallback to a stale uid or to
          // token.sub, so a refreshed token that lost its sub ends the session.
          uid: decoded.sub,
          // #164: a refresh doesn't re-authenticate, so preserve the prior acr/authTime
          // (freshness is still gated by authTime downstream). Prefer the freshly
          // decoded values if the refreshed access token carries them.
          acr: decoded.acr ?? (token.acr as string | undefined),
          authTime: decoded.authTime ?? (token.authTime as number | undefined),
          // CR2: the refreshed access token may restate the issuer; otherwise
          // preserve the prior tokenIss (every other refresh exit is a {...token}
          // spread, which already carries it).
          tokenIss: decoded.iss ?? (token.tokenIss as string | undefined),
          error: undefined
        }
      } catch (err) {
        const e = err as { name?: string; message?: string }
        console.warn(`[auth] token refresh failed tenant=${tenantId} exception=${e?.name ?? 'Error'}: ${String(e?.message ?? '').slice(0, 200)}`)
        // Network error: transient while within grace, else force re-login.
        if (withinRefreshGrace(token)) return token
        return { ...token, error: 'RefreshTokenFailed' }
      }
    }

const sessionCallback: NonNullable<NonNullable<SvelteKitAuthConfig['callbacks']>['session']> =
  async ({ session, token }) => {
      const user = session.user as unknown as SessionUser
      // user.id MUST be the real Keycloak UUID (token.uid, derived from the
      // access-token sub) — NOT token.sub, which is the gremion-ui client's
      // pairwise ID-token sub and matches nothing in Nextcloud / org_unit_members
      // / finance / matrix. TRD-147: if uid is unset (the access token had no
      // `sub`) the id stays EMPTY and authGuard refuses the session; it is never
      // taken from token.sub.
      user.id = typeof token.uid === 'string' ? token.uid : ''
      const tokenRoles = token.roles as Role[] | undefined
      user.roles = tokenRoles?.length ? tokenRoles : [Role.Guest]
      user.groups = (token.groups as string[]) ?? []
      user.preferredUsername = token.preferredUsername as string | undefined
      // #164: expose the derived Level of Assurance + auth event time so step-up
      // enforcement (Phase 4) can read them straight off the session user.
      user.loa = acrToLoa(token.acr as string | undefined)
      // #164: prefer the server-recorded step-up time (reliable, provider-independent)
      // over the token's auth_time (which Keycloak often omits); fall back to 0.
      user.authTime =
        (token.stepUpAt as number | undefined) ??
        (token.authTime as number | undefined) ??
        0
      // A failed refresh / decode (jwtCallback sets token.error) must reach the
      // authGuard: hooks.server.ts forces re-login on session.error. Without this
      // a stale cookie kept rendering pages after the SSO session ended and every
      // integrated-service call carried an expired bearer.
      ;(session as unknown as { error?: string }).error = token.error as string | undefined
      // accessToken and idToken are server-side only — never returned in load() data to browser
      ;(session as unknown as { accessToken?: string }).accessToken = token.accessToken as string | undefined
      ;(session as unknown as { idToken?: string }).idToken = token.idToken as string | undefined
      // accessTokenExpires is lifted onto locals by authGuard for the files-API
      // bearer-rejection diagnostic (#161); server-side only, never sent to the browser.
      ;(session as unknown as { accessTokenExpires?: number }).accessTokenExpires =
        token.accessTokenExpires as number | undefined
      // CR2: expose the access-token issuer for the authGuard iss-match backstop (Task 28).
      // Read token.tokenIss (set by jwtCallback above) — NOT token.iss (Auth.js never sets it).
      ;(session as unknown as { tokenIss?: string }).tokenIss = token.tokenIss as string | undefined
      return session
    }

/** Test seams: the exact functions wired into callbacks.jwt / callbacks.session. */
export const __jwtCallbackForTests = jwtCallback
export const __sessionCallbackForTests = sessionCallback

export const { handle, signIn, signOut } = SvelteKitAuth(buildAuthConfig)
