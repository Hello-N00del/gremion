// test/receipt-key.store.test.ts -- F1-FIX-05-K (H05 leaf: K4#2, K4#29).
//
// The receipt storage key used to be `finance/expense/<id>/<client filename>`: no
// tenant, no unique part, client-controlled. So (a) a same-name upload overwrote a
// published receipt and deleting its twin deleted it, (b) `../` in the filename
// crossed expense folders, (c) two tenants' expense 1 shared one folder.
//
// The fake storage below behaves like BOTH real backends (local fs and Nextcloud
// WebDAV): a plain key -> bytes store where put() on an existing key replaces the
// bytes and delete() removes whatever sits at the key. The handle is derived from
// the key exactly as the real backends derive it (a prefix + the key).

import { describe, it, expect } from 'vitest'
import {
  uploadReceipt,
  deleteReceipt,
  publishReceipt,
  InvalidReceiptFilenameError,
  type ActorContext,
  type ReceiptUpload,
} from '../src/store/index.ts'
import type { StorageBackend } from '../src/storage/index.ts'
import type { Sql } from '../src/tenant-store.ts'

const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_1 = '11111111-1111-4111-8111-111111111111'
const TENANT_2 = '22222222-2222-4222-8222-222222222222'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/

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

/** Query-aware fake over an in-memory expense_attachment table; every expense id
 *  in `expenses` belongs to OU_A. */
function fakeSql(expenses: string[] = ['1', '2', '7']) {
  const atts = new Map<string, AttRow>()
  let nextId = 100
  const run = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    if (/FROM finance\.expense WHERE id/.test(q)) {
      const id = String(values[0])
      return Promise.resolve(expenses.includes(id) ? [{ id, finance_unit_id: '3' }] : [])
    }
    if (/FROM finance\.finance_unit WHERE id/.test(q)) {
      return Promise.resolve([{ org_unit_id: OU_A }])
    }
    if (/SELECT \* FROM finance\.expense_attachment WHERE id/.test(q)) {
      const row = atts.get(String(values[0]))
      return Promise.resolve(row ? [row] : [])
    }
    if (/INSERT INTO finance\.expense_attachment/.test(q)) {
      const [expenseId, filename, mime, storagePath, ncPath, userId] = values as [
        number, string, string | null, string, null, string,
      ]
      const row: AttRow = {
        id: String(nextId++), expense_id: String(expenseId), kind: 'beleg', filename,
        mime_type: mime, storage_path: storagePath, nextcloud_path: ncPath, uploaded_by: userId,
        published_at: null, created_at: new Date('2026-09-30T10:00:00.000Z'),
      }
      atts.set(row.id, row)
      return Promise.resolve([row])
    }
    if (/UPDATE finance\.expense_attachment SET published_at/.test(q)) {
      const row = atts.get(String(values[1]))
      if (!row) return Promise.resolve([])
      row.published_at = values[0] as Date
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
  return { fn: fn as unknown as Sql, atts }
}

/** Key -> bytes store with the real backends' overwrite-on-put semantics. */
function keyedStorage() {
  const objects = new Map<string, Uint8Array>()
  const keys: string[] = []
  const backend: StorageBackend = {
    async put(relPath, bytes) {
      keys.push(relPath)
      const handle = `store://${relPath}`
      objects.set(handle, bytes)
      return handle
    },
    async read(handle) {
      const b = objects.get(handle)
      if (!b) throw new Error(`missing ${handle}`)
      return b
    },
    async delete(handle) {
      objects.delete(handle)
    },
  }
  return { backend, objects, keys }
}

const WRITER: ActorContext = {
  userId: 'u-writer', groups: [], isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A],
}
const pdf = (fill: number, filename = 'beleg.pdf'): ReceiptUpload => ({
  filename, mimeType: 'application/pdf', bytes: new Uint8Array(8).fill(fill),
})

