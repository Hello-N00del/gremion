// Module Karenz (phase 2, Task 10): an in-memory stand-in for the tenant pool, just big enough for
// the statements the retained store and the guarded writers issue. Shared by the unit tests of
// crypto.ts and write.ts. It enforces the two database rules the code under test relies on:
// the unique (karenz_id, extractor_id) of retained_record, and the compare-and-swap of
// karenz_rewrap_data_key(); and db.begin() rolls back whatever the callback wrote when it throws.
import { randomUUID } from 'node:crypto'
import type { Sql } from '@gremion/db'

export interface FakeKey {
  key_id: string
  wrapped: Buffer
  kek_version: number
  created_at: number
  retired_at: Date | null
}

export interface FakeRecord {
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

export function fakeTenantDb() {
  let keys: FakeKey[] = []
  let records: FakeRecord[] = []
  let clock = 0
  const statements: string[] = []

  const handle = (text: string, v: unknown[]): unknown[] => {
    statements.push(text)
    if (/has_any_column_privilege/.test(text)) {
      return [{ present: true, can_update: false, can_delete: false, can_truncate: false, key_guard: true }]
    }
    if (/INSERT INTO karenz_data_key/.test(text)) {
      const k: FakeKey = { key_id: randomUUID(), wrapped: v[0] as Buffer, kek_version: v[1] as number, created_at: ++clock, retired_at: null }
      keys.push(k)
      return [{ key_id: k.key_id }]
    }
    if (/INSERT INTO retained_record/.test(text)) {
      const [karenz_id, catalogue_id, retention_class, extractor_id, line_count, plaintext_sha256, key_id, nonce, ciphertext, subject_refs, hold_until] = v as [
        string, string, string, string, number, string, string, Buffer, Buffer, string[], string | null,
      ]
      if (records.some((r) => r.karenz_id === karenz_id && r.extractor_id === extractor_id)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "retained_record_karenz_id_extractor_id_key"'), { code: '23505' })
      }
      const r: FakeRecord = { id: randomUUID(), karenz_id, catalogue_id, retention_class, extractor_id, line_count, plaintext_sha256, key_id, nonce, ciphertext, subject_refs, hold_until }
      records.push(r)
      return [{ id: r.id }]
    }
    if (/karenz_rewrap_data_key/.test(text)) {
      const [keyId, expected, wrapped] = v as [string, number, Buffer]
      const k = keys.find((x) => x.key_id === keyId)
      if (!k || k.kek_version !== expected) return [{ ok: false }]
      k.wrapped = wrapped
      k.kek_version += 1
      return [{ ok: true }]
    }
    if (/FROM karenz_data_key/.test(text) && /retired_at IS NULL/.test(text)) {
      const k = keys.filter((x) => x.retired_at === null).toSorted((a, b) => b.created_at - a.created_at)[0]
      return k ? [{ ...k }] : []
    }
    if (/FROM karenz_data_key/.test(text) && /WHERE key_id =/.test(text)) {
      const k = keys.find((x) => x.key_id === v[0])
      return k ? [{ ...k }] : []
    }
    if (/FROM karenz_data_key/.test(text)) return keys.toSorted((a, b) => a.created_at - b.created_at).map((k) => ({ ...k }))
    if (/FROM retained_record/.test(text) && /extractor_id =/.test(text)) {
      const r = records.find((x) => x.karenz_id === v[0] && x.extractor_id === v[1])
      return r ? [{ id: r.id }] : []
    }
    if (/FROM retained_record/.test(text) && /WHERE id =/.test(text)) {
      const r = records.find((x) => x.id === v[0])
      return r ? [{ ...r }] : []
    }
    throw new Error(`fake tenant db: unexpected statement: ${text}`)
  }

  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => handle(strings.join('?'), values)
  const db = Object.assign(tag, {
    // postgres.js `db.unsafe(...)` fragments are inlined into the text by the real driver; here they are not needed
    unsafe: (s: string) => s,
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const savedKeys = keys.map((k) => ({ ...k }))
      const savedRecords = records.map((r) => ({ ...r }))
      try {
        return await fn(db)
      } catch (err) {
        keys = savedKeys
        records = savedRecords
        throw err
      }
    },
  })

  return {
    db: db as unknown as Sql,
    statements,
    keys: () => keys,
    records: () => records,
  }
}
