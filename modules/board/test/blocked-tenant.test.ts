// modules/board/test/blocked-tenant.test.ts
// PG-free: a module switch-off BLOCKS the tenant's database (module Karenz) instead of dropping it.
// The app role then loses CONNECT, which Postgres answers with SQLSTATE 42501 at connect time. That is
// the same operator-visible state as a missing database: 404 tenant_not_provisioned, not a 503. A
// 42501 from a TABLE privilege (a real bug) must stay a 500 and must not be disguised as "switched off".
import { describe, expect, it, vi } from 'vitest'
import type { SchemaGate, TenantStore } from '@gremion/tenant-store'
import { buildApiRoutes } from '../src/http/routes.ts'
import { createBoardTenantDb, NOT_PROVISIONED } from '../src/store/tenant-db.ts'
import type { Sql, TenantRef } from '../src/store/index.ts'

const TENANT: TenantRef = { id: '11111111-1111-4111-8111-111111111111', slug: 'a' }
const isTemplate = (v: unknown): v is TemplateStringsArray => Array.isArray(v) && 'raw' in v
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code })

describe('classify: a blocked database is not provisioned', () => {
  const gate = { check: async () => ({ ok: false, reason: 'unavailable' }) } as unknown as SchemaGate
  const storeThatFails = (code: string) => ({ openTenantDb: async () => { throw pgError(code) } }) as unknown as TenantStore

  it('maps 42501 (CONNECT revoked) to 404 tenant_not_provisioned', async () => {
    const db = createBoardTenantDb({ store: storeThatFails('42501'), gate })
    expect(await db.classify(TENANT.id)).toEqual(NOT_PROVISIONED)
    expect(await db.resolve(TENANT.id)).toEqual(NOT_PROVISIONED)
  })
  it('maps 3D000 as before and any other error to 503', async () => {
    expect(await createBoardTenantDb({ store: storeThatFails('3D000'), gate }).classify(TENANT.id)).toEqual(NOT_PROVISIONED)
    expect((await createBoardTenantDb({ store: storeThatFails('53300'), gate }).classify(TENANT.id)).status).toBe(503)
  })
})

describe('route: 42501 at query time', () => {
  const route = buildApiRoutes(async () => { throw new Error('unused') }).find((r) => r.method === 'GET' && r.path === '/api/v1/boards')!
  const ORG = '22222222-2222-4222-8222-222222222222'

  async function run(sqlFor: () => Sql): Promise<{ status: number; body: unknown }> {
    const routes = buildApiRoutes(async () => sqlFor())
    const r = routes.find((x) => x.method === 'GET' && x.path === '/api/v1/boards')!
    let status = 0
    let body = ''
    const res = {
      headersSent: false,
      writeHead: (s: number) => { status = s },
      end: (b: string) => { body = b },
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await r.handler({ req: { url: `/api/v1/boards?orgUnitId=${ORG}` }, res, tenant: TENANT } as never)
    } finally {
      err.mockRestore()
    }
    return { status, body: JSON.parse(body) }
  }

  it('exists', () => expect(route).toBeDefined())

  it('answers 404 tenant_not_provisioned when the connection itself is refused', async () => {
    const sql = ((first: unknown) => (isTemplate(first) ? Promise.reject(pgError('42501')) : {})) as unknown as Sql
    expect(await run(() => sql)).toEqual({ status: 404, body: { success: false, error: 'tenant_not_provisioned' } })
  })

  it('stays a 500 when only a table privilege is missing (the connection works)', async () => {
    const sql = ((first: unknown) => {
      if (!isTemplate(first)) return {} // a sql(list) helper call, not a query
      return first[0]?.includes('SELECT 1') ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(pgError('42501'))
    }) as unknown as Sql
    expect(await run(() => sql)).toEqual({ status: 500, body: { success: false, error: 'internal error' } })
  })
})
