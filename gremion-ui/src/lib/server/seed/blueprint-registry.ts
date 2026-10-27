// P2.3 (#202) T3 — the blueprint registry.
//
// A non-default tenant must be fed ITS OWN blueprint at seed time. The registry
// row carries a `blueprintRef` string; this module turns that ref back into a
// concrete seedable artifact.
//
// Verticals are DATA (verticals/README.md): a ref of the form `<ID>_BLUEPRINT@1`
// is served from `verticals/<id>/blueprint.json`, read through the same
// `loadVertical` path the import/seed-vertical verbs use. No vertical's blueprint
// lives in code any more, so `STURA_BLUEPRINT@1` (existing tenants' ref) still
// resolves, but only because verticals/stura exists -- drop a directory in, and
// its ref resolves; remove it, and the ref is refused.
//
// The kernel's own default is `KERNEL_BLUEPRINT@1`: one empty council, no people,
// no offices, no vertical vocabulary.
//
// Unknown refs THROW loudly: a non-resolvable ref MUST NOT silently fall through
// to another tenant's blueprint (that is exactly the cross-tenant data-leak the
// per-tenant seed path exists to prevent).
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadVertical, type Vertical } from '@gremion/member-import'
import type { GremionBlueprint } from './org-blueprint'
import { MUNICIPAL_BLUEPRINT } from './municipal-blueprint'

/** The kernel's neutral blueprint ref. */
export const KERNEL_BLUEPRINT_REF = 'KERNEL_BLUEPRINT@1' as const

/** The ref a tenant gets when the caller names none: the neutral kernel one. */
export const DEFAULT_BLUEPRINT_REF = KERNEL_BLUEPRINT_REF

/** The minimal kernel blueprint: a single, empty root council. */
const KERNEL_BLUEPRINT: GremionBlueprint = {
  schema_version: 1,
  users: [],
  orgUnits: [
    {
      key: 'council', name: 'Council', description: null, kind: 'council', parentKey: null,
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    },
  ],
  memberships: [],
  roles: [],
  assignments: [],
}

/** Refs still served from code (not yet promoted to verticals/<id>/ data). */
const CODE_BLUEPRINTS: Readonly<Record<string, GremionBlueprint>> = {
  [KERNEL_BLUEPRINT_REF]: KERNEL_BLUEPRINT,
  'MUNICIPAL_BLUEPRINT@1': MUNICIPAL_BLUEPRINT,
}

/** `<ID>_BLUEPRINT@1` → vertical id (`stura`). Anchored: no separators survive. */
const VERTICAL_REF = /^([A-Z][A-Z0-9]{0,31})_BLUEPRINT@1$/

/** Where vertical data lives: GREMION_VERTICALS_DIR (the image sets it), else the
 *  repo's `verticals/` next to gremion-ui (the cwd of dev, tests and tenant-create). */
function verticalsDir(): string {
  return process.env.GREMION_VERTICALS_DIR ?? resolve(process.cwd(), '..', 'verticals')
}

function loadVerticalData(id: string): Vertical | null {
  const dir = join(verticalsDir(), id)
  try {
    return loadVertical((file) => readFileSync(join(dir, file), 'utf8'), id)
  } catch (err) {
    // A missing directory is "unknown ref"; a present-but-broken vertical is a data bug: say so.
    const missing = (err as { message?: string }).message?.includes('ENOENT') ?? false
    if (missing) return null
    throw new Error(`blueprint vertical "${id}" is unusable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A vertical carries organisation only (tree, offices, kinds); the seedable
 *  blueprint has no users, memberships or assignments of its own. */
function fromVertical(v: Vertical): GremionBlueprint {
  const b = v.blueprint
  return {
    schema_version: 1,
    users: [],
    orgUnits: b.orgUnits,
    memberships: [],
    roles: b.seats,
    assignments: [],
    ...(b.orgSchema ? { orgSchema: b.orgSchema } : {}),
  }
}

function unknownRef(ref: string): Error {
  const known = [...Object.keys(CODE_BLUEPRINTS), '<ID>_BLUEPRINT@1 for each verticals/<id>/']
  return new Error(`unknown blueprint ref "${ref}" — known refs: ${known.join(', ')}`)
}

/** Resolve a registry `blueprintRef` to its seedable blueprint, or THROW on an
 *  unknown ref (never silently default to another tenant's blueprint). */
export function resolveBlueprint(ref: string): GremionBlueprint {
  const code = CODE_BLUEPRINTS[ref]
  if (code) return code
  const m = VERTICAL_REF.exec(ref)
  if (!m) throw unknownRef(ref)
  const vertical = loadVerticalData(m[1].toLowerCase())
  if (!vertical) throw unknownRef(ref)
  return fromVertical(vertical)
}
