// test/lane-e2.integration.test.ts — #383 Lane E2 (R7) value-parity suite against a
// REAL disposable Postgres + a REAL storage backend (local-fs AND a MOCK WebDAV server —
// NEVER the live Nextcloud). Full HTTP round-trips (guard → router → handler → PG +
// storage) for the receipts trio:
//   - uploadReceipt — multipart/form-data (the exact FormData the ACL client sends),
//     10 MiB cap (413), pdf/jpeg/png allow-list (415), §11 write-scope (403), the opaque
//     storage handle persisted in expense_attachment.storage_path, byte round-trip via
//     the SAME backend read (local fs OR the mock WebDAV GET).
//   - deleteReceipt — removes the storage object + the row; published → 409; 404 anti-probe.
//   - publishReceipt — stamps published_at (idempotent); then delete is refused (409).
//
// NB the API GET /receipts (listReceipts) reads finance.receipt (the §3.4 paper-trail
// header), which is DECOUPLED from finance.expense_attachment (the uploaded files) — a
// faithfully-preserved native quirk (services/read/receipt.ts vs write/receipt-storage.ts).
// The byte round-trip is therefore asserted through the storage backend, not that read.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer as createHttp, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { getStorage, resetStorageForTest } from '../src/storage/index.ts'
import { storeFor, _resetTenantStoreForTests, type TenantRef, type Sql } from '../src/tenant-store.ts'

// ── fail-closed ephemeral-PG guard (mirrors lane-e3.integration.test.ts) ────────
const TEST_DB_PREFIX = 'finance_test_'
const TEST_PG_URL = (() => {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED — refusing to default to localhost:5432 ' +
        '(the LIVE staging Postgres). Start a throwaway container on a NON-5432 port, e.g. :55436.',
    )
  }
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" — refusing.`)
  }
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error('[fin-test-guard] SAFETY VIOLATION: port 5432 (or implicit default) is the live Postgres — refusing.')
  }
  return url
})()

const SECRET = 'lane-e2-secret'
const TENANT: TenantRef = { id: 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2', slug: 'lanee2' }
const BASE_HEADERS = { 'x-internal-auth': SECRET, 'x-tenant-id': TENANT.id, 'x-tenant-slug': TENANT.slug }
const OU_1 = 'e1111111-aaaa-4aaa-8aaa-e11111111111'
const OU_2 = 'e2222222-bbbb-4bbb-8bbb-e22222222222'

/** WRITE actor headers (member scoped to `orgUnits`). */
const writer = (orgUnits: string[], userId = 'u-writer'): Record<string, string> => ({
  ...BASE_HEADERS,
  'x-finance-user-id': userId,
  'x-finance-is-auditor': 'false',
  'x-finance-is-superuser': 'false',
  ...(orgUnits.length > 0 ? { 'x-finance-scoped-org-units': orgUnits.join(',') } : {}),
})

/** Build the exact multipart FormData the ACL client's uploadReceipt sends. */
const receiptForm = (bytes: Uint8Array, name: string, type: string): FormData => {
  const f = new FormData()
  f.append('file', new File([bytes], name, { type }))
  return f
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 253, 254, 255]) // "%PDF" + binary tail

