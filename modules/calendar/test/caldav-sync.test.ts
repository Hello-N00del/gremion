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
  markCaldavUnsynced: vi.fn().mockResolvedValue(undefined),
  getEvent: vi.fn(),
}))

vi.mock('../src/store/index.js', () => mocks)

import { drainCaldavQueue } from '../src/caldav/sync.js'

// The Sql DI parameter is opaque to sync.ts's own logic — it is only ever
// forwarded to the (mocked) store functions — so a stub object is enough.
const fakeSql = {} as Sql

// D-2 (R29-I15): only is_public=true events may ever be pushed to the shared
// Nextcloud calendar, so the default fixture is a PUBLIC event and the
// non-public cases below say so explicitly.
function makeEvent(id: string, uid: string, isPublic = true): DbEvent {
  return {
    id,
    title: 'Test',
    description: null,
    location: null,
    startAt: new Date('2026-01-01T10:00:00Z'),
    endAt: new Date('2026-01-01T11:00:00Z'),
    allDay: false,
    isPublic,
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

  // K4#6: a create/update whose event is already gone has nothing left to push
  // (a delete entry for the same uid carries the removal). It used to land in the
  // failed list forever; it is now retired.
  it('retires a create/update whose event vanished instead of failing it forever', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q3', operation: 'create', eventId: 'missing' }),
    ])
    mocks.getEvent.mockResolvedValueOnce(null)
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(result).toEqual({ succeeded: 1, failed: 0 })
    expect(mocks.recordCaldavSyncFailure).not.toHaveBeenCalled()
    expect(mocks.removeCaldavSyncEntry).toHaveBeenCalledWith(fakeSql, 'q3')
    expect(pusher.pushCreate).not.toHaveBeenCalled()
  })

  it('retires a create/update queue entry whose event_id was nulled by the event delete', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([
      makeEntry({ id: 'q4', operation: 'update', eventId: null }),
    ])
    const pusher = makePusher()

    const result = await drainCaldavQueue(fakeSql, pusher)

    expect(result).toEqual({ succeeded: 1, failed: 0 })
    expect(mocks.getEvent).not.toHaveBeenCalled()
    expect(mocks.recordCaldavSyncFailure).not.toHaveBeenCalled()
    expect(mocks.removeCaldavSyncEntry).toHaveBeenCalledWith(fakeSql, 'q4')
    expect(pusher.pushUpdate).not.toHaveBeenCalled()
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

  // ── D-2 = NEVER PUSH NON-PUBLIC (R29-I15, H06) ─────────────────────────────
  describe('D-2: is_public=false events never reach the shared calendar', () => {
    it('does NOT push a queued create for a non-public event, and retires the queue row', async () => {
      mocks.listPendingCaldavSync.mockResolvedValueOnce([
        makeEntry({ id: 'np1', operation: 'create', eventId: 'e-np', caldavUid: 'uid-np@stura' }),
      ])
      mocks.getEvent.mockResolvedValueOnce(makeEvent('e-np', 'uid-np@stura', false))
      const pusher = makePusher()

      const result = await drainCaldavQueue(fakeSql, pusher)

      expect(pusher.pushCreate).not.toHaveBeenCalled()
      expect(pusher.pushUpdate).not.toHaveBeenCalled()
      expect(mocks.markCaldavSynced).not.toHaveBeenCalled()
      expect(mocks.removeCaldavSyncEntry).toHaveBeenCalledWith(fakeSql, 'np1')
      expect(result).toEqual({ succeeded: 1, failed: 0 })
    })

    it('does NOT push a queued update for a non-public event; it retracts any earlier copy instead', async () => {
      mocks.listPendingCaldavSync.mockResolvedValueOnce([
        makeEntry({ id: 'np2', operation: 'update', eventId: 'e-np2', caldavUid: 'uid-np2@stura' }),
      ])
      // The event was public once (pushed), then flipped to non-public.
      mocks.getEvent.mockResolvedValueOnce(makeEvent('e-np2', 'uid-np2@stura', false))
      const pusher = makePusher()

      const result = await drainCaldavQueue(fakeSql, pusher)

      expect(pusher.pushUpdate).not.toHaveBeenCalled()
      expect(pusher.pushCreate).not.toHaveBeenCalled()
      expect(pusher.pushDelete).toHaveBeenCalledWith('uid-np2@stura')
      expect(mocks.removeCaldavSyncEntry).toHaveBeenCalledWith(fakeSql, 'np2')
      expect(result).toEqual({ succeeded: 1, failed: 0 })
    })

    // After the retract the copy is gone, so the row must stop looking synced:
    // otherwise migration 004 re-queues it on every leaf first contact.
    it('clears caldav_synced_at AFTER the retract DELETE succeeded', async () => {
      mocks.listPendingCaldavSync.mockResolvedValueOnce([
        makeEntry({ id: 'np4', operation: 'update', eventId: 'e-np4', caldavUid: 'uid-np4@stura' }),
      ])
      mocks.getEvent.mockResolvedValueOnce(makeEvent('e-np4', 'uid-np4@stura', false))
      const order: string[] = []
      const pusher = makePusher({
        pushDelete: vi.fn().mockImplementation(async () => {
          order.push('pushDelete')
        }),
      })
      mocks.markCaldavUnsynced.mockImplementationOnce(async () => {
        order.push('markCaldavUnsynced')
      })

      await drainCaldavQueue(fakeSql, pusher)

      expect(mocks.markCaldavUnsynced).toHaveBeenCalledWith(fakeSql, 'e-np4')
      expect(order).toEqual(['pushDelete', 'markCaldavUnsynced'])
    })

    it('does NOT clear caldav_synced_at when the retract DELETE fails (the copy may still exist)', async () => {
      mocks.listPendingCaldavSync.mockResolvedValueOnce([
        makeEntry({ id: 'np5', operation: 'update', eventId: 'e-np5', caldavUid: 'uid-np5@stura' }),
      ])
      mocks.getEvent.mockResolvedValueOnce(makeEvent('e-np5', 'uid-np5@stura', false))
      const pusher = makePusher({
        pushDelete: vi.fn().mockRejectedValueOnce(new Error('DELETE 500')),
      })

      const result = await drainCaldavQueue(fakeSql, pusher)

      expect(mocks.markCaldavUnsynced).not.toHaveBeenCalled()
      expect(result).toEqual({ succeeded: 0, failed: 1 })
    })

    it('a non-public create touches neither the pusher nor caldav_synced_at', async () => {
      mocks.listPendingCaldavSync.mockResolvedValueOnce([
        makeEntry({ id: 'np6', operation: 'create', eventId: 'e-np6', caldavUid: 'uid-np6@stura' }),
      ])
      mocks.getEvent.mockResolvedValueOnce(makeEvent('e-np6', 'uid-np6@stura', false))
      const pusher = makePusher()

      await drainCaldavQueue(fakeSql, pusher)

      expect(pusher.pushDelete).not.toHaveBeenCalled()
      expect(mocks.markCaldavUnsynced).not.toHaveBeenCalled()
      expect(mocks.markCaldavSynced).not.toHaveBeenCalled()
    })

    it('fails closed: an event whose isPublic is missing is treated as non-public', async () => {
      mocks.listPendingCaldavSync.mockResolvedValueOnce([
        makeEntry({ id: 'np3', operation: 'create', eventId: 'e-np3', caldavUid: 'uid-np3@stura' }),
      ])
      const ev = makeEvent('e-np3', 'uid-np3@stura') as Partial<DbEvent>
      delete ev.isPublic
      mocks.getEvent.mockResolvedValueOnce(ev)
      const pusher = makePusher()

      await drainCaldavQueue(fakeSql, pusher)

      expect(pusher.pushCreate).not.toHaveBeenCalled()
      expect(pusher.pushUpdate).not.toHaveBeenCalled()
    })

    it('still pushes a PUBLIC event (the guard is not a blanket stop)', async () => {
      mocks.listPendingCaldavSync.mockResolvedValueOnce([
        makeEntry({ id: 'p1', operation: 'create', eventId: 'e-p', caldavUid: 'uid-p@stura' }),
      ])
      mocks.getEvent.mockResolvedValueOnce(makeEvent('e-p', 'uid-p@stura', true))
      const pusher = makePusher()

      await drainCaldavQueue(fakeSql, pusher)

      expect(pusher.pushCreate).toHaveBeenCalledOnce()
    })
  })

  it('passes maxAttempts and limit through to listPendingCaldavSync', async () => {
    mocks.listPendingCaldavSync.mockResolvedValueOnce([])
    const pusher = makePusher()

    await drainCaldavQueue(fakeSql, pusher, 5, 10)

    expect(mocks.listPendingCaldavSync).toHaveBeenCalledWith(fakeSql, 5, 10)
  })
})
