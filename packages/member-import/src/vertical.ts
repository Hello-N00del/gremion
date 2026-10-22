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
  key,
  label: z.string(),
  childTerm: z.string().nullable().optional(),
  allowedParentKinds: z.array(z.string()),
  canBeRoot: z.boolean(),
  rootMin: z.number().int().optional(),
  rootMax: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
})

export const verticalBlueprintSchema = z.strictObject({
  schema_version: z.literal(1),
  orgUnits: z.array(blueprintUnitSchema).min(1),
  seats: z.array(blueprintSeatSchema),
  orgSchema: z.array(blueprintKindSchema).optional(),
})

export const wordingSchema = z.record(z.string(), z.string())

export type VerticalManifest = z.infer<typeof verticalManifestSchema>
export type VerticalBlueprint = z.infer<typeof verticalBlueprintSchema>
export type BlueprintUnit = z.infer<typeof blueprintUnitSchema>

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
  if (roots.length !== 1) throw new VerticalError(`blueprint: exactly one root unit is required, found ${roots.length}`)
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
