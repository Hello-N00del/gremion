// src/lib/server/seed/blueprint-schema.ts
// P2.2-data (#202) Task 6: layer-1 SHAPE validation for the versioned
// blueprint document (design §3.5(g); decision D-V: Zod v4 strict schemas,
// not Ajv — Zod is the codebase's sole validation idiom, and z.toJSONSchema
// can emit a portable JSON-Schema artifact if the S3 provisioning script
// ever needs one).
//
// Two layers:
//   1. SHAPE (this file): every object node is z.strictObject, so an unknown
//      property anywhere in the tree is rejected; schema_version is pinned
//      to the literal 1.
//   2. INTEGRITY (org-blueprint.ts validateBlueprint + finance-blueprint.ts):
//      referential integrity, org-schema root/parent rules, finance keyspace.
//
// Finance subtree decision (recorded per the Task 6 plan): the finance
// surface is mirrored STRICTLY structure-wise, but its 17 enum-valued fields
// (FinanceUnitKind, BookkeepingMode, …) are validated as plain strings here.
// Layer 1 owns SHAPE (property names, nesting, nullability); enum VALUES are
// TS-typed at authoring time and enforced by the DB CHECK constraints at
// seed time — duplicating the unions in Zod would create a second
// drift-prone copy for no added shape guarantee.
import { z } from 'zod'
import type { GremionBlueprint } from './org-blueprint'
import { validateBlueprint } from './org-blueprint'
import { GREMION_ORG_SCHEMA, orgSchemaFromBlueprint } from '../governance/org-schema'

// ── org sections ─────────────────────────────────────────────────────────
const userSchema = z.strictObject({
  username: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  realmRole: z.enum(['guest', 'member', 'council-admin', 'it-admin']),
})

const orgUnitSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.string(),
  parentKey: z.string().nullable(),
  visibility: z.enum(['all_members', 'committee_only']),
  wantsMatrixRoom: z.boolean(),
  wantsNextcloudFolder: z.boolean(),
  childTerm: z.string().nullable().optional(),
  kindLabel: z.string().nullable().optional(),
  authority: z.enum(['advisory', 'deciding']).optional(),
})

const membershipSchema = z.strictObject({
  userKey: z.string(),
  orgUnitKey: z.string(),
  membershipType: z.enum(['elected', 'unelected', 'employee']),
  termStart: z.string().nullable(),
  termEnd: z.string().nullable(),
  voting: z.boolean().optional(),
})

const roleSchema = z.strictObject({
  key: z.string(),
  orgUnitKey: z.string(),
  name: z.string(),
  electionMethod: z.enum(['helios', 'poll', 'manual']),
  isElected: z.boolean(),
})

const assignmentSchema = z.strictObject({
  roleKey: z.string(),
  userKey: z.string(),
  startDate: z.string(),
  endDate: z.string(),
})

const blueprintKindSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  childTerm: z.string().nullable().optional(),
  allowedParentKinds: z.array(z.string()),
  canBeRoot: z.boolean(),
  rootMin: z.number().int().optional(),
  rootMax: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
})

const caucusSchema = z.strictObject({
  key: z.string(),
  councilOrgUnitKey: z.string(),
  name: z.string(),
  color: z.string().nullable().optional(),
  members: z.array(z.strictObject({
    userKey: z.string(),
    termStart: z.string().nullable().optional(),
    termEnd: z.string().nullable().optional(),
  })),
})

const caucusPolicySchema = z.strictObject({
  min_size: z.number().int().optional(),
  allow_groups: z.boolean().optional(),
  proportional_committee_allocation: z.boolean().optional(),
})

// Carve note: the finance feature module is not part of the governance-only
// kernel, so the (strict structural) finance subtree schemas were removed here
// along with the `finance` field on the document schema below. They re-attach
// with the finance module.

// ── the versioned document ───────────────────────────────────────────────
export const blueprintDocumentSchema = z.strictObject({
  schema_version: z.literal(1),
  users: z.array(userSchema),
  orgUnits: z.array(orgUnitSchema),
  memberships: z.array(membershipSchema),
  roles: z.array(roleSchema),
  assignments: z.array(assignmentSchema),
  orgSchema: z.array(blueprintKindSchema).optional(),
  caucuses: z.strictObject({
    policy: caucusPolicySchema.optional(),
    caucuses: z.array(caucusSchema),
  }).optional(),
  // P2.3 (#202): which demo-fixture set the includeDemo path seeds (absent → StuRa).
  demoSeeder: z.enum(['stura', 'municipal']).optional(),
})

export type ParseBlueprintResult =
  | { ok: true; bp: GremionBlueprint }
  | { ok: false; errors: string[] }

/** Parse + validate a blueprint document through BOTH layers: Zod strict
 *  shape first, then `validateBlueprint` integrity against the document's
 *  own `orgSchema` (when present) or the StuRa default catalog. */
export function parseBlueprintDocument(json: unknown): ParseBlueprintResult {
  const shaped = blueprintDocumentSchema.safeParse(json)
  if (!shaped.success) {
    return {
      ok: false,
      errors: shaped.error.issues.map(
        (i) => `${i.path.length > 0 ? i.path.join('.') : '(document)'}: ${i.message}`
      ),
    }
  }
  // Layer 1 guarantees every property name / nesting / nullability matches
  // the GremionBlueprint surface (finance enum VALUES are TS/DB territory —
  // see the header note), so this narrowing cast is sound for layer 2.
  const bp = shaped.data as unknown as GremionBlueprint
  const schema = bp.orgSchema ? orgSchemaFromBlueprint(bp.orgSchema) : GREMION_ORG_SCHEMA
  const errors = validateBlueprint(bp, schema)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, bp }
}
