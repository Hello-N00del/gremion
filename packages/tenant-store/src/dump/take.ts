// packages/tenant-store/src/dump/take.ts
//
// TASK-075 (TRD-206): takeDump -- ONE custom-format dump of the database a
// migration (or a member import, TASK-031) is about to alter, taken before
// anything is changed, recorded in ledger.jsonl, and kept until the release
// that needed it has switched (gremion-migration-dump switched) or an operator
// discards it. Never a series: a live dump of ANOTHER release for the same
// database refuses (DUMP_SERIES); the same release reuses its live dump.
//
// Order (every refusal happens before pg_dump runs, so before any DDL):
//   1. release ref and dump dir: set, a directory, mode 0700, owned by this uid;
//   2. under <dir>/ledger.lock: the ledger's live dumps for this database
//      (another release -> DUMP_SERIES; this release -> reused);
//   3. pg_dump major >= the server's major (PG_DUMP_VERSION);
//   4. free space >= 1.2 x pg_database_size (DUMP_SPACE);
//   5. pg_dump -Fc (TASK-021's pgDumpExporter) to <dir>/<release>/<db>.<id>.dump,
//      0600 in a 0700 directory; a non-zero exit removes the partial file;
//   6. fsync the file and both directories, bytes > 0, pg_restore --list names
//      the database, sha256;
//   7. append `created` (fsynced) and print one audit line.
import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, createReadStream, fsyncSync, mkdirSync, openSync, rmSync, statSync, statfsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Exporter } from '../lifecycle/types.js'
import { appendEvent, assertRelease, auditLine, DumpError, fsyncDir, liveDumps, readEvents, withLedgerLock, type ByKind, type DumpEvent, type DumpScope } from './ledger.js'

/** Free space must be at least this multiple of pg_database_size (brief §1). */
export const SPACE_FACTOR = 1.2

export interface DumpProbe {
  /** The server's major version (server_version_num / 10000). */
  serverMajor(): Promise<number>
  /** pg_database_size of the database, in bytes. */
  databaseBytes(): Promise<number>
  /** The major version of the pg_dump the exporter runs. */
  pgDumpMajor(): Promise<number>
}

export interface DumpFs {
  statDir(dir: string): { isDirectory: boolean; mode: number; uid: number }
  freeBytes(dir: string): number
  /** This process's uid; undefined where the platform has none (the owner check then refuses). */
  uid: number | undefined
}

export const defaultDumpFs: DumpFs = {
  statDir(dir) {
    const s = statSync(dir)
    return { isDirectory: s.isDirectory(), mode: s.mode & 0o777, uid: s.uid }
  },
  freeBytes(dir) {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  },
  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
}

export interface TakeDumpOptions {
  /** GREMION_MIGRATION_DUMP_DIR: 0700, owned by the running uid. */
  dir: string | undefined
  release: string
  database: string
  scope: DumpScope
  customerId?: string | null
  moduleId?: string | null
  /** TASK-021's pgDumpExporter (or a fake in unit tests). */
  exporter: Exporter
  /** ExportTarget.service handed to the exporter (compose service name). Default 'postgres'. */
  service?: string
  probe: DumpProbe
  fs?: DumpFs
  byKind?: ByKind
  now?: () => Date
  /** One stdout line per event (TRD-143). Default console.log. */
  audit?: (line: string) => void
}

export interface TakenDump {
  status: 'created' | 'reused'
  id: string
  path: string
  sha256: string
  bytes: number
}

/** RFC 9562 UUIDv7: 48-bit ms timestamp, version 7, variant 10. */
export function uuidv7(now: Date = new Date()): string {
  const b = randomBytes(16)
  const ms = BigInt(now.getTime())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The dump dir checks (brief §1 "Never a series"): set, a directory, 0700, owned by this uid. */
export function checkDumpDir(dir: string | undefined, fs: DumpFs = defaultDumpFs): string {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new DumpError('DUMP_DIR_UNSET', 'GREMION_MIGRATION_DUMP_DIR is not set: no pre-migration dump can be taken, so nothing is migrated')
  }
  let s: ReturnType<DumpFs['statDir']>
  try {
    s = fs.statDir(dir)
  } catch (err) {
    throw new DumpError('DUMP_DIR_INVALID', `${dir} cannot be read: ${(err as Error).message}`, { cause: err })
  }
  if (!s.isDirectory) throw new DumpError('DUMP_DIR_INVALID', `${dir} is not a directory`)
  if ((s.mode & 0o777) !== 0o700) throw new DumpError('DUMP_DIR_MODE', `${dir} has mode ${(s.mode & 0o777).toString(8).padStart(4, '0')}, want 0700 (the dump holds the whole database in clear)`)
  if (fs.uid === undefined) throw new DumpError('DUMP_DIR_OWNER', `the owner of ${dir} cannot be verified on this platform (no uid)`)
  if (s.uid !== fs.uid) throw new DumpError('DUMP_DIR_OWNER', `${dir} is owned by uid ${s.uid}, not by this process (uid ${fs.uid})`)
  return dir
}

const DB_FILE_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/

