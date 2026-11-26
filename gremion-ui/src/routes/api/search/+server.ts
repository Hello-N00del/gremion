import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { pageAccessForTenant } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { readConfig } from '$lib/server/config'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { disabledModuleForPath } from '$lib/server/module-gate'
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  emptyResults,
  normalizeQuery,
  searchForPalette,
} from '$lib/server/search/palette-search'

// GET /api/search?q=<text>  -> { success: true, data: { minutes, events, units, people } }
// Each kind is a list of { id, label, hint, href }, at most five per kind.
//
// The command palette (Ctrl+K) searches minutes (title, body, date), calendar events (title, date), units
// (name) and people (name) with this one endpoint. What a person finds is what the page each result links
// to would show them: see lib/server/search/palette-search.ts for the rule per kind.
// Scope: the calling tenant only. The database is read through the request's tenant scope and the Keycloak
// client is built from locals.tenant, never from a request parameter. A request with no tenant is refused.
// Bounds: a query under two characters (after trimming) answers empty without asking any backend; one over
// 100 characters is a 400. No query text and no error text is logged.

export const GET: RequestHandler = async ({ url, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Nicht angemeldet' }, { status: 401 })
  if (!locals.tenant) return json({ success: false, error: 'Forbidden' }, { status: 403 })

  const query = normalizeQuery(url.searchParams.get('q'))
  if (query.length > MAX_QUERY_LENGTH) {
    return json({ success: false, error: 'Suchbegriff zu lang' }, { status: 400 })
  }
  if (query.length < MIN_QUERY_LENGTH) return json({ success: true, data: emptyResults() })

  const data = await searchForPalette({
    query,
    user,
    kc: getKeycloakAdminClient(locals.tenant),
    pageAccess: pageAccessForTenant(locals.tenant),
    // The module gate answers for the calendar page; the same switch decides here.
    calendarOn: disabledModuleForPath('/calendar', readConfig()) === null,
  })
  return json({ success: true, data })
}
