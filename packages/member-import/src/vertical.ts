// packages/member-import/src/vertical.ts — the vertical loader. A vertical is
// DATA: a directory of four JSON files (vertical.json, blueprint.json,
// wording.de.json, roles.json). This loader is id-generic: it names no
// vertical, takes the directory's file reader as a port, and refuses a vertical
// that points back into code (a `blueprintRef` to a registry entry) instead of
// carrying its own data.
import { z } from 'zod'
import { parseRoles, type RolesDocument } from './roles.ts'

export class VerticalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerticalError'
  }
}

const key = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)
/** a unit kind (org_units.kind): the catalogue's own keys may use underscores (`district_council`) */
const kindKey = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/)

export const verticalManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  id: key,
  name: z.string().min(1).max(120),
  blueprint: z.literal('blueprint.json'),
  wording: z.literal('wording.de.json'),
  roles: z.literal('roles.json'),
})

export const blueprintUnitSchema = z.strictObject({
  key,
  name: z.string().min(1),
  description: z.string().nullable(),
  kind: z.string().min(1),
  parentKey: key.nullable(),
  visibility: z.enum(['all_members', 'committee_only']),
  wantsMatrixRoom: z.boolean(),
  wantsNextcloudFolder: z.boolean(),
  childTerm: z.string().nullable().optional(),
  kindLabel: z.string().nullable().optional(),
  authority: z.enum(['advisory', 'deciding']).optional(),
})

export const blueprintSeatSchema = z.strictObject({
  key,
  orgUnitKey: key,
  name: z.string().min(1),
  electionMethod: z.enum(['helios', 'poll', 'manual']),
  isElected: z.boolean(),
})

export const blueprintKindSchema = z.strictObject({
  key: kindKey,
  label: z.string(),
  childTerm: z.string().nullable().optional(),
  allowedParentKinds: z.array(z.string()),
  canBeRoot: z.boolean(),
  rootMin: z.number().int().optional(),
  rootMax: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
})

/** A Fraktion/caucus. The STRUCTURE is vertical data; who sits in one is people data and
 *  stays out of a vertical (a seeded fixture may fill `members` in tests). */
export const blueprintCaucusSchema = z.strictObject({
  key,
  councilOrgUnitKey: key,
  name: z.string().min(1),
  color: z.string().nullable().optional(),
  members: z.array(z.strictObject({
    userKey: z.string().min(1),
    termStart: z.string().nullable().optional(),
    termEnd: z.string().nullable().optional(),
  })),
})

export const blueprintCaucusPolicySchema = z.strictObject({
  min_size: z.number().int().optional(),
  allow_groups: z.boolean().optional(),
  proportional_committee_allocation: z.boolean().optional(),
})

export const verticalBlueprintSchema = z.strictObject({
  schema_version: z.literal(1),
  orgUnits: z.array(blueprintUnitSchema).min(1),
  seats: z.array(blueprintSeatSchema),
  orgSchema: z.array(blueprintKindSchema).optional(),
  /** which demo-fixture set the opt-in demo path seeds (absent: the default set); the kernel checks the name */
  demoSeeder: key.optional(),
  caucuses: z.strictObject({
    policy: blueprintCaucusPolicySchema.optional(),
    caucuses: z.array(blueprintCaucusSchema),
  }).optional(),
})

export const wordingSchema = z.record(z.string(), z.string())

export type VerticalManifest = z.infer<typeof verticalManifestSchema>
export type VerticalBlueprint = z.infer<typeof verticalBlueprintSchema>
export type BlueprintUnit = z.infer<typeof blueprintUnitSchema>
export type BlueprintSeat = z.infer<typeof blueprintSeatSchema>

export interface Vertical {
  manifest: VerticalManifest
  blueprint: VerticalBlueprint
  /** terms merged into the tenant's config (flat record, i18n/terms.ts) */
  wording: Record<string, string>
  roles: RolesDocument
}

/** A registry reference such as `SOMETHING_BLUEPRINT@1`: a pointer into code. */
const CODE_REF = /\b[A-Z][A-Z0-9_]*_BLUEPRINT(@\d+)?\b/

