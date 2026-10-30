/**
 * F1-FIX-08 - CalDAV visibility against a real per-tenant Postgres.
 *
 * Operator decision D-2 (R29-I15, NEVER PUSH NON-PUBLIC): an is_public=false
 * event never reaches the shared Nextcloud calendar; an update of one removes
 * any copy an earlier push left there and clears caldav_synced_at; migration 004
 * queues that removal for every non-public event that is still marked synced,
 * exactly once.
 * H06: the drain uses the tenant's own collection and refuses an unconfigured
 * tenant without touching its queue.
 *
 * Fail-closed guard: localhost only, non-5432 port, *_test_ DB prefix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { storeFor, _resetTenantStoreForTests, type TenantRef } from '../src/tenant-store.ts'
import {
  createEvent,
  updateEvent,
  markCaldavUnsynced,
  listPendingCaldavSync,
} from '../src/store/index.ts'
import { drainCaldavForTenant, _resetTenantDrainWarnings } from '../src/caldav/tenant-drain.ts'
import type { CalDavPusher } from '../src/caldav/pusher.ts'
import { requireEphemeralTestPgUrl, assertSafeTestEnv } from './support/pg-test-guard.ts'

const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'calendar_dtwo_test_'
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const TENANT: TenantRef = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', slug: 'tenant-a' }
const ENV = {
  NEXTCLOUD_ADMIN_USER: 'admin',
  CALDAV_TENANT_CALENDARS: JSON.stringify({ 'tenant-a': 'tenant-a-cal' }),
}
const MIGRATION_004 = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
  '004_caldav_unpublish_private.sql',
)

let admin: ReturnType<typeof postgres>
let sql: Awaited<ReturnType<typeof storeFor>>

async function dropOwnDbs(): Promise<void> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'calendar\_dtwo\_test\_%'
  `
  for (const { datname } of rows) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
    )
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`)
  }
}

function fakePusher(): CalDavPusher {
  return {
    calPath: '/remote.php/dav/calendars/admin/tenant-a-cal/',
    pushCreate: vi.fn().mockResolvedValue(undefined),
    pushUpdate: vi.fn().mockResolvedValue(undefined),
    pushDelete: vi.fn().mockResolvedValue(undefined),
  }
}

const base = {
  description: 'internal note',
  location: 'Room 1',
  startAt: new Date('2026-11-03T17:00:00Z'),
  endAt: new Date('2026-11-03T18:00:00Z'),
  allDay: false,
  eventTypeId: null,
  isMultiCommittee: false,
  createdBy: 'user-1',
  source: 'manual' as const,
  externalId: null,
  committeeIds: [],
  recurrence: null,
}

beforeAll(async () => {
  admin = postgres(TEST_PG_URL, { max: 1, prepare: false })
  await dropOwnDbs()
  sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
})

afterAll(async () => {
  await _resetTenantStoreForTests()
  await dropOwnDbs()
  await admin.end()
})

beforeEach(async () => {
  _resetTenantDrainWarnings()
  await sql`DELETE FROM caldav_sync_queue`
  await sql`DELETE FROM calendar_events`
})

async function syncedAt(id: string): Promise<Date | null> {
  const [row] = await sql<{ caldav_synced_at: Date | null }[]>`
    SELECT caldav_synced_at FROM calendar_events WHERE id = ${id}`
  return row!.caldav_synced_at
}

describe('D-2: NEVER PUSH NON-PUBLIC (real DB)', () => {
  it('markCaldavUnsynced clears caldav_synced_at', async () => {
    const ev = await createEvent(sql, { ...base, title: 'Open', isPublic: true })
    await sql`UPDATE calendar_events SET caldav_synced_at = now() WHERE id = ${ev.id}`
    expect(await syncedAt(ev.id)).not.toBeNull()

    await markCaldavUnsynced(sql, ev.id)

    expect(await syncedAt(ev.id)).toBeNull()
  })

  it('the drain pushes the public event and never the non-public one', async () => {
    const pub = await createEvent(sql, { ...base, title: 'Open', isPublic: true })
    await createEvent(sql, { ...base, title: 'Internal', isPublic: false })
    const pusher = fakePusher()

    const result = await drainCaldavForTenant(sql, TENANT, { env: ENV, makePusher: () => pusher })

    expect(result).toEqual({ succeeded: 2, failed: 0 })
    expect(pusher.pushCreate).toHaveBeenCalledTimes(1)
    const pushed = vi.mocked(pusher.pushCreate).mock.calls[0]![0]
    expect(pushed.uid).toBe(pub.caldavUid)
    expect(pushed.summary).toBe('Open')
    expect(await listPendingCaldavSync(sql)).toEqual([])
  })

  it('unpublishing an event deletes its CalDAV copy and clears caldav_synced_at', async () => {
    const ev = await createEvent(sql, { ...base, title: 'Public first', isPublic: true })
    await drainCaldavForTenant(sql, TENANT, { env: ENV, makePusher: () => fakePusher() })
    expect(await syncedAt(ev.id)).not.toBeNull()
    await updateEvent(sql, ev.id, { isPublic: false })
    const pusher = fakePusher()

    await drainCaldavForTenant(sql, TENANT, { env: ENV, makePusher: () => pusher })

    expect(pusher.pushUpdate).not.toHaveBeenCalled()
    expect(pusher.pushDelete).toHaveBeenCalledWith(ev.caldavUid)
    expect(await syncedAt(ev.id)).toBeNull()
  })

  it('migration 004 queues one cleanup per already-synced non-public event, idempotently, never for a public one', async () => {
    const leaked = await createEvent(sql, { ...base, title: 'Leaked', isPublic: false })
    const pub = await createEvent(sql, { ...base, title: 'Open', isPublic: true })
    await sql`DELETE FROM caldav_sync_queue`
    await sql`UPDATE calendar_events SET caldav_synced_at = now()`

    const text = await readFile(MIGRATION_004, 'utf-8')
    await sql.unsafe(text)
    await sql.unsafe(text)

    const rows = await sql<{ event_id: string; operation: string }[]>`
      SELECT event_id, operation FROM caldav_sync_queue`
    expect(rows).toEqual([{ event_id: leaked.id, operation: 'update' }])
    expect(rows.some((r) => r.event_id === pub.id)).toBe(false)
  })

  it('migration 004 skips a non-public event that was never synced', async () => {
    await createEvent(sql, { ...base, title: 'Never pushed', isPublic: false })
    await sql`DELETE FROM caldav_sync_queue`

    await sql.unsafe(await readFile(MIGRATION_004, 'utf-8'))

    expect(await sql`SELECT 1 FROM caldav_sync_queue`).toHaveLength(0)
  })

  it('an unconfigured tenant is refused and its queue is left untouched', async () => {
    await createEvent(sql, { ...base, title: 'Open', isPublic: true })
    const makePusher = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await drainCaldavForTenant(sql, TENANT, {
      env: { NEXTCLOUD_ADMIN_USER: 'admin' },
      makePusher,
    })

    errSpy.mockRestore()
    expect(result.refused).toBeTruthy()
    expect(makePusher).not.toHaveBeenCalled()
    const pending = await listPendingCaldavSync(sql)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.attempts).toBe(0)
  })
})
