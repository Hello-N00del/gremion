// services/kernel-api/src/migrate/cli.ts — `kernel-api migrate [--customer <id>]`
// (Q10; the image's `node dist/index.js migrate ...`, the kernel-api-migrate
// one-shot's command).
//
// Environment (never argv, so no secret reaches `ps`):
//   KERNEL_API_CONTROL_DB_URL      the control registry (the reader role suffices)
//   GREMION_KERNEL_PG_DIRECT_URL   the kernel Postgres server itself (host/port; never PgBouncer)
//   GREMION_RELEASE_REF            the release this image ships (ledger release_ref, dump release)
//   GREMION_MIGRATION_DUMP_DIR     0700, owned by the image uid (TASK-075's dump hook)
//   KERNEL_API_PG_DUMP_CONTAINER   scratch stacks only: run pg_dump inside that container
//
// Output: one MIGRATE-RESULT line per customer migrated, one MIGRATE-SKIPPED
// per customer skipped, one MIGRATE-FAILED per failure; exit 0 only when
// nothing failed, 1 otherwise (naming every failed customer), 2 on usage.
import type { Sql } from '@gremion/db'
import postgres from 'postgres'
import { createSecretResolver } from '../tenancy/secrets.ts'
import { MigrateError, migrateAllCustomers, migrateKernelDb, type MigrateOptions } from './migrate.ts'

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface MigrateCliDeps {
  /** Overrides any MigrateOptions field (tests: tools, dumpFs, openSql). */
  options?: Partial<MigrateOptions>
  openControl?: (url: string) => Sql
}

class UsageError extends Error {}

function parse(argv: readonly string[]): { customer?: string } {
  const [cmd, ...rest] = argv
  if (cmd !== 'migrate') throw new UsageError(`unknown command ${JSON.stringify(cmd)}`)
  if (rest.length === 0) return {}
  if (rest.length === 2 && rest[0] === '--customer' && rest[1] && !rest[1].startsWith('--')) return { customer: rest[1] }
  throw new UsageError(`unexpected arguments ${rest.join(' ')}`)
}

export async function runMigrateCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  roots: { dirs: readonly string[]; kernelRoot: string },
  deps: MigrateCliDeps = {},
): Promise<number> {
  let args: { customer?: string }
  try {
    args = parse(argv)
  } catch (err) {
    io.err(`usage: kernel-api migrate [--customer <customer id>]  (${(err as Error).message})`)
    return 2
  }
  const missing = ['KERNEL_API_CONTROL_DB_URL', 'GREMION_KERNEL_PG_DIRECT_URL', 'GREMION_RELEASE_REF'].filter((k) => !env[k]?.trim())
  if (missing.length) {
    io.err(`kernel-api migrate: ${missing.join(', ')} not set; nothing was migrated`)
    return 1
  }
  const control = (deps.openControl ?? ((u: string) => postgres(u, { max: 1, onnotice: () => {}, connect_timeout: 15 })))(env.KERNEL_API_CONTROL_DB_URL!)
  const options: MigrateOptions = {
    control,
    resolveSecret: createSecretResolver({ env }),
    directBase: env.GREMION_KERNEL_PG_DIRECT_URL!,
    dirs: roots.dirs,
    kernelRoot: roots.kernelRoot,
    releaseRef: env.GREMION_RELEASE_REF!.trim(),
    dumpDir: env.GREMION_MIGRATION_DUMP_DIR,
    log: (l) => io.out(l),
    audit: (l) => io.out(l),
    ...(env.KERNEL_API_PG_DUMP_CONTAINER ? { pgDumpContainer: env.KERNEL_API_PG_DUMP_CONTAINER } : {}),
    ...deps.options,
  }
  const describe = (err: unknown) => {
    const cause = (err as { cause?: { message?: string } }).cause?.message
    return `${(err as Error).message}${cause ? ` (cause: ${cause})` : ''}`
  }
  try {
    if (args.customer !== undefined) {
      try {
        const r = await migrateKernelDb(args.customer, options)
        io.out(`MIGRATE-RESULT customer=${r.customerId} applied=${r.applied.length} already=${r.alreadyApplied}${r.applied.length === 0 ? ' dump=none' : ''}`)
        return 0
      } catch (err) {
        io.err(`MIGRATE-FAILED customer=${args.customer} ${describe(err)}`)
        return 1
      }
    }
    const all = await migrateAllCustomers(options)
    for (const r of all.migrated) io.out(`MIGRATE-RESULT customer=${r.customerId} applied=${r.applied.length} already=${r.alreadyApplied}${r.applied.length === 0 ? ' dump=none' : ''}`)
    for (const s of all.skipped) io.out(`MIGRATE-SKIPPED customer=${s.customerId} status=${s.status}`)
    for (const f of all.failed) io.err(`MIGRATE-FAILED customer=${f.customerId} ${f.error}`)
    io.out(`MIGRATE-SUMMARY migrated=${all.migrated.length} skipped=${all.skipped.length} failed=${all.failed.length}`)
    if (all.failed.length) {
      io.err(`kernel-api migrate: ${all.failed.length} customer(s) failed: ${all.failed.map((f) => f.customerId).join(', ')}`)
      return 1
    }
    return 0
  } catch (err) {
    io.err(`kernel-api migrate: ${err instanceof MigrateError ? '' : 'error: '}${describe(err)}`)
    return 1
  } finally {
    await control.end({ timeout: 5 })
  }
}
