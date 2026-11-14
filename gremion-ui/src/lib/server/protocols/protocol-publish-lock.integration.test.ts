// #433 — the publish lock on resolution edits/deletes, proven against REAL
// Postgres with two connections.
//
// The mocked-sql unit tests (protocol-db.test.ts) can only inspect the emitted
// SQL; they cannot evaluate a WHERE clause or model concurrency. The race the
// lock exists for is a Read Committed interleaving: an edit whose statement
// started while the publish transaction was still open, and which therefore
// blocks behind it. When the publish commits, Postgres re-checks the blocked
// statement's predicate only against the NEWEST version of the row it targets;
// a plain sub-SELECT on the parent protocol still reads the statement's old
// snapshot and says "not published". So these tests hold a publish transaction
// OPEN, start the edit/delete while it is open, wait until the database reports
// the statement is blocked, and only then commit the publish.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getDb } from '$lib/server/db'
import { createOrgUnit } from '../governance/org-units-db'
import { actor } from '../audit-test-actor'
import {
  createProtocol,
  addResolution,
  listResolutions,
  updateProtocol,
  assignGlobalNrs,
  setProtocolStatus,
  recordResolutionAdoptions,
  updateResolution,
  deleteResolution,
  ResolutionPublishedError,
  ResolutionNotFoundError,
  ProtocolNotEditableError,
} from './protocol-db'

const ADOPTER = actor('admin-user-1')
const MISSING_ID = '00000000-0000-4000-8000-000000000000'

async function seed(status: 'draft' | 'submitted' = 'submitted') {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'author-1',
  })
  const resolution = await addResolution(protocol.id, {
    text: 'Antrag A', votesYes: 2, votesNo: 0, votesAbstain: 1, result: 'passed', requiredMajority: 'simple',
  })
  const sql = getDb()
  await sql`UPDATE protocols SET status = ${status} WHERE id = ${protocol.id}`
  return { unit, protocol, resolution }
}

