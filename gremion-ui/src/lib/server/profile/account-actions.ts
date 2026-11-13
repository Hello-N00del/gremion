// Settings > Profil: three buttons start Keycloak application-initiated actions
// (AIA, the `kc_action` authorization parameter) through the normal Auth.js
// sign-in of the gremion-ui client. The Keycloak account console is NOT used.
//
//   password -> UPDATE_PASSWORD     totp -> CONFIGURE_TOTP     email -> UPDATE_EMAIL
//
// WHICH PARAMETERS, AND WHY (MEASURED on Keycloak 26.6.1, the pinned image, with the
// repo's realm-export.base.json; every line below was seen on the wire, not cited):
//
//  * kc_action=<ACTION>   starts the action after authentication.
//  * prompt=login         ignores the SSO cookie: the password is asked again even inside
//                         a live session. Measured: a user with a live loa2 session (OTP
//                         entered seconds before) was asked password AND one-time code again.
//  * acr_values=loa2      (only for a user who HAS an OTP credential) adds the realm's
//                         stepup-2fa subflow: password, then the EXISTING one-time code,
//                         before the action form opens. It is what protects UPDATE_PASSWORD
//                         (and UPDATE_EMAIL, measured only with all parameters: password,
//                         one-time code, e-mail form): on a loa1 session, kc_action=UPDATE_PASSWORD
//                         with no parameters opened the new-password form straight away; with
//                         prompt=login alone it asked the password only; with both it asked
//                         password, one-time code, then the form (acr loa2).
//                         A user WITHOUT an OTP is not sent loa2: the realm's second-factor
//                         subflow is OTP-or-deny and answers "Zugriff verweigert" (measured),
//                         and enrolling the first authenticator is what they came for. They
//                         re-enter the password (prompt=login) and enrol.
//  * No max_age: prompt=login already forces the full re-authentication.
//
// Defence in depth that does not depend on this code (measured, a loa1 SSO session of a user
// with an OTP, kc_action=CONFIGURE_TOTP with NO prompt and NO acr_values): Keycloak itself
// asked for the existing one-time code before the setup form. That holds for CONFIGURE_TOTP
// only; UPDATE_PASSWORD got nothing from Keycloak (above), so for it these parameters are
// the protection.
//
// WRONG CODE = NO SETUP FORM (measured): password right, one-time code wrong -> the code
// form again with "Ungueltiger One-time Code"; the setup form never appeared, and a fresh
// plain kc_action request in the same browser started at the password form (no half session).
//
// THE ROUND TRIP DOES NOT RAISE THE SESSION BY ITSELF (measured acr of the exchanged token):
//   user WITH an OTP, any of the three actions:  loa2, because they typed the code a moment
//     ago (earned; the realm has no REQUIRED OTP form, see docs/auth.md);
//   user WITHOUT an OTP, CONFIGURE_TOTP:         loa1, although a second factor was enrolled
//     in that very round trip (enrolling through kc_action does not mint loa2);
//   cancelled setup form:                        the callback still carries a code, the
//     session is intact, kc_action_status=cancelled.
// A residual that remains, and it is wider than "the password": the FIRST authenticator of a
// user without one is not protected by this button's parameters against a crafted request.
// Measured (26.6.1, base realm, user WITHOUT an OTP): plain sign-in (password, loa1), then in
// the same browser a hand-made authorize request with kc_action=CONFIGURE_TOTP and NO prompt
// and NO acr_values opened the setup form with no password prompt (kc_action_status=success,
// one OTP credential added); a following acr_values=loa2 step-up asked only for that new code
// and returned acr loa2. So a live, unlocked session of a member without a second factor can
// enrol a code and reach loa2 around the app, within Keycloak's re-authentication window for
// an action request (per-action max_auth_age, default 300 s; NOT measured for an older
// session). This button itself is not that hole: it sends prompt=login and asks the password.
// The cause is a realm property (no max_auth_age on the actions, no mandatory first-login
// enrolment), not something this module can close.
//
// The server decides every parameter. The form contributes one allowlisted key; whatever
// else a client posts (authorizationParams-*, redirectTo, providerId) never reaches Auth.js.
import { fail } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { errorFields } from './error-fields'

