// @vitest-environment node
// gremion-ui/src/lib/server/vault/backend/service-client.test.ts
// TDD suite for ServiceVaultClient (HTTP ACL to the vault leaf).
//
// Runs in the `node` environment (not the suite-default jsdom): this is a pure
// server-side client driving a real node:http stub via native undici fetch.
// Under jsdom the installed AbortController is a different realm than the one
// undici closed over → "Expected signal to be an instance of AbortSignal". The
// node env keeps the native fetch/AbortSignal pair intact (matching the board /
// calendar service-client specs' same pragma).
//
// Strategy: spin up a node:http stub per suite; point VAULT_SERVICE_URL at it;
// assert header forwarding (incl. the vault-specific x-vault-user-id on reveal),
// error mapping, and retry behaviour.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import { ServiceVaultClient, VaultServiceError } from './service-client'
import type { VaultBackendPort } from './port'

const FAKE_TENANT: TenantContext = {
  id: 'tenant-uuid-vault',
  slug: 'vault-test',
} as unknown as TenantContext

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

interface StubBehaviour {
  firstStatus?: number
  subsequentStatus?: number
  body?: unknown
  callCount: number
}

let server: Server
let port: number
let lastRequest: CapturedRequest | null = null
let stubBehaviour: StubBehaviour = { callCount: 0 }

function resetStub(opts: Omit<StubBehaviour, 'callCount'> = {}) {
  lastRequest = null
  stubBehaviour = { callCount: 0, ...opts }
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    stubBehaviour.callCount++
    const callIdx = stubBehaviour.callCount
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let parsedBody: unknown = undefined
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        parsedBody = rawBody
      }
    }
    lastRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: parsedBody,
    }
    const status =
      callIdx === 1
        ? (stubBehaviour.firstStatus ?? 200)
        : (stubBehaviour.subsequentStatus ?? stubBehaviour.firstStatus ?? 200)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(stubBehaviour.body ?? {}))
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
  process.env.INTERNAL_VAULT_SECRET = 'vault-secret-5678'
  resetStub({ body: {} })
})

function withTenant<T>(fn: () => T): T {
  return runWithTenant(FAKE_TENANT, fn)
}

function makeItemBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    org_unit_id: 'ou-1',
    name: 'DB-Zugang',
    username: 'admin',
    url: null,
    notes: null,
    created_by: 'u1',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('ServiceVaultClient — kind', () => {
  it('has kind === service', () => {
    const client: VaultBackendPort = new ServiceVaultClient()
    expect(client.kind).toBe('service')
  })
})

describe('ServiceVaultClient — header forwarding', () => {
  it('forwards x-tenant-id, x-tenant-slug, and x-internal-auth on createItem', async () => {
    resetStub({ firstStatus: 201, body: makeItemBody() })
    const client = new ServiceVaultClient()
    await withTenant(() => client.createItem({ orgUnitId: 'ou-1', name: 'X', secret: 's', createdBy: 'u1' }))
    expect(lastRequest).not.toBeNull()
    expect(lastRequest!.headers['x-tenant-id']).toBe('tenant-uuid-vault')
    expect(lastRequest!.headers['x-tenant-slug']).toBe('vault-test')
    expect(lastRequest!.headers['x-internal-auth']).toBe('vault-secret-5678')
  })

  it('forwards x-correlation-id when provided in constructor', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceVaultClient({ correlationId: 'corr-abc' })
    await withTenant(() => client.listItemsForOrgUnits(['ou-1']))
    expect(lastRequest!.headers['x-correlation-id']).toBe('corr-abc')
  })

  it('omits x-correlation-id when not provided', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceVaultClient()
    await withTenant(() => client.listItemsForOrgUnits(['ou-1']))
    expect(lastRequest!.headers['x-correlation-id']).toBeUndefined()
  })
})

describe('ServiceVaultClient — reveal (audit header + no-retry)', () => {
  it('revealSecret GETs /items/v1/secret and forwards x-vault-user-id', async () => {
    resetStub({ body: { secret: 'p@ss' } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.revealSecret('v1', 'u1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/items/v1/secret')
    expect(lastRequest!.headers['x-vault-user-id']).toBe('u1')
    expect(result.secret).toBe('p@ss')
  })

  it('does NOT retry revealSecret even when the leaf returns 503 (no double-audit)', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 200, body: { secret: 'p@ss' } })
    const client = new ServiceVaultClient()
    await expect(withTenant(() => client.revealSecret('v1', 'u1'))).rejects.toSatisfy(
      (e: unknown) => e instanceof VaultServiceError && e.status === 503,
    )
    expect(stubBehaviour.callCount).toBe(1)
  })

  it('revealSecret THROWS on a 200 missing the { secret } field (fail-loud)', async () => {
    resetStub({ firstStatus: 200, body: { oops: true } })
    const client = new ServiceVaultClient()
    await expect(withTenant(() => client.revealSecret('v1', 'u1'))).rejects.toThrow(
      /malformed reveal response/,
    )
  })
})