describe('receipt storage key (H05 leaf)', () => {
  it('two uploads of beleg.pdf to one expense keep BOTH byte sets', async () => {
    const { fn } = fakeSql()
    const { backend, objects } = keyedStorage()
    const a = await uploadReceipt(fn, WRITER, 7, pdf(1), backend, TENANT_1)
    const b = await uploadReceipt(fn, WRITER, 7, pdf(2), backend, TENANT_1)
    expect(a.id).not.toBe(b.id)
    expect(a.filename).toBe('beleg.pdf')
    expect(b.filename).toBe('beleg.pdf')
    // two stored objects, not one overwritten object
    expect(objects.size).toBe(2)
  })

  it('both same-name receipts read back their own bytes; deleting one keeps the other', async () => {
    const { fn, atts } = fakeSql()
    const { backend } = keyedStorage()
    const a = await uploadReceipt(fn, WRITER, 7, pdf(1), backend, TENANT_1)
    const b = await uploadReceipt(fn, WRITER, 7, pdf(2), backend, TENANT_1)
    const pathA = atts.get(String(a.id))!.storage_path
    const pathB = atts.get(String(b.id))!.storage_path
    expect(pathA).not.toBe(pathB)
    expect(await backend.read(pathA)).toEqual(new Uint8Array(8).fill(1))
    expect(await backend.read(pathB)).toEqual(new Uint8Array(8).fill(2))

    await deleteReceipt(fn, WRITER, 7, b.id, backend)
    expect(await backend.read(pathA)).toEqual(new Uint8Array(8).fill(1))
  })

  it("a published receipt's bytes are unchanged by a later same-name upload", async () => {
    const { fn, atts } = fakeSql()
    const { backend } = keyedStorage()
    const published = await uploadReceipt(fn, WRITER, 7, pdf(9), backend, TENANT_1)
    await publishReceipt(fn, WRITER, 7, published.id)
    await uploadReceipt(fn, WRITER, 7, pdf(4), backend, TENANT_1)
    const path = atts.get(String(published.id))!.storage_path
    expect(await backend.read(path)).toEqual(new Uint8Array(8).fill(9))
  })

  it("filename '../2/x.pdf' never reaches the storage key; the key stays under the expense", async () => {
    const { fn, atts } = fakeSql()
    const { backend, keys } = keyedStorage()
    const r = await uploadReceipt(fn, WRITER, 1, pdf(5, '../2/x.pdf'), backend, TENANT_1)
    expect(keys).toHaveLength(1)
    const key = keys[0]!
    expect(key.split('/')).not.toContain('..')
    expect(key.startsWith(`finance/${TENANT_1}/expense/1/`)).toBe(true)
    expect(key.slice(`finance/${TENANT_1}/expense/1/`.length)).not.toContain('/')
    expect(key).not.toContain('x.pdf')
    // the DB keeps a display name only: the basename, never a path
    expect(r.filename).toBe('x.pdf')
    expect(atts.get(String(r.id))!.filename).toBe('x.pdf')
  })

  it('a filename that is only a path or dot segment is refused before any storage write', async () => {
    const { fn } = fakeSql()
    const { backend, keys } = keyedStorage()
    for (const bad of ['..', '.', '../', 'a/..', '', '/']) {
      await expect(uploadReceipt(fn, WRITER, 7, pdf(1, bad), backend, TENANT_1)).rejects.toBeInstanceOf(
        InvalidReceiptFilenameError,
      )
    }
    expect(keys).toHaveLength(0)
  })

  it("two tenants' expense 1 get different keys; each key carries the tenant id and a UUID", async () => {
    const t1 = fakeSql()
    const t2 = fakeSql()
    const { backend, keys } = keyedStorage()
    await uploadReceipt(t1.fn, WRITER, 1, pdf(1), backend, TENANT_1)
    await uploadReceipt(t2.fn, WRITER, 1, pdf(2), backend, TENANT_2)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[0]).toContain(TENANT_1)
    expect(keys[1]).toContain(TENANT_2)
    expect(keys[0]).toMatch(UUID_RE)
    expect(keys[1]).toMatch(UUID_RE)
  })

  it('refuses an unusable tenant id (no path characters can enter the key)', async () => {
    const { fn } = fakeSql()
    const { backend, keys } = keyedStorage()
    for (const bad of ['', '../x', 'a/b', 'a b']) {
      await expect(uploadReceipt(fn, WRITER, 7, pdf(1), backend, bad)).rejects.toThrow(/tenant/)
    }
    expect(keys).toHaveLength(0)
  })
})
