// packages/tenant-store/src/dump/cli.ts
//
// TASK-075: the kernel-checkout entry point of the pre-migration dump.
//
//   tsx packages/tenant-store/src/dump/cli.ts migrate --chain <id> --release <R> [--pg-dump-container <c>] [--root <kernel>]
//   tsx packages/tenant-store/src/dump/cli.ts take --release import-<job> --db <D> [--pg-dump-container <c>]
//
// Environment (never argv, so no secret reaches `ps`):
//   GREMION_MIGRATE_URL         a DIRECT postgres:// url (migrate: the chain's
//                               database; take: any database on the server,
//                               --db replaces its path)
//   GREMION_MIGRATION_DUMP_DIR  0700, owned by the running uid
//
// migrate: only a chain whose class in scripts/migrations/runner/chain-runners.json
// is `tenant-store`. Its preApply is composePreApply(TASK-029's chainPreApply
// over chainFileNames(id), the dump hook): chain refusal first, then ONE dump,
// both on the first pending file under the migration lock, before any BEGIN.
//
// take: the same checks and ledger for a data job (TASK-031's member import):
// one `created` line; `gremion-migration-dump discard --release import-<job>
// --reason import-verified` deletes it once the import is checked (Q10).
//
// --pg-dump-container <c> runs pg_dump/pg_restore inside that container over
// its local socket (`docker exec -i <c> pg_dump`) -- the scratch stack only;
// on a host the server's own pg_dump 18 is used the same way by the bash tool.
//
// Exit: 0 ok (dump created, reused, or nothing pending), 1 refused or failed,
// 2 usage.
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { chainFileNames, chainPreApply } from '../../../../scripts/migrations/pre-apply.mjs'
import { pgDumpExporter } from '../lifecycle/export.js'
import { KERNEL_ROOT } from '../lifecycle/platform.js'
import type { Exporter } from '../lifecycle/types.js'
import { loadBaselinePhaseFor } from '../phase.js'
import { runMigrations } from '../runner.js'
import { composePreApply, dumpHook, scopeOf, type DumpHookOptions, type PreApply } from './hook.js'
import { DumpError } from './ledger.js'
import { takeDump, type DumpFs } from './take.js'

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface CliDeps {
  /** Replaces the exporter and pg_dump version probe (tests). */
  tools?: { exporter: Exporter; pgDumpMajor(): Promise<number> }
  fs?: DumpFs
  now?: () => Date
}

class UsageError extends Error {}

function parse(argv: readonly string[]): { cmd: string; flags: Map<string, string> } {
  const [cmd, ...rest] = argv
  if (!cmd) throw new UsageError('missing command (migrate | take)')
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`)
    const v = rest[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`option ${a} needs a value`)
    flags.set(a.slice(2), v)
    i++
  }
  return { cmd, flags }
}

function need(flags: Map<string, string>, name: string): string {
  const v = flags.get(name)
  if (!v) throw new UsageError(`--${name} is required`)
  return v
}

/** "pg_dump (PostgreSQL) 18.1 (Debian 18.1-1)" -> 18 */
export function parsePgDumpMajor(versionOutput: string): number {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput)
  if (!m) throw new DumpError('PG_DUMP_VERSION', `cannot read the pg_dump version from ${JSON.stringify(versionOutput.trim().slice(0, 80))}`)
  return Number(m[1])
}

function capture(argv: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    const child = spawn(cmd!, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(-200)}`))))
  })
}

/** TASK-021's pgDumpExporter, local (`pg_dump`) or inside a container (scratch). --no-owner via connection().args. */
export function dumpTools(url: URL, container: string | undefined): { exporter: Exporter; pgDumpMajor(): Promise<number> } {
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const pgDump = container ? ['docker', 'exec', '-i', container, 'pg_dump'] : ['pg_dump']
  const pgRestore = container ? ['docker', 'exec', '-i', container, 'pg_restore'] : ['pg_restore']
  const exporter = pgDumpExporter({
    pgDump,
    pgRestore,
    connection: (target) =>
      container
        ? // the container's own socket (the image trusts local connections): no password crosses argv
          { args: ['--no-owner', '--username', user, '--dbname', target.database] }
        : {
            args: ['--no-owner', '--host', url.hostname, '--port', url.port || '5432', '--username', user, '--dbname', target.database],
            ...(password ? { env: { PGPASSWORD: password } } : {}),
          },
  })
  return { exporter, pgDumpMajor: async () => parsePgDumpMajor(await capture([...pgDump, '--version'])) }
}

/**
 * The ONE preApply of `migrate`: TASK-029's chain check first, then the dump.
 * The order is the guarantee that a chain-refused run takes no dump; the
 * specs drive this function, so a swapped order is caught.
 */
export function migratePreApply(o: { chainFiles: string[]; log?: (line: string) => void; dump: DumpHookOptions }): PreApply {
  return composePreApply(chainPreApply({ chainFiles: o.chainFiles, ...(o.log ? { log: o.log } : {}) }), dumpHook(o.dump))
}

interface Chain {
  id: string
  database: string
  dirs: string[]
  manifestDirs?: string[]
}

function dbOf(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''))
}