describe('ServiceVaultClient — error mapping', () => {
  it('getItem returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'not found' } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.getItem('missing'))
    expect(result).toBeNull()
  })

  it('deleteItem returns false when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'not found' } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.deleteItem('missing'))
    expect(result).toBe(false)
  })

  it('throws VaultServiceError with the status on POST 500', async () => {
    resetStub({ firstStatus: 500, body: { error: 'boom' } })
    const client = new ServiceVaultClient()
    await expect(
      withTenant(() => client.createItem({ orgUnitId: 'ou-1', name: 'x', secret: 's' })),
    ).rejects.toSatisfy((e: unknown) => e instanceof VaultServiceError && e.status === 500)
    expect(stubBehaviour.callCount).toBe(1) // POST must NOT retry
  })

  it('throws when VAULT_SERVICE_URL is not set', async () => {
    delete process.env.VAULT_SERVICE_URL
    const client = new ServiceVaultClient()
    await expect(withTenant(() => client.listItemsForOrgUnits(['ou-1']))).rejects.toThrow(
      /VAULT_SERVICE_URL/,
    )
    process.env.VAULT_SERVICE_URL = `http://127.0.0.1:${port}`
  })

  it('throws when INTERNAL_VAULT_SECRET is not set', async () => {
    delete process.env.INTERNAL_VAULT_SECRET
    const client = new ServiceVaultClient()
    await expect(withTenant(() => client.listItemsForOrgUnits(['ou-1']))).rejects.toThrow(
      /INTERNAL_VAULT_SECRET/,
    )
    process.env.INTERNAL_VAULT_SECRET = 'vault-secret-5678'
  })

  it('throws VaultServiceError status 503 when leaf returns 503 on both attempts (GET)', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 503, body: { error: 'unavailable' } })
    const client = new ServiceVaultClient()
    await expect(withTenant(() => client.listItemsForOrgUnits(['ou-1']))).rejects.toSatisfy(
      (e: unknown) => e instanceof VaultServiceError && e.status === 503,
    )
  })
})

describe('ServiceVaultClient — retry policy', () => {
  it('retries once on GET when leaf returns 503 then 200', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 200, body: { data: [] } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.listItemsForOrgUnits(['ou-1']))
    expect(Array.isArray(result)).toBe(true)
    expect(stubBehaviour.callCount).toBe(2)
  })

  it('does NOT retry on POST even when leaf returns 503', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 200, body: makeItemBody() })
    const client = new ServiceVaultClient()
    await expect(
      withTenant(() => client.createItem({ orgUnitId: 'ou-1', name: 'x', secret: 's' })),
    ).rejects.toSatisfy((e: unknown) => e instanceof VaultServiceError && e.status === 503)
    expect(stubBehaviour.callCount).toBe(1)
  })
})

