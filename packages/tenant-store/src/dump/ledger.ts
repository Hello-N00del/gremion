// packages/tenant-store/src/dump/ledger.ts
//
// TASK-075 (TRD-206, Q1): the durable record of every pre-migration dump.
// `<dir>/ledger.jsonl` is append-only, one JSON object per line, fsynced after
// every line (file and directory). Its fields map 1:1 onto
// DB-OPS-MIGRATION-DUMP (SCHEMA ~2602), which TASK-086 imports it into:
//
//   migration_dump_id  uuidv7
//   release            the deployment release ref (dist-vX.Y.Z | import-<job>);
//                      TASK-086 resolves it to deployment_release_id
//   scope              'platform' | 'customer'
//   customer_id        the tenant id (customer scope), else null
//   module_id          the module id (catalogue id; TASK-086 maps it), else null
//   dump_taken_at      created only
//   deleted_at         deleted only (switched | discard)
//   restored           restored only (true)
//   by_kind            created_by_kind / updated_by_kind: 'system' | 'operator'
//
// plus what the host needs to find and check the file (database, file, sha256,
// bytes) and why a dump went (reason). Ids only: no person, no row content.
//
// Two writers share the file: this module (cli.ts migrate/take) and the host's
// infra/host/bin/gremion-migration-dump (bash). Both take `<dir>/ledger.lock`
// with O_EXCL before they read-then-append, and both REFUSE on an existing
// lock (a stale lock is an operator decision, never auto-broken).
import { closeSync, constants, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DumpError, type DumpErrorCode } from './errors.js'
import { assertPlain, openNoFollow, readTextNoFollow, SELF_UID } from './safefs.js'

// The error type lives in errors.ts (safefs.ts needs it too); these two names keep every importer of this file working.
export { DumpError }
export type { DumpErrorCode }

export const LEDGER_FILE = 'ledger.jsonl'
export const LEDGER_LOCK = 'ledger.lock'
/** logger(1) tag of every event, also on the host (journalctl -t premigration-dump). */
export const AUDIT_TAG = 'premigration-dump'

export type DumpScope = 'platform' | 'customer'
export type ByKind = 'system' | 'operator'

export interface DumpEvent {
  v: 1
  event: 'created' | 'deleted' | 'restored'
  at: string
  migration_dump_id: string
  release: string
  scope: DumpScope
  customer_id: string | null
  module_id: string | null
  database: string
  by_kind: ByKind
  /** created: the dump file, relative to the dump dir (<release>/<db>.<id>.dump). */
  file?: string
  sha256?: string
  bytes?: number
  dump_taken_at?: string
  deleted_at?: string
  restored?: boolean
  /** deleted: 'switched' or the operator's discard reason; restored: the accepted loss window. */
  reason?: string
  /**
   * created, a database on a module server only: the compose service and the login role it was dumped as. The
   * host's `restore` reads the server and the role of a dump from its line and takes no option, so a line
   * without them can only be restored on the main server. Written together or not at all (valid_pg_service and
   * valid_pg_role of infra/host/bin/gremion-migration-dump).
   */
  pg_service?: string
  pg_user?: string
  /**
   * created only, optional: who took the dump. The enable catch-up (a customer switching a module on again inside its
   * Karenz) writes 'enable-catchup'; the host's `take` and the migrate CLI write nothing. The enable retires the dumps
   * of its own origin for a database and release, and leaves any other writer's dump of the same label alone.
   */
  origin?: typeof ENABLE_ORIGIN
}

/**
 * Hands a node that a ROOT process has just made to the owner of the dump directory and sets its mode, on the
 * descriptor that made it (`fd`; `path` names it for tests and messages only). undefined for every process that is
 * not root: it never changes ownership and behaves as it always did.
 */
export type HandOver = (path: string, mode: number, fd: number) => void

/** The `origin` of a dump the enable catch-up took (see DumpEvent.origin). */
export const ENABLE_ORIGIN = 'enable-catchup'

/** Release refs name a directory: 1-64 of [A-Za-z0-9._-], starting alphanumeric. */
export const RELEASE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function assertRelease(release: unknown): asserts release is string {
  if (typeof release !== 'string' || !RELEASE_REF.test(release) || release.includes('..')) {
    throw new DumpError('RELEASE_INVALID', `release ${JSON.stringify(release)} is not 1-64 of [A-Za-z0-9._-] (it names a directory)`)
  }
}

// The file a ledger line names is <release>/<name>.<id>.dump: the host names <name> after the database, or after the
// compose service for a module server. The ledger is a file the deploy user can write, so a line is trusted for nothing
// but this shape: the release is the line's own release, the id its own id, no separator and no dot segment anywhere.
const DUMP_FILE = /^([^/\\]+)\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,62})\.([A-Za-z0-9-]{1,64})\.dump$/

/** The release directory and the file name below it that a ledger line names; LEDGER_CORRUPT for any other shape. */
export function dumpFileParts(e: DumpEvent): { rel: string; name: string } {
  const m = typeof e.file === 'string' ? DUMP_FILE.exec(e.file) : null
  if (!m || m[1] !== e.release || m[3] !== e.migration_dump_id || !RELEASE_REF.test(m[1]!) || m[1]!.includes('..')) {
    throw new DumpError('LEDGER_CORRUPT', `the ledger line of dump ${e.migration_dump_id} names a file that is not <release>/<name>.<id>.dump of its own release and id; it was not touched`)
  }
  return { rel: m[1]!, name: `${m[2]}.${m[3]}.dump` }
}

