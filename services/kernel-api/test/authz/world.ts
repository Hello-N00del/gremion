// Shared seeding for the authz integration suites: two customers' worth of
// persons and bodies, the catalogue synced, grants inserted as the owner
// (bypassing RLS) so each test controls state exactly.
import type { Sql } from '@gremion/db'
import { syncAuthzCatalogue } from '../../src/authz/sync.ts'
import { buildKernelDb, uuidv7, type KernelDb } from './db.ts'

export const ALL_MODULES = ['publishing', 'votes', 'board', 'calendar', 'finance']
export const moduleIds = new Map(ALL_MODULES.map((k) => [k, uuidv7()]))

/** A mutable stand-in for the per-request registry read: tests flip it between decisions. */
export function makeRegistry(initial: string[]) {
  let enabled = new Set(initial)
  let reads = 0
  return {
    read: async (_customerId: string): Promise<ReadonlySet<string>> => {
      reads++
      return new Set(enabled)
    },
    set(keys: string[]) {
      enabled = new Set(keys)
    },
    get reads() {
      return reads
    },
  }
}

export interface World {
  db: KernelDb
  bodyA: string
  bodyB: string
  verwaltung: string
  persons: Record<string, string>
}

export async function buildWorld(name: string, enabled: string[] = ALL_MODULES, people = ['alice', 'bob', 'admin']): Promise<World> {
  const db = await buildKernelDb(name)
  const bodyA = uuidv7()
  const bodyB = uuidv7()
  const verwaltung = uuidv7()
  for (const [id, kind] of [[bodyA, 'fachschaft'], [bodyB, 'fachschaft'], [verwaltung, 'verwaltung']] as const) {
    await db.admin`INSERT INTO idt.body (body_id, customer_id, body_kind) VALUES (${id}::uuid, ${db.customerId}::uuid, ${kind})`
  }
  const persons: Record<string, string> = {}
  for (const p of people) {
    persons[p] = uuidv7()
    await db.admin`INSERT INTO idt.person (person_id, customer_id, idp_subject) VALUES (${persons[p]!}::uuid, ${db.customerId}::uuid, ${'sub-' + p})`
  }
  await syncAuthzCatalogue(db.app, { customerId: db.customerId, moduleIds, enabledModules: new Set(enabled) })
  return { db, bodyA, bodyB, verwaltung, persons }
}

export interface GrantSeed {
  bodyId: string
  personId: string
  kind?: 'role' | 'capability'
  key: string
  state?: string
  validFrom?: string
  validUntil?: string | null
  resource?: { kind: string; id: string }
  source?: string
  granterKind?: 'operator' | 'person' | 'system'
}

/** Inserts one grant as the owner. Returns grant_id. */
export async function seedGrant(admin: Sql, customerId: string, g: GrantSeed): Promise<string> {
  const id = uuidv7()
  const kind = g.kind ?? 'role'
  const granterKind = g.granterKind ?? 'operator'
  const granter = granterKind === 'system' ? null : uuidv7()
  await admin`
    INSERT INTO idt.authz_grant (grant_id, customer_id, body_id, subject_person_id, grant_kind, role_key, capability_key, resource_kind, resource_id,
      valid_from, valid_until, granter_kind, granted_by, source, state, created_by_kind, created_by, updated_by_kind, updated_by)
    VALUES (${id}::uuid, ${customerId}::uuid, ${g.bodyId}::uuid, ${g.personId}::uuid, ${kind}, ${kind === 'role' ? g.key : null}, ${kind === 'capability' ? g.key : null},
      ${g.resource?.kind ?? null}, ${g.resource?.id ?? null}::uuid, ${g.validFrom ?? new Date().toISOString()}::timestamptz, ${g.validUntil ?? null}::timestamptz,
      ${granterKind}, ${granter}::uuid, ${g.source ?? 'control_panel'}, ${g.state ?? 'active'}, ${granterKind}, ${granter}::uuid, ${granterKind}, ${granter}::uuid)`
  return id
}
