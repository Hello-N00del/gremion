// The authz suites' kernel database on test/authz/stack.mjs's PG18: the shipped
// kernel-api chain as `kernel-api migrate` applies it (core, bodies = TASK-080-a's
// real tables, authz), preceded by the migrate hook's schema + btree_gist step and
// followed by the vendor kind catalogue, under a NON-superuser app role so FORCE
// RLS binds.
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import postgres from 'postgres'
import { VENDOR_KINDS } from '../../src/bodies/kinds.ts'
import { KERNEL_API_MIGRATION_DIRS } from '../../src/migrate/chain.ts'

export const SERVICE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface State {
  sha8: string
  port: number
  user: string
  password: string
  db: string
}
export function stack(): State {
  const path = process.env.T081_STATE
  if (!path) throw new Error('T081_STATE is unset: run through `node test/authz/stack.mjs`')
  const s = JSON.parse(readFileSync(path, 'utf8')) as State
  if (s.sha8 !== process.env.T081_SCRATCH) throw new Error('the scratch-stack state does not belong to this run')
  return s
}

export function connect(db: string, o: { user?: string; password?: string; max?: number } = {}): Sql {
  const s = stack()
  const u = `postgres://${encodeURIComponent(o.user ?? s.user)}:${encodeURIComponent(o.password ?? s.password)}@127.0.0.1:${s.port}/${db}`
  return postgres(u, { max: o.max ?? 2, onnotice: () => {}, connect_timeout: 10 }) as unknown as Sql
}

/** RFC 9562 v7 (the writers mint it; the table has no default). */
export function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The shipped chain files in apply order (the dirs' order, then the number), the authz dir's own files marked. */
export function chainFiles(o: { withAuthz?: boolean } = {}): string[] {
  return KERNEL_API_MIGRATION_DIRS.filter((d) => o.withAuthz !== false || d !== 'migrations/authz').flatMap((d) =>
    readdirSync(join(SERVICE_ROOT, d))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => join(SERVICE_ROOT, d, f)),
  )
}

export interface KernelDb {
  customerId: string
  admin: Sql
  /** the non-superuser app role: RLS binds */
  app: Sql
  /** a further pool under the same app role with its own connection cap (to prove behaviour at a small pool) */
  appPool(max: number): Sql
  close(): Promise<void>
}

/** A fresh `t081_<name>` database holding one customer's binding + the authz schema. */
export async function buildKernelDb(name: string, o: { withAuthz?: boolean } = {}): Promise<KernelDb> {
  const s = stack()
  const dbName = `t081_${name}`
  const root = connect(s.db)
  await root.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  await root.unsafe(`CREATE DATABASE ${dbName}`)
  await root.end({ timeout: 5 })
  const admin = connect(dbName)
  // the migrate hook's beforeRun (idt-hooks.ts): the gist EXCLUDEs of membership / tenure need btree_gist in schema idt
  await admin.unsafe('CREATE SCHEMA IF NOT EXISTS idt')
  await admin.unsafe('CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA idt')
  for (const f of chainFiles(o)) await admin.unsafe(readFileSync(f, 'utf8'))
  const customerId = uuidv7()
  const token = 't' + customerId.replaceAll('-', '').slice(0, 12)
  await admin`INSERT INTO idt.database_binding (customer_id, tenant_token, context_code) VALUES (${customerId}::uuid, ${token}, 'idt')`
  // the migrate hook's afterRun vendor kinds (the org_unit_kind rows idt.body's foreign key needs); the owner here is the superuser, which bypasses RLS
  for (const k of VENDOR_KINDS) {
    await admin`
      INSERT INTO idt.org_unit_kind (kind_key, customer_id, level, label_de, label_en, is_organ, can_hold_seats, may_adopt_beschluesse, allowed_parent_kinds, origin, created_by_kind, updated_by_kind)
      VALUES (${k.kindKey}, ${customerId}::uuid, ${k.level}, ${k.labelDe}, ${k.labelEn}, ${k.isOrgan}, ${k.canHoldSeats}, ${k.mayAdoptBeschluesse}, ${[...k.allowedParentKinds]}::text[], 'vendor_default', 'system', 'system')`
  }
  const role = `t081_app_${name}`
  const password = randomBytes(16).toString('base64url')
  await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
  await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
  await admin.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO ${role}`)
  await admin.unsafe(`GRANT USAGE ON SCHEMA idt TO ${role}`)
  await admin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA idt TO ${role}`)
  const app = connect(dbName, { user: role, password })
  return {
    customerId,
    admin,
    app,
    appPool: (max) => connect(dbName, { user: role, password, max }),
    async close() {
      await Promise.allSettled([app.end({ timeout: 5 }), admin.end({ timeout: 5 })])
    },
  }
}
