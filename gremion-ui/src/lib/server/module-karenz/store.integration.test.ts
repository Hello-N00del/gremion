// Module Karenz (phase 2, Task 7): the tenant tables of migration 0064 and the step
// ledger store. Runs against the migrated integration database (pnpm test:integration).
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import {
  getStep,
  listItems,
  listSteps,
  markStep,
  noticesSent,
  recordNotice,
  setItemState,
  upsertItem,
  type KarenzItem,
} from './store'

const TABLES = [
  'module_karenz_step',
  'module_karenz_item',
  'module_karenz_notice',
  'retained_record',
  'karenz_data_key',
  'module_karenz_erasure',
  'retained_sink_state',
]

function item(karenzId: string, over: Partial<KarenzItem> = {}): KarenzItem {
  return { karenzId, kind: 'poll', externalId: '42', state: 'recorded', ...over }
}

const sqlState = (e: unknown) => (e as { code?: string }).code

async function code(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (e) {
    return sqlState(e) ?? String(e)
  }
}

beforeEach(async () => {
  const db = getDb()
  // retained_record references karenz_data_key; truncate the lot in one statement
  await db.unsafe(`TRUNCATE ${TABLES.join(', ')} CASCADE`)
})

describe('markStep / getStep / listSteps', () => {
  it('markStep increments attempts and keeps the first done_at', async () => {
    const db = getDb()
    const k = randomUUID()
    const first = await markStep(db, k, 'notice-switchoff', { state: 'failed', error: 'smtp down' })
    expect(first).toMatchObject({ karenzId: k, step: 'notice-switchoff', state: 'failed', attempts: 1, lastError: 'smtp down', doneAt: null })

    const done = await markStep(db, k, 'notice-switchoff', { state: 'done' })
    expect(done.state).toBe('done')
    expect(done.attempts).toBe(2)
    expect(done.lastError).toBeNull()
    expect(done.doneAt).toBeInstanceOf(Date)

    // a later pass that records done again must not move the first completion time
    await db`UPDATE module_karenz_step SET done_at = '2001-02-03T04:05:06Z' WHERE karenz_id = ${k} AND step = 'notice-switchoff'`
    const again = await markStep(db, k, 'notice-switchoff', { state: 'done' })
    expect(again.attempts).toBe(3)
    expect(again.doneAt!.toISOString()).toBe('2001-02-03T04:05:06.000Z')
    expect((await getStep(db, k, 'notice-switchoff'))!.attempts).toBe(3)
  })

  it('reported stamps last_reported_at, an unreported mark leaves it alone', async () => {
    const db = getDb()
    const k = randomUUID()
    const a = await markStep(db, k, 'lock-items', { state: 'failed', error: 'refused', reported: true })
    expect(a.lastReportedAt).toBeInstanceOf(Date)
    await db`UPDATE module_karenz_step SET last_reported_at = '2001-02-03T04:05:06Z' WHERE karenz_id = ${k}`
    const b = await markStep(db, k, 'lock-items', { state: 'failed', error: 'refused again' })
    expect(b.lastReportedAt!.toISOString()).toBe('2001-02-03T04:05:06.000Z')
    expect(b.lastError).toBe('refused again')
  })

  it('getStep is null for a step never marked; listSteps is per karenz row, ordered by step', async () => {
    const db = getDb()
    const k = randomUUID()
    const other = randomUUID()
    expect(await getStep(db, k, 'nope')).toBeNull()
    await markStep(db, k, 'b-step', { state: 'done' })
    await markStep(db, k, 'a-step', { state: 'pending' })
    await markStep(db, other, 'c-step', { state: 'done' })
    expect((await listSteps(db, k)).map((s) => s.step)).toEqual(['a-step', 'b-step'])
  })

  it('a failed step always says why: markStep refuses a failed mark without an error, and so does the table', async () => {
    const db = getDb()
    const k = randomUUID()
    await expect(markStep(db, k, 's', { state: 'failed' } as never)).rejects.toThrow(/failed step records why/)
    await expect(markStep(db, k, 's', { state: 'failed', error: '  ' })).rejects.toThrow(/failed step records why/)
    expect(await getStep(db, k, 's')).toBeNull()
    // the CHECK holds for a writer that bypasses markStep
    expect(await code(db`INSERT INTO module_karenz_step (karenz_id, step, state) VALUES (${k}, 's', 'failed')`)).toBe('23514')
    expect(await code(db`INSERT INTO module_karenz_step (karenz_id, step, state, last_error) VALUES (${k}, 's', 'failed', 'x')`)).toBe('ok')
    expect(await code(markStep(db, k, 's', { state: 'done' }))).toBe('ok')
  })

  it('a bad state violates the CHECK', async () => {
    const db = getDb()
    expect(await code(markStep(db, randomUUID(), 's', { state: 'exploded' as never }))).toBe('23514')
  })
})