async function migrate(flags: Map<string, string>, env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps): Promise<number> {
  const chainId = need(flags, 'chain')
  const release = need(flags, 'release')
  const root = flags.get('root') ?? KERNEL_ROOT
  const runners = JSON.parse(readFileSync(join(root, 'scripts', 'migrations', 'runner', 'chain-runners.json'), 'utf8')) as { chains: Record<string, string> }
  const cls = runners.chains[chainId]
  if (cls === undefined) throw new UsageError(`chain ${chainId} is not in chain-runners.json`)
  if (cls !== 'tenant-store') {
    io.err(`chain ${chainId} is class ${cls}, not tenant-store: this runner does not apply it (legacy-boot: gremion-migration-dump preflight takes its host dump; unadopted: -- gremion:manual-dump)`)
    return 2
  }
  const register = JSON.parse(readFileSync(join(root, 'scripts', 'migrations', 'ranges.json'), 'utf8')) as { chains: Chain[] }
  const chain = register.chains.find((c) => c.id === chainId)
  if (!chain) throw new UsageError(`chain ${chainId} is not in ranges.json`)
  const dirs = chain.manifestDirs ?? chain.dirs
  if (dirs.length !== 1) throw new UsageError(`chain ${chainId} spans ${dirs.length} manifest dirs; the union runner is TASK-077's`)
  const rawUrl = env.GREMION_MIGRATE_URL
  if (!rawUrl) throw new UsageError('GREMION_MIGRATE_URL is not set')
  const url = new URL(rawUrl)
  if (!chain.database.includes(':') && dbOf(url) !== chain.database) {
    io.err(`GREMION_MIGRATE_URL names database ${dbOf(url)}, chain ${chainId} is ${chain.database}; nothing was applied`)
    return 1
  }
  const tools = deps.tools ?? dumpTools(url, flags.get('pg-dump-container'))
  const log = (l: string) => io.out(`[migrate ${chainId}] ${l}`)
  const sql = postgres(rawUrl, { max: 2, onnotice: () => {} })
  try {
    const r = await runMigrations({
      sql,
      dir: join(root, dirs[0]!),
      releaseRef: release,
      phaseFor: loadBaselinePhaseFor(chainId, root),
      log,
      hooks: {
        preApply: migratePreApply({
          chainFiles: chainFileNames(chainId, { root }),
          log,
          dump: {
            dir: env.GREMION_MIGRATION_DUMP_DIR,
            release,
            exporter: tools.exporter,
            pgDumpMajor: () => tools.pgDumpMajor(),
            audit: (l) => io.out(l),
            ...(deps.fs ? { fs: deps.fs } : {}),
            ...(deps.now ? { now: deps.now } : {}),
          },
        }),
      },
    })
    io.out(`MIGRATE-RESULT chain=${chainId} release=${release} applied=${r.applied.length} already=${r.alreadyApplied}${r.applied.length === 0 ? ' dump=none' : ''}`)
    return 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function take(flags: Map<string, string>, env: NodeJS.ProcessEnv, io: CliIo, deps: CliDeps): Promise<number> {
  const release = need(flags, 'release')
  const db = need(flags, 'db')
  const rawUrl = env.GREMION_MIGRATE_URL
  if (!rawUrl) throw new UsageError('GREMION_MIGRATE_URL is not set')
  const url = new URL(rawUrl)
  url.pathname = `/${encodeURIComponent(db)}`
  const scope = flags.has('customer') ? { scope: 'customer' as const, customerId: flags.get('customer')!, moduleId: flags.get('module') ?? null } : scopeOf(db)
  const tools = deps.tools ?? dumpTools(url, flags.get('pg-dump-container'))
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} })
  try {
    const [row] = await sql<{ db: string; major: number; bytes: string }[]>`
      SELECT pg_catalog.current_database() AS db,
             pg_catalog.current_setting('server_version_num')::int / 10000 AS major,
             pg_catalog.pg_database_size(pg_catalog.current_database())::text AS bytes`
    const taken = await takeDump({
      dir: env.GREMION_MIGRATION_DUMP_DIR,
      release,
      database: row!.db,
      ...scope,
      exporter: tools.exporter,
      probe: { serverMajor: async () => Number(row!.major), databaseBytes: async () => Number(row!.bytes), pgDumpMajor: () => tools.pgDumpMajor() },
      audit: (l) => io.out(l),
      ...(deps.fs ? { fs: deps.fs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    })
    io.out(`TAKE-RESULT release=${release} db=${db} status=${taken.status} id=${taken.id}`)
    return 0
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, io: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }, deps: CliDeps = {}): Promise<number> {
  try {
    const { cmd, flags } = parse(argv)
    if (cmd === 'migrate') return await migrate(flags, env, io, deps)
    if (cmd === 'take') return await take(flags, env, io, deps)
    throw new UsageError(`unknown command ${cmd} (migrate | take)`)
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`usage: cli.ts migrate --chain <id> --release <R> | take --release <R> --db <D>  (${err.message})`)
      return 2
    }
    const code = (err as { code?: string }).code
    io.err(`${code ? `${code}: ` : ''}${(err as Error).message}`)
    const cause = (err as { cause?: { message?: string } }).cause
    if (cause?.message) io.err(`  cause: ${cause.message}`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => (process.exitCode = code))
}
