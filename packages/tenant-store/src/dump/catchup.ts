// packages/tenant-store/src/dump/catchup.ts
//
// CD stage 1, unit U6g: the dump of the ENABLE path. A customer who switches a module on again inside its
// Karenz gets a blocked database back; the release may have moved on, so enableModule applies the pending files
// of the chain first. Releases never touch a blocked database, so that apply has no dump from the host's set:
// this factory builds the hook that takes one, of that ONE database, once, before the first BEGIN, and not at
// all when nothing is pending (the runner never calls preApply then).
//
// It imports nothing that loads cli.ts: the tenant-create image carries no root scripts/ directory, and cli.ts
// imports scripts/migrations/pre-apply.mjs at load. dump/index.ts re-exports cli.ts, so tenant-create reaches
// this file through @gremion/tenant-store/lifecycle (lifecycle/index.ts), never through ./dump.
//
// Fail closed, named: with no usable dump directory the hook throws on the FIRST PENDING FILE (a set but
// unusable directory, an unset one, a bad owner uid), so the enable stops with the database still blocked and
// nothing applied. An enable with nothing pending never reaches the hook.
import { execFile } from 'node:child_process'
import type { RunMigrationsHooks } from '../runner.js'
import type { DumpRetirer, Exporter } from '../lifecycle/types.js'
import { dumpHook, type PreApply } from './hook.js'
import { DumpError, ENABLE_ORIGIN } from './ledger.js'
import { retireDatabaseDumps, retireEnableDumps } from './retire.js'
import { isOwnerUid, type DumpFs } from './take.js'

/** "pg_dump (PostgreSQL) 18.1 (Debian 18.1-1)" -> 18. */
export function pgDumpMajorOf(versionOutput: string): number {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput)
  if (!m) throw new DumpError('PG_DUMP_VERSION', `cannot read the pg_dump version from ${JSON.stringify(versionOutput.trim().slice(0, 80))}`)
  return Number(m[1])
}

/** The major version of the local `pg_dump` (the tenant-create image carries the PostgreSQL 18 client). */
export function localPgDumpMajor(): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('pg_dump', ['--version'], { windowsHide: true }, (err, stdout) => {
      if (err) return reject(new DumpError('PG_DUMP_VERSION', `pg_dump --version failed: ${err.message}`, { cause: err }))
      try {
        resolve(pgDumpMajorOf(stdout))
      } catch (e) {
        reject(e)
      }
    })
  })
}

export interface CatchupDumpOptions {
  /** GREMION_MIGRATION_DUMP_DIR and GREMION_MIGRATION_DUMP_OWNER_UID are read from here (process.env in the one-shot). */
  env: Record<string, string | undefined>
  /** The release label of the dump: GREMION_RELEASE_REF, the live colour's tag (deps.releaseRef of the lifecycle). */
  release: string
  /** Resolves the module server by the `service` it is handed (the live exporter reads MODULE_PG_ADMIN_<ID>_FILE of that server). */
  exporter: Exporter
  /** The login role the exporter uses on a module server; called only when a dump is really taken. */
  pgUserFor(service: string): string
  pgDumpMajor?(): Promise<number>
  fs?: DumpFs
  now?: () => Date
  /** One line per ledger event. Default stderr: the one-shot's stdout belongs to its verb. */
  audit?: (line: string) => void
}

export interface CatchupDump {
  /** LifecycleDeps.upgradeHooks: built per module, so the dump and its exporter use the module's own server. */
  upgradeHooks: (moduleId: string, postgresService: string) => RunMigrationsHooks | undefined
  /** LifecycleDeps.dumpRetire. */
  retire: DumpRetirer
}

function ownerUidOf(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined || raw === '') return undefined
  if (!/^[0-9]{1,10}$/.test(raw)) return 'invalid'
  const n = Number(raw)
  return isOwnerUid(n) ? n : 'invalid'
}

export function catchupDump(o: CatchupDumpOptions): CatchupDump {
  const dir = o.env.GREMION_MIGRATION_DUMP_DIR
  const rawOwner = o.env.GREMION_MIGRATION_DUMP_OWNER_UID
  const owner = ownerUidOf(rawOwner)
  const audit = o.audit ?? ((l: string) => console.error(l))
  const more = { ...(typeof owner === 'number' ? { ownerUid: owner } : {}), ...(o.fs ? { fs: o.fs } : {}), ...(o.now ? { now: o.now } : {}), audit }
  // No directory configured: nothing could have been taken, so there is nothing to retire (a hook that ran would have refused).
  const configured = typeof dir === 'string' && dir.trim() !== ''
  return {
    upgradeHooks: (_moduleId, postgresService) => {
      let inner: PreApply | undefined
      const preApply: PreApply = async (file, ctx) => {
        if (owner === 'invalid') {
          throw new DumpError('DUMP_DIR_OWNER', 'GREMION_MIGRATION_DUMP_OWNER_UID is not a uid: no pre-migration dump can be taken, so nothing is migrated')
        }
        // built on the first pending file: dumpHook keeps its once-per-run mark in the instance
        inner ??= dumpHook({
          dir,
          release: o.release,
          exporter: o.exporter,
          pgDumpMajor: () => (o.pgDumpMajor ? o.pgDumpMajor() : localPgDumpMajor()),
          service: postgresService,
          pgUser: o.pgUserFor(postgresService),
          // the ledger line says who took it: afterEnable retires the dumps of this origin and no other writer's
          origin: ENABLE_ORIGIN,
          ...more,
        })
        await inner(file, ctx)
      }
      return { preApply }
    },
    retire: {
      async afterEnable(release, database) {
        if (!configured) return
        // Only the dumps of the enable's own origin go: a live dump of the same release and database that another
        // writer took (the host's `take` of a release) belongs to that writer, stays, and is named here, with ids only
        // (the database name is an id, t_<hex>__<module>, never a slug), because it holds the next release's take.
        const r = await retireEnableDumps(dir, release, database, 'enable committed', more)
        for (const id of r.left) {
          audit(`premigration-dump left-live id=${id} release=${release} db=${database} reason="not recorded as taken by this enable"`)
        }
      },
      async afterDrop(database) {
        if (!configured) return
        await retireDatabaseDumps(dir, database, 'database dropped by Karenz', more)
      },
    },
  }
}
