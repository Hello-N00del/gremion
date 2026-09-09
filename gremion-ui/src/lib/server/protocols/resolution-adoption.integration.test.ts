// #320 (INV-5 + INV-1, ported gremion#22 M3b) — recordResolutionAdoptions
// DB-backed integration tests.
//
// Adoption = protocol publish. This suite exercises the real behaviour the
// publish route relies on, against the integration-test Postgres (the
// hash-chain trigger from migration 043 + the decided_at column from
// migration 048 both live in the DB, so only a real DB can prove the
// contract):
//   (a) decided_at is stamped on each adopted (binding) resolution,
//   (b) exactly ONE audit_log row per adopted resolution, field
//       'protocol_resolution.decided', newValue carrying the decision payload,
//   (c) a withdrawn resolution is NOT recorded (no decided_at, no audit row),
//   (d) the audit hash chain is still intact afterwards (verifyAuditChain ok),
//   (e) the whole record participates in the caller's tx — a rolled-back
//       publish leaves NO decided_at and NO audit row.
//
// The route-level wiring (helper invoked on the publish tx, in the right
// order) is pinned separately in the mocked unit test
// routes/api/protocols/[id]/publish/publish.test.ts.

import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '$lib/server/db'
import { createOrgUnit, addOrgUnitMember } from '../governance/org-units-db'
import { readAuditLog, verifyAuditChain } from '$lib/server/audit-db'
import {
  createProtocol,
  addResolution,
  listResolutions,
  recordResolutionAdoptions,
} from './protocol-db'

const ADOPTER = 'admin-user-1'

async function seedProtocolWithResolutions() {
  const unit = await createOrgUnit({
    name: 'Rat', description: null, parentId: null, kind: 'council',
    visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
  })
  for (let i = 0; i < 3; i++) {
    await addOrgUnitMember({
      orgUnitId: unit.id, userKeycloakId: `voter-${i}`, membershipType: 'elected',
      termStart: null, termEnd: null, voting: true,
    })
  }
  const protocol = await createProtocol({
    committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'voter-0',
  })
  const passed = await addResolution(protocol.id, {
    text: 'Antrag A', votesYes: 2, votesNo: 0, votesAbstain: 1, result: 'passed', requiredMajority: 'simple',
  })
  const rejected = await addResolution(protocol.id, {
    text: 'Antrag B', votesYes: 0, votesNo: 3, votesAbstain: 0, result: 'rejected', requiredMajority: 'two_thirds',
  })
  const withdrawn = await addResolution(protocol.id, {
    text: 'Antrag C', votesYes: 0, votesNo: 0, votesAbstain: 0, result: 'withdrawn', requiredMajority: 'simple',
  })
  return { protocol, passed, rejected, withdrawn }
}