describe('upsertItem / listItems / setItemState', () => {
  it('is idempotent per (karenz, kind, external_id) and does not downgrade a locked item to recorded', async () => {
    const db = getDb()
    const k = randomUUID()
    const a = await upsertItem(db, item(k, { payload: { remainingMs: 5000 } }))
    expect(a.state).toBe('recorded')

    expect(await setItemState(db, a.itemId, 'locked')).toBe(true)
    // the next pass observes the same poll again and records it again
    const b = await upsertItem(db, item(k, { payload: { remainingMs: 1 } }))
    expect(b.itemId).toBe(a.itemId)
    expect(b.state).toBe('locked')
    expect(b.payload).toEqual({ remainingMs: 5000 })

    const rows = await listItems(db, k)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'poll', externalId: '42', state: 'locked' })
  })

  it('a non-recorded upsert moves the state and merges detail; recorded refreshes only a recorded row', async () => {
    const db = getDb()
    const k = randomUUID()
    const a = await upsertItem(db, item(k, { payload: { v: 1 } }))
    const refreshed = await upsertItem(db, item(k, { payload: { v: 2 } }))
    expect(refreshed.itemId).toBe(a.itemId)
    expect(refreshed.payload).toEqual({ v: 2 })
    const failed = await upsertItem(db, item(k, { state: 'lock_failed', detail: 'HTTP 403' }))
    expect(failed).toMatchObject({ state: 'lock_failed', detail: 'HTTP 403' })
    expect(failed.payload).toEqual({ v: 2 })
  })

  it('listItems filters by kind and is scoped to the karenz row', async () => {
    const db = getDb()
    const k = randomUUID()
    await upsertItem(db, item(k, { kind: 'poll', externalId: '1' }))
    await upsertItem(db, item(k, { kind: 'election', externalId: '1' }))
    await upsertItem(db, item(randomUUID(), { kind: 'poll', externalId: '9' }))
    expect(await listItems(db, k)).toHaveLength(2)
    expect((await listItems(db, k, 'poll')).map((i) => i.externalId)).toEqual(['1'])
  })

  it('setItemState reports false for an unknown item and stores the detail', async () => {
    const db = getDb()
    expect(await setItemState(db, randomUUID(), 'gone')).toBe(false)
    const k = randomUUID()
    const a = await upsertItem(db, item(k))
    expect(await setItemState(db, a.itemId, 'unlock_failed', 'poll is locked, Nextcloud answered 500')).toBe(true)
    expect((await listItems(db, k))[0]).toMatchObject({ state: 'unlock_failed', detail: 'poll is locked, Nextcloud answered 500' })
  })

  it('a bad state violates the CHECK', async () => {
    const db = getDb()
    expect(await code(upsertItem(db, item(randomUUID(), { state: 'exploded' as never })))).toBe('23514')
    const a = await upsertItem(db, item(randomUUID()))
    expect(await code(setItemState(db, a.itemId, 'exploded' as never))).toBe('23514')
  })
})

describe('recordNotice / noticesSent', () => {
  it('noticesSent returns the user ids already mailed, per kind, and not the failed ones', async () => {
    const db = getDb()
    const k = randomUUID()
    await recordNotice(db, { karenzId: k, kind: 'switchoff', userId: 'u1', state: 'sent' })
    await recordNotice(db, { karenzId: k, kind: 'switchoff', userId: 'u2', state: 'failed', error: 'mailbox full' })
    await recordNotice(db, { karenzId: k, kind: 't23', userId: 'u3', state: 'sent' })
    await recordNotice(db, { karenzId: randomUUID(), kind: 'switchoff', userId: 'u4', state: 'sent' })
    expect([...(await noticesSent(db, k, 'switchoff'))]).toEqual(['u1'])
    expect([...(await noticesSent(db, k, 't23'))]).toEqual(['u3'])
    expect((await noticesSent(db, k, 't29')).size).toBe(0)
  })

  it('a retry counts attempts, and a failed notice that later succeeds becomes sent', async () => {
    const db = getDb()
    const k = randomUUID()
    await recordNotice(db, { karenzId: k, kind: 'switchoff', userId: 'u2', state: 'failed', error: 'mailbox full' })
    await recordNotice(db, { karenzId: k, kind: 'switchoff', userId: 'u2', state: 'sent' })
    expect([...(await noticesSent(db, k, 'switchoff'))]).toEqual(['u2'])
    const [row] = await db<{ attempts: number; sent_at: Date | null; last_error: string | null }[]>`
      SELECT attempts, sent_at, last_error FROM module_karenz_notice WHERE karenz_id = ${k} AND user_id = 'u2'`
    expect(row!.attempts).toBe(2)
    expect(row!.sent_at).toBeInstanceOf(Date)
    expect(row!.last_error).toBeNull()
  })

  it('a sent notice is never turned back into failed by a later failing attempt', async () => {
    const db = getDb()
    const k = randomUUID()
    await recordNotice(db, { karenzId: k, kind: 't29', userId: 'u1', state: 'sent' })
    await recordNotice(db, { karenzId: k, kind: 't29', userId: 'u1', state: 'failed', error: 'late' })
    expect([...(await noticesSent(db, k, 't29'))]).toEqual(['u1'])
  })

  it('a failed notice always says why: recordNotice refuses a failed notice without an error, and so does the table', async () => {
    const db = getDb()
    const k = randomUUID()
    await expect(recordNotice(db, { karenzId: k, kind: 'switchoff', userId: 'u', state: 'failed' } as never)).rejects.toThrow(/failed notice records why/)
    expect(await noticesSent(db, k, 'switchoff')).toEqual(new Set())
    expect(await code(db`INSERT INTO module_karenz_notice (karenz_id, kind, user_id, state) VALUES (${k}, 'switchoff', 'u', 'failed')`)).toBe('23514')
    expect(await code(db`INSERT INTO module_karenz_notice (karenz_id, kind, user_id, state, last_error) VALUES (${k}, 'switchoff', 'u', 'failed', 'x')`)).toBe('ok')
  })

  it('a bad kind or state violates the CHECK', async () => {
    const db = getDb()
    expect(await code(recordNotice(db, { karenzId: randomUUID(), kind: 't30' as never, userId: 'u', state: 'sent' }))).toBe('23514')
    expect(await code(recordNotice(db, { karenzId: randomUUID(), kind: 'switchoff', userId: 'u', state: 'maybe' as never }))).toBe('23514')
  })
})

