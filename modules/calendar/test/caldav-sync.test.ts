// services/calendar/test/caldav-sync.test.ts
//
// Task 19 fix: unit tests for drainCaldavQueue/processEntry
// (src/caldav/sync.ts) — the scheduler's per-tenant drainCaldav callback,
// wired directly into production src/index.ts and invoked unattended every
// 30s per tenant. Ported from
// gremion-ui/src/lib/server/calendar/caldav-sync.test.ts, adapted for the
// leaf's per-tenant `sql: Sql` DI signature (store fns take `sql` as the
// first arg instead of the kernel's internal getDb()).
//
// vi.hoisted() is required here because the vi.mock() factory for
// '../src/store/index.js' needs to return references shared with the test
// body's vi.mocked(...) calls — plain consts declared before vi.mock() throw
// 'Cannot access before initialization' under this project's vitest setup.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DbCalDavQueueEntry, DbEvent } from '../src/store/index.js'
import type { Sql } from '../src/tenant-store.js'
import type { CalDavPusher } from '../src/caldav/pusher.js'

const mocks = vi.hoisted(() => ({
  listPendingCaldavSync: vi.fn(),
  removeCaldavSyncEntry: vi.fn().mockResolvedValue(undefined),
  recordCaldavSyncFailure: vi.fn().mockResolvedValue(undefined),
  markCaldavSynced: vi.fn().mockResolvedValue(undefined),
  getEvent: vi.fn(),
}))

vi.mock('../src/store/index.js', () => mocks)

import { drainCaldavQueue } from '../src/caldav/sync.js'

// The Sql DI parameter is opaque to sync.ts's own logic — it is only ever
// forwarded to the (mocked) store functions — so a stub object is enough.
const fakeSql = {} as Sql

function makeEvent(id: string, uid: string): DbEvent {
  return {
    id,
    title: 'Test',
    description: null,
    location: null,
    startAt: new Date('2026-01-01T10:00:00Z'),
    endAt: new Date('2026-01-01T11:00:00Z'),
    allDay: false,
    eventTypeId: null,
    eventTypeColor: null,
    eventTypeName: null,
    isMultiCommittee: false,
    createdBy: 'u1',
    source: 'manual',
    externalId: null,
    caldavUid: uid,
    caldavSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    committeeIds: [],
    recurrence: null,
    colour: { primary: '#000', secondary: '#111' },
    readOnly: false,
  }
}

function makeEntry(partial: Partial<DbCalDavQueueEntry>): DbCalDavQueueEntry {
  return {
    id: partial.id ?? 'q1',
    eventId: 'eventId' in partial ? (partial.eventId as string | null) : 'e1',
    caldavUid: partial.caldavUid ?? 'uid-1@stura',
    operation: partial.operation ?? 'create',
    attempts: partial.attempts ?? 0,
    lastError: partial.lastError ?? null,
    createdAt: partial.createdAt ?? new Date(),
  }
}

