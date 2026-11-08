// Module Karenz (phase 2, JOIN-2 fix 6 and 7): the retained write guard and the key-row
// guard of migration 0064 on a REAL, non-superuser role (a superuser holds every
// privilege, so only a role created here shows what the app role can and cannot do).
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import {
  RetainedGuardError,
  assertRetainedAppendOnly,
  insertDataKey,
  insertRetainedRecord,
  resetRetainedGuardCache,
  rewrapDataKey,
} from './retained-guard'

const ROLE = 'kz_guard_app'

async function code(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
}

const sealed = (keyId: string) => ({
  karenzId: randomUUID(),
  catalogueId: 'votes',
  retentionClass: 'RC-VOTE',
  extractorId: 'votes.polls',
  lineCount: 1,
  plaintextSha256: 'a'.repeat(64),
  keyId,
  nonce: Buffer.alloc(12),
  ciphertext: Buffer.from('sealed'),
  subjectRefs: ['ref-1', 'ref-2'],
  holdUntil: null,
})

afterAll(async () => {
  const db = getDb()
  await db.unsafe(`DROP OWNED BY ${ROLE}`).catch(() => {})
  await db.unsafe(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {})
})

describe('the retained write guard on a real, non-superuser role', () => {
  it('refuses while the role can still rewrite retained_record, writes after the revoke, and notices a disabled key guard or a column grant', async () => {
    const admin = getDb()
    await admin.unsafe('TRUNCATE retained_record, karenz_data_key CASCADE')
    await admin.unsafe(`DROP OWNED BY ${ROLE}`).catch(() => {})
    await admin.unsafe(`DROP ROLE IF EXISTS ${ROLE}`)
    await admin.unsafe(`CREATE ROLE ${ROLE} NOLOGIN`)
    await admin.unsafe(`GRANT ALL ON retained_record, karenz_data_key TO ${ROLE}`)
    const [seed] = await admin<{ key_id: string }[]>`INSERT INTO karenz_data_key (wrapped, kek_version) VALUES (${Buffer.from('seed')}, 1) RETURNING key_id`
    const app = await admin.reserve()
    const count = async () => (await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM retained_record`)[0]!.n
    try {
      await app.unsafe(`SET ROLE ${ROLE}`)

      // 1. reconcile has not run: the role holds UPDATE, DELETE and TRUNCATE
      resetRetainedGuardCache()
      const err = (await assertRetainedAppendOnly(app).catch((e: unknown) => e)) as RetainedGuardError
      expect(err).toBeInstanceOf(RetainedGuardError)
      expect(err.problems).toEqual([
        'retained_record: the role can still UPDATE',
        'retained_record: the role can still DELETE',
        'retained_record: the role can still TRUNCATE',
      ])
      await expect(insertRetainedRecord(app, sealed(seed!.key_id))).rejects.toBeInstanceOf(RetainedGuardError)
      await expect(insertDataKey(app, Buffer.from('w'))).rejects.toBeInstanceOf(RetainedGuardError)
      expect(await count(), 'nothing was written while the guard was missing').toBe(0)

      // 2. reconcile revokes: the write goes through, the hashed refs round-trip
      await admin.unsafe(`REVOKE UPDATE, DELETE, TRUNCATE ON retained_record FROM ${ROLE}`)
      resetRetainedGuardCache()
      const id = await insertRetainedRecord(app, sealed(seed!.key_id))
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      const [back] = await admin<{ subject_refs: string[] }[]>`SELECT subject_refs FROM retained_record WHERE id = ${id}`
      expect(back!.subject_refs).toEqual(['ref-1', 'ref-2'])
      expect(await code(app.unsafe('UPDATE retained_record SET line_count = 9'))).toBe('42501')

      // 3. a column-level UPDATE grant is a way to rewrite a copy too
      await admin.unsafe(`GRANT UPDATE (line_count) ON retained_record TO ${ROLE}`)
      resetRetainedGuardCache()
      await expect(assertRetainedAppendOnly(app)).rejects.toThrow(/can still UPDATE/)
      await admin.unsafe(`REVOKE UPDATE (line_count) ON retained_record FROM ${ROLE}`)

      // 4. the key-row guard trigger is part of the guard
      await admin.unsafe('ALTER TABLE karenz_data_key DISABLE TRIGGER karenz_data_key_guard_trg')
      try {
        resetRetainedGuardCache()
        await expect(assertRetainedAppendOnly(app)).rejects.toThrow(/karenz_data_key_guard_trg is missing or disabled/)
      } finally {
        await admin.unsafe('ALTER TABLE karenz_data_key ENABLE TRIGGER karenz_data_key_guard_trg')
      }
      resetRetainedGuardCache()
      await expect(assertRetainedAppendOnly(app)).resolves.toBeUndefined()

      // 5. the data key: minted through the guard, replaced only by the re-wrap function
      const keyId = await insertDataKey(app, Buffer.from('w1'))
      expect(await code(app.unsafe("UPDATE karenz_data_key SET wrapped = 'x'::bytea"))).toBe('42501')
      expect(await code(app.unsafe('DELETE FROM karenz_data_key'))).toBe('42501')
      expect(await rewrapDataKey(app, keyId, 5, Buffer.from('stale'))).toBe(false)
      expect(await rewrapDataKey(app, keyId, 1, Buffer.from('w2'))).toBe(true)
      const [k] = await admin<{ wrapped: Buffer; kek_version: number }[]>`SELECT wrapped, kek_version FROM karenz_data_key WHERE key_id = ${keyId}`
      expect(Buffer.from(k!.wrapped).toString()).toBe('w2')
      expect(k!.kek_version).toBe(2)
    } finally {
      await app.unsafe('RESET ROLE').catch(() => {})
      app.release()
      resetRetainedGuardCache()
    }
  })

  it('a superuser holds every privilege, so the probe refuses it (the injected guard is the seam for suites that run as one)', async () => {
    resetRetainedGuardCache()
    await expect(assertRetainedAppendOnly(getDb())).rejects.toBeInstanceOf(RetainedGuardError)
  })
})
