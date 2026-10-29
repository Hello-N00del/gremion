// A migrated scratch world for the bodies suites: the real control + platform
// databases (scratch.ts), customers from the libraries, the REAL
// `kernel-api migrate` over the shipped chain (core + bodies, with the idt
// hooks), and each customer's APP-role pool (what the service runs on).
// Pure exports (no top-level side effect); callers own the lifecycle.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from '@gremion/db'
import { KERNEL_API_MIGRATION_DIRS } from '../../src/migrate/chain.ts'
import { runMigrateCli } from '../../src/migrate/cli.ts'
import { kernelDatabaseOf } from '../../src/tenancy/target.ts'
import { buildWorld, connect, createCustomer, KERNEL_ROOT, SERVICE_ROOT, stack, url, type Customer, type ScratchWorld } from './scratch.ts'

export const DIRS = KERNEL_API_MIGRATION_DIRS.map((d) => join(SERVICE_ROOT, d))
// Windows has no uid: the dump dir's 0700/owner check is tenant-store's (unit-tested there with the same fake).
const dumpFs = { statDir: () => ({ isDirectory: true, mode: 0o700, uid: 1000 }), freeBytes: () => 1e12, uid: 1000 }

/** HOST/PORT only (directUrlFor refuses userinfo): each customer's db_conn_ref carries the credentials. */
export const directBase = (): string => {
  const u = new URL(url('postgres'))
  u.username = ''
  u.password = ''
  return u.toString()
}

export interface BodiesWorld {
  world: ScratchWorld
  dumps: string
  migrate(args: string[]): Promise<{ code: number; lines: string[] }>
  /** A customer migrated through the real command. */
  customer(slug: string, host: string, o?: { realm?: string; issuer?: string; kcInternal?: string }): Promise<Customer>
  /** The customer's app-role pool on its kernel database (prepare off, like the service). */
  appPool(c: Customer): Sql
  /** The customer's OWNER-role-less superuser view of its database (admin), for post-condition reads that bypass RLS. */
  adminPool(c: Customer): Sql
  close(): Promise<void>
}

export async function buildBodiesWorld(tag: string): Promise<BodiesWorld> {
  const dumps = join(KERNEL_ROOT, '.scratch', `t080-dumps-${tag}`, String(process.pid))
  mkdirSync(dumps, { recursive: true })
  const world = await buildWorld()
  const pools: Sql[] = []
  const migrate = async (args: string[]) => {
    const lines: string[] = []
    const code = await runMigrateCli(
      ['migrate', ...args],
      {
        ...world.env,
        KERNEL_API_CONTROL_DB_URL: world.readerControlUrl,
        GREMION_KERNEL_PG_DIRECT_URL: directBase(),
        GREMION_RELEASE_REF: 'dist-v1.0.0',
        GREMION_MIGRATION_DUMP_DIR: dumps,
        KERNEL_API_PG_DUMP_CONTAINER: stack().container,
      },
      { out: (l) => lines.push(l), err: (l) => lines.push(l) },
      { dirs: DIRS, kernelRoot: KERNEL_ROOT },
      { options: { dumpFs } },
    )
    return { code, lines }
  }
  return {
    world,
    dumps,
    migrate,
    async customer(slug, host, o = {}) {
      const c = await createCustomer(world, slug, host, o)
      const r = await migrate(['--customer', c.id])
      if (r.code !== 0) throw new Error(`migrate ${slug} failed: ${r.lines.join('\n')}`)
      return c
    },
    appPool(c) {
      const hex = c.id.replaceAll('-', '')
      const pool = connect(kernelDatabaseOf(c.id), { user: `k_${hex}_app`, password: c.appPassword, max: 3 })
      pools.push(pool)
      return pool
    },
    adminPool(c) {
      const pool = connect(kernelDatabaseOf(c.id), { max: 2 })
      pools.push(pool)
      return pool
    },
    async close() {
      await Promise.allSettled(pools.map((p) => p.end({ timeout: 5 })))
      await world.close()
      rmSync(dumps, { recursive: true, force: true })
    },
  }
}

/** Runs `fn` in a transaction of `sql` with the tenant GUC set (the way the service does it). */
export async function asCustomer<T>(sql: Sql, customerId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`SELECT set_config('gremion.customer_id', ${customerId}, true)`
    return fn(tx as unknown as Sql)
  })) as T
}
