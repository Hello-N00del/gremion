// packages/member-import/src/seed-plan.ts — what seeding a vertical's blueprint
// onto a customer's existing org-unit tree has to do. PURE.
//
// The customer's first body (TASK-043) already exists as the single root; the
// seed ADOPTS it (its name from the create request is never overwritten) and
// creates the rest under it, parents before children. A unit that already
// exists (same parent, same name) is left as it is, so a rerun is a no-op.
//
// D-8 (operator decision 2026-10-22): a unit's `wants_matrix_room` /
// `wants_nextcloud_folder` are written true only when the blueprint wants them
// AND the tenant has messaging / files enabled; with the module off they are
// false and no matrix / nextcloud projection row is ever created for the unit.
import { labelKey } from './normalize.ts'
import type { BlueprintUnit, VerticalBlueprint } from './vertical.ts'

export interface ExistingUnit {
  id: string
  parentId: string | null
  name: string
  childTerm: string | null
  wantsMatrixRoom: boolean
  wantsNextcloudFolder: boolean
}

export interface SeedModules {
  /** messaging is enabled for the tenant (a matrix room per unit is possible) */
  messaging: boolean
  /** files is enabled for the tenant (a Nextcloud folder per unit is possible) */
  files: boolean
}

export interface CreateUnitData {
  name: string
  description: string | null
  kind: string
  visibility: 'all_members' | 'committee_only'
  wantsMatrixRoom: boolean
  wantsNextcloudFolder: boolean
  childTerm: string | null
  kindLabel: string | null
  authority: 'advisory' | 'deciding'
}

export type SeedOp =
  | { type: 'adopt-root'; key: string; id: string; patch: { childTerm: string | null; wantsMatrixRoom: boolean; wantsNextcloudFolder: boolean } }
  | { type: 'create'; key: string; parentKey: string | null; data: CreateUnitData }
  | { type: 'present'; key: string; id: string }

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedRefused'
  }
}

export function effectiveWants(unit: BlueprintUnit, modules: SeedModules): { wantsMatrixRoom: boolean; wantsNextcloudFolder: boolean } {
  return {
    wantsMatrixRoom: unit.wantsMatrixRoom && modules.messaging,
    wantsNextcloudFolder: unit.wantsNextcloudFolder && modules.files,
  }
}

/** Parents before children, file order otherwise. */
function ordered(bp: VerticalBlueprint): BlueprintUnit[] {
  const out: BlueprintUnit[] = []
  const placed = new Set<string>()
  let rest = [...bp.orgUnits]
  while (rest.length) {
    const next = rest.filter((u) => u.parentKey === null || placed.has(u.parentKey))
    if (next.length === 0) throw new SeedRefused('blueprint: units cannot be ordered (parent cycle)')
    for (const u of next) {
      out.push(u)
      placed.add(u.key)
    }
    rest = rest.filter((u) => !placed.has(u.key))
  }
  return out
}

export function planSeed(bp: VerticalBlueprint, existing: readonly ExistingUnit[], modules: SeedModules): SeedOp[] {
  const roots = existing.filter((u) => u.parentId === null)
  if (roots.length > 1) throw new SeedRefused(`the customer already holds ${roots.length} top-level bodies; the seed adopts exactly one root`)
  const ids = new Map<string, string>() // blueprint key -> existing unit id
  const ops: SeedOp[] = []
  for (const u of ordered(bp)) {
    const wants = effectiveWants(u, modules)
    if (u.parentKey === null) {
      const root = roots[0]
      if (!root) {
        ops.push({
          type: 'create',
          key: u.key,
          parentKey: null,
          data: toData(u, wants),
        })
        continue
      }
      ids.set(u.key, root.id)
      const patch = {
        childTerm: root.childTerm ?? u.childTerm ?? null,
        // only ever turned ON by the seed: an operator's earlier choice to switch one off stays
        wantsMatrixRoom: root.wantsMatrixRoom || wants.wantsMatrixRoom,
        wantsNextcloudFolder: root.wantsNextcloudFolder || wants.wantsNextcloudFolder,
      }
      const same =
        patch.childTerm === root.childTerm &&
        patch.wantsMatrixRoom === root.wantsMatrixRoom &&
        patch.wantsNextcloudFolder === root.wantsNextcloudFolder
      ops.push(same ? { type: 'present', key: u.key, id: root.id } : { type: 'adopt-root', key: u.key, id: root.id, patch })
      continue
    }
    const parentId = ids.get(u.parentKey)
    const found = parentId === undefined ? undefined : existing.find((e) => e.parentId === parentId && labelKey(e.name) === labelKey(u.name))
    if (found) {
      ids.set(u.key, found.id)
      ops.push({ type: 'present', key: u.key, id: found.id })
      continue
    }
    ops.push({ type: 'create', key: u.key, parentKey: u.parentKey, data: toData(u, wants) })
  }
  return ops
}

function toData(u: BlueprintUnit, wants: { wantsMatrixRoom: boolean; wantsNextcloudFolder: boolean }): CreateUnitData {
  return {
    name: u.name,
    description: u.description,
    kind: u.kind,
    visibility: u.visibility,
    wantsMatrixRoom: wants.wantsMatrixRoom,
    wantsNextcloudFolder: wants.wantsNextcloudFolder,
    childTerm: u.childTerm ?? null,
    kindLabel: u.kindLabel ?? null,
    authority: u.authority ?? 'deciding',
  }
}

/** The projection subsystems a unit's flags ask for (keycloak always). */
export function subsystemsFor(u: { wantsMatrixRoom: boolean; wantsNextcloudFolder: boolean }): Array<'keycloak' | 'matrix' | 'nextcloud'> {
  return ['keycloak', ...(u.wantsMatrixRoom ? (['matrix'] as const) : []), ...(u.wantsNextcloudFolder ? (['nextcloud'] as const) : [])]
}

/** Merges a vertical's wording into a tenant's terms; the vertical never overrides an operator's own term. */
export function mergeTerms(current: Record<string, string>, wording: Record<string, string>): Record<string, string> {
  return { ...wording, ...current }
}
