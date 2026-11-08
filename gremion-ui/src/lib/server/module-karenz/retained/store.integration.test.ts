// Module Karenz (phase 2, Task 10): the sealed copies against the migrated integration database.
// A superuser holds every privilege, so the append-only proof runs as a real non-superuser role that
// gets exactly what the app role gets after reconcile (SELECT and INSERT on retained_record).
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import { subjectRef } from '$lib/server/erasure/orchestrator'
import type { TenantContext } from '$lib/server/tenant/context'
import { markStep } from '../store'
import { resetRetainedGuardCache } from '../retained-guard'
import { openLines, rewrapDataKeys, sealLines } from './crypto'
import { _clearRetentionRegistriesForTests, registerRetainedSink, type RetainedLine } from './extractors'
import { listRecordsOfKarenz, listRetained, republishRetainedForSubject, resetPublishStepsForSubject } from './serve'
import { activeDataKey, getRetainedRecord, retainedRecordIdFor } from './store'

const ROLE = 'kz_retained_app'
const TENANT = '01920000-0000-7000-8000-00000000f1c5'
const SECRET = 'integration-secret-one'
const SECRET_2 = 'integration-secret-two'
const META = { catalogueId: 'votes', retentionClass: 'RC-TEST' }
const seam = { secret: SECRET, guard: async () => {} }

const lines: RetainedLine[] = [
  { id: 'p1', data: { title: 'Haushalt', n: 3 }, persons: [{ id: 'user-a', field: 'createdBy' }] },
  { id: 'p2', data: { title: 'zwei' }, persons: [] },
]

async function code(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
}

beforeEach(async () => {
  resetRetainedGuardCache()
  await getDb().unsafe('TRUNCATE retained_record, karenz_data_key, module_karenz_step CASCADE')
  _clearRetentionRegistriesForTests()
})

afterAll(async () => {
  const db = getDb()
  await db.unsafe(`DROP OWNED BY ${ROLE}`).catch(() => {})
  await db.unsafe(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {})
})

