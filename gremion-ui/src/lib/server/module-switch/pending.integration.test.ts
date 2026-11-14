// A confirmed module switch that waits for the second factor: the table module_switch_pending (migration
// 0065) and the two store functions of pending.ts, against the migrated integration database
// (pnpm test:integration). What is pinned here is what the endpoint relies on: a claim removes the row
// (single-use, also between two instances), a person has one row, the expiry runs on the database clock,
// and the table never holds the handle itself.
import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import { armPendingSwitch, claimPendingSwitch, PENDING_TTL_SECONDS } from './pending'
import type { SwitchInput } from './service'

const DISABLE: SwitchInput = { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }
const ENABLE: SwitchInput = { moduleId: 'calendar', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2 "Anhang"' } }

const count = async () => Number((await getDb()<{ n: string }[]>`SELECT count(*)::text AS n FROM module_switch_pending`)[0]!.n)
/** Move every row of a person past its expiry (inside the table's ten-minute bound). */
const expire = (userId: string) =>
  getDb()`UPDATE module_switch_pending SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE user_id = ${userId}`

beforeEach(async () => {
  await getDb()`TRUNCATE module_switch_pending`
})

describe('armPendingSwitch / claimPendingSwitch', () => {
  it('round-trips the confirmed input, the person, the second-factor time and a key, and expires on the database clock', async () => {
    const db = getDb()
    const userId = randomUUID()
    const handle = await armPendingSwitch(db, { userId, authTime: 1_800_000_000.9, input: ENABLE })
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const [row] = await db<{ ttl: string }[]>`SELECT extract(epoch FROM expires_at - created_at)::text AS ttl FROM module_switch_pending`
    expect(Number(row!.ttl)).toBe(PENDING_TTL_SECONDS)

    const claimed = await claimPendingSwitch(db, handle)
    expect(claimed).toEqual({ userId, armedAuthTime: 1_800_000_000, input: ENABLE, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), live: true })
  })

  it('stores the SHA-256 of the handle, never the handle', async () => {
    const db = getDb()
    const handle = await armPendingSwitch(db, { userId: randomUUID(), authTime: 0, input: DISABLE })
    const [row] = await db<{ token_hash: string; whole: string }[]>`SELECT token_hash, p::text AS whole FROM module_switch_pending p`
    expect(row!.token_hash).toBe(createHash('sha256').update(handle).digest('hex'))
    expect(row!.whole).not.toContain(handle)
    // the hash is not a handle: presenting it claims nothing
    expect(await claimPendingSwitch(db, row!.token_hash)).toBeNull()
    expect(await count()).toBe(1)
  })

  it('replay: a claim removes the row, so the second presentation of the same handle finds nothing', async () => {
    const db = getDb()
    const handle = await armPendingSwitch(db, { userId: randomUUID(), authTime: 0, input: DISABLE })
    expect(await claimPendingSwitch(db, handle)).not.toBeNull()
    expect(await count()).toBe(0)
    expect(await claimPendingSwitch(db, handle)).toBeNull()
  })

  it('two instances claiming the same handle at once: exactly one gets it', async () => {
    const db = getDb()
    const handle = await armPendingSwitch(db, { userId: randomUUID(), authTime: 0, input: DISABLE })
    const results = await Promise.all(Array.from({ length: 8 }, () => claimPendingSwitch(db, handle)))
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(await count()).toBe(0)
  })

  it('an unknown handle claims nothing and removes nothing', async () => {
    const db = getDb()
    await armPendingSwitch(db, { userId: randomUUID(), authTime: 0, input: DISABLE })
    expect(await claimPendingSwitch(db, 'A'.repeat(43))).toBeNull()
    expect(await count()).toBe(1)
  })

  it('a person has one row: a new confirmation replaces the earlier one, and another person is untouched', async () => {
    const db = getDb()
    const a = randomUUID()
    const b = randomUUID()
    const first = await armPendingSwitch(db, { userId: a, authTime: 10, input: DISABLE })
    const others = await armPendingSwitch(db, { userId: b, authTime: 20, input: DISABLE })
    const second = await armPendingSwitch(db, { userId: a, authTime: 10, input: ENABLE })
    expect(await count()).toBe(2)
    expect(await claimPendingSwitch(db, first)).toBeNull()
    expect((await claimPendingSwitch(db, second))?.input).toEqual(ENABLE)
    expect(await claimPendingSwitch(db, others)).toMatchObject({ userId: b, armedAuthTime: 20 })
  })

  it('confirmations of one person racing each other leave exactly one row', async () => {
    const db = getDb()
    const userId = randomUUID()
    const handles = await Promise.all(Array.from({ length: 6 }, () => armPendingSwitch(db, { userId, authTime: 0, input: DISABLE })))
    expect(await count()).toBe(1)
    const claims = await Promise.all(handles.map((h) => claimPendingSwitch(db, h)))
    expect(claims.filter((c) => c !== null)).toHaveLength(1)
  })

  it('expiry: a row past its time is handed out as not live, and it is removed all the same', async () => {
    const db = getDb()
    const userId = randomUUID()
    const handle = await armPendingSwitch(db, { userId, authTime: 0, input: DISABLE })
    await expire(userId)
    expect(await claimPendingSwitch(db, handle)).toMatchObject({ userId, live: false })
    expect(await count()).toBe(0)
  })

  it('expired rows of other people are removed by the next confirmation and by the next claim', async () => {
    const db = getDb()
    const stale = randomUUID()
    await armPendingSwitch(db, { userId: stale, authTime: 0, input: DISABLE })
    await expire(stale)
    const handle = await armPendingSwitch(db, { userId: randomUUID(), authTime: 0, input: DISABLE })
    expect(await count()).toBe(1)

    await armPendingSwitch(db, { userId: stale, authTime: 0, input: DISABLE })
    await expire(stale)
    expect(await claimPendingSwitch(db, 'B'.repeat(43))).toBeNull()
    expect(await count()).toBe(1)
    expect(await claimPendingSwitch(db, handle)).toMatchObject({ live: true })
  })

  it('a stored input that lost its shape is not handed out (and the row is gone)', async () => {
    const db = getDb()
    const userId = randomUUID()
    const handle = await armPendingSwitch(db, { userId, authTime: 0, input: DISABLE })
    await db`UPDATE module_switch_pending SET payload = '{"moduleId":"vault","action":"enable"}'::jsonb WHERE user_id = ${userId}`
    expect(await claimPendingSwitch(db, handle)).toBeNull()
    expect(await count()).toBe(0)
  })
})

