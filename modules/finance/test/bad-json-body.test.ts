// test/bad-json-body.test.ts -- F1-FIX-05-K (K4#4 / S4#4).
//
// readJsonBody turned a malformed or non-object JSON body into {}, so a mutation ran
// on an empty body: a truncated sign request still signed the approval stage, a
// broken PATCH still wrote. A malformed / non-object body is now a 400 before any
// store call; a truly empty body keeps meaning {}.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import type { Sql, TenantRef } from '../src/tenant-store.ts'

const SECRET = 'bad-json-secret'
const HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': 'cccccccc-0000-4000-8000-00000000000c',
  'x-tenant-slug': 'badjson',
  'content-type': 'application/json',
  'x-finance-user-id': 'u',
  'x-finance-is-superuser': 'true',
}

describe('malformed JSON bodies (K4#4)', () => {
  let base: string
  let server: ReturnType<typeof createServer>
  let storeCalls = 0

  beforeAll(async () => {
    const storeFn = async (_t: TenantRef): Promise<Sql> => {
      storeCalls++
      const fn = (() => Promise.resolve([])) as unknown as Sql & { begin: unknown }
      ;(fn as unknown as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (cb) => cb(fn)
      return fn as unknown as Sql
    }
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const send = (method: string, path: string, body: string) =>
    fetch(`${base}${path}`, { method, headers: HEADERS, body })

  for (const [label, body] of [
    ['truncated JSON', '{"note":'],
    ['a JSON array', '[1,2]'],
    ['JSON null', 'null'],
    ['a JSON string', '"x"'],
  ] as const) {
    it(`${label} on a sign request -> 400 and no store call`, async () => {
      storeCalls = 0
      const res = await send('POST', '/api/v1/approvals/1/sign', body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toMatch(/invalid JSON body/)
      expect(storeCalls).toBe(0)
    })
  }

  it('a malformed PATCH body -> 400 and no store call', async () => {
    storeCalls = 0
    const res = await send('PATCH', '/api/v1/fiscal-years/1', '{name:')
    expect(res.status).toBe(400)
    expect(storeCalls).toBe(0)
  })

  it('an empty body still means {} (reaches the store)', async () => {
    storeCalls = 0
    const res = await send('PATCH', '/api/v1/fiscal-years/1', '')
    expect(res.status).not.toBe(400)
    expect(storeCalls).toBe(1)
  })
})
