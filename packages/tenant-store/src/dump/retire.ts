// packages/tenant-store/src/dump/retire.ts
//
// CD stage 1, unit U6g: the retire of ONE database's live dump. The host program's `switched` and `discard`
// retire every dump of a RELEASE; the enable path (and the day-30 Karenz job) must retire one dump of one
// database, because the host `take` and the ledger's DUMP_SERIES both refuse another live label while any
// dump of the database is live.
//
// It mirrors infra/host/bin/gremion-migration-dump delete_release, under the same ledger lock:
//   1. the live dumps that match (this release and this database; or this database under any release; or exactly
//      the dump ids named);
//   1b. the ledger must take an append (LEDGER_UNWRITABLE) BEFORE anything is unlinked, as the host checks first;
//   2. the dump file and the sidecar files the host writes beside it are unlinked and the directory fsynced,
//      and a file that is still there fails the retire (the clear-text copy must really be gone);
//   3. one `deleted` line per dump, fsynced, of the shape the host writes;
//   4. the release directory goes when it is empty.
// A missing file is not an error (a retire that died after the unlink is repeated); no live dump is a no-op.
// A root process hands the ledger to the directory's owner exactly as takeDump does.
//
// Links (safefs.ts): the ledger is a file the deploy user can write, and this runs as root. A ledger line is trusted
// for the shape <release>/<name>.<id>.dump of its own release and id and for nothing else; the dump directory and the
// release directory are opened without following a link and every unlink goes through those descriptors, so no ledger
// line and no planted link can make a retire remove a file elsewhere.
import { lstatSync, rmdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, assertLedgerWritable, assertRelease, auditLine, DumpError, dumpFileParts, fsyncDir, liveDumps, readEvents, withLedgerLock, type DumpEvent } from './ledger.js'
import { allowedOwners, openChildDir } from './safefs.js'
import { anchorDumpDir, defaultDumpFs, handOverFor, type DumpFs } from './take.js'

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

async function retireMatching(o: RetireOptions, match: (e: DumpEvent) => boolean): Promise<RetireResult> {
  if (typeof o.reason !== 'string' || o.reason.trim() === '') throw new DumpError('DUMP_SCOPE', 'a retire needs a reason: it is written to the ledger')
  const fs = o.fs ?? defaultDumpFs
  const anchor = anchorDumpDir(o.dir, fs, o.ownerUid)
  const adir = anchor.dir
  const handOver = handOverFor(fs, o.ownerUid)
  const owners = allowedOwners(o.ownerUid)
  const now = o.now ?? (() => new Date())
  const audit = o.audit ?? ((l: string) => console.log(l))
  try {
    return await withLedgerLock(
      adir,
      async () => {
        const mine = liveDumps(readEvents(adir)).filter(match)
        const retired: string[] = []
        const releaseDirs = new Set<string>()
        // every line is checked before anything is unlinked: a line of another shape refuses the whole retire
        const parts = mine.map((e) => dumpFileParts(e))
        // the host does this first too: the `deleted` line must be writable BEFORE a file is unlinked
        if (mine.length > 0) assertLedgerWritable(adir)
        for (const [i, e] of mine.entries()) {
          const { rel, name } = parts[i]!
          const relDir = openChildDir(anchor, rel, { create: false, owners })
          if (relDir !== null) {
            try {
              const path = join(relDir.dir, name)
              rmSync(path, { force: true })
              rmSync(`${path.replace(/\.dump$/, '')}.acl.json`, { force: true })
              rmSync(`${path.replace(/\.dump$/, '')}.acl.json.tmp`, { force: true })
              fsyncDir(relDir.dir)
              fsyncDir(adir)
              // lstat semantics: whatever now stands at that name (a link included) means the unlink did not do its job
              if (existsNoFollow(path)) throw new DumpError('DUMP_UNVERIFIED', `the dump ${e.migration_dump_id} still exists after the unlink; its ledger line was not closed`)
            } finally {
              relDir.close()
            }
          }
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
          appendEvent(adir, event, handOver)
          audit(auditLine(event))
          retired.push(e.migration_dump_id)
          releaseDirs.add(rel)
        }
        for (const rel of releaseDirs) {
          try {
            rmdirSync(join(adir, rel))
          } catch {
            // not empty (another database's dump of that release) or already gone: both are fine
          }
        }
        return { retired }
      },
      handOver,
    )
  } finally {
    anchor.close()
  }
}

/** True when anything, a link included, stands at `path` (lstat, never the target). */
function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
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
 * Retires exactly the live dumps whose ids are named, and only while each is still a live dump of `database` and
 * `release`. For a caller that took a dump itself and must retire that one and nothing else: a live dump of the same
 * database and release that another writer took (the host's `take`, an earlier run) is never touched.
 */
export async function retireDumpsById(dir: string | undefined, release: string, database: string, ids: readonly string[], reason: string, more: Omit<RetireOptions, 'dir' | 'database' | 'reason'> = {}): Promise<RetireResult> {
  assertRelease(release)
  const wanted = new Set(ids)
  return retireMatching({ dir, database, reason, ...more }, (e) => wanted.has(e.migration_dump_id) && e.database === database && e.release === release)
}

/**
 * Retires every live dump of `database`, whatever release took it. For a database that is gone (the day-30 job
 * dropped it): the Karenz row carries no release label, and the job may run under a later release than the one
 * that took the dump, so a retire keyed on the current release would silently do nothing.
 */
export async function retireDatabaseDumps(dir: string | undefined, database: string, reason: string, more: Omit<RetireOptions, 'dir' | 'database' | 'reason'> = {}): Promise<RetireResult> {
  return retireMatching({ dir, database, reason, ...more }, (e) => e.database === database)
}
