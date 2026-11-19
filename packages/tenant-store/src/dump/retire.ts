// packages/tenant-store/src/dump/retire.ts
//
// CD stage 1, unit U6g: the retire of ONE database's live dump. The host program's `switched` and `discard`
// retire every dump of a RELEASE; the enable path (and the day-30 Karenz job) must retire one dump of one
// database, because the host `take` and the ledger's DUMP_SERIES both refuse another live label while any
// dump of the database is live.
//
// It mirrors infra/host/bin/gremion-migration-dump delete_release, under the same ledger lock:
//   1. the live dumps that match (this release and this database; or this database under any release);
//   2. the dump file and the sidecar files the host writes beside it are unlinked and the directory fsynced,
//      and a file that is still there fails the retire (the clear-text copy must really be gone);
//   3. one `deleted` line per dump, fsynced, of the shape the host writes;
//   4. the release directory goes when it is empty.
// A missing file is not an error (a retire that died after the unlink is repeated); no live dump is a no-op.
// A root process hands the ledger to the directory's owner exactly as takeDump does.
import { existsSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { appendEvent, assertRelease, auditLine, DumpError, fsyncDir, liveDumps, readEvents, withLedgerLock, type DumpEvent } from './ledger.js'
import { checkDumpDir, defaultDumpFs, handOverFor, type DumpFs } from './take.js'

export interface RetireOptions {
  /** GREMION_MIGRATION_DUMP_DIR. */
  dir: string | undefined
  database: string
  /** The logged reason, e.g. `enable committed` (the `deleted` line carries it). */
  reason: string
  /** See TakeDumpOptions.ownerUid. */
  ownerUid?: number
  fs?: DumpFs
  now?: () => Date
  /** One stdout line per event (TRD-143). Default console.log. */
  audit?: (line: string) => void
}

export interface RetireResult {
  /** The migration_dump_id of every dump retired, oldest first; empty when none was live. */
  retired: string[]
}

/** The file named by a ledger line, refused when it would leave the dump directory (a ledger edited by hand). */
function dumpPath(dir: string, e: DumpEvent): string {
  const file = e.file
  if (typeof file !== 'string' || file === '' || isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new DumpError('LEDGER_CORRUPT', `the ledger line of dump ${e.migration_dump_id} names a file outside the dump directory; it was not retired`)
  }
  return join(dir, file)
}

async function retireMatching(o: RetireOptions, match: (e: DumpEvent) => boolean): Promise<RetireResult> {
  if (typeof o.reason !== 'string' || o.reason.trim() === '') throw new DumpError('DUMP_SCOPE', 'a retire needs a reason: it is written to the ledger')
  const fs = o.fs ?? defaultDumpFs
  const dir = checkDumpDir(o.dir, fs, o.ownerUid)
  const handOver = handOverFor(fs, o.ownerUid)
  const now = o.now ?? (() => new Date())
  const audit = o.audit ?? ((l: string) => console.log(l))
  return withLedgerLock(
    dir,
    async () => {
      const mine = liveDumps(readEvents(dir)).filter(match)
      const retired: string[] = []
      const releaseDirs = new Set<string>()
      for (const e of mine) {
        const path = dumpPath(dir, e)
        rmSync(path, { force: true })
        rmSync(`${path.replace(/\.dump$/, '')}.acl.json`, { force: true })
        rmSync(`${path.replace(/\.dump$/, '')}.acl.json.tmp`, { force: true })
        fsyncDir(dirname(path))
        fsyncDir(dir)
        if (existsSync(path)) throw new DumpError('DUMP_UNVERIFIED', `the dump ${e.migration_dump_id} still exists after the unlink; its ledger line was not closed`)
        const at = now().toISOString()
        const event: DumpEvent = {
          v: 1,
          event: 'deleted',
          at,
          migration_dump_id: e.migration_dump_id,
          release: e.release,
          scope: e.scope,
          customer_id: e.customer_id,
          module_id: e.module_id,
          database: e.database,
          by_kind: 'system',
          ...(e.file !== undefined ? { file: e.file } : {}),
          deleted_at: at,
          reason: o.reason,
          ...(e.pg_service !== undefined ? { pg_service: e.pg_service } : {}),
          ...(e.pg_user !== undefined ? { pg_user: e.pg_user } : {}),
        }
        appendEvent(dir, event, handOver)
        audit(auditLine(event))
        retired.push(e.migration_dump_id)
        releaseDirs.add(dirname(path))
      }
      for (const d of releaseDirs) {
        if (d === dir || !d.startsWith(`${dir}${sep}`)) continue
        try {
          rmdirSync(d)
        } catch {
          // not empty (another database's dump of that release) or already gone: both are fine
        }
      }
      return { retired }
    },
    handOver,
  )
}

/**
 * Retires the live dump of `database` that `release` took, if there is one. The one-database counterpart of the
 * host's `switched` and `discard`: a dump of another release or another database is never touched.
 */
export async function retireDump(dir: string | undefined, release: string, database: string, reason: string, more: Omit<RetireOptions, 'dir' | 'database' | 'reason'> = {}): Promise<RetireResult> {
  assertRelease(release)
  return retireMatching({ dir, database, reason, ...more }, (e) => e.database === database && e.release === release)
}

/**
 * Retires every live dump of `database`, whatever release took it. For a database that is gone (the day-30 job
 * dropped it): the Karenz row carries no release label, and the job may run under a later release than the one
 * that took the dump, so a retire keyed on the current release would silently do nothing.
 */
export async function retireDatabaseDumps(dir: string | undefined, database: string, reason: string, more: Omit<RetireOptions, 'dir' | 'database' | 'reason'> = {}): Promise<RetireResult> {
  return retireMatching({ dir, database, reason, ...more }, (e) => e.database === database)
}
