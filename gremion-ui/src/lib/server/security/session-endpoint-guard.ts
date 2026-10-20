import type { Handle } from '@sveltejs/kit'
import { base } from '$app/paths'

/**
 * Close Auth.js' HTTP session endpoint (`${base}/auth/session`, every method).
 *
 * Its body is the sessionCallback result, which carries the raw Keycloak
 * accessToken and idToken for server use, so any script on the origin could
 * read a working bearer. Nothing in the browser needs it: pages receive
 * `{ user, expires }` from the root layout load, the login page only calls
 * signIn (/auth/signin), and server code reads the session through
 * locals.auth(), which runs Auth() in-process rather than over HTTP.
 * Must run BEFORE the Auth.js handle in the sequence.
 */
export const sessionEndpointGuard: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname.replace(/\/+$/, '')
  if (path === `${base}/auth/session`) {
    return new Response('Not Found', { status: 404 })
  }
  return resolve(event)
}
