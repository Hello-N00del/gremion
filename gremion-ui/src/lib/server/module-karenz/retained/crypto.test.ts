// Module Karenz (phase 2, Task 10): sealing of the retained copies. AES-256-GCM per record under a
// per-tenant data key that is wrapped by a key derived from AUTH_SECRET.
import { describe, expect, it, vi } from 'vitest'
import { subjectRef } from '$lib/server/erasure/orchestrator'
import { fakeTenantDb } from './fake-db.test-util'
import { openLines, rewrapDataKeys, sealLines, RetainedNotFoundError } from './crypto'
import type { RetainedLine } from './extractors'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const KARENZ = '44444444-4444-4444-8444-444444444441'
const SECRET = 'unit-test-secret-one'
const SECRET_2 = 'unit-test-secret-two'
const META = { catalogueId: 'votes', retentionClass: 'RC-TEST' }
const guard = { guard: async () => {} }
const deps = { secret: SECRET, ...guard }

const lines: RetainedLine[] = [
  { id: 'poll-1', data: { title: 'Haushalt äöü', votes: [1, 2, { nested: true }] }, persons: [{ id: 'user-a', field: 'createdBy' }] },
  { id: 'poll-2', data: { title: 'zwei' }, persons: [{ id: 'user-a', field: 'createdBy' }, { id: 'user-b', field: 'closedBy' }] },
]

describe('seal and open', () => {
  it('seal then open round-trips', async () => {
    const t = fakeTenantDb()
    const sealed = await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    expect(sealed.lineCount).toBe(2)
    expect(sealed.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await openLines(t.db, TENANT, sealed.id, { secret: SECRET })).toEqual(lines)
  })

  it('an empty extraction seals and opens as zero lines', async () => {
    const t = fakeTenantDb()
    const sealed = await sealLines(t.db, TENANT, KARENZ, 'votes.empty', [], META, deps)
    expect(sealed.lineCount).toBe(0)
    expect(await openLines(t.db, TENANT, sealed.id, { secret: SECRET })).toEqual([])
  })

  it('one data key per tenant serves every record, and the stored bytes are not the plaintext', async () => {
    const t = fakeTenantDb()
    await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    await sealLines(t.db, TENANT, KARENZ, 'votes.other', lines, META, deps)
    expect(t.keys()).toHaveLength(1)
    expect(t.records()).toHaveLength(2)
    const stored = t.records()[0]!
    expect(stored.ciphertext.toString('utf8')).not.toContain('Haushalt')
    expect(stored.nonce).toHaveLength(12)
    expect(t.records()[0]!.nonce.equals(t.records()[1]!.nonce)).toBe(false)
    expect(t.keys()[0]!.wrapped.toString('utf8')).not.toContain('Haushalt')
  })

  it('sealLines stores the hashed subject refs of every person in the lines and never a person id', async () => {
    const t = fakeTenantDb()
    await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    const stored = t.records()[0]!
    expect([...stored.subject_refs].sort()).toEqual([subjectRef(TENANT, 'user-a', SECRET), subjectRef(TENANT, 'user-b', SECRET)].sort())
    const dump = JSON.stringify(stored)
    expect(dump).not.toContain('user-a')
    expect(dump).not.toContain('user-b')
  })

  it('the catalogue id, class and hold date go to the record row', async () => {
    const t = fakeTenantDb()
    await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, { ...META, holdUntil: '2036-01-02' }, deps)
    expect(t.records()[0]).toMatchObject({ catalogue_id: 'votes', retention_class: 'RC-TEST', extractor_id: 'votes.polls', karenz_id: KARENZ, hold_until: '2036-01-02' })
  })

  it('a flipped ciphertext byte fails to open (GCM tag)', async () => {
    const t = fakeTenantDb()
    const sealed = await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    t.records()[0]!.ciphertext[0]! ^= 0x01
    await expect(openLines(t.db, TENANT, sealed.id, { secret: SECRET })).rejects.toThrow(/does not (verify|unwrap)/)
  })

  it('opening with another tenant id or karenz id fails (AAD)', async () => {
    const t = fakeTenantDb()
    const sealed = await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    await expect(openLines(t.db, OTHER_TENANT, sealed.id, { secret: SECRET })).rejects.toThrow(/does not (verify|unwrap)/)
    // the same key, but the record claims to belong to another karenz row or extractor: the AAD no longer matches
    t.records()[0]!.karenz_id = '44444444-4444-4444-8444-444444444442'
    await expect(openLines(t.db, TENANT, sealed.id, { secret: SECRET })).rejects.toThrow(/does not (verify|unwrap)/)
    t.records()[0]!.karenz_id = KARENZ
    t.records()[0]!.extractor_id = 'votes.other'
    await expect(openLines(t.db, TENANT, sealed.id, { secret: SECRET })).rejects.toThrow(/does not (verify|unwrap)/)
  })

  it('a record whose stored hash differs from its plaintext does not open', async () => {
    const t = fakeTenantDb()
    const sealed = await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    t.records()[0]!.plaintext_sha256 = 'f'.repeat(64)
    await expect(openLines(t.db, TENANT, sealed.id, { secret: SECRET })).rejects.toThrow(/hash/)
  })

  it('an unknown id is a RetainedNotFoundError', async () => {
    const t = fakeTenantDb()
    await expect(openLines(t.db, TENANT, '55555555-5555-4555-8555-555555555555', { secret: SECRET })).rejects.toBeInstanceOf(RetainedNotFoundError)
  })

  it('opening with the wrong secret fails', async () => {
    const t = fakeTenantDb()
    const sealed = await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    await expect(openLines(t.db, TENANT, sealed.id, { secret: SECRET_2 })).rejects.toThrow(/does not (verify|unwrap)/)
  })

  it('sealing with another secret than the data key was wrapped with does not mint a second key silently', async () => {
    const t = fakeTenantDb()
    await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    await expect(sealLines(t.db, TENANT, KARENZ, 'votes.again', lines, META, { secret: SECRET_2, ...guard })).rejects.toThrow(/does not (verify|unwrap)/)
    expect(t.keys()).toHaveLength(1)
    expect(t.records()).toHaveLength(1)
  })
})

