// org-units-db.members.test.ts — adversarial-review fix (#202):
// addOrgUnitMember's ON-CONFLICT upsert must NOT clobber a stored
// voting=false (sachkundige Bürger, §3.5(d)) when the caller omits `voting`
// — every runtime mutation path (orchestrator addMember, members POST,
// groups POST) omits it, so `voting = EXCLUDED.voting` silently reset the
// flag to true on any membership update.
//
// `$lib/server/db` is mocked with a recording tagged-template spy (the
// layout.server.test.ts idiom): static SQL parts joined by '$?', bound
// params captured, so we can pin the generated upsert semantics without a
// live Postgres. The behavioral round-trip lives in
// org-units-db.integration.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params: unknown[] }>,
}))

vi.mock('$lib/server/db', () => ({
  getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('$?'), params: values })
    return Promise.resolve([{ id: 'm-1' }])
  },
}))

import { addOrgUnitMember } from './org-units-db'

beforeEach(() => {
  calls.length = 0
})

describe('addOrgUnitMember voting upsert', () => {
  // params: [orgUnitId, userKeycloakId, membershipType, termStart, termEnd,
  //          votingInsertValue, votingProvidedGuard]
  it('preserves the stored voting flag on conflict when voting is omitted', async () => {
    await addOrgUnitMember({
      orgUnitId: 'ou-1',
      userKeycloakId: 'u-1',
      membershipType: 'unelected',
      termStart: null,
      termEnd: null,
    })
    expect(calls).toHaveLength(1)
    const q = calls[0]!
    // The conflict branch must fall back to the existing row's value …
    expect(q.text).toMatch(
      /voting = CASE WHEN \$\? THEN EXCLUDED\.voting ELSE org_unit_members\.voting END/
    )
    // … guarded by an explicit "was voting provided?" flag (false here),
    expect(q.params[6]).toBe(false)
    // while a fresh insert still defaults to true.
    expect(q.params[5]).toBe(true)
  })

  it('overwrites voting on conflict when explicitly provided', async () => {
    await addOrgUnitMember({
      orgUnitId: 'ou-1',
      userKeycloakId: 'u-1',
      membershipType: 'unelected',
      termStart: null,
      termEnd: null,
      voting: false,
    })
    expect(calls).toHaveLength(1)
    const q = calls[0]!
    expect(q.params[5]).toBe(false) // explicit value inserted
    expect(q.params[6]).toBe(true) // provided → EXCLUDED.voting wins on conflict
  })
})
