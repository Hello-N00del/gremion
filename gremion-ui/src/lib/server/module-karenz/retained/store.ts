// src/lib/server/module-karenz/retained/store.ts
// Module Karenz (phase 2, Task 10): the READ side of the sealed copies (tables retained_record and
// karenz_data_key of migration 0064). Every function takes the tenant pool and only SELECTs.
//
// Writing a copy or a data key is NOT done here: the only writers are insertRetainedRecord,
// insertDataKey and rewrapDataKey in ../retained-guard.ts, which refuse unless the append-only guard
// of the tables is in place for the current role.
import type { Sql } from '@gremion/db'

/** One row of karenz_data_key: the per-tenant data key, wrapped by the key-encryption key. */
export interface DataKeyRow {
  keyId: string
  wrapped: Buffer
  kekVersion: number
}

/** One row of retained_record, ciphertext included. */
export interface RetainedRecordRow {
  id: string
  karenzId: string
  catalogueId: string
  retentionClass: string
  extractorId: string
  lineCount: number
  plaintextSha256: string
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
  /** The hashed subjectRef values of the persons in the lines (never the ids). */
  subjectRefs: string[]
  holdUntil: string | null
}

interface KeyDb {
  key_id: string
  wrapped: Buffer
  kek_version: number
}

interface RecordDb {
  id: string
  karenz_id: string
  catalogue_id: string
  retention_class: string
  extractor_id: string
  line_count: number
  plaintext_sha256: string
  key_id: string
  nonce: Buffer
  ciphertext: Buffer
  subject_refs: string[]
  hold_until: string | null
}

const toKey = (r: KeyDb): DataKeyRow => ({ keyId: r.key_id, wrapped: Buffer.from(r.wrapped), kekVersion: r.kek_version })

const toRecord = (r: RecordDb): RetainedRecordRow => ({
  id: r.id,
  karenzId: r.karenz_id,
  catalogueId: r.catalogue_id,
  retentionClass: r.retention_class,
  extractorId: r.extractor_id,
  lineCount: r.line_count,
  plaintextSha256: r.plaintext_sha256,
  keyId: r.key_id,
  nonce: Buffer.from(r.nonce),
  ciphertext: Buffer.from(r.ciphertext),
  subjectRefs: r.subject_refs ?? [],
  holdUntil: r.hold_until,
})

/** The id of the copy this extractor already wrote for this Karenz row, or null. */
export async function retainedRecordIdFor(db: Sql, karenzId: string, extractorId: string): Promise<string | null> {
  const rows = await db<{ id: string }[]>`
    SELECT id FROM retained_record
     WHERE karenz_id = ${karenzId} AND extractor_id = ${extractorId}`
  return rows[0]?.id ?? null
}

/** The tenant's current data key (the newest one that is not retired), or null when none was minted yet. */
export async function activeDataKey(db: Sql): Promise<DataKeyRow | null> {
  const rows = await db<KeyDb[]>`
    SELECT key_id, wrapped, kek_version FROM karenz_data_key
     WHERE retired_at IS NULL
     ORDER BY created_at DESC, key_id DESC
     LIMIT 1`
  return rows[0] ? toKey(rows[0]) : null
}

/** One data key by id, or null. */
export async function getDataKey(db: Sql, keyId: string): Promise<DataKeyRow | null> {
  const rows = await db<KeyDb[]>`
    SELECT key_id, wrapped, kek_version FROM karenz_data_key
     WHERE key_id = ${keyId}`
  return rows[0] ? toKey(rows[0]) : null
}

/** Every data key of the tenant, retired ones included (a retired key still opens the copies sealed under it). */
export async function listDataKeys(db: Sql): Promise<DataKeyRow[]> {
  const rows = await db<KeyDb[]>`
    SELECT key_id, wrapped, kek_version FROM karenz_data_key
     ORDER BY created_at, key_id`
  return rows.map(toKey)
}

/** One sealed copy by id, or null. */
export async function getRetainedRecord(db: Sql, id: string): Promise<RetainedRecordRow | null> {
  const rows = await db<RecordDb[]>`
    SELECT id, karenz_id, catalogue_id, retention_class, extractor_id, line_count, plaintext_sha256,
           key_id, nonce, ciphertext, subject_refs, hold_until::text AS hold_until
      FROM retained_record
     WHERE id = ${id}`
  return rows[0] ? toRecord(rows[0]) : null
}