describe('AUTH_SECRET', () => {
  it('a missing AUTH_SECRET throws instead of sealing with an empty key', async () => {
    vi.stubEnv('AUTH_SECRET', '')
    try {
      const t = fakeTenantDb()
      await expect(sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, guard)).rejects.toThrow(/AUTH_SECRET/)
      expect(t.keys()).toHaveLength(0)
      expect(t.records()).toHaveLength(0)
      await expect(sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, { secret: '', ...guard })).rejects.toThrow(/AUTH_SECRET/)
      await expect(openLines(t.db, TENANT, '55555555-5555-4555-8555-555555555555')).rejects.toThrow(/AUTH_SECRET/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('the secret is read from the environment when the caller passes none', async () => {
    vi.stubEnv('AUTH_SECRET', SECRET)
    try {
      const t = fakeTenantDb()
      const sealed = await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, guard)
      expect(await openLines(t.db, TENANT, sealed.id)).toEqual(lines)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rewrapDataKeys with the new secret keeps every record readable and the old secret no longer unwraps', async () => {
    const t = fakeTenantDb()
    const a = await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    const b = await sealLines(t.db, TENANT, KARENZ, 'votes.other', lines.slice(0, 1), META, deps)
    const wrappedBefore = Buffer.from(t.keys()[0]!.wrapped)
    const ciphertextBefore = Buffer.from(t.records()[0]!.ciphertext)

    expect(await rewrapDataKeys(t.db, TENANT, SECRET, SECRET_2)).toBe(1)

    expect(t.keys()[0]!.kek_version).toBe(2)
    expect(t.keys()[0]!.wrapped.equals(wrappedBefore)).toBe(false)
    // the records themselves are untouched
    expect(t.records()[0]!.ciphertext.equals(ciphertextBefore)).toBe(true)
    expect(await openLines(t.db, TENANT, a.id, { secret: SECRET_2 })).toEqual(lines)
    expect(await openLines(t.db, TENANT, b.id, { secret: SECRET_2 })).toEqual(lines.slice(0, 1))
    await expect(openLines(t.db, TENANT, a.id, { secret: SECRET })).rejects.toThrow(/does not (verify|unwrap)/)
  })

  it('rewrapDataKeys is safe to run again after it finished (a copy already under the new secret is skipped)', async () => {
    const t = fakeTenantDb()
    await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    expect(await rewrapDataKeys(t.db, TENANT, SECRET, SECRET_2)).toBe(1)
    expect(await rewrapDataKeys(t.db, TENANT, SECRET, SECRET_2)).toBe(0)
    expect(t.keys()[0]!.kek_version).toBe(2)
  })

  it('rewrapDataKeys refuses a key that opens under neither secret, and an empty secret', async () => {
    const t = fakeTenantDb()
    await sealLines(t.db, TENANT, KARENZ, 'votes.polls', lines, META, deps)
    await expect(rewrapDataKeys(t.db, TENANT, 'not-the-old-secret', SECRET_2)).rejects.toThrow(/neither/)
    await expect(rewrapDataKeys(t.db, TENANT, SECRET, '')).rejects.toThrow(/AUTH_SECRET/)
    expect(t.keys()[0]!.kek_version).toBe(1)
  })
})