/** Form value -> Keycloak required-action id. The ONLY actions this route can start. */
export const ACCOUNT_ACTIONS = {
  password: 'UPDATE_PASSWORD',
  totp: 'CONFIGURE_TOTP',
  email: 'UPDATE_EMAIL',
} as const
export type AccountActionKey = keyof typeof ACCOUNT_ACTIONS
export type KcAction = (typeof ACCOUNT_ACTIONS)[AccountActionKey]

const KC_ACTIONS: readonly string[] = Object.values(ACCOUNT_ACTIONS)
const STATUSES = ['success', 'cancelled', 'error'] as const
export type KcActionStatus = (typeof STATUSES)[number]

/** Where the user comes back to after Keycloak (Auth.js callbackUrl, same-origin checked by authRedirect). */
export const RETURN_PATH = '/settings/profil'
/** Short-lived cookie: `<KC_ACTION>` while pending, `<KC_ACTION>.<status>` after the return. */
export const ACTION_COOKIE = 'gremion.kc_action'
const COOKIE_MAX_AGE_SECONDS = 15 * 60

export function accountActionParams(kcAction: KcAction, hasOtp: boolean): Record<string, string> {
  const params: Record<string, string> = { kc_action: kcAction, prompt: 'login' }
  if (hasOtp) params.acr_values = 'loa2'
  return params
}

interface CookieJar {
  get(name: string): string | undefined
  set(name: string, value: string, opts: { path: string } & Record<string, unknown>): void
  delete(name: string, opts: { path: string } & Record<string, unknown>): void
}

export interface StartAccountActionEvent {
  request: Request
  url: URL
  cookies: CookieJar
  locals: { user?: SessionUser | null }
}

export interface StartAccountActionDeps {
  /** The Auth.js server signIn (src/auth.ts). Throws a redirect to Keycloak when it works. */
  signIn(event: never): Promise<unknown>
  hasOtpCredential(userId: string): Promise<boolean>
  /** Is UPDATE_EMAIL enabled in the request tenant's realm? false on any doubt. */
  emailActionAvailable(): Promise<boolean>
}

export async function startAccountAction(event: StartAccountActionEvent, deps: StartAccountActionDeps) {
  const user = event.locals.user
  if (!user || typeof user.id !== 'string' || user.id === '' || !hasRole(user.roles, Role.Member)) {
    return fail(403, { accountAction: { error: 'forbidden' as const } })
  }
  const form = await event.request.formData()
  const key = form.get('action')
  if (typeof key !== 'string' || !Object.hasOwn(ACCOUNT_ACTIONS, key)) {
    return fail(400, { accountAction: { error: 'invalid' as const } })
  }
  const kcAction = ACCOUNT_ACTIONS[key as AccountActionKey]
  if (kcAction === 'UPDATE_EMAIL' && !(await deps.emailActionAvailable())) {
    return fail(400, { accountAction: { error: 'unavailable' as const } })
  }

  // Fail closed: without knowing whether an OTP exists we cannot choose the parameters
  // (loa2 for a user without one is refused by the realm; none for a user with one would
  // skip the existing code), so nothing is started.
  let hasOtp: boolean
  try {
    hasOtp = await deps.hasOtpCredential(user.id)
  } catch (err) {
    console.error('[profile] otp lookup failed, account action not started', errorFields(err))
    return fail(503, { accountAction: { error: 'unavailable-now' as const } })
  }

  event.cookies.set(ACTION_COOKIE, kcAction, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: event.url.protocol === 'https:',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })

  // The body the Auth.js server signIn reads: providerId, redirectTo and the
  // `authorizationParams-` prefixed keys it forwards to the authorize URL.
  const body = new URLSearchParams({ providerId: 'keycloak', redirectTo: RETURN_PATH })
  for (const [name, value] of Object.entries(accountActionParams(kcAction, hasOtp))) {
    body.set(`authorizationParams-${name}`, value)
  }
  const headers = new Headers(event.request.headers)
  headers.set('content-type', 'application/x-www-form-urlencoded')
  headers.delete('content-length')
  const signInEvent = { ...event, request: new Request(event.request.url, { method: 'POST', headers, body }) }

  await deps.signIn(signInEvent as never) // redirects to Keycloak
  // Only reached when Auth.js did not redirect (misconfiguration): never report that as success.
  return fail(500, { accountAction: { error: 'unavailable-now' as const } })
}

