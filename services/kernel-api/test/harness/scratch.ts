// The kernel API's scratch world on test/harness/stack.mjs's PG18 (lane note
// C3: customers from the LIBRARIES, never through the gremion-tenant CLI):
//   control           the real control migrations (gremion-ui/migrations-control),
//                     tenant + tenant_domain rows inserted directly;
//   gremion_platform  tenant-store's migratePlatform, then TASK-043's
//                     loadCatalogueRows over the REAL modules/*/module.json (A1);
//   t_<hex>__kernel   per customer, tenant-store's ensureKernelDatabase (roles
//                     k_<hex>_{owner,app,purger}, UTC, REVOKE), its runtime url
//                     handed to the service through an env: secret ref;
//   the reader role   ensureKernelApiReader (C13), whose url the service uses.
// Every url passes assertNonProductionDbUrl: 127.0.0.1, this run's ports, the
// harness's own throwaway users.
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import { ensureKernelApiReader, ensureKernelDatabase, migratePlatform } from '@gremion/tenant-store/lifecycle'
import postgres from 'postgres'
import { loadCatalogueRows, type CatalogueModule } from '../../../../packages/provisioning/src/catalogue-rows.ts'

export interface StackState {
  sha8: string
  port: number
  poolerPort: number
  user: string
  password: string
  db: string
  image: string
  container: string
}

let cached: StackState | undefined
export function stack(): StackState {
  if (cached) return cached
  const path = process.env.T077_STATE
  if (!path) throw new Error('T077_STATE is unset: run through `pnpm --filter @gremion/kernel-api test:integration` (test/harness/stack.mjs)')
  const s = JSON.parse(readFileSync(path, 'utf8')) as StackState
  if (s.sha8 !== process.env.T077_SCRATCH) throw new Error('the scratch-stack state does not belong to this run')
  return (cached = s)
}

export const KERNEL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
export const SERVICE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const CONTROL_DB = 't077_control'
export const READER_ROLE = 't077_kernel_api_reader'
export const READER_PASSWORD = randomBytes(24).toString('base64url')

/** Fail closed unless `url` is this run's scratch server or its pooler. */
export function assertNonProductionDbUrl(url: string): void {
  const s = stack()
  const u = new URL(url)
  const ok = (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && u.hostname === '127.0.0.1' && (u.port === String(s.port) || u.port === String(s.poolerPort))
  if (!ok) throw new Error(`[t077] refusing a database url that is not this run's scratch server (${u.hostname}:${u.port})`)
}

export function url(db: string, o: { user?: string; password?: string; pooler?: boolean } = {}): string {
  const s = stack()
  const u = `postgres://${encodeURIComponent(o.user ?? s.user)}:${encodeURIComponent(o.password ?? s.password)}@127.0.0.1:${o.pooler ? s.poolerPort : s.port}/${db}`
  assertNonProductionDbUrl(u)
  return u
}

export function connect(db: string, o: { user?: string; password?: string; max?: number } = {}): Sql {
  return postgres(url(db, o), { max: o.max ?? 2, onnotice: () => {}, connect_timeout: 10 }) as unknown as Sql
}

/** RFC 9562 v7, as the control registry's default would mint it. */
export function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function realModules(): CatalogueModule[] {
  const root = join(KERNEL_ROOT, 'modules')
  return readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory())
    .map((id) => ({ id, moduleJson: JSON.parse(readFileSync(join(root, id, 'module.json'), 'utf8')) }))
}

export interface ScratchWorld {
  admin: Sql
  control: Sql
  platform: Sql
  /** env for the service's secret resolver: one T077_DB_<SLUG> per customer */
  env: Record<string, string>
  readerControlUrl: string
  readerPlatformUrl: string
  catalogueSize: number
  close(): Promise<void>
}

