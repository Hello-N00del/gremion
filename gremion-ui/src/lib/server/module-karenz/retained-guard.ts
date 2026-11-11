// src/lib/server/module-karenz/retained-guard.ts
// Module Karenz (phase 2): the guarded write path of the sealed retained copies.
//
// retained_record is a write-once table: the app role holds SELECT and INSERT and
// nothing else, which is a REVOKE that tenant-store applies at provisioning and on
// reconcile (audit-append-only.ts). Migration 0064 only creates the table; on a tenant
// that was provisioned before this table existed the boot migration runs as the app
// role, so the table is writable by that role until the next reconcile revokes it. A
// copy written in that window could be rewritten or removed by a stray statement, which
// is exactly what a "read-only copy" must rule out.
//
// So every write of a retained copy (and of the data key it is sealed under) goes
// through here, and refuses unless the guard is in place for the CURRENT role:
//   - retained_record: the role holds no UPDATE (table or any column), DELETE or TRUNCATE
//     (has_*_privilege sees role membership and PUBLIC, so the owner role counts);
//   - karenz_data_key: the row guard trigger of 0064 exists and is enabled, so the wrapped
//     key of every sealed copy cannot be overwritten or removed except by
//     karenz_rewrap_data_key().
// The check runs once per process and database (a passing result is cached; a failing one
// is not, so the first write after reconcile goes through). An in-flight check is shared.
//
// The data key is replaced ONLY by rewrapDataKey() below, which calls the SQL function;
// nothing in this module issues a bare UPDATE of karenz_data_key.
import type { Sql } from '@gremion/db'

export class RetainedGuardError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(
      `retained copies are not written while the append-only guard is missing (${problems.join('; ')}); ` +
        'reconcile applies it, then the next pass writes them',
    )
    this.name = 'RetainedGuardError'
    this.problems = problems
  }
}

export interface RetainedGuardDeps {
  /** Replaces the probe (a suite that runs as a superuser, which holds every privilege, passes a no-op). */
  guard?: (db: Sql) => Promise<void>
}

interface ProbeRow {
  present: boolean
  can_update: boolean | null
  can_delete: boolean | null
  can_truncate: boolean | null
  key_guard: boolean
}

const verified = new Set<string>()
const inflight = new Map<string, Promise<void>>()

/** Forget every cached result (tests; also useful after a tenant database is re-provisioned in-process). */
export function resetRetainedGuardCache(): void {
  verified.clear()
  inflight.clear()
}

/** The database and role the pool is connected as, from its options (no query). Null when unknown: then nothing is cached. */
function cacheKey(db: Sql): string | null {
  const o = (db as unknown as { options?: { database?: unknown; user?: unknown; host?: unknown; port?: unknown } }).options
  if (!o || typeof o.database !== 'string' || typeof o.user !== 'string') return null
  return JSON.stringify([o.host ?? null, o.port ?? null, o.database, o.user])
}

async function probe(db: Sql): Promise<void> {
  const [r] = await db<ProbeRow[]>`
    SELECT t.oid IS NOT NULL AS present,
           pg_catalog.has_any_column_privilege(t.oid, 'UPDATE') AS can_update,
           pg_catalog.has_table_privilege(t.oid, 'DELETE') AS can_delete,
           pg_catalog.has_table_privilege(t.oid, 'TRUNCATE') AS can_truncate,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_trigger g
              WHERE g.tgrelid = pg_catalog.to_regclass('karenz_data_key')
                AND g.tgname = 'karenz_data_key_guard_trg'
                AND g.tgenabled = 'O'
                AND NOT g.tgisinternal
           ) AS key_guard
      FROM (SELECT pg_catalog.to_regclass('retained_record') AS oid) t`
  const problems: string[] = []
  if (!r || !r.present) {
    problems.push('retained_record: the table does not exist (migration 0064 has not run)')
  } else {
    if (r.can_update) problems.push('retained_record: the role can still UPDATE')
    if (r.can_delete) problems.push('retained_record: the role can still DELETE')
    if (r.can_truncate) problems.push('retained_record: the role can still TRUNCATE')
  }
  if (!r || !r.key_guard) problems.push('karenz_data_key: the row guard trigger karenz_data_key_guard_trg is missing or disabled')
  if (problems.length) throw new RetainedGuardError(problems)
}

/**
 * Throws RetainedGuardError unless retained_record is append-only for the pool's role and
 * the key-row guard of karenz_data_key is in place. Checked once per process and database.
 */
export async function assertRetainedAppendOnly(db: Sql): Promise<void> {
  const key = cacheKey(db)
  if (key === null) return probe(db)
  if (verified.has(key)) return
  let p = inflight.get(key)
  if (!p) {
    p = probe(db)
      .then(() => {
        verified.add(key)
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, p)
  }
  return p
}

export interface RetainedRecordInsert {
  karenzId: string
  catalogueId: string
  retentionClass: string
  extractorId: string
  lineCount: number
  plaintextSha256: string
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
  /** The hashed subjectRef values of the persons in the lines, never the ids. */
  subjectRefs: string[]
  holdUntil: string | null
}

/** Insert one sealed copy. Refuses (RetainedGuardError) unless the append-only guard is in place. Returns the new id. */
export async function insertRetainedRecord(db: Sql, r: RetainedRecordInsert, deps: RetainedGuardDeps = {}): Promise<string> {
  await (deps.guard ?? assertRetainedAppendOnly)(db)
  const rows = await db<{ id: string }[]>`
    INSERT INTO retained_record
      (karenz_id, catalogue_id, retention_class, extractor_id, line_count, plaintext_sha256, key_id, nonce, ciphertext, subject_refs, hold_until)
    VALUES
      (${r.karenzId}, ${r.catalogueId}, ${r.retentionClass}, ${r.extractorId}, ${r.lineCount}, ${r.plaintextSha256}, ${r.keyId},
       ${r.nonce}, ${r.ciphertext}, ${r.subjectRefs}, ${r.holdUntil})
    RETURNING id`
  return rows[0]!.id
}

/** Insert a wrapped data key. Refuses unless the guard is in place (a key nobody can protect is not minted). Returns the key id. */
export async function insertDataKey(db: Sql, wrapped: Buffer, kekVersion = 1, deps: RetainedGuardDeps = {}): Promise<string> {
  await (deps.guard ?? assertRetainedAppendOnly)(db)
  const rows = await db<{ key_id: string }[]>`
    INSERT INTO karenz_data_key (wrapped, kek_version) VALUES (${wrapped}, ${kekVersion}) RETURNING key_id`
  return rows[0]!.key_id
}

/**
 * The AUTH_SECRET rotation step for ONE key: replace `wrapped` with a value wrapped under the
 * new key-encryption key. Compare-and-swap on the version the caller read: true when the key was
 * at `expectedKekVersion` and is now one version higher, false when another writer got there
 * first (nothing changed). The only writer of karenz_data_key.wrapped.
 */
export async function rewrapDataKey(db: Sql, keyId: string, expectedKekVersion: number, newWrapped: Buffer): Promise<boolean> {
  const rows = await db<{ ok: boolean }[]>`
    SELECT karenz_rewrap_data_key(${keyId}::uuid, ${expectedKekVersion}::integer, ${newWrapped}) AS ok`
  return rows[0]!.ok === true
}