/**
 * Auth.js drops the query of /auth/callback/keycloak when it redirects on to the
 * callbackUrl, so Keycloak's `kc_action_status` (success | cancelled | error) would be
 * lost. A hook calls this for that callback and parks the status in the cookie of the
 * pending action. Only the three known values are accepted, and only next to a pending
 * action of ours.
 */
export function recordAccountActionReturn(url: URL, cookies: CookieJar): void {
  const status = url.searchParams.get('kc_action_status')
  if (!status || !(STATUSES as readonly string[]).includes(status)) return
  const pending = cookies.get(ACTION_COOKIE)
  if (!pending || !KC_ACTIONS.includes(pending)) return
  cookies.set(ACTION_COOKIE, `${pending}.${status}`, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })
}

/**
 * A Set-Cookie header value for the action cookie. Only used where SvelteKit's own cookie
 * handling cannot reach the response (the Auth.js callback, see kc-action-return-handle).
 * The value alphabet of this cookie is `[A-Z_.a-z]`, so nothing needs encoding.
 */
export function serializeActionCookie(
  name: string,
  value: string,
  opts: { path?: string; maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string },
): string {
  const parts = [`${name}=${value}`, `Path=${opts.path ?? '/'}`]
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${Math.floor(opts.maxAge)}`)
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  if (typeof opts.sameSite === 'string') parts.push(`SameSite=${opts.sameSite[0]!.toUpperCase()}${opts.sameSite.slice(1)}`)
  return parts.join('; ')
}

export interface AccountActionResult {
  action: KcAction
  status: KcActionStatus
}

/** The recorded outcome, once: a valid `<ACTION>.<status>` cookie is returned and deleted. */
export function readAccountActionResult(cookies: CookieJar): AccountActionResult | null {
  const raw = cookies.get(ACTION_COOKIE)
  if (!raw) return null
  const [action, status, ...rest] = raw.split('.')
  if (status === undefined) return null // still pending: no outcome yet
  cookies.delete(ACTION_COOKIE, { path: '/' })
  if (rest.length > 0 || !KC_ACTIONS.includes(action!) || !(STATUSES as readonly string[]).includes(status)) return null
  return { action: action as KcAction, status: status as KcActionStatus }
}

export interface CapabilityCache {
  /** The cached answer for `key`, else the probe's; any probe failure is `false`. */
  get(key: string, probe: () => Promise<boolean>): Promise<boolean>
}

/** A tiny per-key TTL cache for a boolean capability probe. A failed probe is cached shortly as false. */
export function createCapabilityCache(opts: { ttlMs?: number; failureTtlMs?: number; now?: () => number } = {}): CapabilityCache {
  const ttl = opts.ttlMs ?? 60_000
  const failureTtl = opts.failureTtlMs ?? 15_000
  const now = opts.now ?? (() => Date.now())
  const entries = new Map<string, { value: boolean; expiresAt: number }>()
  return {
    async get(key, probe) {
      const hit = entries.get(key)
      if (hit && hit.expiresAt > now()) return hit.value
      let value = false
      let ttlMs = failureTtl
      try {
        value = await probe()
        ttlMs = ttl
      } catch (err) {
        // unknown = unavailable; say so once per failed probe (the answer is cached shortly)
        console.warn('[profile] capability probe failed', { key, ...errorFields(err) })
      }
      entries.set(key, { value, expiresAt: now() + ttlMs })
      return value
    },
  }
}
