// src/lib/server/governance/org-schema.ts
// P2.2-data (#202): the per-tenant org schema — data-driven kind/root/parent
// rules read from the org_unit_kind catalog (design §3.5(a)/(b), D-RB). Pure
// validators shared by the blueprint validator (seed-time) and the three
// runtime CRUD create paths (Task 10) so the rules cannot drift apart.
import { getDb } from '../db'

export interface OrgKindDef {
  readonly key: string
  readonly label: string
  readonly childTerm: string | null
  readonly allowedParentKinds: readonly string[]
  readonly canBeRoot: boolean
  readonly rootMin: number
  readonly rootMax: number | null // null = unbounded
  readonly sortOrder: number
}
export interface OrgSchema {
  readonly kinds: Readonly<Record<string, OrgKindDef>>
}

/** Raw `org_unit_kind` catalog row (column names as in migration 038). */
export interface OrgKindRow {
  key: string
  label: string
  child_term: string | null
  allowed_parent_kinds: string[]
  can_be_root: boolean
  root_min: number
  root_max: number | null
  sort_order: number
}

export function orgSchemaFromRows(rows: readonly OrgKindRow[]): OrgSchema {
  const kinds: Record<string, OrgKindDef> = {}
  for (const r of rows) {
    kinds[r.key] = {
      key: r.key,
      label: r.label,
      childTerm: r.child_term,
      allowedParentKinds: r.allowed_parent_kinds,
      canBeRoot: r.can_be_root,
      rootMin: r.root_min,
      rootMax: r.root_max,
      sortOrder: r.sort_order,
    }
  }
  return { kinds }
}

/** Blueprint kind-catalog entry — structurally identical to `BlueprintKind` in
 *  `seed/org-blueprint.ts` (declared here too so org-schema stays free of a
 *  seed-layer import; assignability is guaranteed by structure). */
export interface BlueprintKindInput {
  key: string
  label: string
  childTerm?: string | null
  allowedParentKinds: string[]
  canBeRoot: boolean
  rootMin?: number
  rootMax?: number | null
  sortOrder?: number
}

/** Build an OrgSchema from a blueprint's `orgSchema` section (P2.2 Task 6).
 *  Defaults: childTerm null, rootMin 0, rootMax unbounded, sortOrder = array position. */
export function orgSchemaFromBlueprint(kinds: readonly BlueprintKindInput[]): OrgSchema {
  const out: Record<string, OrgKindDef> = {}
  kinds.forEach((k, i) => {
    out[k.key] = {
      key: k.key,
      label: k.label,
      childTerm: k.childTerm ?? null,
      allowedParentKinds: k.allowedParentKinds,
      canBeRoot: k.canBeRoot,
      rootMin: k.rootMin ?? 0,
      rootMax: k.rootMax === undefined ? null : k.rootMax,
      sortOrder: k.sortOrder ?? i,
    }
  })
  return { kinds: out }
}

/** Tenant #1 default vocabulary — MUST mirror the 038 seed exactly (pinned by test). */
export const GREMION_ORG_SCHEMA: OrgSchema = {
  kinds: {
    council:   { key: 'council',   label: 'Gremium', childTerm: 'Referate',       allowedParentKinds: [],                       canBeRoot: true,  rootMin: 1, rootMax: 1,    sortOrder: 0 },
    committee: { key: 'committee', label: 'Referat', childTerm: 'Arbeitsgruppen', allowedParentKinds: ['council', 'committee'], canBeRoot: false, rootMin: 0, rootMax: 0,    sortOrder: 1 },
    group:     { key: 'group',     label: 'Gruppe',  childTerm: null,             allowedParentKinds: ['council', 'committee', 'group'], canBeRoot: true, rootMin: 0, rootMax: null, sortOrder: 2 },
  },
}

/** Seed-time root-cardinality rule: per-kind bounds over the blueprint's roots. */
export function validateRootCounts(
  schema: OrgSchema,
  rootCounts: ReadonlyMap<string, number>
): string[] {
  const errors: string[] = []

  // Kinds present as roots but absent from the catalog are unknown.
  for (const kind of rootCounts.keys()) {
    if (!schema.kinds[kind]) errors.push(`unknown kind: '${kind}'`)
  }

  for (const def of Object.values(schema.kinds)) {
    const count = rootCounts.get(def.key) ?? 0
    if (count > 0 && !def.canBeRoot) {
      // cannot-be-root subsumes the bounds checks for this kind
      errors.push(`kind '${def.key}' cannot be a root org-unit`)
      continue
    }
    if (count < def.rootMin) {
      errors.push(
        `blueprint requires at least ${def.rootMin} root org-unit(s) of kind '${def.key}', found ${count}`
      )
    }
    if (def.rootMax !== null && count > def.rootMax) {
      errors.push(
        `blueprint allows at most ${def.rootMax} root org-unit(s) of kind '${def.key}', found ${count}`
      )
    }
  }
  return errors
}

/** Runtime create rule: can this kind exist at this position? null = OK, else error. */
export function validateCreatePlacement(
  schema: OrgSchema,
  kind: string,
  parentKind: string | null
): string | null {
  const def = schema.kinds[kind]
  if (!def) return `unknown kind: '${kind}'`
  if (parentKind === null) {
    return def.canBeRoot ? null : `kind '${kind}' cannot be a root org-unit`
  }
  if (!schema.kinds[parentKind]) return `unknown kind: '${parentKind}'`
  if (def.allowedParentKinds.includes(parentKind)) return null
  const allowed = def.allowedParentKinds.length > 0 ? def.allowedParentKinds.join(', ') : 'none'
  return `kind '${kind}' cannot be created under kind '${parentKind}' (allowed: ${allowed})`
}

/** Load the tenant's catalog (getDb() is tenant-resolved by construction). */
export async function loadOrgSchema(): Promise<OrgSchema> {
  const rows = await getDb()<OrgKindRow[]>`SELECT * FROM org_unit_kind ORDER BY sort_order`
  return orgSchemaFromRows(rows)
}
