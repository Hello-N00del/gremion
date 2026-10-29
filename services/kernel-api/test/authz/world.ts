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

/** An active person with every NOT NULL column 080-a's idt.person has (the stand-in fixture mirrors them). */
export async function insertPerson(admin: Sql, customerId: string, personId: string, sub: string): Promise<void> {
  await admin`
    INSERT INTO idt.person (person_id, customer_id, idp_subject, display_name, email, account_state, pseudonym, activated_at, created_by_kind, updated_by_kind)
    VALUES (${personId}::uuid, ${customerId}::uuid, ${sub}, ${sub}, ${sub + '@example.test'}, 'active', ${'p-' + personId}, now(), 'system', 'system')`
}

/** A body of `kindKey` (one verwaltung per customer, as 080-a's unique index holds). */
export async function insertBody(admin: Sql, customerId: string, bodyId: string, kindKey: string): Promise<void> {
  await admin`
    INSERT INTO idt.body (body_id, customer_id, kind_key, name, created_by_kind, updated_by_kind)
    VALUES (${bodyId}::uuid, ${customerId}::uuid, ${kindKey}, ${kindKey + '-' + bodyId.slice(-8)}, 'system', 'system')`
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
  for (const [id, kind] of [[bodyA, 'fachschaftsrat'], [bodyB, 'fachschaftsrat'], [verwaltung, 'verwaltung']] as const) await insertBody(db.admin, db.customerId, id, kind)
  const persons: Record<string, string> = {}
  for (const p of people) {
    persons[p] = uuidv7()
    await insertPerson(db.admin, db.customerId, persons[p]!, 'sub-' + p)
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
  // audit columns keep a legal kind so a bogus granter_kind is refused by authz_grant_granter_check ALONE
  const auditKind = (granterKind as string) === 'customer_admin' ? 'person' : granterKind
  await admin`
    INSERT INTO idt.authz_grant (grant_id, customer_id, body_id, subject_person_id, grant_kind, role_key, capability_key, resource_kind, resource_id,
      valid_from, valid_until, granter_kind, granted_by, source, state, created_by_kind, created_by, updated_by_kind, updated_by)
    VALUES (${id}::uuid, ${customerId}::uuid, ${g.bodyId}::uuid, ${g.personId}::uuid, ${kind}, ${kind === 'role' ? g.key : null}, ${kind === 'capability' ? g.key : null},
      ${g.resource?.kind ?? null}, ${g.resource?.id ?? null}::uuid, ${g.validFrom ?? new Date().toISOString()}::timestamptz, ${g.validUntil ?? null}::timestamptz,
      ${granterKind}, ${granter}::uuid, ${g.source ?? 'control_panel'}, ${g.state ?? 'active'}, ${auditKind}, ${granter}::uuid, ${auditKind}, ${granter}::uuid)`
  return id
}
