import type { Handle } from '@sveltejs/kit'
import { requestPath } from '$lib/server/request-path'
import { base } from '$app/paths'
import { recordAccountActionReturn, serializeActionCookie } from './account-actions'

/**
 * Parks Keycloak's `kc_action_status` from the OIDC callback in the account-action
 * cookie (Auth.js forgets the query when it redirects on). Runs BEFORE the Auth.js
 * handle; the callback itself is untouched, so a cancelled or failed action still
 * completes the sign-in and the session stays intact.
 *
 * The cookie goes onto the RESPONSE by hand: Auth.js answers the callback with a
 * Response of its own, and SvelteKit adds `event.cookies` only to responses that its
 * own resolve() builds, so `event.cookies.set` here would be lost.
 */
export const kcActionReturnHandle: Handle = async ({ event, resolve }) => {
  if (event.request.method !== 'GET' || requestPath(event).replace(/\/+$/, '') !== `${base}/auth/callback/keycloak`) {
    return resolve(event)
  }
  const headers: string[] = []
  recordAccountActionReturn(event.url, {
    get: (name) => event.cookies.get(name),
    set: (name, value, opts) => void headers.push(serializeActionCookie(name, value, opts)),
    delete: () => {},
  })
  const response = await resolve(event)
  if (headers.length === 0) return response
  const out = new Headers(response.headers)
  for (const h of headers) out.append('set-cookie', h)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out })
}
