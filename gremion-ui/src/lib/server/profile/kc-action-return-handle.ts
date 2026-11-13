import type { Handle } from '@sveltejs/kit'
import { requestPath } from '$lib/server/request-path'
import { base } from '$app/paths'
import { recordAccountActionReturn } from './account-actions'

/**
 * Parks Keycloak's `kc_action_status` from the OIDC callback in the account-action
 * cookie (Auth.js forgets the query when it redirects on). Runs BEFORE the Auth.js
 * handle; it only reads the URL and sets one cookie, the callback itself is untouched,
 * so a cancelled or failed action still completes the sign-in and the session stays intact.
 */
export const kcActionReturnHandle: Handle = ({ event, resolve }) => {
  if (event.request.method === 'GET' && requestPath(event).replace(/\/+$/, '') === `${base}/auth/callback/keycloak`) {
    recordAccountActionReturn(event.url, event.cookies)
  }
  return resolve(event)
}