describe('sealed copies in the database', () => {
  it('seal then open round-trips through the tables, with the hashed refs and the hold date stored', async () => {
    const db = getDb()
    const karenz = randomUUID()
    const sealed = await sealLines(db, TENANT, karenz, 'votes.polls', lines, { ...META, holdUntil: '2036-05-06' }, seam)
    expect(await openLines(db, TENANT, sealed.id, { secret: SECRET })).toEqual(lines)
    const row = await getRetainedRecord(db, sealed.id)
    expect(row).toMatchObject({ karenzId: karenz, extractorId: 'votes.polls', lineCount: 2, plaintextSha256: sealed.sha256, holdUntil: '2036-05-06' })
    expect(row!.subjectRefs).toHaveLength(1)
    expect(row!.subjectRefs[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(await retainedRecordIdFor(db, karenz, 'votes.polls')).toBe(sealed.id)
    expect(await retainedRecordIdFor(db, karenz, 'votes.none')).toBeNull()
  })

  it('one data key serves the tenant, and a second copy for the same (karenz, extractor) violates the unique constraint', async () => {
    const db = getDb()
    const karenz = randomUUID()
    await sealLines(db, TENANT, karenz, 'votes.a', lines, META, seam)
    await sealLines(db, TENANT, karenz, 'votes.b', lines, META, seam)
    expect((await db<{ n: number }[]>`SELECT count(*)::int AS n FROM karenz_data_key`)[0]!.n).toBe(1)
    expect(await code(sealLines(db, TENANT, karenz, 'votes.a', lines, META, seam))).toBe('23505')
  })

  it('a copy that fails inside the transaction leaves no record and no data key behind', async () => {
    const db = getDb()
    await expect(
      db.begin(async (tx) => {
        await sealLines(tx as never, TENANT, randomUUID(), 'votes.a', lines, META, seam)
        throw new Error('stop')
      }),
    ).rejects.toThrow('stop')
    expect(await activeDataKey(db)).toBeNull()
    expect((await db<{ n: number }[]>`SELECT count(*)::int AS n FROM retained_record`)[0]!.n).toBe(0)
  })

  it('rewrapDataKeys keeps the copies readable under the new secret through the version-checked function', async () => {
    const db = getDb()
    const sealed = await sealLines(db, TENANT, randomUUID(), 'votes.a', lines, META, seam)
    expect(await rewrapDataKeys(db, TENANT, SECRET, SECRET_2)).toBe(1)
    expect((await activeDataKey(db))!.kekVersion).toBe(2)
    expect(await openLines(db, TENANT, sealed.id, { secret: SECRET_2 })).toEqual(lines)
    await expect(openLines(db, TENANT, sealed.id, { secret: SECRET })).rejects.toThrow(/does not (verify|unwrap)/)
  })
})

describe('retained_record is append-only for the app role', () => {
  it('rows are visible to the role for INSERT and SELECT and refuse UPDATE, DELETE and TRUNCATE once reconcile revoked them; the real guard lets the write through', async () => {
    const admin = getDb()
    await admin.unsafe(`DROP OWNED BY ${ROLE}`).catch(() => {})
    await admin.unsafe(`DROP ROLE IF EXISTS ${ROLE}`)
    await admin.unsafe(`CREATE ROLE ${ROLE} NOLOGIN`)
    await admin.unsafe(`GRANT ALL ON retained_record, karenz_data_key TO ${ROLE}`)
    const app = await admin.reserve()
    try {
      await app.unsafe(`SET ROLE ${ROLE}`)
      const karenz = randomUUID()
      const real = { secret: SECRET } // no injected guard: the real probe runs as the role

      // before reconcile: the guard refuses, nothing is written
      resetRetainedGuardCache()
      await expect(sealLines(app, TENANT, karenz, 'votes.a', lines, META, real)).rejects.toThrow(/append-only guard is missing/)
      expect((await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM retained_record`)[0]!.n).toBe(0)

      // reconcile revokes what a copy must not allow
      await admin.unsafe(`REVOKE UPDATE, DELETE, TRUNCATE ON retained_record FROM ${ROLE}`)
      resetRetainedGuardCache()
      const sealed = await sealLines(app, TENANT, karenz, 'votes.a', lines, META, real)
      expect(await openLines(app, TENANT, sealed.id, { secret: SECRET })).toEqual(lines)
      expect(await code(app.unsafe('UPDATE retained_record SET line_count = 9'))).toBe('42501')
      expect(await code(app.unsafe('DELETE FROM retained_record'))).toBe('42501')
      expect(await code(app.unsafe('TRUNCATE retained_record'))).toBe('42501')
      // the data key can only be replaced through the version-checked function
      expect(await code(app.unsafe("UPDATE karenz_data_key SET wrapped = 'x'::bytea"))).toBe('42501')
      expect(await rewrapDataKeys(app, TENANT, SECRET, SECRET_2)).toBe(1)
      expect(await openLines(app, TENANT, sealed.id, { secret: SECRET_2 })).toEqual(lines)
    } finally {
      await app.unsafe('RESET ROLE').catch(() => {})
      app.release()
      resetRetainedGuardCache()
    }
  })
})

describe('serving: the publish steps and the lists, against the real SQL', () => {
  const REF_A = subjectRef(TENANT, 'user-a', SECRET)
  const lineB: RetainedLine[] = [{ id: 'q1', data: { title: 'x', createdBy: 'Max Muster' }, persons: [{ id: 'user-b', field: 'createdBy' }] }]
  const named: RetainedLine[] = [{ id: 'p1', data: { title: 'Haushalt', createdBy: 'Erika Beispiel' }, persons: [{ id: 'user-a', field: 'createdBy' }] }]

  async function setup() {
    const db = getDb()
    const k1 = randomUUID()
    const k2 = randomUUID()
    const a = await sealLines(db, TENANT, k1, 'votes.a', named, META, seam)
    const b = await sealLines(db, TENANT, k1, 'votes.b', lineB, META, seam)
    const c = await sealLines(db, TENANT, k2, 'votes.c', named, META, seam)
    for (const [k, id] of [[k1, a.id], [k1, b.id], [k2, c.id]] as const) await markStep(db, k, `publish:files:${id}`, { state: 'done' })
    await markStep(db, k1, 'publish:list', { state: 'done' })
    await markStep(db, k1, 'retained', { state: 'done' })
    return { db, k1, k2, a, b, c }
  }
  const stateOf = async (k: string, step: string) => (await getDb()<{ state: string }[]>`SELECT state FROM module_karenz_step WHERE karenz_id = ${k} AND step = ${step}`)[0]?.state

  it('resetPublishStepsForSubject resets only the publish steps of the records naming the subject, in every Karenz row', async () => {
    const { db, k1, k2, a, b, c } = await setup()
    expect(await resetPublishStepsForSubject(db, REF_A)).toBe(2)
    expect(await stateOf(k1, `publish:files:${a.id}`)).toBe('pending')
    expect(await stateOf(k2, `publish:files:${c.id}`)).toBe('pending')
    expect(await stateOf(k1, `publish:files:${b.id}`)).toBe('done')
    expect(await stateOf(k1, 'publish:list')).toBe('done')
    expect(await stateOf(k1, 'retained')).toBe('done')
    expect(await resetPublishStepsForSubject(db, subjectRef(TENANT, 'nobody', SECRET))).toBe(0)
  })

  it('listRecordsOfKarenz lists the records of that row only; listRetained all of them without ciphertext', async () => {
    const { db, k1, k2, a, b, c } = await setup()
    expect((await listRecordsOfKarenz(db, k1)).map((r) => r.id).toSorted()).toEqual([a.id, b.id].toSorted())
    expect(await listRecordsOfKarenz(db, k2)).toEqual([{ id: c.id, catalogueId: 'votes' }])
    const all = await listRetained(TENANT, db)
    expect(all.map((r) => r.id).toSorted()).toEqual([a.id, b.id, c.id].toSorted())
  })

  it('republishRetainedForSubject publishes the redacted copy and marks the step done, for a row that is not live', async () => {
    const { db, k1, a } = await setup()
    // an erasure report names the subject, whatever its status
    await db`DELETE FROM erasure_report WHERE tenant_id = ${TENANT} AND status = 'running'`
    await db`INSERT INTO erasure_report (tenant_id, subject_ref, requested_by) VALUES (${TENANT}, ${REF_A}, 'integration-test')`
    const sent: string[] = []
    registerRetainedSink({ id: 'files', available: () => true, publish: async (c) => void sent.push(c.ndjson.toString('utf8')) })
    const out = await republishRetainedForSubject({ id: TENANT, slug: 'fixture', db } as unknown as TenantContext, REF_A, { secret: SECRET })
    expect(out.unreachable).toEqual([])
    expect(out.failed).toEqual([])
    expect(out.published).toBe(2)
    expect(await stateOf(k1, `publish:files:${a.id}`)).toBe('done')
    expect(sent).toHaveLength(2)
    for (const text of sent) {
      expect(text).not.toContain('Erika Beispiel')
      expect(text).toContain('"createdBy":"erased"')
    }
    await db`DELETE FROM erasure_report WHERE tenant_id = ${TENANT} AND status = 'running'`
  })
})
