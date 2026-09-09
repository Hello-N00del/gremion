import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../../db'
import { createOrgUnit } from '../org-units-db'
import {
  ensureResourceRow, getResource, getResources,
  markResourceOk, markResourceFailed, listDueOrgUnitIds,
  GIVE_UP_AFTER_SECONDS
} from './ledger'

async function freshUnit() {
  return createOrgUnit({
    name: 'T', description: null, parentId: null, kind: 'group',
    visibility: 'all_members', wantsMatrixRoom: true, wantsNextcloudFolder: true
  })
}

describe('provisioning ledger', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM committee_elections`
    await sql`DELETE FROM org_units`
  })

  it('ensureResourceRow is idempotent and starts pending', async () => {
    const u = await freshUnit()
    await ensureResourceRow(u.id, 'keycloak')
    await ensureResourceRow(u.id, 'keycloak')
    const r = await getResource(u.id, 'keycloak')
    expect(r?.status).toBe('pending')
    expect((await getResources(u.id)).length).toBe(1)
  })

  it('markResourceOk stores the external id and clears retry state', async () => {
    const u = await freshUnit()
    await ensureResourceRow(u.id, 'matrix')
    await markResourceOk(u.id, 'matrix', '!room:server')
    const r = await getResource(u.id, 'matrix')
    expect(r?.status).toBe('ok')
    expect(r?.external_id).toBe('!room:server')
    expect(r?.next_attempt_at).toBeNull()
  })

  it('markResourceFailed increments attempts and schedules a retry', async () => {
    const u = await freshUnit()
    await ensureResourceRow(u.id, 'nextcloud')
    await markResourceFailed(u.id, 'nextcloud', 'boom')
    const r = await getResource(u.id, 'nextcloud')
    expect(r?.status).toBe('failed')
    expect(r?.attempts).toBe(1)
    expect(r?.last_error).toBe('boom')
    expect(r?.next_attempt_at).not.toBeNull()
  })

  it('listDueOrgUnitIds returns units with a non-ok, due resource', async () => {
    const u = await freshUnit()
    await ensureResourceRow(u.id, 'keycloak') // pending, next_attempt_at NULL -> due
    expect(await listDueOrgUnitIds()).toContain(u.id)
    await markResourceOk(u.id, 'keycloak', 'g1')
    expect(await listDueOrgUnitIds()).not.toContain(u.id)
  })

  it('a failed resource older than GIVE_UP_AFTER is no longer due; a successful retry resets it', async () => {
    const u = await freshUnit()
    await ensureResourceRow(u.id, 'keycloak')
    await markResourceFailed(u.id, 'keycloak', 'down')
    await getDb()`UPDATE provisioning_resources SET first_failed_at = now() - make_interval(secs => ${GIVE_UP_AFTER_SECONDS + 60}), next_attempt_at = now() - interval '1 minute' WHERE org_unit_id = ${u.id} AND subsystem = 'keycloak'`
    expect((await listDueOrgUnitIds()).includes(u.id)).toBe(false)
    await markResourceOk(u.id, 'keycloak', 'kc-ext-1')
    const rows = await getResources(u.id)
    const row = rows[0]
    expect(row.first_failed_at).toBeNull()
    expect(row.attempts).toBe(0)
  })
})
