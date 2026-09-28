// services/vault/test/api.integration.test.ts
//
// Integration tests for services/vault/src/http/routes.ts. Each test drives an
// in-process node:http server backed by a REAL vault leaf store on an EPHEMERAL,
// isolated Postgres (VAULT_TEST_PG_URL). A fail-closed guard refuses to run unless
// the host is localhost/127.0.0.1 on a non-5432 port — a test run can NEVER touch
// the live staging stack. The test creates + drops its own vault_test_api database.
//
// Core contract proved here (acceptance):
//   * items list / get / create responses carry NO secret (plaintext or ciphertext).
//   * GET /items/:id/secret decrypts the stored blob back to the ORIGINAL plaintext
//     AND writes exactly one access_log row per reveal.
import http from 'node:http'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { runMigrations, type Sql } from '../src/store/index.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

// -- fail-closed guard --------------------------------------------------------

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'vault_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TEST_DB = 'vault_test_api'
const TEST_SECRET = 'test-vault-secret-123'
// Fixed 32-byte (64-hex) AES-256-GCM key for the suite.
const TEST_KEY = Buffer.from('1'.repeat(64), 'hex')

function dbUrlFor(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/' + dbName
  return u.toString()
}

// -- HTTP helpers -------------------------------------------------------------

const TENANT = { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', slug: 'vaulttenant' }
const ACTOR = 'user-actor-42'

// org_unit_id is UUID, so fixtures MUST use real UUIDs, not readable slugs.
const OU1 = '11111111-1111-1111-1111-111111111111'
const OU2 = '22222222-2222-2222-2222-222222222222'
const MISSING_UUID = '00000000-0000-0000-0000-000000000000'

function guardHeaders(): Record<string, string> {
  return {
    'x-internal-auth': TEST_SECRET,
    'x-tenant-id': TENANT.id,
    'x-tenant-slug': TENANT.slug,
    'x-vault-user-id': ACTOR,
    'content-type': 'application/json',
  }
}

/** Guard headers WITHOUT the caller user-id — for the anonymous-reveal negative test. */
function headersNoActor(): Record<string, string> {
  const h = guardHeaders()
  delete h['x-vault-user-id']
  return h
}

interface FetchResult {
  status: number
  body: unknown
}

async function callServer(
  srv: http.Server,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<FetchResult> {
  const addr = srv.address()
  if (!addr || typeof addr === 'string') throw new Error('server not listening')
  const port = addr.port
  return new Promise<FetchResult>((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// -- setup --------------------------------------------------------------------

let admin: Sql
let sql: Sql
let server: http.Server

async function dropTestDb(pgSql: Sql): Promise<void> {
  await pgSql
    .unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()`)
    .catch(() => {})
  await pgSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`)
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropTestDb(admin)
  await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`)

  const testUrl = dbUrlFor(TEST_PG_URL, TEST_DB)
  await runMigrations(testUrl)
  sql = postgres(testUrl, { max: 4, prepare: true })

  const routes = buildApiRoutes(() => Promise.resolve(sql), TEST_KEY)
  server = createServer({ secret: TEST_SECRET, routes })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end().catch(() => {})
  await dropTestDb(admin)
  await admin.end()
})

beforeEach(async () => {
  await sql`DELETE FROM access_log`
  await sql`DELETE FROM vault_item`
})

async function seedItem(over: Record<string, unknown> = {}): Promise<{ id: string }> {
  const r = await callServer(server, 'POST', '/items', guardHeaders(), {
    orgUnitId: OU1,
    name: 'WiFi',
    secret: 'hunter2',
    createdBy: 'u1',
    ...over,
  })
  expect(r.status).toBe(201)
  return { id: (r.body as { id: string }).id }
}

// -- health (guard-exempt) ----------------------------------------------------

describe('health probes (guard-exempt)', () => {
  it('GET /health returns 200 without any auth headers', async () => {
    const r = await callServer(server, 'GET', '/health', {})
    expect(r.status).toBe(200)
    expect((r.body as Record<string, unknown>)['status']).toBe('ok')
  })
  it('GET /healthz returns 200 without any auth headers', async () => {
    const r = await callServer(server, 'GET', '/healthz', {})
    expect(r.status).toBe(200)
    expect((r.body as Record<string, unknown>)['status']).toBe('ok')
  })
})

// -- guard --------------------------------------------------------------------

describe('guard', () => {
  it('returns 403 without x-internal-auth', async () => {
    const r = await callServer(server, 'GET', '/items', { 'x-tenant-id': TENANT.id, 'x-tenant-slug': TENANT.slug })
    expect(r.status).toBe(403)
  })
  it('returns 400 with missing x-tenant-id', async () => {
    const r = await callServer(server, 'GET', '/items', { 'x-internal-auth': TEST_SECRET, 'x-tenant-slug': TENANT.slug })
    expect(r.status).toBe(400)
  })
})

// -- create / list / get: NO secret ever leaves in the metadata surface -------

describe('POST /items', () => {
  it('creates an item (201) and the response carries NO secret field', async () => {
    const r = await callServer(server, 'POST', '/items', guardHeaders(), {
      orgUnitId: OU1,
      name: 'Router admin',
      secret: 'p@ss',
      username: 'admin',
      createdBy: 'u1',
    })
    expect(r.status).toBe(201)
    const item = r.body as Record<string, unknown>
    expect(item['name']).toBe('Router admin')
    expect(item['username']).toBe('admin')
    expect(Object.keys(item)).not.toContain('secret')
    expect(Object.keys(item)).not.toContain('secret_ciphertext')
  })

  it('returns 400 on a missing secret', async () => {
    const r = await callServer(server, 'POST', '/items', guardHeaders(), { orgUnitId: OU1, name: 'x' })
    expect(r.status).toBe(400)
  })

  it('returns 400 on a missing name', async () => {
    const r = await callServer(server, 'POST', '/items', guardHeaders(), { orgUnitId: OU1, secret: 'x' })
    expect(r.status).toBe(400)
  })
})

describe('GET /items', () => {
  it('lists only items in the requested org-unit scope, with NO secret field', async () => {
    await seedItem({ orgUnitId: OU1, name: 'A', secret: 's1' })
    await seedItem({ orgUnitId: OU2, name: 'B', secret: 's2' })
    const r = await callServer(server, 'GET', `/items?orgUnitId=${OU1}`, guardHeaders())
    expect(r.status).toBe(200)
    const data = (r.body as { data: Record<string, unknown>[] }).data
    expect(data).toHaveLength(1)
    expect(data[0]!['org_unit_id']).toBe(OU1)
    // The core contract: the list surface never carries the secret.
    for (const item of data) {
      expect(Object.keys(item)).not.toContain('secret')
      expect(Object.keys(item)).not.toContain('secret_ciphertext')
    }
  })

  it('returns [] when no org-unit scope is passed', async () => {
    await seedItem()
    const r = await callServer(server, 'GET', '/items', guardHeaders())
    expect(r.status).toBe(200)
    expect((r.body as { data: unknown[] }).data).toEqual([])
  })
})

describe('GET /items/:id', () => {
  it('returns an item by id with NO secret field', async () => {
    const { id } = await seedItem()
    const r = await callServer(server, 'GET', `/items/${id}`, guardHeaders())
    expect(r.status).toBe(200)
    const item = r.body as Record<string, unknown>
    expect(item['id']).toBe(id)
    expect(Object.keys(item)).not.toContain('secret')
    expect(Object.keys(item)).not.toContain('secret_ciphertext')
  })

  it('returns 404 for an unknown item', async () => {
    const r = await callServer(server, 'GET', `/items/${MISSING_UUID}`, guardHeaders())
    expect(r.status).toBe(404)
  })
})

// -- reveal: round-trips the plaintext AND writes exactly one access_log row ---

describe('GET /items/:id/secret', () => {
  it('returns the ORIGINAL stored plaintext and writes exactly one access_log row', async () => {
    const { id } = await seedItem({ orgUnitId: OU1, secret: 'correct-horse-battery-staple' })
    const r = await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    expect(r.status).toBe(200)
    expect((r.body as { secret: string }).secret).toBe('correct-horse-battery-staple')

    // The audit row is COMPLETE: actor (from the x-vault-user-id header, NOT
    // spoofable via query), item, collection (org_unit), tenant, and a timestamp.
    const rows = await sql<
      { c: string; accessed_by: string; org_unit_id: string; tenant_id: string; accessed_at: Date }[]
    >`SELECT COUNT(*)::int AS c, MAX(accessed_by) AS accessed_by, MAX(org_unit_id::text) AS org_unit_id,
             MAX(tenant_id) AS tenant_id, MAX(accessed_at) AS accessed_at
        FROM access_log WHERE item_id = ${id}`
    expect(Number(rows[0]!.c)).toBe(1)
    expect(rows[0]!.accessed_by).toBe(ACTOR)
    expect(rows[0]!.org_unit_id).toBe(OU1)
    expect(rows[0]!.tenant_id).toBe(TENANT.id)
    expect(rows[0]!.accessed_at).toBeInstanceOf(Date)
  })

  it('REJECTS a reveal with no x-vault-user-id header (400) and writes NO access_log row', async () => {
    const { id } = await seedItem({ secret: 'no-anon-reveal' })
    const r = await callServer(server, 'GET', `/items/${id}/secret`, headersNoActor())
    expect(r.status).toBe(400)
    // The plaintext was NOT returned…
    expect((r.body as { secret?: string }).secret).toBeUndefined()
    // …and no audit row was written for the anonymous attempt.
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM access_log WHERE item_id = ${id}`
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('logs one row per reveal (two reveals → two rows)', async () => {
    const { id } = await seedItem({ secret: 's' })
    await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM access_log WHERE item_id = ${id}`
    expect(Number(rows[0]!.c)).toBe(2)
  })

  it('returns 404 (and writes NO access_log row) for an unknown item', async () => {
    const r = await callServer(server, 'GET', `/items/${MISSING_UUID}/secret`, guardHeaders())
    expect(r.status).toBe(404)
    const rows = await sql<{ c: string }[]>`SELECT COUNT(*) AS c FROM access_log`
    expect(Number(rows[0]!.c)).toBe(0)
  })
})

// -- update: metadata edit + optional secret re-encrypt (#405 design v11) ------

describe('PUT /items/:id', () => {
  it('updates metadata fields and keeps the stored secret when none is sent', async () => {
    const { id } = await seedItem({ name: 'Old name', secret: 'keep-me' })
    const r = await callServer(server, 'PUT', `/items/${id}`, guardHeaders(), {
      name: 'New name',
      username: 'new-user',
    })
    expect(r.status).toBe(200)
    const item = r.body as Record<string, unknown>
    expect(item['name']).toBe('New name')
    expect(item['username']).toBe('new-user')
    expect(Object.keys(item)).not.toContain('secret')
    expect(Object.keys(item)).not.toContain('secret_ciphertext')
    // The stored secret is untouched — the reveal still round-trips the original.
    const reveal = await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    expect((reveal.body as { secret: string }).secret).toBe('keep-me')
  })

  it('re-encrypts when a new secret is provided (reveal returns the NEW plaintext)', async () => {
    const { id } = await seedItem({ secret: 'old-secret' })
    const r = await callServer(server, 'PUT', `/items/${id}`, guardHeaders(), { secret: 'new-secret' })
    expect(r.status).toBe(200)
    const reveal = await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    expect((reveal.body as { secret: string }).secret).toBe('new-secret')
  })

  it('clears a nullable field on explicit null and keeps it when absent', async () => {
    const { id } = await seedItem({ username: 'keep', notes: 'wipe-me' })
    const r = await callServer(server, 'PUT', `/items/${id}`, guardHeaders(), { notes: null })
    expect(r.status).toBe(200)
    const item = r.body as Record<string, unknown>
    expect(item['notes']).toBeNull()
    expect(item['username']).toBe('keep') // absent field = keep
  })

  it('moves an item to another org-unit', async () => {
    const { id } = await seedItem({ orgUnitId: OU1 })
    const r = await callServer(server, 'PUT', `/items/${id}`, guardHeaders(), { orgUnitId: OU2 })
    expect(r.status).toBe(200)
    expect((r.body as Record<string, unknown>)['org_unit_id']).toBe(OU2)
  })

  it('returns 400 on an invalid patch (empty name), validated like POST', async () => {
    const { id } = await seedItem()
    const r = await callServer(server, 'PUT', `/items/${id}`, guardHeaders(), { name: '' })
    expect(r.status).toBe(400)
  })

  it('returns 404 for an unknown item', async () => {
    const r = await callServer(server, 'PUT', `/items/${MISSING_UUID}`, guardHeaders(), { name: 'X' })
    expect(r.status).toBe(404)
  })
})

// -- access-log read: newest first, joined item name, paginated (#405) ---------

describe('GET /access-log', () => {
  it('returns rows for the requested scope, newest first, joined with the item name', async () => {
    const a = await seedItem({ orgUnitId: OU1, name: 'Item A', secret: 's1' })
    const b = await seedItem({ orgUnitId: OU2, name: 'Item B', secret: 's2' })
    await callServer(server, 'GET', `/items/${a.id}/secret`, guardHeaders())
    await callServer(server, 'GET', `/items/${b.id}/secret`, guardHeaders())
    await callServer(server, 'GET', `/items/${a.id}/secret`, guardHeaders())

    const r = await callServer(server, 'GET', `/access-log?orgUnitIds=${OU1}`, guardHeaders())
    expect(r.status).toBe(200)
    const data = (r.body as { data: Record<string, unknown>[] }).data
    // Only OU1 reveals (2 of the 3), scoped exactly like the /items list.
    expect(data).toHaveLength(2)
    for (const row of data) {
      expect(row['org_unit_id']).toBe(OU1)
      expect(row['item_name']).toBe('Item A')
      expect(row['accessed_by']).toBe(ACTOR)
      expect(typeof row['accessed_at']).toBe('string')
    }
  })

  it('covers both units when the csv carries both, newest first', async () => {
    const a = await seedItem({ orgUnitId: OU1, name: 'First', secret: 's1' })
    const b = await seedItem({ orgUnitId: OU2, name: 'Second', secret: 's2' })
    await callServer(server, 'GET', `/items/${a.id}/secret`, guardHeaders())
    await callServer(server, 'GET', `/items/${b.id}/secret`, guardHeaders())
    const r = await callServer(server, 'GET', `/access-log?orgUnitIds=${OU1},${OU2}`, guardHeaders())
    const data = (r.body as { data: Record<string, unknown>[] }).data
    expect(data).toHaveLength(2)
    // Newest first: the OU2 reveal happened after the OU1 reveal.
    expect(data[0]!['item_name']).toBe('Second')
    expect(data[1]!['item_name']).toBe('First')
  })

  it('paginates with limit/offset', async () => {
    const { id } = await seedItem({ orgUnitId: OU1, secret: 's' })
    await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())
    const page1 = await callServer(server, 'GET', `/access-log?orgUnitIds=${OU1}&limit=2`, guardHeaders())
    expect((page1.body as { data: unknown[] }).data).toHaveLength(2)
    const page2 = await callServer(server, 'GET', `/access-log?orgUnitIds=${OU1}&limit=2&offset=2`, guardHeaders())
    expect((page2.body as { data: unknown[] }).data).toHaveLength(1)
  })

  it('returns 400 when orgUnitIds is missing (required csv)', async () => {
    const r = await callServer(server, 'GET', '/access-log', guardHeaders())
    expect(r.status).toBe(400)
  })
})

// -- delete -------------------------------------------------------------------

describe('DELETE /items/:id', () => {
  it('deletes an item (200) and it is gone afterwards', async () => {
    const { id } = await seedItem()
    const del = await callServer(server, 'DELETE', `/items/${id}`, guardHeaders())
    expect(del.status).toBe(200)
    const after = await callServer(server, 'GET', `/items/${id}`, guardHeaders())
    expect(after.status).toBe(404)
  })

  it('returns 404 deleting an unknown item', async () => {
    const r = await callServer(server, 'DELETE', `/items/${MISSING_UUID}`, guardHeaders())
    expect(r.status).toBe(404)
  })

  // Design v11 review: the /vault surface promises an APPEND-ONLY audit trail
  // that survives item deletion ("Das Zugriffsprotokoll bleibt erhalten").
  // Mig 002 dropped the ON DELETE CASCADE and snapshots the item name onto the
  // row — reveal + delete must NOT erase the trace of the reveal.
  it('PRESERVES the access_log rows (with the item-name snapshot) after the item is deleted', async () => {
    const { id } = await seedItem({ orgUnitId: OU1, name: 'Doomed item', secret: 's3cret' })
    await callServer(server, 'GET', `/items/${id}/secret`, guardHeaders())

    const del = await callServer(server, 'DELETE', `/items/${id}`, guardHeaders())
    expect(del.status).toBe(200)

    // The DB row survives the delete (no cascade)…
    const rows = await sql<{ c: number; item_name: string; accessed_by: string }[]>`
      SELECT COUNT(*)::int AS c, MAX(item_name) AS item_name, MAX(accessed_by) AS accessed_by
        FROM access_log WHERE item_id = ${id}`
    expect(Number(rows[0]!.c)).toBe(1)
    expect(rows[0]!.item_name).toBe('Doomed item')
    expect(rows[0]!.accessed_by).toBe(ACTOR)

    // …and the read surface still lists it, named via the snapshot.
    const log = await callServer(server, 'GET', `/access-log?orgUnitIds=${OU1}`, guardHeaders())
    expect(log.status).toBe(200)
    const data = (log.body as { data: Record<string, unknown>[] }).data
    expect(data).toHaveLength(1)
    expect(data[0]!['item_id']).toBe(id)
    expect(data[0]!['item_name']).toBe('Doomed item')
  })
})
