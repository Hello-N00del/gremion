// packages/tenant-store/src/dump/hook.ts
//
// TASK-075: the pre-migration dump as a runner hook, and the composition of
// hooks into the runner's ONE preApply slot (runner.ts step 7).
//
//   composePreApply(chainPreApply(...), dumpHook(...))
//
// Order is the point: TASK-029's chain check refuses a renamed/renumbered
// ledger (LEDGER_NAME_NOT_IN_CHAIN) or a back-fill (BELOW_HIGH_WATER) FIRST, so
// a refused run takes no dump and writes no `created` line. Both hooks act
// once per run, on the first pending file, under the migration lock and
// before the first BEGIN; the runner never calls preApply when nothing pends,
// so a current database is never dumped.
import type { PreApplyContext, RunMigrationsHooks } from '../runner.js'
import { PLATFORM_DATABASE } from '../lifecycle/platform.js'
import type { Exporter } from '../lifecycle/types.js'
import { DumpError, type ByKind, type DumpScope } from './ledger.js'
import { takeDump, type DumpFs, type TakenDump } from './take.js'

export type PreApply = NonNullable<RunMigrationsHooks['preApply']>
type AnyPreApply = (file: string, ctx: PreApplyContext) => void | Promise<void>

/** Runs each hook in order for every file; the first throw stops the rest (and the run). */
export function composePreApply(...hooks: ReadonlyArray<AnyPreApply | undefined>): PreApply {
  const list = hooks.filter((h): h is AnyPreApply => typeof h === 'function')
  return async (file, ctx) => {
    for (const h of list) await h(file, ctx)
  }
}

const TENANT_DB = /^t_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})__([a-z][a-z0-9_]*)$/

/** DB-OPS-MIGRATION-DUMP scope of a database name: gremion_platform, or a (tenant, module) database. */
export function scopeOf(database: string): { scope: DumpScope; customerId: string | null; moduleId: string | null } {
  if (database === PLATFORM_DATABASE) return { scope: 'platform', customerId: null, moduleId: null }
  const m = TENANT_DB.exec(database)
  if (m) return { scope: 'customer', customerId: `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`, moduleId: m[6]! }
  throw new DumpError('DUMP_SCOPE', `database ${database} is neither ${PLATFORM_DATABASE} nor a (tenant, module) database: no DB-OPS-MIGRATION-DUMP scope; nothing was dumped or migrated`)
}

export interface DumpHookOptions {
  dir: string | undefined
  release: string
  exporter: Exporter
  pgDumpMajor(): Promise<number>
  service?: string
  fs?: DumpFs
  byKind?: ByKind
  now?: () => Date
  audit?: (line: string) => void
  /** Called with what was taken (tests, the CLI's summary). */
  onDump?: (d: TakenDump) => void
}

/**
 * A preApply that takes the dump of the database the reserved connection is
 * on, once per run (the runner passes the same ctx to every call of a run).
 */
export function dumpHook(o: DumpHookOptions): PreApply {
  const seen = new WeakSet<object>()
  return async (_file, ctx) => {
    if (seen.has(ctx)) return
    seen.add(ctx)
    const [row] = await ctx.sql<{ db: string; major: number; bytes: string }[]>`
      SELECT pg_catalog.current_database() AS db,
             pg_catalog.current_setting('server_version_num')::int / 10000 AS major,
             pg_catalog.pg_database_size(pg_catalog.current_database())::text AS bytes`
    if (!row) throw new DumpError('DUMP_SCOPE', 'the migration connection answered no current_database()')
    const { scope, customerId, moduleId } = scopeOf(row.db)
    const taken = await takeDump({
      dir: o.dir,
      release: o.release,
      database: row.db,
      scope,
      customerId,
      moduleId,
      exporter: o.exporter,
      probe: { serverMajor: async () => Number(row.major), databaseBytes: async () => Number(row.bytes), pgDumpMajor: () => o.pgDumpMajor() },
      ...(o.service !== undefined ? { service: o.service } : {}),
      ...(o.fs ? { fs: o.fs } : {}),
      ...(o.byKind ? { byKind: o.byKind } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.audit ? { audit: o.audit } : {}),
    })
    o.onDump?.(taken)
  }
}
