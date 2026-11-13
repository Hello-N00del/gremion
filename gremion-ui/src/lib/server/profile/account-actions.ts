// Settings > Profil: three buttons start Keycloak application-initiated actions
// (AIA, the `kc_action` authorization parameter) through the normal Auth.js
// sign-in of the gremion-ui client. The Keycloak account console is NOT used.
//
//   password -> UPDATE_PASSWORD     totp -> CONFIGURE_TOTP     email -> UPDATE_EMAIL
//
// WHICH PARAMETERS, AND WHY (Keycloak 26.1 source, services module):
//
//  * kc_action=<ACTION>   starts the action after authentication.
//  * prompt=login         OIDCLoginProtocol.requireReauthentication() is true for
//                         prompt=login, so CookieAuthenticator ignores the SSO cookie,
//                         resets the level of authentication to NO_LOA and sets
//                         FORCED_REAUTHENTICATION. AcrStore.isLevelAuthenticatedInPreviousAuth()
//                         then returns false for every level: nothing authenticated
//                         earlier (password, OTP, a loa2 inside its 300 s window) is
//                         reused, the user presents each credential again.
//  * acr_values=loa2      (only for a user who HAS an OTP credential) requests level 2, so
//                         the realm's stepup-2fa subflow asks for the existing one-time code
//                         after the password. Together with prompt=login it means: password
//                         AND existing OTP, fresh, before the action form opens. A user
//                         WITHOUT an OTP is not sent loa2: the realm's second-factor subflow
//                         is OTP-or-deny and would refuse them, and enrolling the first
//                         authenticator is exactly what they came for (they still re-enter
//                         the password, level 1).
//  * No max_age: prompt=login already forces the full re-authentication; a window would
//                         only add a way to reuse an older one.
//
// Defence in depth that does not depend on this code: for CONFIGURE_TOTP Keycloak itself
// raises the requested level to the level of the `otp` credential type in the realm flow
// (AcrStore.getRequestedLevelOfAuthenticationByKcAction: UpdateTotp is a CredentialAction),
// when the user has an OTP credential. And every AIA re-authenticates once the last login
// is older than the action's max auth age (default 300 s).
//
// THE ROUND TRIP DOES NOT RAISE THE SESSION BY ITSELF: no flow here enrols and then grants
// loa2 (the realm has no REQUIRED OTP form, see docs/auth.md). A user with an OTP gets loa2
// only because they just entered it. A user without one comes back at loa1: enrolling a
// first authenticator through kc_action does not mint an acr of loa2.
//
// The server decides every parameter. The form contributes one allowlisted key; whatever
// else a client posts (authorizationParams-*, redirectTo, providerId) never reaches Auth.js.
import { fail } from '@sveltejs/kit'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'

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
    console.error('[profile] otp lookup failed, account action not started', { error: err instanceof Error ? err.name : typeof err })
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
export function serializeActionCookie(name: string, value: string, opts: Record<string, unknown>): string {
  const parts = [`${name}=${value}`, `Path=${String(opts.path ?? '/')}`]
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
      } catch {
        // unknown = unavailable
      }
      entries.set(key, { value, expiresAt: now() + ttlMs })
      return value
    },
  }
}