function makePusher(overrides: Partial<CalDavPusher> = {}): CalDavPusher {
  return {
    calPath: '/remote.php/dav/calendars/admin/stura/',
    pushCreate: vi.fn().mockResolvedValue(undefined),
    pushUpdate: vi.fn().mockResolvedValue(undefined),
    pushDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('drainCaldavQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when the queue is empty', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([])
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(result).toEqual({ succeeded: 0, failed: 0 })
    expect(pusher.pushCreate).not.toHaveBeenCalled()
  })

  it('pushes a create and marks it synced on success', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ operation: 'create', eventId: 'e1', caldavUid: 'uid-1@stura' }),
    ])
    mocks.getEvent.mockResolvedValueOnce(makeEvent('e1', 'uid-1@stura'))
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(pusher.pushCreate).toHaveBeenCalledOnce()
    const [icsEvent] = vi.mocked(pusher.pushCreate).mock.calls[0]!
    expect(icsEvent.uid).toBe('uid-1@stura')
    expect(mocks.markCaldavSynced).toHaveBeenCalledWith(fakeSql, 'e1')
    expect(mocks.removeCaldavSyncEntry).toHaveBeenCalledWith(fakeSql, 'q1')
    expect(result).toEqual({ succeeded: 1, failed: 0 })
  })

  it('pushes an update (not create) for operation "update"', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q5', operation: 'update', eventId: 'e5', caldavUid: 'uid-5@stura' }),
    ])
    mocks.getEvent.mockResolvedValueOnce(makeEvent('e5', 'uid-5@stura'))
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(pusher.pushUpdate).toHaveBeenCalledOnce()
    expect(pusher.pushCreate).not.toHaveBeenCalled()
    expect(mocks.markCaldavSynced).toHaveBeenCalledWith(fakeSql, 'e5')
    expect(result).toEqual({ succeeded: 1, failed: 0 })
  })

  it('pushes a delete using the stored uid when the event row is already gone', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q9', operation: 'delete', eventId: null, caldavUid: 'old@stura' }),
    ])
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(pusher.pushDelete).toHaveBeenCalledWith('old@stura')
    // getEvent is never consulted for the delete path.
    expect(mocks.getEvent).not.toHaveBeenCalled()
    expect(mocks.removeCaldavSyncEntry).toHaveBeenCalledWith(fakeSql, 'q9')
    expect(result.succeeded).toBe(1)
  })

  it('records a failure when the pusher throws (does not remove the entry)', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q2', operation: 'update', eventId: 'e2' }),
    ])
    mocks.getEvent.mockResolvedValueOnce(makeEvent('e2', 'uid-2@stura'))
    const pusher = makePusher({
      pushUpdate: vi.fn().mockRejectedValueOnce(new Error('Nextcloud down')),
    })

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(mocks.recordCaldavSyncFailure).toHaveBeenCalledWith(fakeSql, 'q2', 'Nextcloud down')
    expect(mocks.removeCaldavSyncEntry).not.toHaveBeenCalledWith(fakeSql, 'q2')
    expect(result).toEqual({ succeeded: 0, failed: 1 })
  })

  it('treats a vanished event as a failure for create/update', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q3', operation: 'create', eventId: 'missing' }),
    ])
    mocks.getEvent.mockResolvedValueOnce(null)
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(result).toEqual({ succeeded: 0, failed: 1 })
    expect(mocks.recordCaldavSyncFailure).toHaveBeenCalledOnce()
    expect(pusher.pushCreate).not.toHaveBeenCalled()
  })

  it('treats a create/update queue entry with no event_id as a failure', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q4', operation: 'update', eventId: null }),
    ])
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(result).toEqual({ succeeded: 0, failed: 1 })
    expect(mocks.getEvent).not.toHaveBeenCalled()
    expect(mocks.recordCaldavSyncFailure).toHaveBeenCalledWith(
      fakeSql,
      'q4',
      expect.stringContaining('no event_id'),
    )
  })

  it('processes multiple pending entries independently, tallying succeeded/failed', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q-ok', operation: 'create', eventId: 'e-ok', caldavUid: 'uid-ok@stura' }),
      makeEntry({ id: 'q-bad', operation: 'delete', eventId: null, caldavUid: 'uid-bad@stura' }),
    ])
    mocks.getEvent.mockResolvedValueOnce(makeEvent('e-ok', 'uid-ok@stura'))
    const pusher = makePusher({
      pushDelete: vi.fn().mockRejectedValueOnce(new Error('DELETE 500')),
    })

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(result).toEqual({ succeeded: 1, failed: 1 })
    expect(mocks.removeCaldavSyncEntry).toHaveBeenCalledWith(fakeSql, 'q-ok')
    expect(mocks.recordCaldavSyncFailure).toHaveBeenCalledWith(fakeSql, 'q-bad', 'DELETE 500')
  })

  it('passes maxAttempts and limit through to listPendingCaldavSync', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([])
    const pusher = makePusher()

    await drainCaldavQueue(fakeSql, pusher, 5, 10)

    expect(mocks.listPendingCaldavSync).toHaveBeenCalledWith(fakeSql, 5, 10)
  })
})