describe('the sealed-record, key, erasure and sink tables', () => {
  async function newKey(): Promise<string> {
    const [k] = await getDb()<{ key_id: string }[]>`
      INSERT INTO karenz_data_key (wrapped, kek_version) VALUES (${Buffer.from('wrapped')}, 1) RETURNING key_id`
    return k!.key_id
  }

  it('retained_record round-trips, defaults subject_refs to empty, and is unique per (karenz, extractor)', async () => {
    const db = getDb()
    const keyId = await newKey()
    const karenzId = randomUUID()
    const ins = (extractor: string) => db`
      INSERT INTO retained_record (karenz_id, catalogue_id, retention_class, extractor_id, line_count, plaintext_sha256, key_id, nonce, ciphertext)
      VALUES (${karenzId}, 'votes', 'RC-VOTE', ${extractor}, 3, ${'a'.repeat(64)}, ${keyId}, ${Buffer.alloc(12)}, ${Buffer.from('sealed')})
      RETURNING id, subject_refs, hold_until, created_at`
    const [r] = await ins('votes.polls')
    expect(r!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r!.subject_refs).toEqual([])
    expect(r!.hold_until).toBeNull()
    expect(await code(ins('votes.polls'))).toBe('23505')
    expect(await code(ins('votes.other'))).toBe('ok')
  })

  it('retained_record refuses a malformed digest, a negative line count and an unknown key', async () => {
    const db = getDb()
    const keyId = await newKey()
    const row = (over: { sha?: string; lines?: number; key?: string }) => db`
      INSERT INTO retained_record (karenz_id, catalogue_id, retention_class, extractor_id, line_count, plaintext_sha256, key_id, nonce, ciphertext)
      VALUES (${randomUUID()}, 'votes', 'RC-VOTE', 'x', ${over.lines ?? 1}, ${over.sha ?? 'b'.repeat(64)}, ${over.key ?? keyId}, ${Buffer.alloc(12)}, ${Buffer.from('c')})`
    expect(await code(row({ sha: 'not-a-digest' }))).toBe('23514')
    expect(await code(row({ lines: -1 }))).toBe('23514')
    expect(await code(row({ key: randomUUID() }))).toBe('23503')
    expect(await code(row({}))).toBe('ok')
  })

  it('module_karenz_erasure holds subject ids only and is idempotent per subject', async () => {
    const db = getDb()
    const cols = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'module_karenz_erasure' ORDER BY column_name`
    expect(cols.map((c) => c.column_name)).toEqual(['requested_at', 'subject_id'])
    await db`INSERT INTO module_karenz_erasure (subject_id) VALUES ('s1')`
    expect(await code(db`INSERT INTO module_karenz_erasure (subject_id) VALUES ('s1')`)).toBe('23505')
  })

  it('retained_sink_state round-trips and refuses a second row for the same sink', async () => {
    const db = getDb()
    await db`INSERT INTO retained_sink_state (sink, external_id, group_id) VALUES ('files', 'folder-1', 'group-1')`
    const [row] = await db<{ sink: string; external_id: string; group_id: string; created_at: Date }[]>`
      SELECT sink, external_id, group_id, created_at FROM retained_sink_state WHERE sink = 'files'`
    expect(row).toMatchObject({ sink: 'files', external_id: 'folder-1', group_id: 'group-1' })
    expect(row!.created_at).toBeInstanceOf(Date)
    expect(await code(db`INSERT INTO retained_sink_state (sink, external_id, group_id) VALUES ('files', 'folder-2', 'group-2')`)).toBe('23505')
    expect(await code(db`INSERT INTO retained_sink_state (sink, external_id, group_id) VALUES ('other', NULL, 'g')`)).toBe('23502')
  })
})
