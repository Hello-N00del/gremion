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
//
// Links (safefs.ts): the dump directory is opened once, without following a link, and every name below it is reached
// through that descriptor; the release directory is opened the same way; every file is opened with O_NOFOLLOW and
// checked on its descriptor; ownership and mode change on the descriptor. A link planted by the owner of the directory
// is refused (DUMP_PATH_UNSAFE), never followed, so a root process cannot be made to write, chown or read elsewhere.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, createReadStream, fstatSync, fsyncSync, rmSync, statfsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Exporter } from '../lifecycle/types.js'
import { appendEvent, assertRelease, auditLine, DumpError, dumpFileParts, fsyncDir, liveDumps, readEvents, withLedgerLock, type ByKind, type DumpEvent, type DumpScope, type ENABLE_ORIGIN, type HandOver } from './ledger.js'
import { allowedOwners, anchorDir, assertPlain, handOverFd, madeSince, openChildDir, openNoFollow, SELF_UID, setMode, sizeNoFollow, unsafePath } from './safefs.js'

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
  /**
   * The same facts read from an OPEN descriptor of the directory: the owner and mode asked of the dump directory are then
   * those of the inode that is used, not of whatever the name pointed at a moment earlier. Optional: a stand-in for
   * statDir (a test) that has none is checked by statDir alone.
   */
  fstatDir?(fd: number): { isDirectory: boolean; mode: number; uid: number }
  freeBytes(dir: string): number
  /** This process's uid; undefined where the platform has none (the owner check then refuses). */
  uid: number | undefined
  /**
   * chown(path, uid) leaving the group alone; only a root process with an `ownerUid` ever calls it. A test seam: the
   * default is fchown on a descriptor opened with O_NOFOLLOW, never a chown by name.
   */
  chown?(path: string, uid: number): void
}

export const defaultDumpFs: DumpFs = {
  statDir(dir) {
    const s = statSync(dir)
    return { isDirectory: s.isDirectory(), mode: s.mode & 0o777, uid: s.uid }
  },
  fstatDir(fd) {
    const s = fstatSync(fd)
    return { isDirectory: s.isDirectory(), mode: s.mode & 0o777, uid: s.uid }
  },
  freeBytes(dir) {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  },
  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
}

/** A uid that can own a directory: a non-negative 32-bit integer. */
export function isOwnerUid(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xfffffffe
}

/**
 * The hand-over of a ROOT process (the tenant-create one-shot runs as root, the dump directory belongs to the
 * deploy user): every path it writes goes to `ownerUid` with its mode re-asserted, so the host's
 * gremion-migration-dump status, verify and switched, which run as that user, can read and retire it. undefined
 * (no hand-over at all) for a process that is not root, and when no `ownerUid` is declared.
 *
 * It changes ownership and mode on the descriptor that made the node (fchown, fchmod), never on a name, and it is
 * called only for nodes made in the same call: a node that already stands in the directory is never handed over.
 */