describe('#320 recordResolutionAdoptions (integration)', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols` // cascades protocol_resolutions
    await sql`DELETE FROM org_unit_members`
    await sql`DELETE FROM org_units`
  })

  it('stamps decided_at + writes exactly one audit row per binding resolution, skips withdrawn, chain intact', async () => {
    const { protocol, passed, rejected, withdrawn } = await seedProtocolWithResolutions()
    const resolutions = await listResolutions(protocol.id)

    const recorded = await getDb().begin((tx) =>
      recordResolutionAdoptions(ADOPTER, resolutions, tx),
    )

    // Two binding resolutions recorded (passed + rejected); withdrawn skipped.
    expect(recorded).toBe(2)

    // (a) + (c) decided_at: set on the binding rows, NULL on the withdrawn one.
    const after = await listResolutions(protocol.id)
    const byId = Object.fromEntries(after.map((r) => [r.id, r]))
    expect(byId[passed.id].decided_at).not.toBeNull()
    expect(byId[rejected.id].decided_at).not.toBeNull()
    expect(byId[withdrawn.id].decided_at).toBeNull()

    // (b) exactly one audit row per binding resolution, with the decision payload.
    const audits = await readAuditLog('protocol_resolution.decided')
    expect(audits).toHaveLength(2)
    for (const a of audits) {
      expect(a.userId).toBe(ADOPTER)
      expect(a.oldValue).toBeNull()
    }
    const payloads = audits.map((a) => JSON.parse(a.newValue) as Record<string, unknown>)
    const passedPayload = payloads.find((p) => p.resolutionId === passed.id)
    const rejectedPayload = payloads.find((p) => p.resolutionId === rejected.id)
    expect(passedPayload).toEqual({
      resolutionId: passed.id, result: 'passed',
      votesYes: 2, votesNo: 0, votesAbstain: 1, requiredMajority: 'simple',
    })
    expect(rejectedPayload).toEqual({
      resolutionId: rejected.id, result: 'rejected',
      votesYes: 0, votesNo: 3, votesAbstain: 0, requiredMajority: 'two_thirds',
    })
    // (c) no audit row references the withdrawn resolution.
    expect(payloads.some((p) => p.resolutionId === withdrawn.id)).toBe(false)

    // (d) the hash chain is still intact after the adoption writes.
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('records nothing (0) and writes no audit row when every resolution is withdrawn', async () => {
    const unit = await createOrgUnit({
      name: 'Rat', description: null, parentId: null, kind: 'council',
      visibility: 'all_members', wantsMatrixRoom: false, wantsNextcloudFolder: false,
    })
    const protocol = await createProtocol({
      committeeId: unit.id, meetingDate: '2026-06-21', title: 'Sitzung', createdBy: 'x',
    })
    await addResolution(protocol.id, {
      text: 'Zurückgezogen', votesYes: 0, votesNo: 0, votesAbstain: 0, result: 'withdrawn', requiredMajority: 'simple',
    })
    const resolutions = await listResolutions(protocol.id)

    const recorded = await getDb().begin((tx) => recordResolutionAdoptions(ADOPTER, resolutions, tx))

    expect(recorded).toBe(0)
    expect(await readAuditLog('protocol_resolution.decided')).toHaveLength(0)
    expect((await listResolutions(protocol.id))[0].decided_at).toBeNull()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // #429 — republishing a protocol must be a NON-EVENT for already-decided
  // resolutions: no decided_at re-stamp, no duplicate audit row.
  // ─────────────────────────────────────────────────────────────────────────

  it('#429 (a): first call stamps decided_at + writes exactly one audit row per adopted resolution', async () => {
    const { protocol, passed, rejected } = await seedProtocolWithResolutions()
    const resolutions = await listResolutions(protocol.id)

    const recorded = await getDb().begin((tx) =>
      recordResolutionAdoptions(ADOPTER, resolutions, tx),
    )

    expect(recorded).toBe(2)
    const after = await listResolutions(protocol.id)
    const byId = Object.fromEntries(after.map((r) => [r.id, r]))
    expect(byId[passed.id].decided_at).not.toBeNull()
    expect(byId[rejected.id].decided_at).not.toBeNull()
    expect(await readAuditLog('protocol_resolution.decided')).toHaveLength(2)
  })

  it('#429 (b): republish leaves decided_at unchanged and appends NO new audit rows', async () => {
    const { protocol, passed, rejected } = await seedProtocolWithResolutions()

    // First publish: stamps + logs as usual.
    const firstResolutions = await listResolutions(protocol.id)
    const firstRecorded = await getDb().begin((tx) =>
      recordResolutionAdoptions(ADOPTER, firstResolutions, tx),
    )
    expect(firstRecorded).toBe(2)

    const afterFirst = await listResolutions(protocol.id)
    const decidedAtById = Object.fromEntries(afterFirst.map((r) => [r.id, r.decided_at]))
    expect(decidedAtById[passed.id]).not.toBeNull()
    expect(decidedAtById[rejected.id]).not.toBeNull()
    const auditsAfterFirst = await readAuditLog('protocol_resolution.decided')
    expect(auditsAfterFirst).toHaveLength(2)

    // Republish (e.g. after document regeneration): same resolutions, called again.
    const secondRecorded = await getDb().begin((tx) =>
      recordResolutionAdoptions(ADOPTER, afterFirst, tx),
    )
    expect(secondRecorded).toBe(0)

    // decided_at is unchanged — no re-stamp. (postgres.js returns timestamptz
    // as a Date; toEqual does value comparison, not reference identity.)
    const afterSecond = await listResolutions(protocol.id)
    const decidedAtById2 = Object.fromEntries(afterSecond.map((r) => [r.id, r.decided_at]))
    expect(decidedAtById2[passed.id]).toEqual(decidedAtById[passed.id])
    expect(decidedAtById2[rejected.id]).toEqual(decidedAtById[rejected.id])

    // Still exactly the two original audit rows — no duplicates appended.
    const auditsAfterSecond = await readAuditLog('protocol_resolution.decided')
    expect(auditsAfterSecond).toHaveLength(2)
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('#429 (c): a mix of already-decided and newly-adopted resolutions stamps only the new ones', async () => {
    const { protocol, passed, rejected } = await seedProtocolWithResolutions()

    // Adopt just the `passed` resolution first (simulates it having already
    // been decided by a prior publish).
    const recordedFirst = await getDb().begin((tx) =>
      recordResolutionAdoptions(ADOPTER, [passed], tx),
    )
    expect(recordedFirst).toBe(1)
    const auditsAfterFirst = await readAuditLog('protocol_resolution.decided')
    expect(auditsAfterFirst).toHaveLength(1)
    const passedDecidedAt = (await listResolutions(protocol.id)).find((r) => r.id === passed.id)!.decided_at
    expect(passedDecidedAt).not.toBeNull()

    // Republish with the full resolution set — `passed` already decided,
    // `rejected` newly adopted.
    const allResolutions = await listResolutions(protocol.id)
    const recordedSecond = await getDb().begin((tx) =>
      recordResolutionAdoptions(ADOPTER, allResolutions, tx),
    )
    expect(recordedSecond).toBe(1) // only `rejected` is new

    const after = await listResolutions(protocol.id)
    const byId = Object.fromEntries(after.map((r) => [r.id, r]))
    // `passed`'s decided_at is untouched by the second call.
    expect(byId[passed.id].decided_at).toEqual(passedDecidedAt)
    expect(byId[rejected.id].decided_at).not.toBeNull()

    // Exactly one NEW audit row (for `rejected`) — total is now 2, not 3.
    const auditsAfterSecond = await readAuditLog('protocol_resolution.decided')
    expect(auditsAfterSecond).toHaveLength(2)
    const payloads = auditsAfterSecond.map((a) => JSON.parse(a.newValue) as Record<string, unknown>)
    expect(payloads.filter((p) => p.resolutionId === passed.id)).toHaveLength(1)
    expect(payloads.filter((p) => p.resolutionId === rejected.id)).toHaveLength(1)
  })

  it('(e) a rolled-back publish tx leaves NO decided_at and NO audit row (atomic participation)', async () => {
    const { protocol, passed } = await seedProtocolWithResolutions()
    const resolutions = await listResolutions(protocol.id)

    await expect(
      getDb().begin(async (tx) => {
        await recordResolutionAdoptions(ADOPTER, resolutions, tx)
        // Simulate a later failure in the same publish tx (e.g. the status flip).
        throw new Error('publish failed after adoption record')
      }),
    ).rejects.toThrow('publish failed after adoption record')

    // Nothing from the rolled-back tx persisted.
    const after = await listResolutions(protocol.id)
    expect(after.find((r) => r.id === passed.id)?.decided_at).toBeNull()
    expect(await readAuditLog('protocol_resolution.decided')).toHaveLength(0)
    // The chain (empty) is still valid.
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })
})
