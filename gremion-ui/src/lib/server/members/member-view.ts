// WI-4B Unified Mitglieder — friendly, leak-free Member projection.
//
// A Member *is* a Keycloak user (real UUID, server-side only) plus optional
// `org_unit_members` rows. This module assembles the friendly client DTO from
// the Keycloak admin client + the governance DB, emitting only the design's
// friendly German strings — never a raw UUID, group id, realm-role key, or any
// "Keycloak"/"SSO" plumbing string. The client-facing `id` is the opaque
// username handle; action endpoints resolve it back to the UUID server-side
// (see ./resolve-handle).
//
// Friendly strings mirror the v6 design contract (`contracts.jsx §2`
// FRIENDLY_ROLES / FRIENDLY_SCOPES), which intentionally differ from the
// `$lib/auth/labels.ts` strings (e.g. council-admin → "Vorstand" here vs
// "Gremienverwaltung" there). The labels.ts util stays the source of truth for
// hidden-plumbing rules elsewhere; here we use the design's user-facing names.
import { getKeycloakAdminClientForCurrentTenant, type KcUser } from '$lib/server/keycloak-admin'
import { getOrgUnitIdsForUser, getOrgUnit, listOrgUnitMembers } from '$lib/server/governance/org-units-db'
import { tlog } from '$lib/server/observability/tenant-log'

export interface MemberMembership {
  gremium_or_referat_name: string
  ou_key: string
  role: string // Gewählt | Berufen | Angestellt | Mitglied
  term: string | null
}

export interface Member {
  id: string // opaque handle (username) — never the UUID
  name: string
  email: string
  enabled: boolean
  roles: string[] // friendly
  scopes: string[] // friendly capabilities
  memberships: MemberMembership[]
  placed: boolean
}

// design strings (contracts.jsx §2 FRIENDLY_SCOPES) — raw group id → capability
const SCOPE_FROM_GROUP: Record<string, string> = {
  'ref-finanzen-hv': 'Belege freigeben',
  'ref-finanzen-kv': 'Belege prüfen',
  'ref-finanzen': 'Finanzen bearbeiten',
  admin: 'Mitglieder verwalten',
  'it-admin': 'System & Integrationen',
}
const SCOPE_ORDER = ['ref-finanzen-hv', 'ref-finanzen-kv', 'ref-finanzen', 'admin', 'it-admin']
const MEMBERSHIP_ROLE: Record<string, string> = {
  elected: 'Gewählt',
  unelected: 'Berufen',
  employee: 'Angestellt',
}

function formatTerm(start: string | Date | null, end: string | Date | null): string | null {
  if (!start && !end) return null
  const y = (d: string | Date | null) => (d ? new Date(d).getFullYear() : '…')
  return `${y(start)} – ${y(end)}`
}

export async function memberView(u: KcUser): Promise<Member> {
  const kc = getKeycloakAdminClientForCurrentTenant()
  // Degrade-not-error: memberView runs inside listMembers' Promise.all over up to
  // 500 users, so one user's KC role/group fetch failure must NOT reject the whole
  // members page — we log the degradation (visible in the fleet log) and fall back
  // to [] so the member still renders, just without that facet.
  const [realmRoles, groups, ouIds] = await Promise.all([
    kc
      .listUserRoles(u.id)
      .then((r) => r.map((x) => x.name))
      .catch((err) => {
        tlog('warn', '[member-view] KC role/group fetch degraded', { userId: u.id, error: String(err) })
        return [] as string[]
      }),
    kc
      .listUserGroups(u.id)
      .then((g) => g.map((x) => x.name))
      .catch((err) => {
        tlog('warn', '[member-view] KC role/group fetch degraded', { userId: u.id, error: String(err) })
        return [] as string[]
      }),
    getOrgUnitIdsForUser(u.id),
  ])

  const memberships: MemberMembership[] = []
  for (const ouId of ouIds) {
    const ou = await getOrgUnit(ouId)
    if (!ou) continue
    const row = (await listOrgUnitMembers(ouId)).find((m) => m.user_keycloak_id === u.id)
    memberships.push({
      gremium_or_referat_name: ou.name,
      ou_key: ou.id,
      role: row ? (MEMBERSHIP_ROLE[row.membership_type] ?? row.membership_type) : 'Mitglied',
      term: row ? formatTerm(row.term_start, row.term_end) : null,
    })
  }

  const placed = memberships.length > 0
  const roles: string[] = []
  if (placed) roles.push('Mitglied')
  if (realmRoles.includes('council-admin')) roles.push('Vorstand')
  if (groups.includes('admin')) roles.push('Admin')
  if (realmRoles.includes('it-admin')) roles.push('IT-Team')
  if (groups.includes('ref-finanzen')) roles.push('Finanzen')
  if (!placed && realmRoles.includes('guest')) roles.push('Eingeladen')

  const scopes = SCOPE_ORDER.filter((g) => groups.includes(g)).map((g) => SCOPE_FROM_GROUP[g])

  return {
    id: u.username,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username,
    email: u.email,
    enabled: u.enabled,
    roles: [...new Set(roles)],
    scopes,
    memberships,
    placed,
  }
}

export async function listMembers(opts: { adminView: boolean }): Promise<Member[]> {
  const kc = getKeycloakAdminClientForCurrentTenant()
  // admin sees all incl. disabled/invited; basic view starts from enabled only
  const users = await kc.listUsers({ first: 0, max: 500, enabled: opts.adminView ? undefined : true })
  const members = await Promise.all(users.map((u) => memberView(u)))
  if (opts.adminView) return members
  return members.filter((m) => m.placed && m.enabled)
}