export function handOverFor(fs: DumpFs, ownerUid: number | undefined): HandOver | undefined {
  if (ownerUid === undefined || fs.uid !== 0) return undefined
  const chown = fs.chown ? (p: string, u: number): void => fs.chown!(p, u) : undefined
  return (path, mode, fd) => handOverFd(fd, path, ownerUid, mode, chown)
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
  /**
   * The login role the exporter dumps as on that module server. With a `service` other than `postgres` it is
   * written to the ledger line beside the service (`pg_service`, `pg_user`), which is how the host's `restore`
   * finds the server of a dump (it takes no option). Without it the line names no server.
   */
  pgUser?: string
  /**
   * GREMION_MIGRATION_DUMP_OWNER_UID: the uid that owns the dump directory when this process is root (the
   * tenant-create one-shot). A root process is accepted only on a directory owned by exactly that uid, and
   * hands everything it writes to it; for every other process it is ignored and nothing changes.
   */
  ownerUid?: number
  /** Written to the ledger line (DumpEvent.origin): who took this dump. The enable catch-up sets it; nothing else does. */
  origin?: typeof ENABLE_ORIGIN
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

/** sha256 of a plain file, read from a descriptor opened with O_NOFOLLOW (a link in its place is DUMP_PATH_UNSAFE). */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let fd: number
    try {
      fd = openNoFollow(file, constants.O_RDONLY)
      assertPlain(fd, file, 'file')
    } catch (err) {
      reject(err)
      return
    }
    const h = createHash('sha256')
    createReadStream('', { fd })
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * What a dump file needs before its ledger line: mode 0600, handed over, fsynced, all on one descriptor that is not a
 * link. The file must be this process's own and written since `startedMs`: the exporter made it a moment ago, so a
 * node of another owner, or an older node that was moved into its place, is refused before anything is changed.
 */
function sealFile(file: string, startedMs: number, handOver: HandOver | undefined): void {
  const fd = openNoFollow(file, constants.O_RDWR)
  try {
    const st = assertPlain(fd, file, 'file', SELF_UID === undefined ? undefined : [SELF_UID])
    if (!madeSince(st, startedMs)) throw unsafePath(file, 'is not the file the exporter just wrote')
    setMode(fd, file, 0o600)
    handOver?.(file, 0o600, fd)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The facts of a directory held to the dump directory rules: set aside from checkDumpDir so a descriptor can be held to them too. */
function verifyDirStat(s: { isDirectory: boolean; mode: number; uid: number }, dir: string, fs: DumpFs, ownerUid?: number): void {
  if (!s.isDirectory) throw new DumpError('DUMP_DIR_INVALID', `${dir} is not a directory`)
  if ((s.mode & 0o777) !== 0o700) throw new DumpError('DUMP_DIR_MODE', `${dir} has mode ${(s.mode & 0o777).toString(8).padStart(4, '0')}, want 0700 (the dump holds the whole database in clear)`)
  if (fs.uid === undefined) throw new DumpError('DUMP_DIR_OWNER', `the owner of ${dir} cannot be verified on this platform (no uid)`)
  if (ownerUid !== undefined && !isOwnerUid(ownerUid)) throw new DumpError('DUMP_DIR_OWNER', `the declared owner uid ${String(ownerUid)} is not a uid`)
  if (ownerUid !== undefined && fs.uid === 0) {
    if (s.uid !== ownerUid) throw new DumpError('DUMP_DIR_OWNER', `${dir} is owned by uid ${s.uid}, not by the declared owner uid ${ownerUid} (this process is root and writes only into that owner's directory)`)
    return
  }
  if (s.uid !== fs.uid) throw new DumpError('DUMP_DIR_OWNER', `${dir} is owned by uid ${s.uid}, not by this process (uid ${fs.uid})`)
}

/**
 * The dump dir checks (brief §1 "Never a series"): set, a directory, 0700, owned by this uid. A root process with a
 * declared `ownerUid` is the one exception: the directory must be owned by exactly that uid (anything
 * else, including a directory root owns, is still DUMP_DIR_OWNER), because everything it writes is handed to it.
 */
export function checkDumpDir(dir: string | undefined, fs: DumpFs = defaultDumpFs, ownerUid?: number): string {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new DumpError('DUMP_DIR_UNSET', 'GREMION_MIGRATION_DUMP_DIR is not set: no pre-migration dump can be taken, so nothing is migrated')
  }
  let s: ReturnType<DumpFs['statDir']>
  try {
    s = fs.statDir(dir)
  } catch (err) {
    throw new DumpError('DUMP_DIR_INVALID', `${dir} cannot be read: ${(err as Error).message}`, { cause: err })
  }
  verifyDirStat(s, dir, fs, ownerUid)
  return dir
}

/**
 * The dump directory, checked by name (checkDumpDir) and then OPENED without following a link, with the same rules
 * asked of the open descriptor: every later name is reached through it. Close the anchor when done.
 */
export function anchorDumpDir(dir: string | undefined, fs: DumpFs, ownerUid?: number): ReturnType<typeof anchorDir> {
  const checked = checkDumpDir(dir, fs, ownerUid)
  return anchorDir(checked, fs.fstatDir ? (fd) => verifyDirStat(fs.fstatDir!(fd), checked, fs, ownerUid) : undefined)
}

const DB_FILE_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/

export async function takeDump(o: TakeDumpOptions): Promise<TakenDump> {
  assertRelease(o.release)
  if (typeof o.database !== 'string' || !DB_FILE_PART.test(o.database)) throw new DumpError('DUMP_SCOPE', `database name ${JSON.stringify(o.database)} cannot name a dump file`)
  if (o.scope !== 'platform' && o.scope !== 'customer') throw new DumpError('DUMP_SCOPE', `scope ${JSON.stringify(o.scope)}`)
  if ((o.scope === 'customer') !== Boolean(o.customerId)) throw new DumpError('DUMP_SCOPE', 'a customer-scope dump names its customer_id; a platform dump names none (DB-OPS-MIGRATION-DUMP scope check)')
  const fs = o.fs ?? defaultDumpFs
  const anchor = anchorDumpDir(o.dir, fs, o.ownerUid)
  try {
    return await takeUnder(o, fs, anchor)
  } finally {
    anchor.close()
  }
}

async function takeUnder(o: TakeDumpOptions, fs: DumpFs, anchor: ReturnType<typeof anchorDir>): Promise<TakenDump> {
  // `dir` is the real path (what callers and audit lines see); `adir` is the anchored one every operation uses.
  const dir = o.dir as string
  const adir = anchor.dir
  const handOver = handOverFor(fs, o.ownerUid)
  const owners = allowedOwners(o.ownerUid, fs.uid)
  const server = o.service !== undefined && o.service !== 'postgres' && o.pgUser !== undefined ? { pg_service: o.service, pg_user: o.pgUser } : null
  if (server && (!/^[a-z][a-z0-9]*-postgres$/.test(server.pg_service) || !/^[a-z_][a-z0-9_]{0,62}$/.test(server.pg_user))) {
    throw new DumpError('DUMP_SCOPE', 'the server and role of a module-server dump are not valid names; nothing was dumped or migrated')
  }
  const now = o.now ?? (() => new Date())
  const audit = o.audit ?? ((l: string) => console.log(l))

  return withLedgerLock(adir, async () => {
    const live = liveDumps(readEvents(adir)).filter((e) => e.database === o.database)
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
      const { rel, name } = dumpFileParts(mine)
      const path = join(dir, mine.file!)
      let bytes: number
      let sha256: string
      try {
        const relDir = openChildDir(anchor, rel, { create: false, owners })
        if (relDir === null) throw new Error('the release directory is missing')
        try {
          const anchored = join(relDir.dir, name)
          bytes = sizeNoFollow(anchored)
          sha256 = await sha256OfFile(anchored)
        } finally {
          relDir.close()
        }
      } catch (err) {
        if (err instanceof DumpError) throw err
        throw new DumpError('DUMP_UNVERIFIED', `the ledger's live dump ${mine.migration_dump_id} of ${o.release} is missing on disk (${path}); nothing was migrated`, { cause: err })
      }
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
    const relDir = openChildDir(anchor, o.release, { create: true, owners, ...(handOver ? { handOver } : {}) })!
    try {
      const name = `${o.database}.${id}.dump`
      const file = `${o.release}/${name}`
      const path = join(relDir.dir, name)
      const startedMs = Date.now()
      try {
        await o.exporter.dump({ service: o.service ?? 'postgres', database: o.database }, path)
      } catch (err) {
        rmSync(path, { force: true })
        throw new DumpError('PG_DUMP_FAILED', `pg_dump of ${o.database} failed: ${(err as Error).message}; the partial file was removed, nothing was migrated`, { cause: err })
      }
      try {
        sealFile(path, startedMs, handOver)
        fsyncDir(relDir.dir)
        fsyncDir(adir)
        const bytes = sizeNoFollow(path)
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
          ...server,
          ...(o.origin ? { origin: o.origin } : {}),
        }
        appendEvent(adir, event, handOver)
        audit(auditLine(event))
        return { status: 'created', id, path: join(dir, file), sha256, bytes }
      } catch (err) {
        rmSync(path, { force: true })
        if (err instanceof DumpError) throw err
        throw new DumpError('DUMP_UNVERIFIED', `the dump of ${o.database} could not be verified: ${(err as Error).message}; it was removed, nothing was migrated`, { cause: err })
      }
    } finally {
      relDir.close()
    }
  }, handOver)
}
