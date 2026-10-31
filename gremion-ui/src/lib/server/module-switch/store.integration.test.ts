// Module switch record (Karenz phase 1, Task 10): the tenant-side table
// module_switch_request (migration 0063) and the store functions the service and the
// reconciler use. Runs against the migrated integration database (pnpm test:integration).
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import { claimNotification, claimTransition, insertSwitch, listSwitches, pendingSwitches, updateSwitch, type SwitchRow } from './store'

function row(over: Partial<SwitchRow> = {}): Pick<SwitchRow, 'requestId' | 'moduleId' | 'action' | 'actorUserId'> & Partial<SwitchRow> {
  return { requestId: randomUUID(), moduleId: 'votes', action: 'enable', actorUserId: randomUUID(), ...over }
}

beforeEach(async () => {
  await getDb()`TRUNCATE module_switch_request`
})

describe('insertSwitch / listSwitches', () => {
  it('round-trips a row and defaults the state to queued', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    const list = await listSwitches(db, 10)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      requestId: r.requestId,
      moduleId: 'votes',
      action: 'enable',
      actorUserId: r.actorUserId,
      state: 'queued',
      outcome: null,
      configError: null,
      appliedAt: null,
      finishedAt: null,
      notifiedAt: null,
      claimedAt: null,
    })
    expect(list[0]!.submittedAt).toBeInstanceOf(Date)
  })

  it('lists newest first and honours the limit', async () => {
    const db = getDb()
    const a = row()
    const b = row()
    await insertSwitch(db, a)
    await getDb()`UPDATE module_switch_request SET submitted_at = now() - interval '1 hour' WHERE request_id = ${a.requestId}`
    await insertSwitch(db, b)
    const list = await listSwitches(db, 1)
    expect(list.map((x) => x.requestId)).toEqual([b.requestId])
    expect((await listSwitches(db, 10)).map((x) => x.requestId)).toEqual([b.requestId, a.requestId])
  })

  it('a bad action or state violates the CHECK', async () => {
    const db = getDb()
    await expect(insertSwitch(db, row({ action: 'drop' as never }))).rejects.toMatchObject({ code: '23514' })
    const r = row()
    await insertSwitch(db, r)
    await expect(updateSwitch(db, r.requestId, { state: 'exploded' as never })).rejects.toMatchObject({ code: '23514' })
  })

  it('a second insert with the same request id is a primary key violation, not a silent overwrite', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    await expect(insertSwitch(db, r)).rejects.toMatchObject({ code: '23505' })
  })
})

describe('pendingSwitches', () => {
  it('returns queued, succeeded and applying rows and excludes applied, failed, refused, expired and dead', async () => {
    const db = getDb()
    const states = ['queued', 'succeeded', 'applying', 'applied', 'failed', 'refused', 'expired', 'dead'] as const
    const ids: Record<string, string> = {}
    for (const state of states) {
      const r = row()
      ids[state] = r.requestId
      await insertSwitch(db, r)
      await updateSwitch(db, r.requestId, { state })
    }
    const pending = await pendingSwitches(db)
    expect(pending.map((x) => x.state).sort()).toEqual(['applying', 'queued', 'succeeded'])
    expect(pending.map((x) => x.requestId).sort()).toEqual([ids.queued, ids.succeeded, ids.applying].sort())
  })
})

describe('updateSwitch', () => {
  it('patches only the named fields', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    const now = new Date()
    await updateSwitch(db, r.requestId, { state: 'failed', outcome: 'GATE_REFUSED', finishedAt: now })
    const [got] = await listSwitches(db, 1)
    expect(got).toMatchObject({ state: 'failed', outcome: 'GATE_REFUSED', configError: null })
    expect(got!.finishedAt!.getTime()).toBe(now.getTime())
  })

  it('an empty patch changes nothing and does not throw', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    await updateSwitch(db, r.requestId, {})
    expect((await listSwitches(db, 1))[0]!.state).toBe('queued')
  })
})

describe('claimTransition', () => {
  it('lets exactly one of two concurrent callers move succeeded -> applying', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    await updateSwitch(db, r.requestId, { state: 'succeeded' })
    const results = await Promise.all([
      claimTransition(db, r.requestId, ['succeeded'], 'applying'),
      claimTransition(db, r.requestId, ['succeeded'], 'applying'),
    ])
    const winners = results.filter((x) => x !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ requestId: r.requestId, state: 'applying' })
    expect(winners[0]!.claimedAt).toBeInstanceOf(Date)
  })

  it('a fresh applying row cannot be re-claimed; one with an expired lease can', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    await updateSwitch(db, r.requestId, { state: 'succeeded' })
    expect(await claimTransition(db, r.requestId, ['succeeded'], 'applying')).not.toBeNull()
    // fresh lease: refused
    expect(await claimTransition(db, r.requestId, ['succeeded'], 'applying')).toBeNull()
    // lease expired (claimed_at in the past): the crashed pass is retried
    await getDb()`UPDATE module_switch_request SET claimed_at = now() - interval '10 minutes' WHERE request_id = ${r.requestId}`
    const again = await claimTransition(db, r.requestId, ['succeeded'], 'applying')
    expect(again).toMatchObject({ requestId: r.requestId, state: 'applying' })
  })

  it('honours a custom lease', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    await updateSwitch(db, r.requestId, { state: 'succeeded' })
    await claimTransition(db, r.requestId, ['succeeded'], 'applying')
    await getDb()`UPDATE module_switch_request SET claimed_at = now() - interval '30 seconds' WHERE request_id = ${r.requestId}`
    expect(await claimTransition(db, r.requestId, ['succeeded'], 'applying', { leaseS: 120 })).toBeNull()
    expect(await claimTransition(db, r.requestId, ['succeeded'], 'applying', { leaseS: 10 })).not.toBeNull()
  })

  it('returns null for a row in none of the from states and for an unknown id', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    await updateSwitch(db, r.requestId, { state: 'applied' })
    expect(await claimTransition(db, r.requestId, ['succeeded'], 'applying')).toBeNull()
    expect(await claimTransition(db, randomUUID(), ['succeeded'], 'applying')).toBeNull()
  })

  it('moves from several allowed source states', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    const got = await claimTransition(db, r.requestId, ['queued', 'succeeded'], 'succeeded')
    expect(got).toMatchObject({ state: 'succeeded' })
  })
})

describe('claimNotification', () => {
  it('returns true once and false afterwards', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    expect(await claimNotification(db, r.requestId)).toBe(true)
    expect(await claimNotification(db, r.requestId)).toBe(false)
    expect((await listSwitches(db, 1))[0]!.notifiedAt).toBeInstanceOf(Date)
  })

  it('exactly one of two concurrent callers wins', async () => {
    const db = getDb()
    const r = row()
    await insertSwitch(db, r)
    const results = await Promise.all([claimNotification(db, r.requestId), claimNotification(db, r.requestId)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('returns false for an unknown request id', async () => {
    expect(await claimNotification(getDb(), randomUUID())).toBe(false)
  })
})
