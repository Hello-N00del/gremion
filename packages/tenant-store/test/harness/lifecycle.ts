// packages/tenant-store/test/harness/lifecycle.ts — TASK-021 G2: the
// lifecycle specs' view of the scratch stack. The kernel server `pg` holds
// gremion_platform (global-setup migrates it) and the customers' kernel
// databases; the module server `pgm` (label module:lcfix) holds the (tenant,
// lcfix) databases. Every connection goes through db.ts
// (assertNonProductionDbUrl); pg_dump / pg_restore run INSIDE the pgm
// container (PostgreSQL 18, the server's own major), by its explicit name.
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import { readCompose } from '@gremion/module-catalogue/compose'
import type { ComposeModel } from '@gremion/module-catalogue/runtime'
import { pgDumpExporter } from '../../src/lifecycle/export.js'
import type { EnableGate, Exporter, LifecycleDeps, LifecycleModule, ModuleServer } from '../../src/lifecycle/types.js'
import { connect, connectModule, stack } from './db.js'

/** The compose service names of the harness servers (the generated compose file). */
export const KERNEL_SERVICE = 'pg'
export const MODULE_SERVICE = 'pgm'
export const LCFIX_DIR = fileURLToPath(new URL('../fixtures/lifecycle/lcfix/', import.meta.url))
export const EXPORT_ROOT = fileURLToPath(new URL('../../../../.scratch/t021-exports/', import.meta.url))

export const OPERATOR = { kind: 'operator' as const, id: randomUUID() }

/** A fresh RFC 9562 version-7 uuid (the tenant ids the lifecycle expects). */
export function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function harnessCompose(): ComposeModel {
  return readCompose(stack().composeFile)
}

/** The lcfix module as the catalogue would hold it. */
export function lcfixModule(runtime: Partial<LifecycleModule['moduleJson']['runtime']> = {}): LifecycleModule {
  return {
    id: 'lcfix',
    dir: LCFIX_DIR,
    moduleJson: {
      schemaVersion: 1,
      id: 'lcfix',
      extractionSource: 'f276af5925abacdcfd05f6613fc11afff2d804c5',
      runtime: {
        version: '1.0.0',
        database: { postgresService: MODULE_SERVICE, migrations: 'migrations' },
        export: { kind: 'pg_dump', retentionProfile: 'rp-ops-module-data' },
        timedJobs: [],
        platformServer: null,
        ...runtime,
      },
    },
  }
}

/** plt.module + plt.module_version rows (TASK-077's registry loads them for real). */
export async function seedCatalogue(platform: Sql, moduleKey: string, semver = '1.0.0'): Promise<void> {
  await platform`
    INSERT INTO plt.module (module_key, name, owning_context_code, toggleable, created_by_kind, updated_by_kind)
    VALUES (${moduleKey}, ${moduleKey}, 'ops', true, 'system', 'system')
    ON CONFLICT (module_key) DO NOTHING`
  await platform`
    INSERT INTO plt.module_version (module_id, semver, retention_profile_default_id, created_by_kind, updated_by_kind)
    SELECT module_id, ${semver}, 'rp-ops-module-data', 'system', 'system' FROM plt.module WHERE module_key = ${moduleKey}
    ON CONFLICT (module_id, semver) DO NOTHING`
}

export const passingGate: EnableGate = () => ({ isolationTestResultId: randomUUID(), dpiaDecisionId: randomUUID() })

/** The module server behind `pgm`, recording every database the lifecycle opens. */
export function moduleServer(): ModuleServer & { opened: string[]; close(): Promise<void> } {
  const admin = connectModule('postgres', { max: 2 })
  const pools: Sql[] = []
  const opened: string[] = []
  return {
    admin,
    opened,
    open(database, options) {
      opened.push(database)
      const sql = connectModule(database, { max: 2, ...(options?.role ? { role: options.role } : {}) })
      pools.push(sql)
      return sql
    },
    async close() {
      await Promise.all([admin, ...pools].map((s) => s.end({ timeout: 5 }).catch(() => {})))
    },
  }
}

/** pg_dump / pg_restore inside the pgm container, as its superuser over the local socket. */
export function containerExporter(): Exporter {
  const s = stack()
  return pgDumpExporter({
    pgDump: ['docker', 'exec', '-i', s.moduleContainer, 'pg_dump'],
    pgRestore: ['docker', 'exec', '-i', s.moduleContainer, 'pg_restore'],
    connection: (t) => {
      if (t.service !== MODULE_SERVICE) throw new Error(`[t021] no container for service ${t.service}`)
      return { args: ['-U', s.user, '-d', t.database] }
    },
  })
}

export const APP_PASSWORD = randomBytes(24).toString('base64url')

export function lifecycleDeps(platform: Sql, server: ModuleServer, overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    platform,
    server: (service) => {
      if (service !== MODULE_SERVICE) throw new Error(`[t021] the harness has no module server ${service}`)
      return server
    },
    enableGate: passingGate,
    secrets: { appPassword: () => APP_PASSWORD },
    exporter: containerExporter(),
    exportDir: join(EXPORT_ROOT, String(process.pid)),
    // TASK-075: the lcfix fixture chain is headerless and in no baseline.
    releaseRef: 'dist-v0.0.1',
    phaseFor: () => () => ({ phase: 'expand' as const }),
    log: () => {},
    ...overrides,
  }
}

export function platformDb(): Sql {
  return connect('gremion_platform', { max: 3 })
}

/** Test-side cleanup on pgm: every t_ database and the lifecycle's rows. */
export async function resetModuleServer(admin: Sql, platform: Sql): Promise<void> {
  const dbs = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE 't\\_%'`
  for (const { datname } of dbs) {
    const [q] = await admin<{ stmt: string }[]>`SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', ${datname}::text) AS stmt`
    await admin.unsafe(q!.stmt)
  }
  await platform`DELETE FROM plt.module_database`
  await platform`DELETE FROM plt.module_enablement`
}

export async function databasesOn(admin: Sql): Promise<string[]> {
  return (await admin<{ datname: string }[]>`SELECT datname FROM pg_database ORDER BY datname`).map((r) => r.datname)
}
