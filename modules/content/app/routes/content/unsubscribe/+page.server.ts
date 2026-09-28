// Public (no-auth) content-engine unsubscribe landing page. This is the URI the
// content email footer links to (`/content/unsubscribe?token=…`). It is exempted
// from the session guard in hooks.server.ts (publicPaths) exactly like the
// newsletter-leaf unsubscribe — the tenant resolver still runs, so the
// content-db queries below hit the correct tenant DB.
//
// consumeUnsubscribeToken atomically validates the token, records the
// unsubscribe, and deletes the token (one-shot). We render its three outcomes:
//   - ok       → confirmation.
//   - expired  → the link is past its 7-day TTL.
//   - invalid  → no such token (already used, or never minted).
import type { PageServerLoad } from './$types'
import { resolveContentBackendForPage } from '$lib/server/content/backend/resolve'

export type UnsubscribeStatus = 'ok' | 'expired' | 'invalid'

export const load: PageServerLoad = async ({ url }): Promise<{ status: UnsubscribeStatus }> => {
  const token = url.searchParams.get('token')
  if (!token) return { status: 'invalid' }

  const backend = resolveContentBackendForPage()
  const result = await backend.consumeUnsubscribeToken(token)
  if (result.ok) return { status: 'ok' }
  return { status: result.reason }
}
