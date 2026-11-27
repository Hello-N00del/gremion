// The command palette's search: minutes, calendar events, units and people.
//
// Each kind is offered to a person exactly as the page it links to would show it to them, so the palette
// is never a way around a page's own checks:
//   minutes   the Member page /members/committees/<unit>/protokolle/<id>, through the ONE visibility rule
//             (governance/visibility.ts): a Member sees the all_members units' minutes and their own units'
//             minutes, an admin all of them. The rule runs BEFORE the cap.
//   units     the Member page /members/committees/<unit>, which answers 404 for a committee_only unit to
//             anybody who is not in it (canSeeOrgUnit).
//   people    the Member directory /members, through searchMembers (the directory's own rule; no e-mail
//             address and no match on one for a non-admin).
//   events    the calendar page, open to a Guest; the calendar module's own provider answers, and only when
//             the customer has the module on (the route decides that).
// Everything reads through the caller's tenant: the database through getDb() (the request's tenant scope)
// and Keycloak through the client the caller built from locals.tenant.
import { canAccess, hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import type { KeycloakAdminClient } from '$lib/server/keycloak-admin'
import { getDataProvider } from '$lib/server/modules/runtime-registry'
import { searchProtocols } from '$lib/server/governance/protocols-db'
import { getOrgUnitIdsForUser, listOrgUnits } from '$lib/server/governance/org-units-db'
import {
  canSeeOrgUnit,
  filterVisibleProtocols,
  seesAllGovernance,
  visibleProtocolsWithoutMembership,
  type Viewer,
} from '$lib/server/governance/visibility'
import { searchMembers } from '$lib/server/members/member-view'
import { searchWords } from '$lib/server/members/search-words'
import { foldedIncludes } from './fold'

/** Shorter queries answer empty without asking anybody. */
export const MIN_QUERY_LENGTH = 2
/** Longer queries are refused. */
export const MAX_QUERY_LENGTH = 100
/** Hits per kind. */
export const RESULT_CAP = 5
/** Minutes are filtered by visibility after the query, so the query asks for more rows than it shows. */
const MINUTES_CANDIDATES = 200

export interface SearchHit {
  id: string
  label: string
  hint: string | null
  href: string
}

export interface SearchResults {
  minutes: SearchHit[]
  events: SearchHit[]
  units: SearchHit[]
  people: SearchHit[]
}

export function emptyResults(): SearchResults {
  return { minutes: [], events: [], units: [], people: [] }
}

/** The typed query with its blanks collapsed. */
export function normalizeQuery(raw: string | null): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

/** YYYY-MM-DD to DD.MM.YYYY. */
function germanDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** The calendar day of an instant in Europe/Berlin, as YYYY-MM-DD. */
function berlinDay(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** One failing kind answers empty and is logged by its class only: a search term (or an address typed
 *  into it) can be echoed by the error text, so neither it nor the message is logged. */
async function degrade<T>(kind: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run()
  } catch (err) {
    console.error(`[search] ${kind} degraded to empty:`, err instanceof Error ? err.name : 'error')
    return []
  }
}

async function findMinutes(query: string, viewer: Viewer): Promise<SearchHit[]> {
  const rows = await searchProtocols(query, MINUTES_CANDIDATES)
  const visible = await filterVisibleProtocols(viewer, rows).catch((err) => {
    console.error('[search] membership lookup failed, showing only minutes that need no membership:', err instanceof Error ? err.name : 'error')
    return visibleProtocolsWithoutMembership(viewer, rows)
  })
  return visible.slice(0, RESULT_CAP).map((p) => ({
    id: p.id,
    label: p.title,
    hint: `${germanDate(p.meetingDate)} · ${p.committeeName}`,
    href: `/members/committees/${p.committeeId}/protokolle/${p.id}`,
  }))
}

async function findUnits(query: string, viewer: Viewer): Promise<SearchHit[]> {
  const matching = (await listOrgUnits()).filter((u) => foldedIncludes(u.name, query))
  if (matching.length === 0) return []
  let own: ReadonlySet<string> = new Set()
  if (!seesAllGovernance(viewer)) {
    own = new Set(
      await getOrgUnitIdsForUser(viewer.id).catch((err) => {
        console.error('[search] membership lookup failed, hiding committee_only units:', err instanceof Error ? err.name : 'error')
        return [] as readonly string[]
      }),
    )
  }
  return matching
    .filter((u) => canSeeOrgUnit(viewer, u, own.has(u.id)))
    .slice(0, RESULT_CAP)
    .map((u) => ({ id: u.id, label: u.name, hint: null, href: `/members/committees/${u.id}` }))
}

async function findPeople(query: string, viewer: Viewer, kc: KeycloakAdminClient, isAdmin: boolean): Promise<SearchHit[]> {
  const hits = await searchMembers(kc, { words: searchWords(query), adminView: isAdmin, viewer, limit: RESULT_CAP })
  // A person without a handle (the basic view hides a user name that is an address) is keyed by position
  // and linked to the directory itself.
  return hits.map((p, i) => ({
    id: p.handle ?? `person-${i}`,
    label: p.name,
    hint: isAdmin ? p.email : p.units.slice(0, 2).join(', ') || null,
    href: p.handle ? `/members?member=${encodeURIComponent(p.handle)}` : '/members',
  }))
}

async function findEvents(query: string): Promise<SearchHit[]> {
  const provider = getDataProvider('calendar:search-events')
  if (!provider) return []
  const rows = await provider({ query, limit: RESULT_CAP })
  return rows.slice(0, RESULT_CAP).map((e) => {
    const day = berlinDay(e.startAt)
    return { id: e.id, label: e.title, hint: germanDate(day), href: `/calendar?date=${day}` }
  })
}

export interface PaletteSearchInput {
  /** Already through normalizeQuery and within the length bounds. */
  query: string
  user: Pick<SessionUser, 'id' | 'roles'>
  /** Built from the caller's tenant (never from a request parameter). */
  kc: KeycloakAdminClient
  /** The caller's tenant's page access map (pageAccessForTenant). */
  pageAccess: Record<string, Role>
  /** The customer has the calendar module switched on. */
  calendarOn: boolean
}

export async function searchForPalette(input: PaletteSearchInput): Promise<SearchResults> {
  const { query, user, kc, pageAccess, calendarOn } = input
  if (query.length < MIN_QUERY_LENGTH) return emptyResults()

  const roles = [...user.roles]
  const viewer: Viewer = { id: user.id, roles }
  // The kinds that link into /members/*: the same minimum role as that page (PAGE_ACCESS 'members').
  const members = canAccess(roles, 'members', pageAccess)
  // A build without the calendar module has no 'calendar' page entry; canAccess throws for an unknown page
  // in development, and a missing calendar must never fail the other kinds.
  const calendar = calendarOn && pageAccess['calendar'] !== undefined && canAccess(roles, 'calendar', pageAccess)
  const isAdmin = hasRole(roles, Role.CouncilAdmin) || hasRole(roles, Role.ITAdmin)

  const [minutes, units, people, events] = await Promise.all([
    members ? degrade('minutes', () => findMinutes(query, viewer)) : [],
    members ? degrade('units', () => findUnits(query, viewer)) : [],
    members ? degrade('people', () => findPeople(query, viewer, kc, isAdmin)) : [],
    calendar ? degrade('events', () => findEvents(query)) : [],
  ])
  return { minutes, events, units, people }
}
