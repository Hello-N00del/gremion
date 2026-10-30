// test/finance-groups-header.test.ts.
//
// The ACL forwarded the actor's Keycloak groups comma-joined in x-finance-groups and
// the leaf split them on ','. A group NAME containing a comma (an org-unit / Keycloak
// group named e.g. "Team X,ref-finanzen-hv") therefore smuggled a signer group
// into the leaf's Vier-Augen eligibility check. The groups now travel as one
// unambiguous value: x-finance-groups-json = base64url(JSON.stringify(groups)). The
// legacy comma header is no longer read, and a malformed value is the fail-closed
// empty group set.
//
// HTTP round trips through the real server + routes; the store sees a fake Sql that
// answers only the queries signApproval issues, so the per-stage required_group
// check is what decides the outcome.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import type { Sql, TenantRef } from '../src/tenant-store.ts'

const SECRET = 'groups-header-secret'
const BASE_HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': 'dddddddd-0000-4000-8000-00000000000d',
  'x-tenant-slug': 'groupsheader',
  'content-type': 'application/json',
  'x-finance-user-id': 'u-signer',
  'x-finance-is-auditor': 'false',
  'x-finance-is-superuser': 'false',
}

const encode = (groups: unknown): string => Buffer.from(JSON.stringify(groups), 'utf8').toString('base64url')

/** A pending single-stage budget_plan approval whose only stage needs ref-finanzen-hv. */
function approvalSql(): Sql {
  const fn = ((strings: TemplateStringsArray) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    if (/FROM finance\.approval WHERE id/.test(q)) {
      return Promise.resolve([{
        id: '9', approvable_type: 'budget_plan', approvable_id: '3', created_by: 'creator',
        amount_cents: null, status: 'pending', current_stage_index: 0, method: 'manual',
      }])
    }
    if (/FROM finance\.approval_stage WHERE approval_id/.test(q)) {
      return Promise.resolve([{
        id: '21', approval_id: '9', stage_index: 0, role: 'HV', required_group: 'ref-finanzen-hv',
        certifies: ['anordnung'], state: 'pending', signer_user_id: null, acted_at: null, note: null,
        step_up_loa: null, step_up_at: null,
      }])
    }
    return Promise.resolve([])
  }) as unknown as Sql
  ;(fn as unknown as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (cb) => cb(fn)
  return fn
}

describe('x-finance-groups-json: unambiguous group forwarding', () => {
  let base: string
  let server: ReturnType<typeof createServer>

  beforeAll(async () => {
    const storeFn = async (_t: TenantRef): Promise<Sql> => approvalSql()
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const sign = (extra: Record<string, string>) =>
    fetch(`${base}/api/v1/approvals/9/sign`, {
      method: 'POST', headers: { ...BASE_HEADERS, ...extra }, body: JSON.stringify({ note: 'ok' }),
    })

  it('a group name containing a comma cannot smuggle a signer group (encoded header)', async () => {
    const res = await sign({ 'x-finance-groups-json': encode(['Team X,ref-finanzen-hv']) })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('NOT_ELIGIBLE')
  })

  it('the legacy comma-joined header is no longer read (the smuggled group grants nothing)', async () => {
    const res = await sign({ 'x-finance-groups': 'Team X,ref-finanzen-hv' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('NOT_ELIGIBLE')
  })

  it('a real signer group in the encoded header is honoured (the stage signs)', async () => {
    const res = await sign({ 'x-finance-groups-json': encode(['ref-finanzen-hv', 'Team, with comma']) })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toBe('approved')
  })

  for (const [label, value] of [
    ['not base64url JSON', '%%%not-base64%%%'],
    ['a JSON object, not an array', encode({ g: 'ref-finanzen-hv' })],
    ['a JSON string', encode('ref-finanzen-hv')],
  ] as const) {
    it(`a malformed header (${label}) is the fail-closed empty group set`, async () => {
      const res = await sign({ 'x-finance-groups-json': value })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { code: string }).code).toBe('NOT_ELIGIBLE')
    })
  }

  it('non-string entries are dropped, string entries kept verbatim', async () => {
    const res = await sign({ 'x-finance-groups-json': encode([42, null, 'ref-finanzen-hv']) })
    expect(res.status, await res.clone().text()).toBe(200)
  })
})
