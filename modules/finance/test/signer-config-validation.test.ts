// TASK-009 lane C, fix round 1 (review r1-finance-C1C2, LOW): updateSignerConfig
// previously checked only `Array.isArray(body.signerStages)` /
// `Array.isArray(body.decisionAuthorityTiers)` — any array, regardless of what
// its entries contained, passed straight through to the UPDATE. This is not
// reachable by an unprivileged caller (the internal shared secret + the
// admin/it-admin re-check below already gate the route), but any caller
// holding the secret could write a malformed Vier-Augen config (e.g. a stage
// missing `required_group`) that createApproval later reads. This suite pins
// that each entry's SHAPE is now validated before the write.
import { describe, it, expect } from 'vitest'
import type http from 'node:http'
import { buildApiRoutes } from '../src/http/routes.ts'
import type { Route } from '../src/http/router.ts'

/** A fake postgres-js Sql whose UPDATE ... RETURNING resolves with the given
 *  row — good enough for updateSignerConfigHandler, which only needs `rows[0]`
 *  to be truthy to answer 200. */
function fakeSql(row: Record<string, unknown> | undefined) {
  const fn = (() => Promise.resolve(row ? [row] : [])) as unknown as {
    (...args: unknown[]): Promise<unknown[]>
    json: (v: unknown) => unknown
  }
  fn.json = (v: unknown) => v
  return fn
}
const fakeStore = async () => fakeSql({ signer_stages: [], decision_authority_tiers: [] }) as never

function fakeReq(body: unknown, groups = 'admin'): http.IncomingMessage {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  return {
    headers: { 'x-finance-groups': groups },
    [Symbol.asyncIterator]: async function* () {
      yield raw
    },
  } as unknown as http.IncomingMessage
}

async function invoke(route: Route, req: http.IncomingMessage) {
  let status = 0
  let respBody = ''
  const res = {
    writeHead(s: number) { status = s; return res },
    end(chunk?: string) { if (chunk) respBody = chunk },
  } as unknown as http.ServerResponse
  await route.handler({ params: {}, req, res, tenant: { id: 't', slug: 's' } } as never)
  return { status, body: respBody ? JSON.parse(respBody) : undefined }
}

function findRoute(): Route {
  const route = buildApiRoutes(fakeStore).find(
    (r) => r.method === 'PUT' && r.path === '/api/v1/finanzordnung/signer-config',
  )
  if (!route) throw new Error('updateSignerConfig route not found')
  return route
}

const VALID_STAGE = { role: 'KV', required_group: 'ref-finanzen-kv', certifies: ['sachlich'] }
const VALID_TIER = { max_amount_cents: 100_000, required_group: 'ref-finanzen-hv' }

describe('updateSignerConfig — entry-shape validation (fix round 1)', () => {
  it('accepts a well-formed body (200)', async () => {
    const { status } = await invoke(
      findRoute(),
      fakeReq({ signerStages: [VALID_STAGE], decisionAuthorityTiers: [VALID_TIER] }),
    )
    expect(status).toBe(200)
  })

  it('rejects a signerStages entry missing required_group (400, never reaches the store)', async () => {
    const { status, body } = await invoke(
      findRoute(),
      fakeReq({
        signerStages: [{ role: 'KV', certifies: ['sachlich'] }],
        decisionAuthorityTiers: [VALID_TIER],
      }),
    )
    expect(status).toBe(400)
    expect(body).toMatchObject({ success: false })
  })

  it('rejects a signerStages entry whose certifies is not a string array (400)', async () => {
    const { status } = await invoke(
      findRoute(),
      fakeReq({
        signerStages: [{ role: 'KV', required_group: 'ref-finanzen-kv', certifies: [1, 2] }],
        decisionAuthorityTiers: [VALID_TIER],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects a decisionAuthorityTiers entry with a non-numeric max_amount_cents (400)', async () => {
    const { status } = await invoke(
      findRoute(),
      fakeReq({
        signerStages: [VALID_STAGE],
        decisionAuthorityTiers: [{ max_amount_cents: 'lots', required_group: 'ref-finanzen-hv' }],
      }),
    )
    expect(status).toBe(400)
  })

  it('accepts max_amount_cents: null (the open-top tier)', async () => {
    const { status } = await invoke(
      findRoute(),
      fakeReq({
        signerStages: [VALID_STAGE],
        decisionAuthorityTiers: [{ max_amount_cents: null, required_group: 'ref-finanzen-hv' }],
      }),
    )
    expect(status).toBe(200)
  })

  it('rejects a decisionAuthorityTiers entry missing required_group (400)', async () => {
    const { status } = await invoke(
      findRoute(),
      fakeReq({
        signerStages: [VALID_STAGE],
        decisionAuthorityTiers: [{ max_amount_cents: 100 }],
      }),
    )
    expect(status).toBe(400)
  })

  it('rejects a bare array of non-objects (400) — an array of anything is no longer enough', async () => {
    const { status } = await invoke(
      findRoute(),
      fakeReq({ signerStages: ['not-an-object'], decisionAuthorityTiers: [VALID_TIER] }),
    )
    expect(status).toBe(400)
  })

  it('still 403s a non-admin caller BEFORE shape validation even runs', async () => {
    const { status, body } = await invoke(
      findRoute(),
      fakeReq({ signerStages: [VALID_STAGE], decisionAuthorityTiers: [VALID_TIER] }, 'member'),
    )
    expect(status).toBe(403)
    expect(body).toMatchObject({ code: 'ACCESS_DENIED' })
  })
})
