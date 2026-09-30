// apps/control-panel/src/lib/server/auth.ts — Auth.js against the ops realm
// ONLY (TRD-048). One provider, one realm: the issuer is PANEL_OIDC_ISSUER
// (https://<platform domain>/auth/realms/platform), exact; the browser is sent
// to the public authorization endpoint, the token, userinfo and JWKS calls go
// to Keycloak's internal base. Every authorization request asks for acr loa2
// (multi-factor); the gate refuses a session that did not get it.
import { Auth, createActionURL, raw, skipCSRFCheck } from '@auth/core'
import Keycloak from '@auth/core/providers/keycloak'
import type { SvelteKitAuthConfig } from '@auth/sveltekit'
import type { RequestEvent } from '@sveltejs/kit'
import type { PanelConfig } from './config'
import { SESSION_ABSOLUTE_SECONDS, sessionTooOld, type SessionClaims } from './gate'

export const PROVIDER_ID = 'keycloak'

/** The error a session past its absolute lifetime carries (the gate reads `error`). */
export const SESSION_EXPIRED = 'SessionExpired'

function payloadOf(jwt: string | undefined): Record<string, unknown> | null {
  if (!jwt) return null
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * The claims the gate reads, from the tokens of ONE authorization code
 * exchange. Auth.js 0.41 checks the id token's iss, aud and exp but does NOT
 * verify a signature against the JWKS (jwks_endpoint below is informational);
 * the tokens are trusted because they come straight from the token endpoint
 * over the internal back channel (OIDC Core 3.1.3.7 item 6), which config.ts
 * restricts to https or the loopback / a compose service name (review A, r2).
 * The access token carries the realm roles and the real subject; acr comes
 * from either.
 */
export function claimsFromTokens(accessToken?: string, idToken?: string): SessionClaims {
  const at = payloadOf(accessToken) ?? {}
  const it = payloadOf(idToken) ?? {}
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const realmRoles = (at.realm_access as { roles?: unknown } | undefined)?.roles
  return {
    iss: str(it.iss) ?? str(at.iss),
    acr: str(at.acr) ?? str(it.acr),
    uid: str(at.sub) ?? str(it.sub),
    email: str(it.email) ?? str(at.email) ?? null,
    roles: Array.isArray(realmRoles) ? realmRoles.filter((r): r is string => typeof r === 'string') : [],
  }
}

export function authConfig(c: PanelConfig): SvelteKitAuthConfig {
  const internal = `${c.internalBase}/realms/${c.realm}/protocol/openid-connect`
  return {
    secret: c.authSecret,
    trustHost: true,
    basePath: '/auth',
    // Roles and acr are read at sign-in only (no refresh re-check yet). Auth.js
    // renews a JWT session's expiry on EVERY read (@auth/core
    // lib/actions/session.js), so maxAge is only an idle timeout. The ABSOLUTE
    // bound is the sign-in time stamped below: the jwt callback replaces the
    // token by a bare expiry marker (every claim dropped) and the gate refuses
    // once it is more than SESSION_ABSOLUTE_SECONDS old, however active the
    // session stays (review
    // r2 HIGH; ASVS 5.0 V7.3.2). A revoked operator therefore loses the panel
    // at most one hour after their last sign-in. The refresh-token re-check
    // against Keycloak (revocation within the hour) is a named residual.
    session: { strategy: 'jwt', maxAge: SESSION_ABSOLUTE_SECONDS },
    providers: [
      Keycloak({
        id: PROVIDER_ID,
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        issuer: c.issuer,
        authorization: {
          url: `${c.issuer}/protocol/openid-connect/auth`,
          params: { scope: 'openid email profile', acr_values: c.requiredAcr },
        },
        token: `${internal}/token`,
        userinfo: `${internal}/userinfo`,
        jwks_endpoint: `${internal}/certs`,
      }),
    ],
    callbacks: {
      jwt({ token, account }) {
        const now = Math.floor(Date.now() / 1000)
        if (account) {
          const claims = claimsFromTokens(account.access_token, account.id_token)
          token.opsIss = claims.iss
          token.opsAcr = claims.acr
          token.opsUid = claims.uid
          token.opsEmail = claims.email
          token.opsRoles = claims.roles
          // Stamped ONCE, at the code exchange; a renewal never moves it.
          token.opsAuthAt = now
          return token
        }
        // Past the absolute lifetime (or never stamped): the token is REPLACED
        // by a bare marker, so no claim survives, and the gate answers
        // "expired" (GET: back to the ops realm; else 403, cookie cleared)
        // rather than "forged" -- null would make Auth.js drop the session and
        // an active operator would meet a forged-cookie 403 instead.
        if (sessionTooOld(token.opsAuthAt, now)) return { opsError: SESSION_EXPIRED }
        return token
      },
      session({ session, token }) {
        if (token.opsError !== undefined) {
          ;(session as unknown as { claims: SessionClaims }).claims = { error: String(token.opsError), roles: [] }
          return session
        }
        ;(session as unknown as { claims: SessionClaims }).claims = {
          iss: token.opsIss as string | undefined,
          acr: token.opsAcr as string | undefined,
          uid: token.opsUid as string | undefined,
          email: (token.opsEmail as string | null | undefined) ?? null,
          roles: (token.opsRoles as string[] | undefined) ?? [],
          authAt: typeof token.opsAuthAt === 'number' ? token.opsAuthAt : undefined,
        }
        return session
      },
    },
  }
}

/**
 * Starts the authorization code flow at the ops realm and returns the
 * Keycloak URL to redirect to (the state, PKCE and callback cookies are set on
 * the event). The same request @auth/sveltekit's signIn builds, issued from
 * the gate so an anonymous GET goes straight to the realm (302), and a step-up
 * forces a fresh login (prompt=login) at loa2.
 */
export async function startSignIn(event: RequestEvent, config: SvelteKitAuthConfig, callbackUrl: string, stepUp: boolean, env: Record<string, string | undefined>): Promise<string> {
  const headers = new Headers(event.request.headers)
  const signInURL = createActionURL('signin', event.url.protocol, headers, env, config)
  const params = new URLSearchParams(stepUp ? { prompt: 'login' } : {})
  const url = `${signInURL}/${PROVIDER_ID}${params.size ? `?${params}` : ''}`
  headers.set('Content-Type', 'application/x-www-form-urlencoded')
  headers.delete('authorization')
  const req = new Request(url, { method: 'POST', headers, body: new URLSearchParams({ callbackUrl }) })
  // Server-initiated, exactly as @auth/sveltekit's own signIn (setEnvDefaults
  // sets the same symbol): no form of the browser is being honoured here, and
  // the callback itself is bound to this browser by the state and PKCE cookies.
  const res = await Auth(req, { ...config, raw, skipCSRFCheck })
  for (const cookie of res?.cookies ?? []) event.cookies.set(cookie.name, cookie.value, { path: '/', ...cookie.options })
  if (!res?.redirect) throw new Error('Auth.js returned no authorization redirect')
  return res.redirect
}