/** fsync a directory so a created/unlinked entry survives a crash. Windows cannot open a directory: skipped there only. */
export function fsyncDir(dir: string): void {
  let fd: number
  try {
    fd = openSync(dir, 'r')
  } catch (err) {
    if (process.platform === 'win32') return
    throw err
  }
  try {
    fsyncSync(fd)
  } catch (err) {
    if (process.platform !== 'win32') throw err
  } finally {
    closeSync(fd)
  }
}

/**
 * Every event in the ledger, oldest first. A line that does not parse is LEDGER_CORRUPT (never skipped). `owners` are
 * the uids an existing ledger may belong to (allowedOwners): a root-owned file that was moved into its place is not
 * read as the ledger. Without it the owner is not checked (a reader that is not the dump code).
 */
export function readEvents(dir: string, owners?: readonly number[]): DumpEvent[] {
  const file = join(dir, LEDGER_FILE)
  // read through a no-follow open: a link in the ledger's place is refused, never read (root would read what it points at)
  const text = readTextNoFollow(file, owners)
  if (text === null) return []
  const out: DumpEvent[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '') continue
    let e: DumpEvent
    try {
      e = JSON.parse(line) as DumpEvent
    } catch (err) {
      throw new DumpError('LEDGER_CORRUPT', `${file} line ${i + 1} is not JSON`, { cause: err })
    }
    if (typeof e !== 'object' || e === null || typeof e.migration_dump_id !== 'string' || !['created', 'deleted', 'restored'].includes(e.event)) {
      throw new DumpError('LEDGER_CORRUPT', `${file} line ${i + 1} is not a dump event`)
    }
    out.push(e)
  }
  return out
}

/** Dumps with a `created` and no `deleted` event: the live ones. */
export function liveDumps(events: readonly DumpEvent[]): DumpEvent[] {
  const created = new Map<string, DumpEvent>()
  for (const e of events) {
    if (e.event === 'created') created.set(e.migration_dump_id, e)
    else if (e.event === 'deleted') created.delete(e.migration_dump_id)
  }
  return [...created.values()]
}

/**
 * Appends one event and fsyncs the file and its directory before returning. The ledger is opened without following a
 * link and must be a plain file with one link. It is handed over only when this call created it, on the descriptor
 * that created it. An existing ledger is appended to and left alone, but only when it belongs to one of `owners`
 * (allowedOwners): a file of another uid that was moved into its place gets no line. A ledger this call created is
 * this process's own, whatever `owners` says.
 */
export function appendEvent(dir: string, event: DumpEvent, handOver?: HandOver, owners?: readonly number[]): void {
  const file = join(dir, LEDGER_FILE)
  const append = constants.O_WRONLY | constants.O_APPEND
  let fd: number
  let created = false
  try {
    fd = openNoFollow(file, append | constants.O_CREAT | constants.O_EXCL, 0o600)
    created = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    fd = openNoFollow(file, append)
  }
  try {
    assertPlain(fd, file, 'file', created ? (SELF_UID === undefined ? undefined : [SELF_UID]) : owners)
    writeSync(fd, `${JSON.stringify(event)}\n`)
    fsyncSync(fd)
    if (created) handOver?.(file, 0o600, fd)
  } finally {
    closeSync(fd)
  }
  fsyncDir(dir)
}

/**
 * Proves the ledger can take an append, before anything it describes is destroyed. The host's delete_release checks
 * the same first (`-w` and an open for append): a dump file unlinked before a failed append leaves a live ledger line
 * with no file. Call it only while the ledger exists (a live dump is in it); it never creates the file.
 */
export function assertLedgerWritable(dir: string, owners?: readonly number[]): void {
  const file = join(dir, LEDGER_FILE)
  try {
    const fd = openNoFollow(file, constants.O_WRONLY | constants.O_APPEND)
    try {
      assertPlain(fd, file, 'file', owners)
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    if (err instanceof DumpError) throw err
    throw new DumpError('LEDGER_UNWRITABLE', `${file} cannot be opened for append: ${err instanceof Error ? err.message : 'unknown error'}; nothing was unlinked`, { cause: err })
  }
}

/** The one stdout audit line per event (TRD-143): ids, never content. */
export function auditLine(e: DumpEvent): string {
  const parts = [`${AUDIT_TAG}`, e.event, `id=${e.migration_dump_id}`, `release=${e.release}`, `db=${e.database}`]
  if (e.sha256) parts.push(`sha256=${e.sha256}`)
  if (e.bytes !== undefined) parts.push(`bytes=${e.bytes}`)
  if (e.reason) parts.push(`reason=${JSON.stringify(e.reason)}`)
  return parts.join(' ')
}

/**
 * Runs `fn` holding `<dir>/ledger.lock` (O_EXCL). An existing lock refuses:
 * another writer is running, or one died and left it (a stale lock) -- the
 * operator removes it after checking, nothing here breaks it.
 */
export async function withLedgerLock<T>(dir: string, fn: () => Promise<T>, handOver?: HandOver): Promise<T> {
  const lock = join(dir, LEDGER_LOCK)
  let fd: number
  try {
    // O_EXCL: a lock (or a link standing in its place) that exists refuses, nothing is followed
    fd = openNoFollow(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DumpError('LEDGER_LOCKED', `${lock} exists: another dump writer is running, or a stale lock was left (remove it only after checking that none runs); nothing was dumped`, { cause: err })
    }
    throw err
  }
  try {
    try {
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      // on the descriptor that created the lock (O_EXCL): the node handed over is the one made here
      handOver?.(lock, 0o600, fd)
    } finally {
      closeSync(fd)
    }
    return await fn()
  } finally {
    unlinkSync(lock)
  }
}
