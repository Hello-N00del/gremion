import { redirect } from '@sveltejs/kit'
import type { Actions } from './$types'

export const actions: Actions = {
  default: async (event) => {
    const session = await event.locals.auth()
    const idToken = (session as unknown as { idToken?: string })?.idToken

    // Delete every authjs cookie present in the actual request (catches any name variant).
    for (const cookie of event.cookies.getAll()) {
      if (cookie.name.includes('authjs')) {
        event.cookies.delete(cookie.name, { path: '/' })
      }
    }

    // Build Keycloak end-session URL so the KC SSO session is also cleared.
    // id_token_hint can be stale after token refresh — only include when present.
    // post_logout_redirect_uri points to /auth/login?loggedOut=1 so the user
    // lands on the "Sie wurden abgemeldet" notice instead of being instantly
    // bounced back into Keycloak by the login page's auto-redirect (v6 P1).
    //
    // Per-tenant (#202): both the realm end-session base and the redirect origin
    // are taken from the CURRENT tenant (event.locals.tenant + event.url.origin),
    // NOT a default-pinned env. event.url.origin is the tenant's own host now that
    // ORIGIN is no longer pinned (adapter-node derives it from the inbound Host).
    // Without this, a non-default tenant's logout would clear the DEFAULT realm's
    // session and bounce to the apex host.
    const tenant = event.locals.tenant
    const externalBase = tenant.authExternalBase.replace(/\/$/, '')
    const origin = event.url.origin.replace(/\/$/, '')

    const kcLogout = new URL(`${externalBase}/protocol/openid-connect/logout`)
    kcLogout.searchParams.set('post_logout_redirect_uri', `${origin}/auth/login?loggedOut=1`)
    kcLogout.searchParams.set('client_id', tenant.authClientId)
    if (idToken) {
      kcLogout.searchParams.set('id_token_hint', idToken)
    }

    redirect(303, kcLogout.toString())
  }
}
