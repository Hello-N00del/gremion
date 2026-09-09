export type RealmRole = 'guest' | 'member' | 'council-admin' | 'it-admin'
import type { OrgUnitKind, MembershipType } from '../governance/org-units-db'
import type { OrgSchema } from '../governance/org-schema'
import { GREMION_ORG_SCHEMA, validateRootCounts, validateCreatePlacement } from '../governance/org-schema'
export type { OrgUnitKind, MembershipType }
export type Visibility = 'all_members' | 'committee_only'
export type ElectionMethod = 'helios' | 'poll' | 'manual'

export interface BlueprintUser {
  username: string
  firstName: string
  lastName: string
  email: string
  realmRole: RealmRole
}
export interface BlueprintOrgUnit {
  key: string
  name: string
  description: string | null
  /** Tenant kind key — validated against the per-tenant org schema (P2.2), no longer a closed union. */
  kind: string
  parentKey: string | null
  visibility: Visibility
  wantsMatrixRoom: boolean
  wantsNextcloudFolder: boolean
  childTerm?: string | null
  /** D-KL: per-unit display label override (NULL/absent → catalog label). */
  kindLabel?: string | null
  /** §3.5(d): beratend vs beschließend; absent → 'deciding' (StuRa-compatible). */
  authority?: 'advisory' | 'deciding'
}
export interface BlueprintMembership {
  userKey: string
  orgUnitKey: string
  membershipType: MembershipType
  termStart: string | null
  termEnd: string | null
  /** §3.5(d): sachkundige Bürger sit without a vote; absent → true. */
  voting?: boolean
}
/** Per-tenant kind-catalog entry (upserted into `org_unit_kind` at seed time). */
export interface BlueprintKind {
  key: string
  label: string
  childTerm?: string | null
  allowedParentKinds: string[]
  canBeRoot: boolean
  rootMin?: number
  rootMax?: number | null
  sortOrder?: number
}
/** Orthogonal caucus/Fraktion dimension (design D1, §3.5(c)). */
export interface BlueprintCaucus {
  key: string
  councilOrgUnitKey: string
  name: string
  color?: string | null
  members: Array<{ userKey: string; termStart?: string | null; termEnd?: string | null }>
}
export interface CaucusPolicy {
  min_size?: number
  allow_groups?: boolean
  proportional_committee_allocation?: boolean
}
export interface BlueprintRole {
  key: string
  orgUnitKey: string
  name: string
  electionMethod: ElectionMethod
  isElected: boolean
}
export interface BlueprintAssignment {
  roleKey: string
  userKey: string
  startDate: string
  endDate: string
}
export interface GremionBlueprint {
  /** Versioned declarative document (§3.5(g)); bumped on breaking blueprint-shape changes. */
  schema_version: 1
  users: BlueprintUser[]
  orgUnits: BlueprintOrgUnit[]
  memberships: BlueprintMembership[]
  roles: BlueprintRole[]
  assignments: BlueprintAssignment[]
  /** Per-tenant kind catalog; absent → GREMION_ORG_SCHEMA / migration-038 defaults. */
  orgSchema?: BlueprintKind[]
  /** Caucus/Fraktion section; absent for StuRa (zero rows = feature disabled). */
  caucuses?: { policy?: CaucusPolicy; caucuses: BlueprintCaucus[] }
  /**
   * Which demo-fixture set the opt-in `includeDemo` path seeds for this vertical.
   * The legacy demo seeders (seedProtocols/seedCalendar/…) are hardcoded to StuRa
   * org-unit keys and usernames, so they MUST NOT run for another vertical — they
   * would throw `unknown org-unit key "studierendenrat"`. Absent → 'stura'
   * (byte-identical StuRa behavior). 'municipal' → the vertical-aware municipal
   * demo seeder keyed on this blueprint's own keys. (P2.3 #202 — Component 3.)
   */
  demoSeeder?: 'stura' | 'municipal'
}

