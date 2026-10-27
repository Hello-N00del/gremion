// packages/member-import/src/roles.ts — a vertical's role table (roles.json):
// which roles a member list may name, how each maps onto an org-unit
// membership, and which capability ids it holds. Capability ids are INERT DATA
// here: a module's ids stay in the file whether or not that module is enabled;
// nothing in this package imports or names a module.
import { z } from 'zod'

const capabilityId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'a capability id is dotted snake_case')

export const roleSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  /** May a member list name this role? */
  importable: z.boolean(),
  /** The org-unit membership this role becomes. */
  membership_type: z.enum(['elected', 'unelected', 'employee']),
  voting: z.boolean(),
  capabilities: z.array(capabilityId),
  /** Capabilities the role is explicitly denied (documentation and read-back guard). */
  withheld: z.array(capabilityId).default([]),
})

export const rolesDocumentSchema = z.strictObject({
  schema_version: z.literal(1),
  roles: z.array(roleSchema).min(1),
})

export type Role = z.infer<typeof roleSchema>
export type RolesDocument = z.infer<typeof rolesDocumentSchema>

export function parseRoles(doc: unknown): RolesDocument {
  const parsed = rolesDocumentSchema.parse(doc)
  const keys = parsed.roles.map((r) => r.key)
  if (new Set(keys).size !== keys.length) throw new Error('roles.json: a role key appears twice')
  for (const r of parsed.roles) {
    const both = r.capabilities.filter((c) => r.withheld.includes(c))
    if (both.length) throw new Error(`roles.json: role ${r.key} both grants and withholds ${both.join(', ')}`)
  }
  return parsed
}

/** The capability ids a role holds (granted minus withheld), in file order. */
export function effectiveCapabilities(doc: RolesDocument, key: string): string[] {
  const role = doc.roles.find((r) => r.key === key)
  if (!role) throw new Error(`unknown role ${key}`)
  return role.capabilities.filter((c) => !role.withheld.includes(c))
}

export function importableRoles(doc: RolesDocument): Role[] {
  return doc.roles.filter((r) => r.importable)
}