async function countResolutions(protocolId: string): Promise<number> {
  const [row] = await getDb()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM protocol_resolutions WHERE protocol_id = ${protocolId}`
  return row.n
}

const NEW_RESOLUTION = {
  text: 'Antrag B', votesYes: 1, votesNo: 0, votesAbstain: 0, result: 'passed', requiredMajority: 'simple',
} as const

async function textOf(id: string): Promise<string | undefined> {
  const [row] = await getDb()<{ text: string }[]>`SELECT text FROM protocol_resolutions WHERE id = ${id}`
  return row?.text
}

/** Poll until some backend is blocked on a lock behind the open publish tx. */
async function waitUntilBlocked(statement: string): Promise<void> {
  const sql = getDb()
  for (let i = 0; i < 100; i++) {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${'%' + statement + '%'}`
    if (row.n > 0) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no "${statement}" statement became blocked within 5s`)
}

/**
 * Run the publish flow's writes (same order and helpers as the publish route:
 * updateProtocol, assignGlobalNrs, status flip) in a transaction that stays open
 * until `commit()` is called. Resolves once the locks are taken.
 *
 * `stampAdoption` also runs recordResolutionAdoptions (decided_at) like the route
 * does. Without the stamp only the parent-status predicate (FOR SHARE) can refuse
 * the blocked statement, so that variant is the guard for FOR SHARE; the decided_at
 * predicate has its own test below (an adopted row on an unpublished protocol).
 */
async function openPublishTx(protocolId: string, committeeId: string, stampAdoption: boolean) {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let locked!: () => void
  const lockedP = new Promise<void>((r) => { locked = r })
  const resolutions = await listResolutions(protocolId)
  const done = getDb().begin(async (tx) => {
    await updateProtocol(protocolId, { bodyHtml: '<p>final</p>' }, { tx, allowPublished: true })
    await assignGlobalNrs(committeeId, 2026, resolutions.map((r) => r.id), tx)
    if (stampAdoption) await recordResolutionAdoptions(ADOPTER, resolutions, tx)
    await setProtocolStatus(protocolId, 'published', { tx })
    locked()
    await gate
  })
  await lockedP
  const handle = { commit: () => { release(); return done } }
  open.push(handle)
  return handle
}

// A test that fails before it commits must not leave the publish tx (and its row
// locks) open for the rest of the file.
const open: { commit: () => Promise<unknown> }[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.commit().catch(() => {})
})

describe('#433 publish lock (real Postgres)', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols` // cascades protocol_resolutions
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  describe.each([
    { stampAdoption: false, variant: 'publish writes only the protocol status (FOR SHARE is the only guard)' },
    { stampAdoption: true, variant: 'publish also stamps decided_at (the real route)' },
  ])('publish tx open, $variant', ({ stampAdoption }) => {
    it('an edit that blocks behind it is refused once the publish commits', async () => {
      const { unit, protocol, resolution } = await seed('submitted')
      const publish = await openPublishTx(protocol.id, unit.id, stampAdoption)

      const outcome = updateResolution(resolution.id, { text: 'tampered' })
        .then(() => 'applied' as const, (e: unknown) => e)
      await waitUntilBlocked('UPDATE protocol_resolutions')
      await publish.commit()

      expect(await outcome).toBeInstanceOf(ResolutionPublishedError)
      expect(await textOf(resolution.id)).toBe('Antrag A')
    })

    it('a delete that blocks behind it is refused once the publish commits', async () => {
      const { unit, protocol, resolution } = await seed('submitted')
      const publish = await openPublishTx(protocol.id, unit.id, stampAdoption)

      const outcome = deleteResolution(resolution.id)
        .then(() => 'applied' as const, (e: unknown) => e)
      await waitUntilBlocked('DELETE FROM protocol_resolutions')
      await publish.commit()

      expect(await outcome).toBeInstanceOf(ResolutionPublishedError)
      expect(await textOf(resolution.id)).toBe('Antrag A')
    })
  })

  it('refuses edit and delete of a resolution whose publish already committed', async () => {
    const { protocol, resolution } = await seed('submitted')
    await getDb()`UPDATE protocols SET status = 'published' WHERE id = ${protocol.id}`
    await expect(updateResolution(resolution.id, { text: 'tampered' })).rejects.toBeInstanceOf(ResolutionPublishedError)
    await expect(deleteResolution(resolution.id)).rejects.toBeInstanceOf(ResolutionPublishedError)
    expect(await textOf(resolution.id)).toBe('Antrag A')
  })

  it('refuses a stamped (adopted) resolution even though its protocol is not published', async () => {
    const { resolution } = await seed('submitted')
    await getDb()`UPDATE protocol_resolutions SET decided_at = now() WHERE id = ${resolution.id}`
    await expect(updateResolution(resolution.id, { text: 'tampered' })).rejects.toBeInstanceOf(ResolutionPublishedError)
    await expect(deleteResolution(resolution.id)).rejects.toBeInstanceOf(ResolutionPublishedError)
    expect(await textOf(resolution.id)).toBe('Antrag A')
  })

  it('still edits and deletes while the protocol is unpublished', async () => {
    const { resolution } = await seed('draft')
    await expect(updateResolution(resolution.id, { text: 'edited' })).resolves.toMatchObject({ text: 'edited' })
    await expect(deleteResolution(resolution.id)).resolves.toBeUndefined()
    expect(await textOf(resolution.id)).toBeUndefined()
  })

  it('allowPublished lets the publish flow number a published protocol (republish)', async () => {
    const { protocol, resolution } = await seed('submitted')
    await getDb()`UPDATE protocols SET status = 'published' WHERE id = ${protocol.id}`
    await expect(updateResolution(resolution.id, { globalNr: 'B-2026-001' }, { allowPublished: true }))
      .resolves.toMatchObject({ global_nr: 'B-2026-001' })
  })

  it('a row that no longer exists is reported as not found, not as a publish refusal', async () => {
    await seed('draft')
    await expect(updateResolution(MISSING_ID, { text: 'x' })).rejects.toBeInstanceOf(ResolutionNotFoundError)
    await expect(deleteResolution(MISSING_ID)).rejects.toBeInstanceOf(ResolutionNotFoundError)
  })
})

