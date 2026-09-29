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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const LEDGER_FILE = 'ledger.jsonl'
export const LEDGER_LOCK = 'ledger.lock'
/** logger(1) tag of every event, also on the host (journalctl -t premigration-dump). */
export const AUDIT_TAG = 'premigration-dump'

export type DumpErrorCode =
  | 'RELEASE_INVALID'
  | 'DUMP_DIR_UNSET'
  | 'DUMP_DIR_INVALID'
  | 'DUMP_DIR_MODE'
  | 'DUMP_DIR_OWNER'
  | 'DUMP_SERIES'
  | 'DUMP_SPACE'
  | 'PG_DUMP_VERSION'
  | 'PG_DUMP_FAILED'
  | 'DUMP_UNVERIFIED'
  | 'DUMP_SCOPE'
  | 'LEDGER_LOCKED'
  | 'LEDGER_CORRUPT'

export class DumpError extends Error {
  override name = 'DumpError'
  code: DumpErrorCode
  constructor(code: DumpErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options)
    this.code = code
  }
}

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
}

/** Release refs name a directory: 1-64 of [A-Za-z0-9._-], starting alphanumeric. */
export const RELEASE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function assertRelease(release: unknown): asserts release is string {
  if (typeof release !== 'string' || !RELEASE_REF.test(release) || release.includes('..')) {
    throw new DumpError('RELEASE_INVALID', `release ${JSON.stringify(release)} is not 1-64 of [A-Za-z0-9._-] (it names a directory)`)
  }
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

/** Every event in the ledger, oldest first. A line that does not parse is LEDGER_CORRUPT (never skipped). */
export function readEvents(dir: string): DumpEvent[] {
  const file = join(dir, LEDGER_FILE)
  if (!existsSync(file)) return []
  const out: DumpEvent[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
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

/** Appends one event and fsyncs the file and its directory before returning. */
export function appendEvent(dir: string, event: DumpEvent): void {
  const fd = openSync(join(dir, LEDGER_FILE), 'a', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  fsyncDir(dir)
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
export async function withLedgerLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, LEDGER_LOCK)
  let fd: number
  try {
    fd = openSync(lock, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DumpError('LEDGER_LOCKED', `${lock} exists: another dump writer is running, or a stale lock was left (remove it only after checking that none runs); nothing was dumped`, { cause: err })
    }
    throw err
  }
  try {
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
  } finally {
    closeSync(fd)
  }
  try {
    return await fn()
  } finally {
    unlinkSync(lock)
  }
}