describe('ServiceVaultClient — method routing', () => {
  it('listItemsForOrgUnits → GET /items?orgUnitId=ou-1', async () => {
    resetStub({ body: { data: [makeItemBody()] } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.listItemsForOrgUnits(['ou-1']))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toMatch(/^\/items\?/)
    expect(lastRequest!.url).not.toContain('/api/v1')
    expect(lastRequest!.url).toContain('orgUnitId=ou-1')
    expect(result[0]!.id).toBe('v1')
    expect(result[0]!.created_at).toBeInstanceOf(Date)
  })

  it('listItemsForOrgUnits([]) short-circuits to [] without a leaf call', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.listItemsForOrgUnits([]))
    expect(result).toEqual([])
    expect(stubBehaviour.callCount).toBe(0)
  })

  it('getItem → GET /items/v1 (no secret on the item)', async () => {
    resetStub({ body: makeItemBody() })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.getItem('v1'))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toBe('/items/v1')
    expect(result!.id).toBe('v1')
    expect(result!.created_at).toBeInstanceOf(Date)
    expect(result).not.toHaveProperty('secret')
  })

  it('createItem → POST /items', async () => {
    resetStub({ firstStatus: 201, body: makeItemBody({ name: 'Neu' }) })
    const client = new ServiceVaultClient()
    const result = await withTenant(() =>
      client.createItem({ orgUnitId: 'ou-1', name: 'Neu', secret: 's', createdBy: 'u1' }),
    )
    expect(lastRequest!.method).toBe('POST')
    expect(lastRequest!.url).toBe('/items')
    expect((lastRequest!.body as Record<string, unknown>).name).toBe('Neu')
    expect((lastRequest!.body as Record<string, unknown>).secret).toBe('s')
    expect(result.name).toBe('Neu')
    expect(result.created_at).toBeInstanceOf(Date)
  })

  it('deleteItem → DELETE /items/v1 → true on success', async () => {
    // The real leaf returns 200 { success: true } (not 204) on a successful delete.
    resetStub({ firstStatus: 200, body: { success: true } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.deleteItem('v1'))
    expect(lastRequest!.method).toBe('DELETE')
    expect(lastRequest!.url).toBe('/items/v1')
    expect(result).toBe(true)
  })

  it('updateItem → PUT /items/v1 with the patch body', async () => {
    resetStub({ body: makeItemBody({ name: 'Umbenannt' }) })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.updateItem('v1', { name: 'Umbenannt', notes: null }))
    expect(lastRequest!.method).toBe('PUT')
    expect(lastRequest!.url).toBe('/items/v1')
    expect((lastRequest!.body as Record<string, unknown>).name).toBe('Umbenannt')
    expect((lastRequest!.body as Record<string, unknown>).notes).toBeNull()
    expect(result!.name).toBe('Umbenannt')
    expect(result!.created_at).toBeInstanceOf(Date)
  })

  it('updateItem returns null when leaf returns 404', async () => {
    resetStub({ firstStatus: 404, body: { error: 'not found' } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.updateItem('missing', { name: 'X' }))
    expect(result).toBeNull()
  })

  it('does NOT retry updateItem on 503 (mutation — never auto-retried)', async () => {
    resetStub({ firstStatus: 503, subsequentStatus: 200, body: makeItemBody() })
    const client = new ServiceVaultClient()
    await expect(withTenant(() => client.updateItem('v1', { name: 'X' }))).rejects.toSatisfy(
      (e: unknown) => e instanceof VaultServiceError && e.status === 503,
    )
    expect(stubBehaviour.callCount).toBe(1)
  })

  it('listAccessLog → GET /access-log with csv orgUnitIds + limit/offset', async () => {
    resetStub({
      body: {
        data: [
          {
            id: 'a1', item_id: 'v1', item_name: 'DB-Zugang',
            org_unit_id: 'ou-1', accessed_by: 'u1',
            accessed_at: new Date().toISOString(),
          },
        ],
      },
    })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.listAccessLog(['ou-1', 'ou-2'], { limit: 10, offset: 20 }))
    expect(lastRequest!.method).toBe('GET')
    expect(lastRequest!.url).toMatch(/^\/access-log\?/)
    const q = new URLSearchParams(lastRequest!.url.split('?')[1])
    expect(q.get('orgUnitIds')).toBe('ou-1,ou-2')
    expect(q.get('limit')).toBe('10')
    expect(q.get('offset')).toBe('20')
    expect(result[0]!.item_name).toBe('DB-Zugang')
    expect(result[0]!.accessed_at).toBeInstanceOf(Date)
  })

  it('listAccessLog([]) short-circuits to [] without a leaf call', async () => {
    resetStub({ body: { data: [] } })
    const client = new ServiceVaultClient()
    const result = await withTenant(() => client.listAccessLog([], { limit: 50, offset: 0 }))
    expect(result).toEqual([])
    expect(stubBehaviour.callCount).toBe(0)
  })

  it('listAccessLog THROWS on a 200 missing the { data: [] } envelope (fail-loud)', async () => {
    resetStub({ firstStatus: 200, body: {} })
    const client = new ServiceVaultClient()
    await expect(
      withTenant(() => client.listAccessLog(['ou-1'], { limit: 50, offset: 0 })),
    ).rejects.toThrow(/malformed listAccessLog response/)
  })
})

describe('ServiceVaultClient — malformed-200 shape guard', () => {
  it('listItemsForOrgUnits THROWS on a 200 missing the { data: [] } envelope (fail-loud, not fail-open)', async () => {
    resetStub({ firstStatus: 200, body: {} })
    const client = new ServiceVaultClient()
    await expect(withTenant(() => client.listItemsForOrgUnits(['ou-1']))).rejects.toThrow(
      /malformed listItemsForOrgUnits response/,
    )
  })
})
