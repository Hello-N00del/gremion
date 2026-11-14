import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { infixSearch, searchWords, SEARCH_MAX_WORDS } from '$lib/server/members/search-words'

// Member search for the committee add-member panel (routes/members/committees/[id]/+page.svelte).
//
//   GET /api/users?search=<term>&slim=true&max=10[&first=<n>]
//   -> { success: true, data: [{ id, email, firstName, lastName, username }] }
//
// Scope: the calling tenant's realm only. The admin client is built from locals.tenant (the registry keys
// it by tenant id), never from a request parameter, so a `tenant=` or `realm=` query cannot reach another
// customer's users. A request with no tenant is refused rather than served from a default realm.
// Matching: any part of a first name, a last name, an e-mail address or a username finds the person, from
// one character on, in any case. Several words must all match, in any order. Keycloak's own default is a
// match at the START of a field only, so each word is sent as `*word*` (lib/server/members/search-words.ts);
// a `*` or a `"` in the input only separates words and never reaches Keycloak as a wildcard or a quote.
// Role: Role.CouncilAdmin through hasRole (admits the it-admin by the hierarchy), as the groups route and
// the committee member-add route do. 401 without a session, 403 with too low a role.
// Bounds: `max` is clamped to 1..25, `first` to 0..10000, a search with no word in it (empty, blank, only
// `*` or quotes) returns an empty list without asking Keycloak (no realm dump), a search over 100 characters
// or over 8 words is a 400. Service accounts (the kernel's own admin client) and disabled accounts are left
// out. Only the five fields above leave the route.
// The elections pages call `?export=email`; elections are off for the pilot and no export is built, so any
// `export` parameter is a 400. No search term and no address is logged.

const MAX_DEFAULT = 10
const MAX_CEILING = 25
const FIRST_CEILING = 10_000
const SEARCH_MAX_LENGTH = 100
const SERVICE_ACCOUNT_PREFIX = 'service-account-'

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Nicht angemeldet' }, { status: 401 })
  if (!hasRole(user.roles, Role.CouncilAdmin)) return json({ success: false, error: 'Forbidden' }, { status: 403 })
  if (!locals.tenant) return json({ success: false, error: 'Forbidden' }, { status: 403 })

  if (url.searchParams.has('export')) {
    return json({ success: false, error: 'Unbekannter Export' }, { status: 400 })
  }

  const search = (url.searchParams.get('search') ?? '').trim()
  if (search.length > SEARCH_MAX_LENGTH) {
    return json({ success: false, error: 'Suchbegriff zu lang' }, { status: 400 })
  }
  const words = searchWords(search)
  if (words.length === 0) return json({ success: true, data: [] })
  if (words.length > SEARCH_MAX_WORDS) {
    return json({ success: false, error: 'Zu viele Suchbegriffe' }, { status: 400 })
  }

  const max = boundedInt(url.searchParams.get('max'), MAX_DEFAULT, 1, MAX_CEILING)
  const first = boundedInt(url.searchParams.get('first'), 0, 0, FIRST_CEILING)

  try {
    const found = await getKeycloakAdminClient(locals.tenant).listUsers({ search: infixSearch(words), max, first, enabled: true })
    const data = found
      .filter((u) => !u.username.startsWith(SERVICE_ACCOUNT_PREFIX))
      // Keycloak leaves unset profile attributes out of its JSON; the contract requires all five fields.
      .map((u) => ({ id: u.id, email: u.email ?? '', firstName: u.firstName ?? '', lastName: u.lastName ?? '', username: u.username }))
    return json({ success: true, data })
  } catch (err) {
    // The upstream text can echo the search term (an address); log the error class only.
    console.error('[api/users] member search failed:', err instanceof Error ? err.name : 'error')
    return json({ success: false, error: 'Mitgliedersuche fehlgeschlagen' }, { status: 502 })
  }
}
