// @vitest-environment node
//
// TRD-196 / PRD-OPS-005 — the elections module's erasure hook. The kernel holds
// exactly one personal datum of an election: committee_elections.created_by (the
// organiser). It is NOT NULL uuid, so it is replaced by the nil uuid, not nulled.
// The election rows themselves, their Helios uuid, tallies and results are
// election-integrity records (RC-ELE -> RC-GOV-RES / RC-GOV-SECRET) and stay: the
// hook never deletes a row and never touches a ballot or a tally.
import { describe, expect, it } from 'vitest'
import type { Sql } from '@gremion/db'
import { electionsErasureHook, ELECTIONS_ERASED_UUID } from './erasure'

function fakeDb(count: number) {
  const calls: { text: string; values: unknown[] }[] = []
  const db = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values })
    return Promise.resolve({ count })
  }
  return { db: db as unknown as Sql, calls }
}

describe('electionsErasureHook', () => {
  it('is registered under the module id and needs a connection', () => {
    expect(electionsErasureHook.moduleId).toBe('elections')
    expect(electionsErasureHook.requiresConnection).not.toBe(false)
  })

  it('pseudonymises created_by of the subject with the nil uuid and reports the count', async () => {
    const { db, calls } = fakeDb(2)
    const res = await electionsErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db })
    expect(res).toEqual({ status: 'erased', counts: { committee_elections: 2 } })
    expect(ELECTIONS_ERASED_UUID).toBe('00000000-0000-0000-0000-000000000000')
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/UPDATE committee_elections SET created_by/)
    expect(calls[0].text).not.toMatch(/DELETE/i)
    expect(calls[0].values).toEqual([ELECTIONS_ERASED_UUID, 'u-1'])
  })

  it('no connection: skipped', async () => {
    const res = await electionsErasureHook.erase({ tenantId: 't', subjectId: 'u-1', db: null })
    expect(res.status).toBe('skipped')
  })
})
