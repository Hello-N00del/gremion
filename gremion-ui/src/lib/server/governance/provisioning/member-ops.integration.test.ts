import { describe, it, expect } from 'vitest'
import { getDb } from '$lib/server/db'

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await getDb()<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}) AS exists`
  return rows[0].exists
}

describe('037 provisioning_member_ops schema', () => {
  it('creates provisioning_member_ops with the expected columns', async () => {
    for (const col of ['org_unit_id', 'user_keycloak_id', 'subsystem', 'op', 'status', 'attempts', 'next_attempt_at', 'first_failed_at', 'created_at']) {
      expect(await columnExists('provisioning_member_ops', col), `column ${col}`).toBe(true)
    }
  })
  it('adds first_failed_at to provisioning_resources', async () => {
    expect(await columnExists('provisioning_resources', 'first_failed_at')).toBe(true)
  })
})

import { enqueueMemberRemoveOps, listDueMemberOps, getMemberOps, markMemberOpOk, markMemberOpFailed } from './member-ops'
import { GIVE_UP_AFTER_SECONDS } from './ledger'

async function seedUnit(name = 'MO Test'): Promise<string> {
  const [u] = await getDb()<{ id: string }[]>`
    INSERT INTO org_units (name, kind, visibility) VALUES (${name}, 'committee', 'all_members') RETURNING id`
  return u.id
}

describe('member-ops outbox', () => {
  it('enqueues one remove op per subsystem and lists them due (pending)', async () => {
    const unit = await seedUnit()
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit, 'user-1', ['keycloak', 'nextcloud']) })
    const ops = await getMemberOps(unit)
    expect(ops.map((o) => o.subsystem).sort()).toEqual(['keycloak', 'nextcloud'])
    expect(ops.every((o) => o.status === 'pending' && o.op === 'remove')).toBe(true)
    expect((await listDueMemberOps()).filter((o) => o.org_unit_id === unit)).toHaveLength(2)
  })
  it('markMemberOpFailed sets first_failed_at + backoff; markMemberOpOk clears it from due', async () => {
    const unit = await seedUnit()
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit, 'user-2', ['matrix']) })
    const id = (await getMemberOps(unit))[0].id
    await markMemberOpFailed(id, 'boom')
    const failed = (await getMemberOps(unit))[0]
    expect(failed.status).toBe('failed'); expect(failed.attempts).toBe(1)
    expect(failed.first_failed_at).not.toBeNull(); expect(failed.next_attempt_at).not.toBeNull()
    await markMemberOpOk(id)
    expect((await getMemberOps(unit))[0].status).toBe('ok')
    expect((await listDueMemberOps()).some((o) => o.id === id)).toBe(false)
  })
  it('excludes a terminally-aged failed op from due', async () => {
    const unit = await seedUnit()
    await getDb().begin(async (tx) => { await enqueueMemberRemoveOps(tx, unit, 'user-3', ['keycloak']) })
    const id = (await getMemberOps(unit))[0].id
    await markMemberOpFailed(id, 'still failing')
    await getDb()`UPDATE provisioning_member_ops SET first_failed_at = now() - make_interval(secs => ${GIVE_UP_AFTER_SECONDS + 60}), next_attempt_at = now() - interval '1 minute' WHERE id = ${id}`
    expect((await listDueMemberOps()).some((o) => o.id === id)).toBe(false)
  })
})