function walk(value: unknown, where: string, visit: (k: string | null, v: unknown, where: string) => void): void {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}[${i}]`, visit))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v, `${where}.${k}`)
      walk(v, `${where}.${k}`, visit)
    }
  } else visit(null, value, where)
}

/** Refuses a document that refers to a blueprint in code instead of carrying data. */
export function assertNoBlueprintRef(doc: unknown, file: string): void {
  walk(doc, file, (k, v, where) => {
    if (k !== null && /^blueprint_?ref$/i.test(k)) {
      throw new VerticalError(`${where}: a vertical carries its blueprint as data (blueprint.json); a blueprintRef into code is refused`)
    }
    if (k === null && typeof v === 'string' && CODE_REF.test(v)) {
      throw new VerticalError(`${where}: "${v}" looks like a reference into a code-side blueprint registry; a vertical carries data, not a pointer`)
    }
  })
}

/** Referential integrity of the blueprint (the shape is zod's). */
export function assertBlueprintIntegrity(bp: VerticalBlueprint): void {
  const keys = new Set<string>()
  for (const u of bp.orgUnits) {
    if (keys.has(u.key)) throw new VerticalError(`blueprint: unit key ${u.key} appears twice`)
    keys.add(u.key)
  }
  const roots = bp.orgUnits.filter((u) => u.parentKey === null)
  // Without its own kind catalogue a vertical has exactly one top-level body; with one, the
  // per-kind bounds (canBeRoot, rootMin, rootMax) decide, as they do for the runtime create paths.
  if (!bp.orgSchema && roots.length !== 1) throw new VerticalError(`blueprint: exactly one root unit is required, found ${roots.length}`)
  if (roots.length === 0) throw new VerticalError('blueprint: at least one root unit is required')
  if (bp.orgSchema) {
    for (const k of bp.orgSchema) {
      const n = roots.filter((u) => u.kind === k.key).length
      if (n > 0 && !k.canBeRoot) throw new VerticalError(`blueprint: kind ${k.key} cannot be a root, found ${n} root unit(s)`)
      if (n < (k.rootMin ?? 0)) throw new VerticalError(`blueprint: kind ${k.key} needs at least ${k.rootMin} root unit(s), found ${n}`)
      if (k.rootMax != null && n > k.rootMax) throw new VerticalError(`blueprint: kind ${k.key} allows at most ${k.rootMax} root unit(s), found ${n}`)
    }
  }
  for (const u of bp.orgUnits) {
    if (u.parentKey !== null && !keys.has(u.parentKey)) throw new VerticalError(`blueprint: unit ${u.key} has unknown parent ${u.parentKey}`)
  }
  // parents before children is not required of the file; a cycle is.
  const parent = new Map(bp.orgUnits.map((u) => [u.key, u.parentKey]))
  for (const u of bp.orgUnits) {
    const seen = new Set<string>()
    for (let k: string | null = u.key; k !== null; k = parent.get(k) ?? null) {
      if (seen.has(k)) throw new VerticalError(`blueprint: unit ${u.key} is part of a parent cycle`)
      seen.add(k)
    }
  }
  // with its own kind catalog every unit must name a kind of it (org_units.kind references the catalog)
  if (bp.orgSchema) {
    const kinds = new Set<string>()
    for (const k of bp.orgSchema) {
      if (kinds.has(k.key)) throw new VerticalError(`blueprint: kind ${k.key} appears twice in orgSchema`)
      kinds.add(k.key)
    }
    for (const u of bp.orgUnits) {
      if (!kinds.has(u.kind)) throw new VerticalError(`blueprint: unit ${u.key} has kind ${u.kind}, which is not in the blueprint's orgSchema`)
    }
  }
  const caucusKeys = new Set<string>()
  for (const c of bp.caucuses?.caucuses ?? []) {
    if (caucusKeys.has(c.key)) throw new VerticalError(`blueprint: caucus ${c.key} appears twice`)
    caucusKeys.add(c.key)
    if (!keys.has(c.councilOrgUnitKey)) throw new VerticalError(`blueprint: caucus ${c.key} names unknown council ${c.councilOrgUnitKey}`)
  }
  for (const s of bp.seats) {
    if (!keys.has(s.orgUnitKey)) throw new VerticalError(`blueprint: seat ${s.key} sits in unknown unit ${s.orgUnitKey}`)
  }
}

export const VERTICAL_FILES = ['vertical.json', 'blueprint.json', 'wording.de.json', 'roles.json'] as const

/**
 * Loads one vertical through `readText(file)` (the directory's reader: fs in
 * the container, a map in tests). Throws VerticalError / ZodError naming the
 * file; never returns a partial vertical.
 */
export function loadVertical(readText: (file: string) => string, expectedId?: string): Vertical {
  const json = (file: string): unknown => {
    let text: string
    try {
      text = readText(file)
    } catch (err) {
      throw new VerticalError(`${file}: cannot be read (${err instanceof Error ? err.message : String(err)})`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new VerticalError(`${file}: is not valid JSON`)
    }
  }
  const rawManifest = json('vertical.json')
  assertNoBlueprintRef(rawManifest, 'vertical.json')
  const manifest = verticalManifestSchema.parse(rawManifest)
  if (expectedId !== undefined && manifest.id !== expectedId) {
    throw new VerticalError(`vertical.json: id ${manifest.id} is not the requested vertical ${expectedId}`)
  }
  const rawBlueprint = json(manifest.blueprint)
  assertNoBlueprintRef(rawBlueprint, manifest.blueprint)
  const blueprint = verticalBlueprintSchema.parse(rawBlueprint)
  assertBlueprintIntegrity(blueprint)
  const wording = wordingSchema.parse(json(manifest.wording))
  const roles = parseRoles(json(manifest.roles))
  return { manifest, blueprint, wording, roles }
}
