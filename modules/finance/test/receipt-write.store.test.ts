// test/receipt-write.store.test.ts — mocked-PG + fake-storage unit test for the
// receipt WRITE domain (#383 Lane E2 / R7): uploadReceipt / deleteReceipt /
// publishReceipt. Mirrors the native oracle services/write/receipt-storage.ts:
//   - the 10 MiB cap + pdf/jpeg/png mime allow-list (byte-identical messages),
//   - the §11 org-unit write-scope gate (assertOrgUnitWritable) resolved via the
//     expense → finance_unit → org_unit chain,
//   - the published-immutable delete refusal,
//   - the opaque storage handle round-trip (storage_path holds the backend handle,
//     nextcloud_path stays NULL), and the ExpenseAttachment → Receipt DTO mapping.
//
// The storage backend is a fake (records put/delete + keeps bytes) — NO real I/O.

import { describe, it, expect } from 'vitest'
import {
  uploadReceipt,
  deleteReceipt,
  publishReceipt,
  ReceiptTooLargeError,
  ReceiptMimeError,
  ReceiptNotFoundError,
  ReceiptImmutableError,
  AccessDeniedError,
  type ActorContext,
  type ReceiptUpload,
} from '../src/store/index.ts'
import type { StorageBackend } from '../src/storage/index.ts'
import type { Sql } from '../src/tenant-store.ts'

const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// expense 7 → finance_unit 3 (OU_A); expense 8 → finance_unit 4 (OU_B); 999 → absent.
const EXPENSE_FU: Record<string, string> = { '7': '3', '8': '4' }
const FU_OU: Record<string, string> = { '3': OU_A, '4': OU_B }

interface AttRow {
  id: string
  expense_id: string
  kind: string
  filename: string
  mime_type: string | null
  storage_path: string
  nextcloud_path: string | null
  uploaded_by: string | null
  published_at: Date | null
  created_at: Date
}

/** A query-aware fake postgres-js Sql over an in-memory expense_attachment table. */
function fakeSql(seed: AttRow[] = []) {
  const atts = new Map<string, AttRow>(seed.map((a) => [a.id, a]))
  let nextId = 100
  const calls: string[] = []
  const run = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push(q)
    if (/FROM finance\.expense WHERE id/.test(q)) {
      const id = String(values[0])
      return Promise.resolve(EXPENSE_FU[id] ? [{ id, finance_unit_id: EXPENSE_FU[id] }] : [])
    }
    if (/FROM finance\.finance_unit WHERE id/.test(q)) {
      const fu = String(values[0])
      return Promise.resolve(FU_OU[fu] ? [{ org_unit_id: FU_OU[fu] }] : [])
    }
    if (/SELECT \* FROM finance\.expense_attachment WHERE id/.test(q)) {
      const row = atts.get(String(values[0]))
      return Promise.resolve(row ? [row] : [])
    }
    if (/INSERT INTO finance\.expense_attachment/.test(q)) {
      // VALUES (${expenseId}, 'beleg', ${filename}, ${mime}, ${storagePath}, ${null}, ${userId})
      const [expenseId, filename, mime, storagePath, ncPath, userId] = values as [number, string, string | null, string, null, string]
      const row: AttRow = {
        id: String(nextId++),
        expense_id: String(expenseId),
        kind: 'beleg',
        filename,
        mime_type: mime,
        storage_path: storagePath,
        nextcloud_path: ncPath,
        uploaded_by: userId,
        published_at: null,
        created_at: new Date('2026-04-01T10:00:00.000Z'),
      }
      atts.set(row.id, row)
      return Promise.resolve([row])
    }
    if (/UPDATE finance\.expense_attachment SET published_at/.test(q)) {
      const publishedAt = values[0] as Date
      const id = String(values[1])
      const row = atts.get(id)
      if (!row) return Promise.resolve([])
      row.published_at = publishedAt
      return Promise.resolve([row])
    }
    if (/DELETE FROM finance\.expense_attachment WHERE id/.test(q)) {
      atts.delete(String(values[0]))
      return Promise.resolve([])
    }
    return Promise.resolve([])
  }
  const fn = run as unknown as Sql & { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }
  ;(fn as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (cb) => cb(fn)
  return { fn: fn as unknown as Sql, atts, calls }
}

/** A fake StorageBackend: records puts/deletes + keeps the bytes for round-trip. */
function fakeStorage() {
  const objects = new Map<string, Uint8Array>()
  const puts: Array<{ relPath: string; bytes: Uint8Array }> = []
  const deletes: string[] = []
  const backend: StorageBackend = {
    async put(relPath, bytes) {
      const handle = `fake://${relPath}`
      objects.set(handle, bytes)
      puts.push({ relPath, bytes })
      return handle
    },
    async read(handle) {
      const b = objects.get(handle)
      if (!b) throw new Error(`fake storage: missing ${handle}`)
      return b
    },
    async delete(handle) {
      deletes.push(handle)
      objects.delete(handle)
    },
  }
  return { backend, objects, puts, deletes }
}

