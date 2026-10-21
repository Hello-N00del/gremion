// @vitest-environment node
// gremion-ui/src/lib/server/vault/backend/service-client.contract.test.ts
//
// SEAM-CONTRACT test for ServiceVaultClient ⇄ the vault leaf.
//
// The ROUTE_TABLE below is transcribed VERBATIM from the leaf's own source of
// truth, so it is the tripwire for client↔leaf drift:
//   services/vault/src/http/routes.ts   (branch wf_afb4a604-3e7-4)  ← verbs + paths
//   services/vault/src/http/guard.ts     (branch wf_afb4a604-3e7-4)  ← required headers
//
// The leaf's pinned route set — NO /api/v1 prefix ANYWHERE; item field is `notes`:
//   GET    /items?orgUnitId=…   → { data: VaultItem[] }
//   POST   /items               → VaultItem (201)
//   GET    /items/:id           → VaultItem | 404
//   PUT    /items/:id           → VaultItem | 404   (update — re-encrypts on new secret)
//   GET    /items/:id/secret    → { secret } | 404   (reveal — GET, single-attempt)
//   DELETE /items/:id           → { success:true } | 404
//   GET    /access-log?orgUnitIds=…,…&limit=…&offset=… → { data: AccessLogEntry[] }
//
// Guard (guard.ts) requires x-internal-auth + x-tenant-id + x-tenant-slug on EVERY
// route; the reveal route ALSO requires x-vault-user-id (an anonymous reveal is a
// 400 before any decryption). list/get/delete never read x-vault-user-id. If the
// leaf seam changes, THIS TABLE must be edited in the same commit — that explicit
// edit is what makes future drift a visible, reviewed change rather than a silent
// break. Node env (not jsdom) for the native fetch/AbortSignal realm — see the
// sibling service-client.test.ts header.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { ServiceVaultClient } from './service-client'

const FAKE_TENANT: TenantContext = {
  id: 'tenant-uuid-vault',
  slug: 'vault-test',
} as unknown as TenantContext

interface Captured {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
}

let server: Server
let port: number
let captured: Captured | null = null
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Drain the request body (not asserted by the contract table).
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    captured = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers as Record<string, string | string[] | undefined>,
    }
    res.writeHead(nextResponse.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(nextResponse.body))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

beforeEach(() => {
  process.env.VAULT_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.INTERNAL_VAULT_SECRET = 'vault-secret-contract'
  captured = null
})

function withTenant<T>(fn: () => T): T {
  return runWithTenant(FAKE_TENANT, fn)
}

// A leaf VaultItem (metadata only — `notes`, never `note`; no secret column).
const ITEM = {
  id: 'v1',
  org_unit_id: 'ou-1',
  name: 'DB-Zugang',
  username: null,
  url: null,
  notes: null,
  created_by: 'u1',
  created_at: new Date().toISOString(),
}

// Guard headers required on EVERY leaf route (guard.ts checkGuard).
const GUARD_HEADERS = ['x-internal-auth', 'x-tenant-id', 'x-tenant-slug'] as const

interface ContractRow {
  name: string
  verb: string
  /** Exact request path (incl. query) the client MUST send — bare, no /api/v1. */
  path: string
  requiredHeaders: readonly string[]
  response: { status: number; body: unknown }
  drive: (c: ServiceVaultClient) => Promise<unknown>
}

// ── ROUTE_TABLE — verbatim from services/vault/src/http/routes.ts (wf_afb4a604-3e7-4) ──
const ROUTE_TABLE: ContractRow[] = [
  {
    name: 'list',
    verb: 'GET',
    path: '/items?orgUnitId=ou-1',
    requiredHeaders: GUARD_HEADERS,
    response: { status: 200, body: { data: [ITEM] } },
    drive: (c) => c.listItemsForOrgUnits(['ou-1']),
  },
  {
    name: 'get',
    verb: 'GET',
    path: '/items/v1',
    requiredHeaders: GUARD_HEADERS,
    response: { status: 200, body: ITEM },
    drive: (c) => c.getItem('v1'),
  },
  {
    name: 'reveal',
    verb: 'GET',
    path: '/items/v1/secret',
    requiredHeaders: [...GUARD_HEADERS, 'x-vault-user-id'],
    response: { status: 200, body: { secret: 'p@ss' } },
    drive: (c) => c.revealSecret('v1', 'u1'),
  },
  {
    name: 'create',
    verb: 'POST',
    path: '/items',
    requiredHeaders: GUARD_HEADERS,
    response: { status: 201, body: ITEM },
    drive: (c) => c.createItem({ orgUnitId: 'ou-1', name: 'X', secret: 's', createdBy: 'u1' }),
  },
  {
    name: 'update',
    verb: 'PUT',
    path: '/items/v1',
    requiredHeaders: GUARD_HEADERS,
    response: { status: 200, body: ITEM },
    drive: (c) => c.updateItem('v1', { name: 'X' }),
  },
  {
    name: 'delete',
    verb: 'DELETE',
    path: '/items/v1',
    requiredHeaders: GUARD_HEADERS,
    response: { status: 200, body: { success: true } },
    drive: (c) => c.deleteItem('v1'),
  },
  {
    name: 'access-log',
    verb: 'GET',
    path: '/access-log?orgUnitIds=ou-1%2Cou-2&limit=50&offset=0',
    requiredHeaders: GUARD_HEADERS,
    response: {
      status: 200,
      body: {
        data: [
          {
            id: 'a1', item_id: 'v1', item_name: 'DB-Zugang',
            org_unit_id: 'ou-1', accessed_by: 'u1',
            accessed_at: new Date().toISOString(),
          },
        ],
      },
    },
    drive: (c) => c.listAccessLog(['ou-1', 'ou-2'], { limit: 50, offset: 0 }),
  },
]

describe('ServiceVaultClient — leaf seam contract (verb + path + required headers)', () => {
  for (const row of ROUTE_TABLE) {
    it(`${row.name}: ${row.verb} ${row.path}`, async () => {
      nextResponse = row.response
      const client = new ServiceVaultClient()
      await withTenant(() => row.drive(client))
      expect(captured).not.toBeNull()
      expect(captured!.method).toBe(row.verb)
      expect(captured!.url).toBe(row.path)
      // The bare /items seam carries NO fabricated /api/v1 prefix.
      expect(captured!.url).not.toContain('/api/v1')
      for (const name of row.requiredHeaders) {
        const val = captured!.headers[name]
        expect(
          typeof val === 'string' && val.length > 0,
          `missing required header ${name} on ${row.name}`,
        ).toBe(true)
      }
    })
  }
})
