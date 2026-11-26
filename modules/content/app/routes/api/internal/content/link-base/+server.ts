// Kernel callback: the origin the content leaf builds its mail links from, for THIS send.
//
// The leaf holds no host for any tenant (see the header of modules/content/src/kernel-client.ts), so the
// unsubscribe link of a content e-mail cannot come from a value fixed when the leaf booted: a second
// customer's subscribers would be sent to the first customer's host. The leaf asks here at the start of
// every e-mail send and uses the answer for that send only.
//
// The answer is `https://<primary host>` of the tenant this call is for. The element-0 resolver has already
// selected that tenant from the x-tenant-id the leaf sends, authenticated with the very secret checked
// below (tenant/leaf-trust.ts), so `locals.tenant` IS the leaf's tenant. A tenant with no primary host gets
// a 404: there is nothing to link to, and a host is never made up from a slug or the platform domain.
//
// Guard: x-internal-auth, constant-time compared with INTERNAL_CONTENT_SECRET, like the sibling callback
// portal-publish. Public in hooks.server.ts PUBLIC_PATHS.
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { constantTimeEqual } from '$lib/server/internal-fetch'

export const GET: RequestHandler = ({ request, locals }) => {
  const secret = request.headers.get('x-internal-auth')
  const expected = process.env.INTERNAL_CONTENT_SECRET
  if (!expected || !secret || !constantTimeEqual(secret, expected)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  // The answer is per tenant and per send: nothing in between may keep it.
  const headers = { 'cache-control': 'no-store' }
  const host = locals.tenant.primaryHost
  if (!host) {
    return json({ success: false, error: 'No public host' }, { status: 404, headers })
  }
  return json({ origin: `https://${host}` }, { headers })
}