const WRITER_A: ActorContext = { userId: 'u-writer', groups: [], isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
const OUTSIDER: ActorContext = { userId: 'u-out', groups: [], isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_B] }
const AUDITOR: ActorContext = { userId: 'u-aud', groups: [], isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }
const SUPERUSER: ActorContext = { userId: 'u-su', groups: [], isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [] }

const pdf = (n = 16): ReceiptUpload => ({ filename: 'beleg.pdf', mimeType: 'application/pdf', bytes: new Uint8Array(n).fill(7) })

describe('receipt write — uploadReceipt (cap / mime / handle / scope)', () => {
  it('rejects a file over 10 MiB with the native message (ReceiptTooLargeError → 413)', async () => {
    const { fn } = fakeSql()
    const { backend, puts } = fakeStorage()
    const over = 10 * 1024 * 1024 + 1
    const big: ReceiptUpload = { filename: 'big.pdf', mimeType: 'application/pdf', bytes: new Uint8Array(over) }
    await expect(uploadReceipt(fn, WRITER_A, 7, big, backend)).rejects.toBeInstanceOf(ReceiptTooLargeError)
    // rejected BEFORE any storage write (no orphaned object).
    expect(puts.length).toBe(0)
  })

  it('rejects a mime outside pdf/jpeg/png (ReceiptMimeError → 415)', async () => {
    const { fn } = fakeSql()
    const { backend, puts } = fakeStorage()
    const bad: ReceiptUpload = { filename: 'x.gif', mimeType: 'image/gif', bytes: new Uint8Array(4) }
    await expect(uploadReceipt(fn, WRITER_A, 7, bad, backend)).rejects.toBeInstanceOf(ReceiptMimeError)
    expect(puts.length).toBe(0)
  })

  it('404s an absent expense before storing (ReceiptNotFoundError)', async () => {
    const { fn } = fakeSql()
    const { backend, puts } = fakeStorage()
    await expect(uploadReceipt(fn, AUDITOR, 999, pdf(), backend)).rejects.toBeInstanceOf(ReceiptNotFoundError)
    expect(puts.length).toBe(0)
  })

  it('403s an out-of-scope non-superuser (AccessDeniedError) before storing', async () => {
    const { fn } = fakeSql()
    const { backend, puts } = fakeStorage()
    // expense 7 → OU_A; OUTSIDER is scoped to OU_B only.
    await expect(uploadReceipt(fn, OUTSIDER, 7, pdf(), backend)).rejects.toBeInstanceOf(AccessDeniedError)
    expect(puts.length).toBe(0)
  })

  it('happy path: stores bytes at finance/expense/<id>/<name>, inserts row, returns the Receipt DTO', async () => {
    const { fn, atts } = fakeSql()
    const { backend, puts, objects } = fakeStorage()
    const file = pdf(16)
    const receipt = await uploadReceipt(fn, WRITER_A, 7, file, backend)
    // storage put with the native relPath convention + exact bytes.
    expect(puts).toEqual([{ relPath: 'finance/expense/7/beleg.pdf', bytes: file.bytes }])
    // opaque handle persisted in storage_path; nextcloud_path NULL.
    const stored = [...atts.values()][0]!
    expect(stored.storage_path).toBe('fake://finance/expense/7/beleg.pdf')
    expect(stored.nextcloud_path).toBeNull()
    expect(stored.kind).toBe('beleg')
    // byte round-trip: the handle reads back the exact bytes.
    expect(await backend.read(stored.storage_path)).toEqual(file.bytes)
    expect(objects.size).toBe(1)
    // DTO shape (ExpenseAttachment → Receipt): uploaded_by → uploaded_by_id, ISO-Z created_at.
    expect(receipt).toEqual({
      id: Number(stored.id),
      expense_id: 7,
      filename: 'beleg.pdf',
      mime_type: 'application/pdf',
      nextcloud_path: null,
      published_at: null,
      uploaded_by_id: 'u-writer',
      created_at: '2026-04-01T10:00:00.000Z',
    })
  })

  it('superuser bypasses the write-scope gate (empty scope)', async () => {
    const { fn } = fakeSql()
    const { backend, puts } = fakeStorage()
    const receipt = await uploadReceipt(fn, SUPERUSER, 8, pdf(), backend) // expense 8 → OU_B, not in scope
    expect(receipt.expense_id).toBe(8)
    expect(puts.length).toBe(1)
  })
})