describe('finance leaf — Lane E2 receipts trio (real PG)', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  let sql: Sql
  let expenseA = '' // in OU_1's finance_unit
  const savedEnv = { ...process.env }

  beforeAll(async () => {
    await _resetTenantStoreForTests()
    sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    await sql`TRUNCATE finance.expense_attachment, finance.receipt, finance.expense,
              finance.finance_unit RESTART IDENTITY CASCADE`
    const fu = async (ou: string) => (await sql<{ id: string }[]>`
      INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
      VALUES (${ou}, 'standard', 'own', 'carry_forward') RETURNING id`)[0]!.id
    const fuA = await fu(OU_1)
    await fu(OU_2) // OU_2 exists but owns no expense (scope lens)
    expenseA = (await sql<{ id: string }[]>`
      INSERT INTO finance.expense (finance_unit_id, payee_name, payment_method)
      VALUES (${fuA}, 'ACME GmbH', 'bank_transfer') RETURNING id`)[0]!.id
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await _resetTenantStoreForTests()
    process.env = { ...savedEnv }
    resetStorageForTest()
  })

  const storagePathOf = async (attachmentId: number): Promise<string> =>
    (await sql<{ storage_path: string }[]>`
      SELECT storage_path FROM finance.expense_attachment WHERE id = ${attachmentId}`)[0]!.storage_path

  // The shared behaviour matrix, parametrised over the storage backend. `setup` sets the
  // env + resets the storage singleton so the SAME server exercises the chosen backend.
  function receiptSuite(label: string, setup: () => void | Promise<void>) {
    describe(label, () => {
      beforeAll(async () => { await setup(); resetStorageForTest() })

      it('upload → persist handle → byte round-trip (download) → delete', async () => {
        // UPLOAD
        const res = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts`, {
          method: 'POST', headers: writer([OU_1]), body: receiptForm(PDF_BYTES, 'beleg.pdf', 'application/pdf'),
        })
        expect(res.status, await res.clone().text()).toBe(200)
        const receipt = await res.json()
        expect(receipt).toMatchObject({
          expense_id: Number(expenseA), filename: 'beleg.pdf', mime_type: 'application/pdf',
          nextcloud_path: null, published_at: null, uploaded_by_id: 'u-writer',
        })
        expect(typeof receipt.id).toBe('number')

        // PERSISTED HANDLE + BYTE ROUND-TRIP via the real storage backend read.
        const handle = await storagePathOf(receipt.id)
        expect(handle.length).toBeGreaterThan(0)
        const readBack = await getStorage().read(handle)
        expect(Buffer.from(readBack)).toEqual(Buffer.from(PDF_BYTES)) // exact bytes

        // LIST (paper-trail read, decoupled from attachments — a native quirk): 200 array.
        const list = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts`, { headers: writer([OU_1]) })
        expect(list.status).toBe(200)
        expect(Array.isArray(await list.json())).toBe(true)

        // DELETE → 200; row gone; storage object gone.
        const del = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts/${receipt.id}`, {
          method: 'DELETE', headers: writer([OU_1]),
        })
        expect(del.status, await del.clone().text()).toBe(200)
        const rows = await sql`SELECT id FROM finance.expense_attachment WHERE id = ${receipt.id}`
        expect(rows.length).toBe(0)
        await expect(getStorage().read(handle)).rejects.toBeTruthy() // object removed
      })

      it('publish stamps published_at (idempotent) and then delete is refused (409)', async () => {
        const up = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts`, {
          method: 'POST', headers: writer([OU_1]), body: receiptForm(PDF_BYTES, 'q.png', 'image/png'),
        })
        const { id } = await up.json()

        const pub = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts/${id}/publish`, {
          method: 'POST', headers: writer([OU_1]),
        })
        expect(pub.status).toBe(200)
        const published = await pub.json()
        expect(published.published_at).not.toBeNull()

        // idempotent: same published_at on a second call.
        const pub2 = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts/${id}/publish`, {
          method: 'POST', headers: writer([OU_1]),
        })
        expect((await pub2.json()).published_at).toBe(published.published_at)

        // published attachment is immutable → delete 409.
        const del = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts/${id}`, {
          method: 'DELETE', headers: writer([OU_1]),
        })
        expect(del.status).toBe(409)
      })

      it('oversize → 413, wrong mime → 415', async () => {
        const big = new Uint8Array(10 * 1024 * 1024 + 1)
        const over = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts`, {
          method: 'POST', headers: writer([OU_1]), body: receiptForm(big, 'big.pdf', 'application/pdf'),
        })
        expect(over.status).toBe(413)

        const bad = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts`, {
          method: 'POST', headers: writer([OU_1]), body: receiptForm(new Uint8Array([1, 2]), 'x.gif', 'image/gif'),
        })
        expect(bad.status).toBe(415)
      })

      it('out-of-scope member → 403; unknown expense → 404', async () => {
        const forbidden = await fetch(`${base}/api/v1/expenses/${expenseA}/receipts`, {
          method: 'POST', headers: writer([OU_2]), body: receiptForm(PDF_BYTES, 'x.pdf', 'application/pdf'),
        })
        expect(forbidden.status).toBe(403)

        const missing = await fetch(`${base}/api/v1/expenses/999999/receipts`, {
          method: 'POST', headers: writer([OU_1]), body: receiptForm(PDF_BYTES, 'x.pdf', 'application/pdf'),
        })
        expect(missing.status).toBe(404)
      })
    })
  }

  // ── Backend A: local filesystem ────────────────────────────────────────────
  let localDir = ''
  receiptSuite('STORAGE_BACKEND=local (filesystem)', () => {
    localDir = mkdtempSync(join(tmpdir(), 'lane-e2-local-'))
    process.env.STORAGE_BACKEND = 'local'
    process.env.RECEIPT_STORAGE_DIR = localDir
  })

  // ── Backend B: Nextcloud WebDAV against an in-process MOCK server ───────────
  let mockNc: Server
  let mockFiles: Map<string, Buffer>
  let mockAuthSeen = false
  let mockImpersonateSeen = false
  receiptSuite('STORAGE_BACKEND=nextcloud (mock WebDAV server)', async () => {
    mockFiles = new Map<string, Buffer>()
    mockNc = createHttp((req, res) => {
      // Assert the leaf client's auth posture: admin Basic + X-Nextcloud-User impersonation.
      if ((req.headers.authorization ?? '').startsWith('Basic ')) mockAuthSeen = true
      else { res.writeHead(401).end(); return }
      if (req.headers['x-nextcloud-user'] === 'admin') mockImpersonateSeen = true
      const path = req.url ?? ''
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        switch (req.method) {
          case 'MKCOL':
            res.writeHead(201); res.end(); return
          case 'PUT':
            mockFiles.set(path, Buffer.concat(chunks)); res.writeHead(201); res.end(); return
          case 'GET': {
            const b = mockFiles.get(path)
            if (!b) { res.writeHead(404); res.end(); return }
            res.writeHead(200, { 'content-length': String(b.byteLength) }); res.end(b); return
          }
          case 'DELETE':
            if (!mockFiles.has(path)) { res.writeHead(404); res.end(); return }
            mockFiles.delete(path); res.writeHead(204); res.end(); return
          default:
            res.writeHead(405); res.end()
        }
      })
    })
    await new Promise<void>((resolve) => mockNc.listen(0, '127.0.0.1', resolve))
    const port = (mockNc.address() as AddressInfo).port
    process.env.STORAGE_BACKEND = 'nextcloud'
    process.env.NEXTCLOUD_URL = `http://127.0.0.1:${port}`
    process.env.NEXTCLOUD_ADMIN_USER = 'admin'
    process.env.NEXTCLOUD_ADMIN_PASSWORD = 'mock-admin-pass'
    process.env.STORAGE_NEXTCLOUD_USER = 'admin'
  })

  it('the mock WebDAV path exercised admin-Basic auth + X-Nextcloud-User impersonation', () => {
    expect(mockAuthSeen).toBe(true)
    expect(mockImpersonateSeen).toBe(true)
  })

  afterAll(() => {
    if (mockNc) mockNc.close()
    if (localDir) rmSync(localDir, { recursive: true, force: true })
  })
})
