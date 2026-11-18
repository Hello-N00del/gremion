// modules/board/test/erase-store.test.ts
// PG-free: the two erasure store ops and the two routes' request handling that needs no database.
//   eraseSubject           the two person updates of the board erasure hook, in ONE transaction, counts returned
//   deleteBoardsForOrgUnit the boards of one org unit (stacks and cards follow by the leaf's own cascade)
import { describe, expect, it } from 'vitest'
import { buildApiRoutes } from '../src/http/routes.ts'
import { deleteBoardsForOrgUnit, eraseSubject, ERASED_MARKER, type Sql, type TenantRef } from '../src/store/index.ts'

const TENANT: TenantRef = { id: '01920000-0000-7000-8000-00000000000a', slug: 'tenant-a' }
const OU = '11111111-1111-1111-1111-111111111111'

interface Call {
  handle: 'outer' | 'tx'
  text: string
  values: unknown[]
}

/** A tagged-template fake that records every statement and which handle (the pool or a transaction) ran it. */
function fakeSql(counts: number[]) {
  const calls: Call[] = []
  let begun = 0
  const make = (handle: 'outer' | 'tx') => (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ handle, text: strings.join('?'), values })
    return Promise.resolve({ count: counts[calls.length - 1] ?? 0 })
  }
  const tx = make('tx')
  const outer = Object.assign(make('outer'), {
    begin: async (fn: (t: typeof tx) => Promise<unknown>) => {
      begun++
      return fn(tx)
    },
  })
  return { sql: outer as unknown as Sql, calls, begun: () => begun }
}

describe('eraseSubject', () => {
  it('runs both updates inside one transaction and returns both counts', async () => {
    const { sql, calls, begun } = fakeSql([2, 5])
    const counts = await eraseSubject(sql, 'subject-1')
    expect(counts).toEqual({ card_assignee: 2, card_created_by: 5 })
    expect(begun()).toBe(1)
    expect(calls.map((c) => c.handle)).toEqual(['tx', 'tx'])
    expect(calls[0]!.text).toMatch(/UPDATE card SET assignee_keycloak_id = NULL WHERE assignee_keycloak_id = \?/)
    expect(calls[0]!.values).toEqual(['subject-1'])
    expect(calls[1]!.text).toMatch(/UPDATE card SET created_by = \? WHERE created_by = \?/)
    expect(calls[1]!.values).toEqual([ERASED_MARKER, 'subject-1'])
  })

  it('uses the marker the app hook writes, one that matches no user', () => {
    expect(ERASED_MARKER).toBe('erased')
  })
})

describe('deleteBoardsForOrgUnit', () => {
  it('deletes the boards of that org unit only and returns how many went', async () => {
    const { sql, calls } = fakeSql([3])
    expect(await deleteBoardsForOrgUnit(sql, OU)).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).toMatch(/DELETE FROM board WHERE org_unit_id = \?/)
    expect(calls[0]!.values).toEqual([OU])
  })
})

describe('erase routes: request validation happens before the tenant database is opened', () => {
  const stats = { opened: 0 }
  const routes = buildApiRoutes(async () => {
    stats.opened++
    throw new Error('the store must not be reached')
  })
  const erase = routes.find((r) => r.method === 'POST' && r.path === '/api/v1/erase-subject')!
  const del = routes.find((r) => r.method === 'DELETE' && r.path === '/api/v1/org-units/:id/boards')!

  async function run(route: (typeof routes)[number], params: Record<string, string>, body?: unknown) {
    let status = 0
    let out = ''
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    const req = {
      url: '/x',
      on(ev: string, cb: (c?: Buffer) => void) {
        if (ev === 'data' && raw) cb(Buffer.from(raw))
        if (ev === 'end') cb()
        return this
      },
    }
    const res = { headersSent: false, writeHead: (s: number) => void (status = s), end: (b: string) => void (out = b) }
    await route.handler({ req, res, params, tenant: TENANT } as never)
    return { status, body: JSON.parse(out) as { success: boolean; error: string } }
  }

  it.each([
    ['an extra field', { subjectId: 'u-1', extra: 1 }],
    ['a number id', { subjectId: 5 }],
    ['an object id', { subjectId: { $ne: '' } }],
    ['an empty id', { subjectId: '' }],
    ['no id', {}],
    ['an oversized id', { subjectId: 'x'.repeat(513) }],
  ])('POST erase-subject refuses %s with 400 and never opens the database', async (_name, body) => {
    stats.opened = 0
    const r = await run(erase, {}, body)
    expect(r.status).toBe(400)
    expect(stats.opened).toBe(0)
  })

  it('POST erase-subject refuses a body that is not JSON with 400', async () => {
    expect((await run(erase, {}, '{nope')).status).toBe(400)
  })

  it('DELETE org-units/:id/boards refuses a malformed org unit id with 400 and never opens the database', async () => {
    stats.opened = 0
    const r = await run(del, { id: 'not-a-uuid' })
    expect(r.status).toBe(400)
    expect(stats.opened).toBe(0)
  })

  it('a tenant-level refusal (blocked database) answers 404 on both routes', async () => {
    const refusing = buildApiRoutes(async () => ({ status: 404, code: 'tenant_not_provisioned' }) as never)
    for (const [route, params, body] of [
      [refusing.find((r) => r.path === '/api/v1/erase-subject')!, {}, { subjectId: 'u-1' }],
      [refusing.find((r) => r.path === '/api/v1/org-units/:id/boards')!, { id: OU }, undefined],
    ] as const) {
      const r = await run(route, params, body)
      expect(r).toEqual({ status: 404, body: { success: false, error: 'tenant_not_provisioned' } })
    }
  })
})