describe('module_switch_pending (the table)', () => {
  const insert = (over: { hash?: string; expires?: string; payload?: Record<string, string> | string[]; userId?: string }) => {
    const db = getDb()
    return db`
      INSERT INTO module_switch_pending (token_hash, idempotency_key, user_id, armed_auth_time, payload, expires_at)
      VALUES (${over.hash ?? 'a'.repeat(64)}, ${randomUUID()}::uuid, ${over.userId ?? 'u1'}, 0, ${db.json(over.payload ?? {})}::jsonb, now() + ${over.expires ?? '5 minutes'}::interval)`
  }

  it('accepts a short-lived row', async () => {
    await insert({})
    expect(await count()).toBe(1)
  })

  it.each([
    ['a row that would wait longer than ten minutes', { expires: '11 minutes' }],
    ['a row that is expired from the start', { expires: '-1 second' }],
    ['a key that is not a SHA-256', { hash: 'not-a-hash' }],
    ['a payload that is not an object', { payload: [] }],
    ['an oversized payload', { payload: { x: 'y'.repeat(4100) } }],
    ['a row without a person', { userId: '' }],
  ])('refuses %s (CHECK)', async (_name, over) => {
    await expect(insert(over)).rejects.toMatchObject({ code: '23514' })
  })
})
