// gremion-ui/scripts/tenant-provision-modules.ts -- the CD module step: the
// `module-upgrade` verb of the tenant-create one-shot. Its own file, like the purge,
// export and Karenz verbs: tenant-provision.ts carries one import, one usage line and
// one case block that injects the pieces only that file can build (the environment
// reads, the module-server factory, the platform pool). This file imports nothing private.
//
//   module-upgrade --all
//       Applies the pending migration files of the module's chain to every ENABLED
//       enable-gate database (plt.module_database `enabled` with an `enabled`
//       enablement), as the database's owner, then re-grants the app role on what the
//       files created (upgradeModuleDatabases, packages/tenant-store). It stops at the
//       first database that fails, writes no plt row, takes no dump and mounts no dump
//       directory: the host's dump set, taken before this verb, is the restore point.
//       The release label is GREMION_RELEASE_REF.
//
//       STDOUT: exactly ONE JSON line of counts and nothing else,
//         {"v":1,"total":N,"upgraded":N,"unchanged":N,"skipped":N,"failed":N,"files_applied":N}
//       printed on every exit this verb controls (0, 1 and 3). No module, database or
//       customer name reaches stdout or stderr: a failure is a fixed code and a position.
//         total          rows skipped plus databases opened; a database after the first
//                        failure is not reached and not counted, so the four counts below
//                        always add up to total
//         upgraded       databases on which at least one file was applied
//         unchanged      databases opened with nothing pending (no DDL ran)
//         skipped        rows not opened: blocked, enabling, disabling, dropped, an
//                        enablement that is not enabled, a module with no database
//         failed         0 or 1 (the loop stops)
//         files_applied  every file applied in this run, a failing database's earlier files included
//       Exit codes (the verb sets process.exitCode itself and returns):
//         0  every enabled database is at the head of its chain
//         1  a migration file or the re-grant raised, or a database is not what the
//            platform says it is: the release's fault, the host holds the release
//         2  usage, or a missing environment value (named): nothing was connected to
//         3  a connection-level error on a database BEFORE any DDL began (a refused or
//            timed-out connection, a server going down or not accepting yet, a full
//            disk), or on the platform database: the infrastructure's fault, retried
//         A connection that drops once a file's transaction has begun is exit 1.
//       An unexpected throw that cannot be turned into counts ends exit 1 with NO JSON
//       line; the host reads that as the container's own failure, not the release's.
import type postgres from 'postgres'
import { upgradeModuleDatabases, type LifecycleModule, type ModuleServer, type UpgradeSummary } from '@gremion/tenant-store/lifecycle'

export const MODULE_VERBS: ReadonlySet<string> = new Set(['module-upgrade'])

export const MODULE_USAGE = `  module-upgrade --all   (CD module step: apply the pending migration files of every enabled module database as its owner, re-grant the app role; stops at the first failure; one JSON line of counts; exit 0 ok, 1 a file or the re-grant failed, 2 usage, 3 a connection-level error)`

export interface ModuleVerbContext {
  /** process.argv after the verb */
  args: readonly string[]
  /** The module catalogue of this image (loadModules). */
  catalogue(): readonly LifecycleModule[]
  /** GREMION_RELEASE_REF, validated; throws the usage error when it is missing or malformed. */
  releaseRef(): string
  /** The admin handle of the server behind a compose service name; throws the usage error that names a missing environment value. The verb closes it. */
  moduleServer(service: string): ModuleServer & { close(): Promise<void> }
  /** A direct pool to gremion_platform as its owner; the verb ends it. Throws the usage error that names a missing environment value. */
  openPlatform(): postgres.Sql
  /** Tests only: where the JSON line goes (default process.stdout). */
  stdout?: (text: string) => void
  usage(message: string): Error
  log(line: string): void
}

/** The ONE stdout line: the Interfaces form, `v` first and the counts in a fixed order, nothing but counts. */
export function moduleUpgradeLine(s: Pick<UpgradeSummary, 'total' | 'upgraded' | 'unchanged' | 'skipped' | 'failed' | 'files_applied'>): string {
  return JSON.stringify({ v: 1, total: s.total, upgraded: s.upgraded, unchanged: s.unchanged, skipped: s.skipped, failed: s.failed, files_applied: s.files_applied })
}

/** 0 ok, 1 a failure of the commit, 3 a connection-level error before any DDL. */
export function moduleUpgradeExitCode(s: Pick<UpgradeSummary, 'failure'>): 0 | 1 | 3 {
  if (!s.failure) return 0
  return s.failure.kind === 'connection' ? 3 : 1
}

export async function moduleVerb(verb: string, ctx: ModuleVerbContext): Promise<void> {
  if (verb !== 'module-upgrade') throw ctx.usage(`unknown verb ${verb}`)
  if (ctx.args.length !== 1 || ctx.args[0] !== '--all') {
    throw ctx.usage(ctx.args.length === 0 ? 'module-upgrade requires --all (it upgrades every enabled module database; there is no single-database form)' : `module-upgrade takes exactly --all (got ${ctx.args.length} argument(s))`)
  }
  // Every precondition is resolved BEFORE anything connects: a missing environment value is a named exit 2,
  // never a failure half way through the customer list.
  const releaseRef = ctx.releaseRef()
  const catalogue = ctx.catalogue()
  const servers = new Map<string, ModuleServer & { close(): Promise<void> }>()
  for (const m of catalogue) {
    const service = m.moduleJson.runtime.database?.postgresService
    if (service && !servers.has(service)) servers.set(service, ctx.moduleServer(service))
  }
  const platform = ctx.openPlatform()
  let summary: UpgradeSummary
  try {
    summary = await upgradeModuleDatabases({
      platform,
      catalogue,
      releaseRef,
      server: (service) => {
        const s = servers.get(service)
        if (!s) throw new Error('no module server was resolved for a service of the catalogue')
        return s
      },
      log: (line) => ctx.log(line),
    })
  } catch (err) {
    // Not a database's failure and not countable: say a code, never a message (it may name a database), and print no JSON line.
    const code = (err as { code?: unknown } | null)?.code
    ctx.log(`module-upgrade: stopped before a result (${typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'error'})`)
    process.exitCode = 1
    return
  } finally {
    await Promise.all([platform.end({ timeout: 5 }).catch(() => {}), ...[...servers.values()].map((s) => s.close().catch(() => {}))])
  }
  ctx.log(`module-upgrade: ${summary.total} row(s): ${summary.upgraded} upgraded, ${summary.unchanged} unchanged, ${summary.skipped} skipped, ${summary.failed} failed, ${summary.files_applied} file(s) applied`)
  if (summary.failure) {
    const f = summary.failure
    ctx.log(`module-upgrade: stopped at database ${f.ordinal}: ${f.kind === 'connection' ? 'connection-level error before any DDL' : 'commit failure'} (${f.code}${f.file ? `, ${f.file}` : ''})`)
  }
  ;(ctx.stdout ?? ((t: string) => void process.stdout.write(t)))(`${moduleUpgradeLine(summary)}\n`)
  process.exitCode = moduleUpgradeExitCode(summary)
}