// Adding a resolution is serialised with publish the same way an edit is: the
// status check is part of the INSERT, so an add that blocks behind the publish
// transaction is decided against the committed status.
describe('adding a resolution while the protocol is being published (real Postgres)', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols` // cascades protocol_resolutions
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  describe.each([
    { stampAdoption: false, variant: 'publish writes only the protocol status' },
    { stampAdoption: true, variant: 'publish also stamps decided_at (the real route)' },
  ])('publish tx open, $variant', ({ stampAdoption }) => {
    it('an add that blocks behind it is refused once the publish commits', async () => {
      const { unit, protocol } = await seed('submitted')
      const publish = await openPublishTx(protocol.id, unit.id, stampAdoption)

      const outcome = addResolution(protocol.id, NEW_RESOLUTION)
        .then(() => 'applied' as const, (e: unknown) => e)
      await waitUntilBlocked('INSERT INTO protocol_resolutions')
      await publish.commit()

      expect(await outcome).toBeInstanceOf(ProtocolNotEditableError)
      expect(await countResolutions(protocol.id)).toBe(1)
    })
  })

  it('an add that blocks behind a row lock on the protocol waits, and is refused once the protocol is published', async () => {
    const { protocol } = await seed('submitted')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const lockedP = new Promise<void>((r) => { locked = r })
    const holder = getDb().begin(async (tx) => {
      await tx`SELECT id FROM protocols WHERE id = ${protocol.id} FOR UPDATE`
      locked()
      await gate
      await tx`UPDATE protocols SET status = 'published' WHERE id = ${protocol.id}`
    })
    open.push({ commit: () => { release(); return holder } })
    await lockedP

    const outcome = addResolution(protocol.id, NEW_RESOLUTION)
      .then(() => 'applied' as const, (e: unknown) => e)
    await waitUntilBlocked('INSERT INTO protocol_resolutions')
    release()
    await holder

    expect(await outcome).toBeInstanceOf(ProtocolNotEditableError)
    expect(await countResolutions(protocol.id)).toBe(1)
  })

  it('an add that blocks behind a row lock goes through when the protocol stays unpublished', async () => {
    const { protocol } = await seed('submitted')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const lockedP = new Promise<void>((r) => { locked = r })
    const holder = getDb().begin(async (tx) => {
      await tx`SELECT id FROM protocols WHERE id = ${protocol.id} FOR UPDATE`
      locked()
      await gate
    })
    open.push({ commit: () => { release(); return holder } })
    await lockedP

    const outcome = addResolution(protocol.id, NEW_RESOLUTION)
    await waitUntilBlocked('INSERT INTO protocol_resolutions')
    release()
    await holder

    await expect(outcome).resolves.toMatchObject({ text: 'Antrag B', sequence_nr: 2 })
    expect(await countResolutions(protocol.id)).toBe(2)
  })

  it('refuses an add to a protocol whose publish already committed', async () => {
    const { protocol } = await seed('submitted')
    await getDb()`UPDATE protocols SET status = 'published' WHERE id = ${protocol.id}`
    await expect(addResolution(protocol.id, NEW_RESOLUTION)).rejects.toBeInstanceOf(ProtocolNotEditableError)
    expect(await countResolutions(protocol.id)).toBe(1)
  })

  it('refuses an add to a protocol that does not exist', async () => {
    await seed('draft')
    await expect(addResolution(MISSING_ID, NEW_RESOLUTION)).rejects.toBeInstanceOf(ProtocolNotEditableError)
  })

  it.each(['draft', 'submitted'] as const)('numbers and stores an add to a %s protocol', async (status) => {
    const { protocol } = await seed(status)
    const added = await addResolution(protocol.id, {
      ...NEW_RESOLUTION, adoptionMode: 'acclamation', votesYes: null, votesNo: null, votesAbstain: null,
      decisionRuleParams: { fraction: 0.5 },
    })
    expect(added).toMatchObject({
      protocol_id: protocol.id, sequence_nr: 2, text: 'Antrag B', adoption_mode: 'acclamation',
      votes_yes: null, decision_rule_params: { fraction: 0.5 },
    })
  })
})