/** @deprecated use GremionBlueprint — kept so existing imports keep compiling. */
export type OrgBlueprint = GremionBlueprint

/** Returns a list of human-readable error strings; empty means the blueprint is valid.
 *  Root/kind/parent rules come from the per-tenant org schema (P2.2, D-RB) so the
 *  seed-time validator and the runtime create paths share one rule source. */
export function validateBlueprint(bp: GremionBlueprint, schema: OrgSchema = GREMION_ORG_SCHEMA): string[] {
  const errors: string[] = []
  const userKeys = new Set<string>()
  for (const u of bp.users) {
    if (userKeys.has(u.username)) errors.push(`duplicate username: ${u.username}`)
    userKeys.add(u.username)
  }
  const ouKeys = new Set<string>()
  const parentOf = new Map<string, string | null>()
  for (const ou of bp.orgUnits) {
    if (ouKeys.has(ou.key)) errors.push(`duplicate org-unit key: ${ou.key}`)
    ouKeys.add(ou.key)
    parentOf.set(ou.key, ou.parentKey)
  }
  const roleKeys = new Set<string>()
  for (const r of bp.roles) {
    if (roleKeys.has(r.key)) errors.push(`duplicate role key: ${r.key}`)
    roleKeys.add(r.key)
  }

  // Root cardinality (D-RB): per-kind bounds over the blueprint's roots — read
  // from the org schema (tenant data), not a hardcoded single-council rule.
  const rootCounts = new Map<string, number>()
  for (const ou of bp.orgUnits) {
    if (ou.parentKey === null) rootCounts.set(ou.kind, (rootCounts.get(ou.kind) ?? 0) + 1)
  }
  errors.push(...validateRootCounts(schema, rootCounts))

  // Per-unit kind + parent-placement rules from the same schema the runtime
  // create paths use (Task 10) so seed-time and runtime cannot drift apart.
  const kindOf = new Map<string, string>()
  for (const ou of bp.orgUnits) kindOf.set(ou.key, ou.kind)
  for (const ou of bp.orgUnits) {
    if (!schema.kinds[ou.kind]) {
      // root units of unknown kinds are already reported by validateRootCounts
      if (ou.parentKey !== null) errors.push(`org-unit ${ou.key}: unknown kind: '${ou.kind}'`)
      continue
    }
    if (ou.parentKey === null) continue // root placement is covered by validateRootCounts
    const parentKind = kindOf.get(ou.parentKey)
    if (parentKind === undefined) continue // dangling parentKey — the check below reports it
    const placementError = validateCreatePlacement(schema, ou.kind, parentKind)
    if (placementError) errors.push(`org-unit ${ou.key}: ${placementError}`)
  }

  for (const ou of bp.orgUnits) {
    if (ou.parentKey !== null && !ouKeys.has(ou.parentKey)) {
      errors.push(`org-unit ${ou.key} has dangling parentKey: ${ou.parentKey}`)
    }
  }
  // cycle detection: walk each node's parent chain
  for (const ou of bp.orgUnits) {
    const seen = new Set<string>()
    let cur: string | null = ou.key
    while (cur !== null) {
      if (seen.has(cur)) { errors.push(`org-unit ${ou.key} is part of a parent cycle`); break }
      seen.add(cur)
      cur = parentOf.get(cur) ?? null
    }
  }

  for (const m of bp.memberships) {
    if (!userKeys.has(m.userKey)) errors.push(`membership references unknown user: ${m.userKey}`)
    if (!ouKeys.has(m.orgUnitKey)) errors.push(`membership references unknown org-unit: ${m.orgUnitKey}`)
  }
  for (const r of bp.roles) {
    if (!ouKeys.has(r.orgUnitKey)) errors.push(`role ${r.key} references unknown org-unit: ${r.orgUnitKey}`)
  }
  for (const a of bp.assignments) {
    if (!roleKeys.has(a.roleKey)) errors.push(`assignment references unknown role: ${a.roleKey}`)
    if (!userKeys.has(a.userKey)) errors.push(`assignment references unknown user: ${a.userKey}`)
  }
  // Caucus integrity (D1, D-CD): a pure in-memory mirror of the migration-039
  // constraints — the caucus→org-unit FK, the member→user reference, and the
  // one-faction-per-member-per-council UNIQUE(council_org_unit_id, user_keycloak_id).
  if (bp.caucuses) {
    const caucusKeys = new Set<string>()
    const memberPerCouncil = new Set<string>() // NUL-separated: `${councilKey}\u0000${userKey}`
    for (const c of bp.caucuses.caucuses) {
      if (caucusKeys.has(c.key)) errors.push(`duplicate caucus key: ${c.key}`)
      caucusKeys.add(c.key)
      if (!ouKeys.has(c.councilOrgUnitKey)) {
        errors.push(`caucus ${c.key} references unknown org-unit: ${c.councilOrgUnitKey}`)
      }
      for (const m of c.members) {
        if (!userKeys.has(m.userKey)) {
          errors.push(`caucus ${c.key} member references unknown user: ${m.userKey}`)
        }
        const pair = `${c.councilOrgUnitKey}\u0000${m.userKey}`
        if (memberPerCouncil.has(pair)) {
          errors.push(
            `user ${m.userKey} is in more than one caucus of council ${c.councilOrgUnitKey} (one caucus per member per council)`
          )
        }
        memberPerCouncil.add(pair)
      }
    }
  }
  return errors
}

