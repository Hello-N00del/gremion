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