export async function buildWorld(): Promise<ScratchWorld> {
  const s = stack()
  const admin = connect(s.db)
  await admin.unsafe(`DROP DATABASE IF EXISTS ${CONTROL_DB} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${CONTROL_DB}`)
  await admin.unsafe('DROP DATABASE IF EXISTS gremion_platform WITH (FORCE)')
  await admin.unsafe('CREATE DATABASE gremion_platform')
  const control = connect(CONTROL_DB)
  const migrations = join(KERNEL_ROOT, 'gremion-ui', 'migrations-control')
  for (const f of readdirSync(migrations).filter((x) => x.endsWith('.sql')).sort()) await control.unsafe(readFileSync(join(migrations, f), 'utf8'))
  const platform = connect('gremion_platform')
  await migratePlatform(platform, { releaseRef: 'dist-v0.0.1', log: () => {} })
  const catalogue = await loadCatalogueRows(platform, realModules())
  if (catalogue.undecided.length) throw new Error(`catalogue rows undecided: ${JSON.stringify(catalogue.undecided)}`)
  await admin.unsafe(`DROP ROLE IF EXISTS ${READER_ROLE}`).catch(() => {})
  await ensureKernelApiReader({ kernelAdmin: admin, openAdminOn: (db) => connect(db, { max: 1 }), role: READER_ROLE, password: READER_PASSWORD, controlDatabase: CONTROL_DB })
  return {
    admin,
    control,
    platform,
    env: { KERNEL_API_ALLOW_ENV_SECRET_REFS: '1' },
    readerControlUrl: url(CONTROL_DB, { user: READER_ROLE, password: READER_PASSWORD }),
    readerPlatformUrl: url('gremion_platform', { user: READER_ROLE, password: READER_PASSWORD }),
    catalogueSize: catalogue.load.length,
    async close() {
      await Promise.allSettled([control.end({ timeout: 5 }), platform.end({ timeout: 5 })])
      await admin.end({ timeout: 5 })
    },
  }
}

export interface Customer {
  id: string
  slug: string
  host: string
  appPassword: string
  /** env: ref of its runtime url */
  ref: string
}

/** A customer from the libraries: kernel database + roles, control rows, its secret in `world.env`. */
export async function createCustomer(world: ScratchWorld, slug: string, host: string, o: { status?: string; realm?: string; issuer?: string; kcInternal?: string } = {}): Promise<Customer> {
  const id = uuidv7()
  const appPassword = randomBytes(24).toString('base64url')
  const server = { admin: world.admin, open: (db: string) => connect(db, { max: 2 }) }
  const r = await ensureKernelDatabase(server as never, id, appPassword)
  const envName = `T077_DB_${slug.toUpperCase().replaceAll('-', '_')}`
  world.env[envName] = url(r.dbName, { user: r.app, password: appPassword })
  await world.control`
    INSERT INTO tenant (id, slug, status, db_conn_ref, realm_name, issuer, kc_internal, kc_client_id,
      kc_client_ref, auth_client_ref, nc_target, matrix_space, domain_profile, brand_ref,
      blueprint_ref, conn_profile, backup_key_ref, audiences)
    VALUES (${id}::uuid, ${slug}, ${o.status ?? 'active'}, ${`env:${envName}`}, ${o.realm ?? `realm-${slug}`},
      ${o.issuer ?? `https://${host}/realms/realm-${slug}`}, ${o.kcInternal ?? `http://127.0.0.1:1/realms/realm-${slug}`}, 'gremion-admin',
      'ref', 'ref', '{}', '{}', '{}', 'ref', 'ref', '{}', 'ref', '{gremion-ui}')`
  await world.control`INSERT INTO tenant_domain (host, tenant_id, is_primary) VALUES (${host}, ${id}::uuid, true)`
  return { id, slug, host, appPassword, ref: `env:${envName}` }
}

/** Enables `moduleKey` (its loaded version) for a customer, satisfying module_enablement_gate_check. */
export async function enableModule(world: ScratchWorld, customerId: string, moduleKey: string, state = 'enabled'): Promise<void> {
  const enabled = state === 'enabled'
  // TRD-063: an enabled row carries a PASSED isolation_test_result of the same module (composite FK, TASK-044 0007)
  const [res] = enabled
    ? await world.platform<{ id: string }[]>`
        INSERT INTO plt.isolation_test_result (module_id, test_kind, passed, run_at, evidence_ref, release_tip_sha)
        SELECT module_id, 'cross_customer', true, now(), 'scratch-fixture:t077-harness', ${'0'.repeat(40)}
          FROM plt.module WHERE module_key = ${moduleKey}
        RETURNING isolation_test_result_id::text AS id`
    : []
  if (enabled && !res) throw new Error(`[t077] no plt.module row for ${moduleKey}`)
  await world.platform`
    INSERT INTO plt.module_enablement (customer_id, module_id, module_version_id, state, isolation_test_result_id,
      dpia_decision_id, enabled_by_kind, enabled_by, enabled_at, created_by_kind, updated_by_kind)
    SELECT ${customerId}::uuid, m.module_id, v.module_version_id, ${state},
      ${res?.id ?? null}::uuid,
      ${enabled ? uuidv7() : null}::uuid, ${enabled ? 'operator' : null}, ${enabled ? uuidv7() : null}::uuid,
      ${enabled ? new Date() : null}, 'system', 'system'
      FROM plt.module m JOIN plt.module_version v ON v.module_id = m.module_id
     WHERE m.module_key = ${moduleKey}`
}