export async function takeDump(o: TakeDumpOptions): Promise<TakenDump> {
  assertRelease(o.release)
  if (typeof o.database !== 'string' || !DB_FILE_PART.test(o.database)) throw new DumpError('DUMP_SCOPE', `database name ${JSON.stringify(o.database)} cannot name a dump file`)
  if (o.scope !== 'platform' && o.scope !== 'customer') throw new DumpError('DUMP_SCOPE', `scope ${JSON.stringify(o.scope)}`)
  if ((o.scope === 'customer') !== Boolean(o.customerId)) throw new DumpError('DUMP_SCOPE', 'a customer-scope dump names its customer_id; a platform dump names none (DB-OPS-MIGRATION-DUMP scope check)')
  const fs = o.fs ?? defaultDumpFs
  const dir = checkDumpDir(o.dir, fs)
  const now = o.now ?? (() => new Date())
  const audit = o.audit ?? ((l: string) => console.log(l))

  return withLedgerLock(dir, async () => {
    const live = liveDumps(readEvents(dir)).filter((e) => e.database === o.database)
    const foreign = live.filter((e) => e.release !== o.release)
    if (foreign.length) {
      const f = foreign[0]!
      throw new DumpError(
        'DUMP_SERIES',
        `database ${o.database} still has the live dump ${f.migration_dump_id} of release ${f.release} (${f.file}); a second release's dump would start a series. Resolve it first: gremion-migration-dump restore --release ${f.release} --db ${o.database} --accept-loss-since <time>, or gremion-migration-dump discard --release ${f.release} --reason <text>; nothing was dumped or migrated`,
      )
    }
    const mine = live.find((e) => e.release === o.release)
    if (mine) {
      const path = join(dir, mine.file!)
      let bytes: number
      try {
        bytes = statSync(path).size
      } catch (err) {
        throw new DumpError('DUMP_UNVERIFIED', `the ledger's live dump ${mine.migration_dump_id} of ${o.release} is missing on disk (${path}); nothing was migrated`, { cause: err })
      }
      const sha256 = await sha256OfFile(path)
      if (sha256 !== mine.sha256 || bytes !== mine.bytes) {
        throw new DumpError('DUMP_UNVERIFIED', `the live dump ${mine.migration_dump_id} of ${o.release} no longer matches its ledger sha256/bytes (${path}); nothing was migrated`)
      }
      audit(`${auditLine({ ...mine, at: now().toISOString() }).replace(' created ', ' reused ')}`)
      return { status: 'reused', id: mine.migration_dump_id, path, sha256, bytes }
    }

    const [serverMajor, pgDumpMajor, dbBytes] = await Promise.all([o.probe.serverMajor(), o.probe.pgDumpMajor(), o.probe.databaseBytes()])
    if (!Number.isInteger(pgDumpMajor) || !Number.isInteger(serverMajor) || pgDumpMajor < serverMajor) {
      throw new DumpError('PG_DUMP_VERSION', `pg_dump ${pgDumpMajor} is older than the server (${serverMajor}): it cannot dump it faithfully; nothing was dumped or migrated`)
    }
    const free = fs.freeBytes(dir)
    const need = Math.ceil(SPACE_FACTOR * dbBytes)
    if (!(free >= need)) {
      throw new DumpError('DUMP_SPACE', `${dir} has ${free} bytes free, the dump of ${o.database} needs ${need} (${SPACE_FACTOR} x pg_database_size ${dbBytes}); nothing was dumped or migrated`)
    }

    const takenAt = now()
    const id = uuidv7(takenAt)
    const relDir = o.release
    const releaseDir = join(dir, relDir)
    mkdirSync(releaseDir, { recursive: true, mode: 0o700 })
    chmodSync(releaseDir, 0o700)
    const file = `${relDir}/${o.database}.${id}.dump`
    const path = join(dir, file)
    try {
      await o.exporter.dump({ service: o.service ?? 'postgres', database: o.database }, path)
    } catch (err) {
      rmSync(path, { force: true })
      throw new DumpError('PG_DUMP_FAILED', `pg_dump of ${o.database} failed: ${(err as Error).message}; the partial file was removed, nothing was migrated`, { cause: err })
    }
    try {
      chmodSync(path, 0o600)
      fsyncFile(path)
      fsyncDir(releaseDir)
      fsyncDir(dir)
      const bytes = statSync(path).size
      if (bytes <= 0) throw new Error('the dump is empty (0 bytes)')
      const toc = await o.exporter.list(path)
      if (!/^; Archive created at /m.test(toc) || !new RegExp(`^;\\s+dbname: ${o.database.replace(/[.]/g, '\\.')}$`, 'm').test(toc)) {
        throw new Error(`pg_restore --list does not describe a dump of ${o.database}`)
      }
      const sha256 = await sha256OfFile(path)
      const event: DumpEvent = {
        v: 1,
        event: 'created',
        at: takenAt.toISOString(),
        migration_dump_id: id,
        release: o.release,
        scope: o.scope,
        customer_id: o.scope === 'customer' ? (o.customerId ?? null) : null,
        module_id: o.moduleId ?? null,
        database: o.database,
        by_kind: o.byKind ?? 'system',
        file,
        sha256,
        bytes,
        dump_taken_at: takenAt.toISOString(),
      }
      appendEvent(dir, event)
      audit(auditLine(event))
      return { status: 'created', id, path, sha256, bytes }
    } catch (err) {
      rmSync(path, { force: true })
      if (err instanceof DumpError) throw err
      throw new DumpError('DUMP_UNVERIFIED', `the dump of ${o.database} could not be verified: ${(err as Error).message}; it was removed, nothing was migrated`, { cause: err })
    }
  })
}