// --- The realistic StuRa mirror (test fixtures) ---
// Term epochs for the fixture. The elected term (Oct 2025 – Sep 2026) is the
// currently-active StuRa term; the appointment dates are seed-authoring-relative
// (authored 2026-05-22) and run one year forward.
const ELECTED_START = '2025-10-01'
const ELECTED_END = '2026-09-30'
const APPOINTED_START = '2026-05-22'
const APPOINTED_END = '2027-05-22'

export const STURA_BLUEPRINT: GremionBlueprint = {
  schema_version: 1,
  users: [
    { username: 'anna.berger',  firstName: 'Anna',   lastName: 'Berger',  email: 'anna.berger@council.example',  realmRole: 'council-admin' },
    { username: 'ben.hoffmann', firstName: 'Ben',    lastName: 'Hoffmann', email: 'ben.hoffmann@council.example', realmRole: 'council-admin' },
    { username: 'clara.wagner', firstName: 'Clara',  lastName: 'Wagner',  email: 'clara.wagner@council.example',  realmRole: 'member' },
    { username: 'david.schulz', firstName: 'David',  lastName: 'Schulz',  email: 'david.schulz@council.example',  realmRole: 'member' },
    { username: 'emma.fischer', firstName: 'Emma',   lastName: 'Fischer', email: 'emma.fischer@council.example',  realmRole: 'member' },
    { username: 'felix.weber',  firstName: 'Felix',  lastName: 'Weber',   email: 'felix.weber@council.example',   realmRole: 'member' },
    { username: 'greta.koch',   firstName: 'Greta',  lastName: 'Koch',    email: 'greta.koch@council.example',    realmRole: 'member' },
    { username: 'hannes.bauer', firstName: 'Hannes', lastName: 'Bauer',   email: 'hannes.bauer@council.example',  realmRole: 'member' },
    { username: 'ida.richter',  firstName: 'Ida',    lastName: 'Richter', email: 'ida.richter@council.example',   realmRole: 'member' },
    { username: 'jonas.klein',  firstName: 'Jonas',  lastName: 'Klein',   email: 'jonas.klein@council.example',   realmRole: 'member' },
    { username: 'klara.wolf',   firstName: 'Klara',  lastName: 'Wolf',    email: 'klara.wolf@council.example',    realmRole: 'guest' },
    { username: 'lena.neumann', firstName: 'Lena',   lastName: 'Neumann', email: 'lena.neumann@council.example',  realmRole: 'member' },
    { username: 'tobias.krause',firstName: 'Tobias', lastName: 'Krause',  email: 'tobias.krause@council.example', realmRole: 'it-admin' },
    // tom.maier: deliberate fixture — a registered 'guest' user with no org-unit
    // membership, exercising the "invited but not yet placed" account state.
    { username: 'tom.maier',    firstName: 'Tom',    lastName: 'Maier',   email: 'tom.maier@council.example',     realmRole: 'guest' },
    { username: 'dev.admin',    firstName: 'Dev',    lastName: 'Admin',   email: 'dev.admin@council.example',     realmRole: 'it-admin' }
  ],
  orgUnits: [
    { key: 'studierendenrat', name: 'Studierendenrat', description: 'Das StuRa-Plenum', kind: 'council',
      parentKey: null, visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true,
      childTerm: 'Referate, Fachschaften & Initiativen' },
    // kindLabel overrides mirror the migration-038 backfill exactly (D-KL):
    // where the retired name-sniffing helper's output differed from the
    // catalog label, the fixture pins it so seeded rendering stays identical.
    { key: 'vorstand', name: 'Vorstand', description: 'Geschäftsführender Vorstand', kind: 'committee',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true,
      childTerm: 'Arbeitsgruppen', kindLabel: 'Vorstand' },
    { key: 'it-team', name: 'IT-Team', description: 'Technische Betreuung', kind: 'group',
      parentKey: 'vorstand', visibility: 'committee_only', wantsMatrixRoom: true, wantsNextcloudFolder: true },
    { key: 'ref-finanzen', name: 'Referat Finanzen', description: 'Haushalt und Finanzen', kind: 'committee',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true },
    { key: 'ref-hochschulpolitik', name: 'Referat Hochschulpolitik', description: 'Hochschulpolitische Arbeit', kind: 'committee',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true,
      childTerm: 'Arbeitsgruppen' },
    { key: 'ag-nachhaltigkeit', name: 'AG Nachhaltigkeit', description: 'Arbeitsgruppe Nachhaltigkeit', kind: 'group',
      parentKey: 'ref-hochschulpolitik', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true,
      kindLabel: 'AG' },
    { key: 'ref-oeffentlichkeit', name: 'Referat Öffentlichkeitsarbeit', description: 'Presse und Kommunikation', kind: 'committee',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true },
    { key: 'ref-soziales', name: 'Referat Soziales', description: 'Soziale Beratung', kind: 'committee',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true },
    { key: 'fs-informatik', name: 'Fachschaft Informatik', description: 'FS Informatik', kind: 'group',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true,
      kindLabel: 'Fachschaft' },
    { key: 'fs-maschinenbau', name: 'Fachschaft Maschinenbau', description: 'FS Maschinenbau', kind: 'group',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true,
      kindLabel: 'Fachschaft' },
    { key: 'ini-kulturcafe', name: 'Initiative Kulturcafé', description: 'Selbstverwaltete Initiative', kind: 'group',
      parentKey: 'studierendenrat', visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true,
      kindLabel: 'Initiative' }
  ],
  memberships: [
    { userKey: 'anna.berger',  orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'anna.berger',  orgUnitKey: 'vorstand',        membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'ben.hoffmann', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'ben.hoffmann', orgUnitKey: 'vorstand',        membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'clara.wagner', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'clara.wagner', orgUnitKey: 'vorstand',        membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'clara.wagner', orgUnitKey: 'ref-finanzen',    membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'david.schulz', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'david.schulz', orgUnitKey: 'ref-hochschulpolitik', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'emma.fischer', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'emma.fischer', orgUnitKey: 'ref-oeffentlichkeit', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'felix.weber',  orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'felix.weber',  orgUnitKey: 'ref-soziales',    membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'greta.koch',   orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'hannes.bauer', orgUnitKey: 'studierendenrat', membershipType: 'elected', termStart: ELECTED_START, termEnd: ELECTED_END },
    { userKey: 'ida.richter',  orgUnitKey: 'ref-finanzen',    membershipType: 'unelected', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'jonas.klein',  orgUnitKey: 'ag-nachhaltigkeit', membershipType: 'unelected', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'klara.wolf',   orgUnitKey: 'ag-nachhaltigkeit', membershipType: 'unelected', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'lena.neumann', orgUnitKey: 'studierendenrat', membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'lena.neumann', orgUnitKey: 'ref-soziales',    membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'tobias.krause',orgUnitKey: 'it-team',         membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    // dev.admin is the all-access development superuser: the central-finance actor
    // for the seeded finance fixtures (master spec §6, Task 21) AND a member of
    // every org-unit so it can act everywhere. Its Keycloak group membership
    // (every realm group) is granted separately in seed.ts → seedDevAdminGroups.
    { userKey: 'dev.admin',    orgUnitKey: 'studierendenrat',     membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'vorstand',            membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'it-team',             membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-finanzen',        membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-hochschulpolitik',membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ag-nachhaltigkeit',   membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-oeffentlichkeit', membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ref-soziales',        membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'fs-informatik',       membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'fs-maschinenbau',     membershipType: 'employee', termStart: APPOINTED_START, termEnd: null },
    { userKey: 'dev.admin',    orgUnitKey: 'ini-kulturcafe',      membershipType: 'employee', termStart: APPOINTED_START, termEnd: null }
  ],
  roles: [
    { key: 'vorsitz',           orgUnitKey: 'vorstand',            name: 'Vorsitz',                          electionMethod: 'helios', isElected: true },
    { key: 'stellv-vorsitz',    orgUnitKey: 'vorstand',            name: 'Stellvertretende·r Vorsitz',       electionMethod: 'helios', isElected: true },
    { key: 'finanzvorstand',    orgUnitKey: 'vorstand',            name: 'Finanzvorstand',                   electionMethod: 'helios', isElected: true },
    { key: 'referent-finanzen', orgUnitKey: 'ref-finanzen',        name: 'Referent·in Finanzen',             electionMethod: 'poll',   isElected: true },
    { key: 'referent-hopo',     orgUnitKey: 'ref-hochschulpolitik',name: 'Referent·in Hochschulpolitik',     electionMethod: 'poll',   isElected: true },
    { key: 'referent-oeffi',    orgUnitKey: 'ref-oeffentlichkeit', name: 'Referent·in Öffentlichkeitsarbeit',electionMethod: 'poll',   isElected: true },
    { key: 'referent-soziales', orgUnitKey: 'ref-soziales',        name: 'Referent·in Soziales',             electionMethod: 'poll',   isElected: true },
    { key: 'it-verantwortung',  orgUnitKey: 'it-team',             name: 'IT-Verantwortung',                 electionMethod: 'manual', isElected: false }
  ],
  assignments: [
    { roleKey: 'vorsitz',           userKey: 'anna.berger',   startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'stellv-vorsitz',    userKey: 'ben.hoffmann',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'finanzvorstand',    userKey: 'clara.wagner',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-finanzen', userKey: 'clara.wagner',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-hopo',     userKey: 'david.schulz',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-oeffi',    userKey: 'emma.fischer',  startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'referent-soziales', userKey: 'felix.weber',   startDate: ELECTED_START,   endDate: ELECTED_END },
    { roleKey: 'it-verantwortung',  userKey: 'tobias.krause', startDate: APPOINTED_START, endDate: APPOINTED_END }
  ]
}

// Carve note: the finance feature module is not part of the governance-only
// kernel, so the StuRa blueprint no longer carries a `finance` fixture section.
// The block below is the former finance fixture, retained only as a comment for
// reference when the finance module is re-attached as a separate module.
/* FINANCE FIXTURE (carved out):
  finance: {
    finanzordnungProfile: {
      bundesland: 'Thüringen',
      deckungsfaehigkeitPct: 20,
      reserveBase: 'contribution_income',
      reserveFreiAmountCents: 5000000, reserveFreiBound: 'ceiling',
      reserveBetriebsmittelAmountCents: 3000000, reserveBetriebsmittelBound: 'ceiling',
      reserveZweckgebundenAmountCents: 0, reserveZweckgebundenBound: 'ceiling',
      carryOverCentral: 'to_reserves',
      carryOverFachschaft: 'carry_forward',
      retentionYears: 6, retentionFrom: 'entlastung',
      inventarThresholdCents: 80000, handkasseCapCents: 50000,
      majorityHaushalt: 'simple', majorityNachtrag: 'two_thirds', majorityEntlastung: 'simple'
    },
    financeUnits: [
      // central singleton on the StuRa root — bookkeeping_mode 'central'
      { key: 'fu-stura', orgUnitKey: 'studierendenrat', kind: 'central',
        bookkeepingMode: 'central', carryOverRule: 'to_reserves' },
      // Fachschaft with its own books (own-account variant)
      { key: 'fu-fs-inf', orgUnitKey: 'fs-informatik', kind: 'standard',
        bookkeepingMode: 'own', carryOverRule: 'carry_forward' },
      // Fachschaft booked centrally (allocations-only variant)
      { key: 'fu-fs-mb', orgUnitKey: 'fs-maschinenbau', kind: 'standard',
        bookkeepingMode: 'central', carryOverRule: 'carry_forward' },
      // autonomous Initiative — own books on a sub-fund
      { key: 'fu-ini', orgUnitKey: 'ini-kulturcafe', kind: 'standard',
        bookkeepingMode: 'own', carryOverRule: 'carry_forward' }
    ],
    fiscalYears: [
      { key: 'fy-2026', name: 'Haushaltsjahr 2026', startDate: '2026-01-01', endDate: '2026-12-31' }
    ],
    bankAccounts: [
      { key: 'ba-giro', name: 'StuRa Girokonto', iban: 'DE89370400440532013000',
        currentBalanceCents: 4250000 }
    ],
    ledgerAccounts: [
      // own_account — the central StuRa Hauptkasse, 1:1 with the giro account
      { key: 'la-stura-haupt', financeUnitKey: 'fu-stura', bankAccountKey: 'ba-giro',
        type: 'own_account', name: 'StuRa Hauptkasse' },
      // sub_fund — the Initiative's earmarked Unterkonto inside the giro account
      { key: 'la-ini-sub', financeUnitKey: 'fu-ini', bankAccountKey: 'ba-giro',
        type: 'sub_fund', name: 'Kulturcafé Unterkonto' },
      // cash_box — a Handkasse with no bank backing
      { key: 'la-stura-kasse', financeUnitKey: 'fu-stura', bankAccountKey: null,
        type: 'cash_box', name: 'StuRa Handkasse' }
    ],
    budgetPlans: [
      { key: 'bp-2026', fiscalYearKey: 'fy-2026', name: 'Haushaltsplan 2026', state: 'active',
        sections: [
          { key: 'sec-stura', financeUnitKey: 'fu-stura', preparationState: 'submitted_to_central',
            groups: [
              { key: 'grp-stura-verw', name: 'Verwaltung', budgetType: 'expense',
                titel: [
                  { key: 'tit-buero', titelNr: '1.1', titelName: 'Bürobedarf',
                    plannedCents: 300000, deckungsfaehig: false, deckungsGroup: null },
                  { key: 'tit-veranst', titelNr: '1.2', titelName: 'Veranstaltungen',
                    plannedCents: 800000, deckungsfaehig: true, deckungsGroup: 'events' }
                ] },
              { key: 'grp-stura-ein', name: 'Einnahmen', budgetType: 'income',
                titel: [
                  { key: 'tit-beitrag', titelNr: '9.1', titelName: 'Studierendenbeiträge',
                    plannedCents: 6000000, deckungsfaehig: false, deckungsGroup: null }
                ] }
            ] },
          { key: 'sec-fs-inf', financeUnitKey: 'fu-fs-inf', preparationState: 'submitted_to_central',
            groups: [
              { key: 'grp-fs-inf', name: 'FS-Informatik Aktivitäten', budgetType: 'expense',
                titel: [
                  { key: 'tit-erstifahrt', titelNr: '2.1', titelName: 'Erstifahrt',
                    plannedCents: 200000, deckungsfaehig: true, deckungsGroup: 'fs-events' }
                ] }
            ] },
          { key: 'sec-ini', financeUnitKey: 'fu-ini', preparationState: 'submitted_to_central',
            groups: [
              { key: 'grp-ini', name: 'Kulturcafé Betrieb', budgetType: 'expense',
                titel: [
                  { key: 'tit-cafe', titelNr: '3.1', titelName: 'Cafébetrieb',
                    plannedCents: 120000, deckungsfaehig: false, deckungsGroup: null }
                ] }
            ] }
        ] }
    ],
    projects: [
      { key: 'prj-erstifahrt', orgUnitKey: 'fs-informatik', type: 'internal',
        name: 'Erstifahrt Informatik 2026', state: 'approved',
        responsibleUserKey: 'david.schulz', description: 'Erstsemester-Fahrt der FS Informatik',
        dateStart: '2026-04-10', dateEnd: '2026-04-12' },
      { key: 'prj-kulturfoerderung', orgUnitKey: 'ini-kulturcafe', type: 'external_grant',
        name: 'Kulturförderung Land', state: 'submitted',
        responsibleUserKey: 'emma.fischer', description: 'Externer Förderantrag',
        dateStart: '2026-02-01', dateEnd: '2026-11-30' }
    ],
    expenses: [
      { key: 'exp-bus', financeUnitKey: 'fu-fs-inf', projectKey: 'prj-erstifahrt',
        payeeName: 'Reisebus Musterland GmbH', payeeIban: 'DE12500105170648489890',
        payeePurpose: 'Busmiete Erstifahrt', paymentMethod: 'bank_transfer', state: 'approved',
        receipts: [
          { belegNr: 'B-2026-0001', belegDate: '2026-04-13', description: 'Busrechnung',
            items: [{ budgetTitelKey: 'tit-erstifahrt', amountCents: 95000 }] }
        ] },
      { key: 'exp-kaffee', financeUnitKey: 'fu-ini', projectKey: null,
        payeeName: 'Röster & Co', payeeIban: null, payeePurpose: 'Kaffeebohnen',
        paymentMethod: 'cash', state: 'paid',
        receipts: [
          { belegNr: 'B-2026-0002', belegDate: '2026-03-02', description: 'Kassenbon Kaffee',
            items: [{ budgetTitelKey: 'tit-cafe', amountCents: 6400 }] }
        ] }
    ],
    bookings: [
      // a posted booking on the Initiative sub-fund, against tit-erstifahrt
      // receiptBelegNr satisfies the booking_belegprinzip_chk CHECK constraint (Task 19/21)
      { key: 'bk-bus', ledgerAccountKey: 'la-ini-sub', budgetTitelKey: 'tit-erstifahrt',
        fiscalYearKey: 'fy-2026', amountCents: -95000, bookingDate: '2026-04-14',
        runningNo: 1, paymentType: 'bargeldlos', state: 'posted',
        receiptBelegNr: 'B-2026-0001' },
      // a draft cash booking on the Handkasse, against tit-cafe
      { key: 'bk-kaffee', ledgerAccountKey: 'la-stura-kasse', budgetTitelKey: 'tit-cafe',
        fiscalYearKey: 'fy-2026', amountCents: -6400, bookingDate: '2026-03-02',
        runningNo: 1, paymentType: 'bar', state: 'draft' }
    ],
    approvals: [
      { approvableType: 'project', approvableKey: 'prj-erstifahrt',
        createdByUserKey: 'david.schulz', method: 'manual' },
      { approvableType: 'budget_plan', approvableKey: 'bp-2026',
        createdByUserKey: 'clara.wagner', method: 'helios' }
    ],
    // ── Demo fixtures (the prototype's `seederExtension:true` rows) ──────────
    // Opt-in only: seeded when SEED_DEMO_FIXTURES is set (runSeed → includeDemo).
    // These give the finance views a populated four-eyes approval queue + mixed
    // expense states. The prototype's display states (pending_approval /
    // under_review / open) have no real ExpenseState — they map to submitted /
    // submitted / draft. The two approved-expense demos carry a receipt so the
    // approval's amount snapshot resolves the > 500 € HV tier.
    demo: {
      expenses: [
        // pending_approval → submitted, open approval app-exp-druck (1.150 €, KV signed)
        { key: 'exp-druck', financeUnitKey: 'fu-stura', projectKey: null,
          payeeName: 'Druckerei Musterdruck GmbH', payeeIban: 'DE89370400440532013000',
          payeePurpose: 'Druck 500 Erstsemester-Hefte', paymentMethod: 'bank_transfer',
          state: 'submitted',
          receipts: [
            { belegNr: 'B-2026-0003', belegDate: '2026-04-18', description: 'Hefte SoSe 26',
              items: [{ budgetTitelKey: 'tit-buero', amountCents: 115000 }] }
          ] },
        // under_review → submitted, open approval app-exp-bueh (4.280 €, both pending)
        { key: 'exp-bueh', financeUnitKey: 'fu-stura', projectKey: null,
          payeeName: 'Eventtechnik Musterstadt GmbH', payeeIban: 'DE12500105170648489890',
          payeePurpose: 'Bühnentechnik Sommerfest', paymentMethod: 'bank_transfer',
          state: 'submitted',
          receipts: [
            { belegNr: 'B-2026-0004', belegDate: '2026-04-22', description: 'Sommerfest Bühne',
              items: [{ budgetTitelKey: 'tit-veranst', amountCents: 428000 }] }
          ] },
        // open → draft, no approval yet
        { key: 'exp-konfli', financeUnitKey: 'fu-stura', projectKey: null,
          payeeName: 'Akademie Musterland', payeeIban: null,
          payeePurpose: 'Fortbildung Konfliktmanagement', paymentMethod: 'bank_transfer',
          state: 'draft', receipts: [] },
        // rejected → rejected, standalone
        { key: 'exp-drucker', financeUnitKey: 'fu-stura', projectKey: null,
          payeeName: 'IT-Shop Musterstadt', payeeIban: null,
          payeePurpose: 'Drucker AG Digital', paymentMethod: 'bank_transfer',
          state: 'rejected', receipts: [] }
      ],
      approvals: [
        // 1-of-2 signed: Clara (KV) signed the first stage, second stage pending
        { approvableType: 'expense', approvableKey: 'exp-druck',
          createdByUserKey: 'emma.fischer', method: 'manual',
          firstStageSignedByUserKey: 'clara.wagner' },
        // both stages pending
        { approvableType: 'expense', approvableKey: 'exp-bueh',
          createdByUserKey: 'felix.weber', method: 'manual' },
        // project approval on the real prj-kulturfoerderung, first stage signed
        { approvableType: 'project', approvableKey: 'prj-kulturfoerderung',
          createdByUserKey: 'emma.fischer', method: 'manual',
          firstStageSignedByUserKey: 'hannes.bauer' }
      ]
    }
  }
*/
