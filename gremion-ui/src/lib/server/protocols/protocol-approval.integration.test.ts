// The record of who submitted a protocol and who approved it, against REAL Postgres: the
// status change stamps the person and the time in the same UPDATE, and nothing else touches
// the two pairs of columns. The columns come from migration 0067.

import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '$lib/server/db'
import { createOrgUnit } from '../governance/org-units-db'
import { createProtocol, getProtocol, setProtocolStatus, isVotingMemberOfBody } from './protocol-db'

async function seed() {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'author-1',
  })
  return { unit, protocol }
}

describe('protocol approval record (real Postgres)', () => {
  beforeEach(async () => {
    await getDb()`TRUNCATE protocols, org_units CASCADE`
  })

  it('starts with nobody recorded', async () => {
    const { protocol } = await seed()
    expect(protocol.submitted_by).toBeNull()
    expect(protocol.submitted_at).toBeNull()
    expect(protocol.approved_by).toBeNull()
    expect(protocol.approved_at).toBeNull()
  })

  it('records the submitter with the time, and leaves the approver empty', async () => {
    const { protocol } = await seed()
    const submitted = await setProtocolStatus(protocol.id, 'submitted', { actorId: 'user-a' })
    expect(submitted.status).toBe('submitted')
    expect(submitted.submitted_by).toBe('user-a')
    expect(submitted.submitted_at).not.toBeNull()
    expect(submitted.approved_by).toBeNull()
    expect(submitted.approved_at).toBeNull()
  })

  it('records the approver on publish without touching the submitter', async () => {
    const { protocol } = await seed()
    const submitted = await setProtocolStatus(protocol.id, 'submitted', { actorId: 'user-a' })
    const published = await setProtocolStatus(protocol.id, 'published', { actorId: 'user-b' })
    expect(published.status).toBe('published')
    expect(published.approved_by).toBe('user-b')
    expect(published.approved_at).not.toBeNull()
    expect(published.submitted_by).toBe('user-a')
    expect(new Date(published.submitted_at as string).getTime()).toBe(new Date(submitted.submitted_at as string).getTime())
    expect((await getProtocol(protocol.id))?.approved_by).toBe('user-b')
  })

  it('records nobody when the change names no actor (seeds)', async () => {
    const { protocol } = await seed()
    await setProtocolStatus(protocol.id, 'submitted')
    const published = await setProtocolStatus(protocol.id, 'published')
    expect(published.submitted_by).toBeNull()
    expect(published.approved_by).toBeNull()
  })

  it('counts a voting member of the body and not a non-voting one or an outsider', async () => {
    const { unit } = await seed()
    const sql = getDb()
    await sql`INSERT INTO org_unit_members (org_unit_id, user_keycloak_id, membership_type, voting)
              VALUES (${unit.id}, 'voter', 'elected', true), (${unit.id}, 'advisor', 'unelected', false)`
    expect(await isVotingMemberOfBody(unit.id, 'voter')).toBe(true)
    expect(await isVotingMemberOfBody(unit.id, 'advisor')).toBe(false)
    expect(await isVotingMemberOfBody(unit.id, 'outsider')).toBe(false)
  })
})
