// Public (no-auth) content-engine unsubscribe landing page. This is the URI the
// content email footer links to (`/content/unsubscribe?token=…`). It is exempted
// from the session guard in hooks.server.ts (publicPaths) exactly like the
// newsletter-leaf unsubscribe — the tenant resolver still runs, so the
// content-db queries below hit the correct tenant DB.
//
// K5#19 / S3#38 (F1-FIX-07): the GET load NEVER consumes the token. Link
// scanners and mail-client prefetchers issue GETs; a GET that consumed the
// single-use token unsubscribed recipients who never clicked and burned the
// link. GET renders a confirmation; the POST form action consumes. The action is
// also the RFC 8058 one-click target (POST with the token in the URL and the
// body `List-Unsubscribe=One-Click`).
//
// consumeUnsubscribeToken atomically validates the token, records the
// unsubscribe, and deletes the token (one-shot). The action renders its three
// outcomes:
//   - ok       → confirmation.
//   - expired  → the link is past its 7-day TTL.
//   - invalid  → no such token (already used, or never minted).
import type { Actions, PageServerLoad } from './$types'
import { resolveContentBackendForPage } from '$lib/server/content/backend/resolve'

export type UnsubscribeStatus = 'ok' | 'expired' | 'invalid'

export const load: PageServerLoad = async ({
  url,
}): Promise<{ status: 'confirm' | 'invalid'; token: string | null }> => {
  const token = url.searchParams.get('token')
  if (!token) return { status: 'invalid', token: null }
  return { status: 'confirm', token }
}

export const actions: Actions = {
  default: async ({ request, url }): Promise<{ status: UnsubscribeStatus }> => {
    const form = await request.formData().catch(() => null)
    const posted = form?.get('token')
    const token = (typeof posted === 'string' && posted) || url.searchParams.get('token')
    if (!token) return { status: 'invalid' }

    const backend = resolveContentBackendForPage()
    const result = await backend.consumeUnsubscribeToken(token)
    if (result.ok) return { status: 'ok' }
    return { status: result.reason }
  },
}