describe('receipt write — deleteReceipt (immutable / scope / storage delete)', () => {
  const seedUnpublished = (): AttRow => ({
    id: '1', expense_id: '7', kind: 'beleg', filename: 'a.pdf', mime_type: 'application/pdf',
    storage_path: 'fake://finance/expense/7/a.pdf', nextcloud_path: null, uploaded_by: 'u',
    published_at: null, created_at: new Date('2026-04-01T10:00:00.000Z'),
  })

  it('404s an absent attachment (ReceiptNotFoundError)', async () => {
    const { fn } = fakeSql([])
    const { backend } = fakeStorage()
    await expect(deleteReceipt(fn, WRITER_A, 7, 99, backend)).rejects.toBeInstanceOf(ReceiptNotFoundError)
  })

  it('404s an attachment that belongs to a DIFFERENT expense (anti-probing)', async () => {
    const { fn } = fakeSql([seedUnpublished()])
    const { backend } = fakeStorage()
    await expect(deleteReceipt(fn, WRITER_A, 8, 1, backend)).rejects.toBeInstanceOf(ReceiptNotFoundError)
  })

  it('409s a PUBLISHED attachment (immutable audit trail)', async () => {
    const published: AttRow = { ...seedUnpublished(), id: '2', published_at: new Date('2026-04-02T00:00:00.000Z') }
    const { fn } = fakeSql([published])
    const { backend, deletes } = fakeStorage()
    await expect(deleteReceipt(fn, WRITER_A, 7, 2, backend)).rejects.toBeInstanceOf(ReceiptImmutableError)
    expect(deletes.length).toBe(0) // storage untouched
  })

  it('403s an out-of-scope actor (AccessDeniedError)', async () => {
    const { fn } = fakeSql([seedUnpublished()])
    const { backend, deletes } = fakeStorage()
    await expect(deleteReceipt(fn, OUTSIDER, 7, 1, backend)).rejects.toBeInstanceOf(AccessDeniedError)
    expect(deletes.length).toBe(0)
  })

  it('happy path: removes the storage object AND the DB row', async () => {
    const { fn, atts } = fakeSql([seedUnpublished()])
    const { backend, deletes } = fakeStorage()
    await deleteReceipt(fn, WRITER_A, 7, 1, backend)
    expect(deletes).toEqual(['fake://finance/expense/7/a.pdf'])
    expect(atts.has('1')).toBe(false)
  })
})

describe('receipt write — publishReceipt (stamp / idempotent / scope)', () => {
  const seedUnpublished = (): AttRow => ({
    id: '1', expense_id: '7', kind: 'beleg', filename: 'a.pdf', mime_type: 'application/pdf',
    storage_path: 'fake://x', nextcloud_path: null, uploaded_by: 'u',
    published_at: null, created_at: new Date('2026-04-01T10:00:00.000Z'),
  })

  it('404s an absent / mismatched attachment', async () => {
    const { fn } = fakeSql([seedUnpublished()])
    await expect(publishReceipt(fn, WRITER_A, 7, 99)).rejects.toBeInstanceOf(ReceiptNotFoundError)
    await expect(publishReceipt(fn, WRITER_A, 8, 1)).rejects.toBeInstanceOf(ReceiptNotFoundError)
  })

  it('403s an out-of-scope actor', async () => {
    const { fn } = fakeSql([seedUnpublished()])
    await expect(publishReceipt(fn, OUTSIDER, 7, 1)).rejects.toBeInstanceOf(AccessDeniedError)
  })

  it('stamps published_at and returns the DTO with an ISO-Z published_at', async () => {
    const { fn, atts } = fakeSql([seedUnpublished()])
    const before = Date.now()
    const receipt = await publishReceipt(fn, WRITER_A, 7, 1)
    expect(receipt.published_at).not.toBeNull()
    expect(Date.parse(receipt.published_at!)).toBeGreaterThanOrEqual(before)
    expect(atts.get('1')!.published_at).toBeInstanceOf(Date)
  })

  it('is idempotent: a second call returns the already-published row with NO new UPDATE', async () => {
    const publishedAt = new Date('2026-04-02T09:00:00.000Z')
    const already: AttRow = { ...seedUnpublished(), published_at: publishedAt }
    const { fn, calls } = fakeSql([already])
    const receipt = await publishReceipt(fn, WRITER_A, 7, 1)
    expect(receipt.published_at).toBe('2026-04-02T09:00:00.000Z')
    expect(calls.some((q) => /UPDATE finance\.expense_attachment/.test(q))).toBe(false)
  })
})
