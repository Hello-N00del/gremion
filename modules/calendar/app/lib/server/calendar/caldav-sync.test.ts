import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DbCalDavQueueEntry, DbEvent } from './calendar-db'

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
}))

vi.mock('./calendar-db', () => ({
  listPendingCaldavSync: vi.fn(),
  removeCaldavSyncEntry: vi.fn().mockResolvedValue(undefined),
  recordCaldavSyncFailure: vi.fn().mockResolvedValue(undefined),
  markCaldavSynced: vi.fn().mockResolvedValue(undefined),
  markCaldavUnsynced: vi.fn().mockResolvedValue(undefined),
  getEvent: vi.fn(),
  getEventPublicFlag: vi.fn(),
  enqueuePrivateCaldavCleanup: vi.fn().mockResolvedValue(0),
}))

vi.mock('./caldav-client', () => ({
  createCalDavPusher: vi.fn(),
  dbEventToIcs: vi.fn((ev: DbEvent) => ({
    uid: ev.caldavUid ?? ev.id,
    summary: ev.title,
    description: ev.description,
    location: ev.location,
    dtstart: ev.startAt,
    dtend: ev.endAt,
    allDay: ev.allDay,
    recurrence: ev.recurrence,
  })),
}))

import { drainCaldavQueue, drainTenantCaldav } from './caldav-sync'
import {
  listPendingCaldavSync,
  removeCaldavSyncEntry,
  recordCaldavSyncFailure,
  markCaldavSynced,
  markCaldavUnsynced,
  getEvent,
  getEventPublicFlag,
  enqueuePrivateCaldavCleanup,
} from './calendar-db'

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

function makeEntry(
  partial: Partial<DbCalDavQueueEntry>,
): DbCalDavQueueEntry {
  return {
    id: partial.id ?? 'q1',
    eventId: partial.eventId ?? 'e1',
    caldavUid: partial.caldavUid ?? 'uid-1@stura',
    operation: partial.operation ?? 'create',
    attempts: partial.attempts ?? 0,
    lastError: partial.lastError ?? null,
    createdAt: partial.createdAt ?? new Date(),
  }
}

describe('drainCaldavQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Existing cases model public events; D-2 cases override per test.
    vi.mocked(getEventPublicFlag).mockResolvedValue(true)
  })

  it('does nothing when the queue is empty', async () => {
    vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([])
    const pusher = {
      pushCreate: vi.fn(),
      pushUpdate: vi.fn(),
      pushDelete: vi.fn(),
    } as unknown as import('./caldav-client').CalDavPusher

    const result = await drainCaldavQueue(pusher)

    expect(result).toEqual({ succeeded: 0, failed: 0 })
    expect(pusher.pushCreate).not.toHaveBeenCalled()
  })

  it('pushes a create and marks it synced on success', async () => {
    vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
      makeEntry({ operation: 'create', eventId: 'e1', caldavUid: 'uid-1@stura' }),
    ])
    vi.mocked(getEvent).mockResolvedValueOnce(makeEvent('e1', 'uid-1@stura'))
    const pushCreate = vi.fn().mockResolvedValue(undefined)
    const pusher = {
      pushCreate,
      pushUpdate: vi.fn(),
      pushDelete: vi.fn(),
    } as unknown as import('./caldav-client').CalDavPusher

    const result = await drainCaldavQueue(pusher)

    expect(pushCreate).toHaveBeenCalledOnce()
    expect(markCaldavSynced).toHaveBeenCalledWith('e1')
    expect(removeCaldavSyncEntry).toHaveBeenCalledWith('q1')
    expect(result).toEqual({ succeeded: 1, failed: 0 })
  })

  it('pushes a delete using stored uid when event row is already gone', async () => {
    vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
      makeEntry({ id: 'q9', operation: 'delete', eventId: null, caldavUid: 'old@stura' }),
    ])
    const pushDelete = vi.fn().mockResolvedValue(undefined)
    const pusher = {
      pushCreate: vi.fn(),
      pushUpdate: vi.fn(),
      pushDelete,
    } as unknown as import('./caldav-client').CalDavPusher

    const result = await drainCaldavQueue(pusher)

    expect(pushDelete).toHaveBeenCalledWith('old@stura')
    // getEvent never called for delete path
    expect(getEvent).not.toHaveBeenCalled()
    expect(removeCaldavSyncEntry).toHaveBeenCalledWith('q9')
    expect(result.succeeded).toBe(1)
  })

  it('records a failure when the pusher throws (does not remove entry)', async () => {
    vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
      makeEntry({ id: 'q2', operation: 'update', eventId: 'e2' }),
    ])
    vi.mocked(getEvent).mockResolvedValueOnce(makeEvent('e2', 'uid-2@stura'))
    const pushUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Nextcloud down'))
    const pusher = {
      pushCreate: vi.fn(),
      pushUpdate,
      pushDelete: vi.fn(),
    } as unknown as import('./caldav-client').CalDavPusher

    const result = await drainCaldavQueue(pusher)

    expect(recordCaldavSyncFailure).toHaveBeenCalledWith('q2', 'Nextcloud down')
    expect(removeCaldavSyncEntry).not.toHaveBeenCalledWith('q2')
    expect(result).toEqual({ succeeded: 0, failed: 1 })
  })

  // F1-FIX-08 (K4#6 twin): a create/update for an event that is gone is
  // obsolete — the delete row cleans up CalDAV. It used to dead-letter.
  it('drops a create/update for a missing event as done (no push, no failure)', async () => {
    vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
      makeEntry({ id: 'q3', operation: 'create', eventId: 'missing' }),
    ])
    vi.mocked(getEvent).mockResolvedValueOnce(null)
    const pusher = makePusher()

    const result = await drainCaldavQueue(pusher)

    expect(result).toEqual({ succeeded: 1, failed: 0 })
    expect(recordCaldavSyncFailure).not.toHaveBeenCalled()
    expect(removeCaldavSyncEntry).toHaveBeenCalledWith('q3')
    expect(pusher.pushCreate).not.toHaveBeenCalled()
  })

  // Operator decision D-2 (R29-I15): NEVER PUSH NON-PUBLIC.
  describe('D-2: is_public=false events never reach the shared calendar', () => {
    it('a create for a non-public event pushes nothing and completes the row', async () => {
      vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
        makeEntry({ id: 'q-priv', operation: 'create', eventId: 'e-priv', caldavUid: 'priv@stura' }),
      ])
      vi.mocked(getEvent).mockResolvedValueOnce(makeEvent('e-priv', 'priv@stura'))
      vi.mocked(getEventPublicFlag).mockResolvedValueOnce(false)
      const pusher = makePusher()

      const result = await drainCaldavQueue(pusher)

      expect(pusher.pushCreate).not.toHaveBeenCalled()
      expect(markCaldavSynced).not.toHaveBeenCalled()
      expect(removeCaldavSyncEntry).toHaveBeenCalledWith('q-priv')
      expect(result).toEqual({ succeeded: 1, failed: 0 })
    })

    it('an update for a non-public event deletes its CalDAV copy instead of pushing it', async () => {
      vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
        makeEntry({ id: 'q-unpub', operation: 'update', eventId: 'e-unpub', caldavUid: 'unpub@stura' }),
      ])
      vi.mocked(getEvent).mockResolvedValueOnce(makeEvent('e-unpub', 'unpub@stura'))
      vi.mocked(getEventPublicFlag).mockResolvedValueOnce(false)
      const pusher = makePusher()

      const result = await drainCaldavQueue(pusher)

      expect(pusher.pushUpdate).not.toHaveBeenCalled()
      expect(pusher.pushDelete).toHaveBeenCalledWith('unpub@stura')
      expect(markCaldavUnsynced).toHaveBeenCalledWith('e-unpub')
      expect(result).toEqual({ succeeded: 1, failed: 0 })
    })

    // Round 2 (K4#6 / S4#12 in-process twin): the D-2 update path DELETEs every
    // private event's CalDAV copy, and a never-synced one has none, so Nextcloud
    // answers 404. The real in-process pusher threw on it and the row
    // dead-lettered after 3 attempts. A 404/410 means the copy is gone: done.
    it.each([404, 410])('a DELETE answered %i completes the row (real CalDavPusher)', async (status) => {
      const { CalDavPusher } = await vi.importActual<typeof import('./caldav-client')>('./caldav-client')
      const { NextcloudResponseError } = await import('../files/nextcloud-client')
      const nc = {
        deleteEvent: vi.fn().mockRejectedValue(
          new NextcloudResponseError({ method: 'DELETE', path: '/x.ics', status, contentType: null, bodySnippet: '' }),
        ),
      }
      const pusher = new CalDavPusher(nc as never, 'admin', 'stura')
      vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
        makeEntry({ id: 'q-never', operation: 'update', eventId: 'e-never', caldavUid: 'never@stura' }),
      ])
      vi.mocked(getEvent).mockResolvedValueOnce(makeEvent('e-never', 'never@stura'))
      vi.mocked(getEventPublicFlag).mockResolvedValueOnce(false)

      const result = await drainCaldavQueue(pusher)

      expect(nc.deleteEvent).toHaveBeenCalledWith('/remote.php/dav/calendars/admin/stura/never@stura.ics', 'admin')
      expect(result).toEqual({ succeeded: 1, failed: 0 })
      expect(removeCaldavSyncEntry).toHaveBeenCalledWith('q-never')
      expect(recordCaldavSyncFailure).not.toHaveBeenCalled()
    })

    // Leaf twin (house finding 4): a 404 for an event that WAS synced means its
    // copy most likely sits in a former collection: complete, but warn.
    it('warns when a 404 completes the cleanup of an event that was synced before', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
          makeEntry({ id: 'q-moved', operation: 'update', eventId: 'e-moved', caldavUid: 'moved@stura' }),
        ])
        vi.mocked(getEvent).mockResolvedValueOnce({
          ...makeEvent('e-moved', 'moved@stura'),
          caldavSyncedAt: new Date('2026-09-01T00:00:00Z'),
        })
        vi.mocked(getEventPublicFlag).mockResolvedValueOnce(false)
        const pusher = Object.assign(makePusher(), { calPath: '/remote.php/dav/calendars/admin/beta-kalender/' })
        pusher.pushDelete.mockResolvedValueOnce(false)

        const result = await drainCaldavQueue(pusher)

        expect(result).toEqual({ succeeded: 1, failed: 0 })
        const lines = warn.mock.calls.map((c) => c.join(' '))
        expect(lines.some((l) => l.includes('moved@stura') && l.includes('/remote.php/dav/calendars/admin/beta-kalender/'))).toBe(true)
      } finally {
        warn.mockRestore()
      }
    })

    it('a DELETE answered 500 still fails the row (real CalDavPusher)', async () => {
      const { CalDavPusher } = await vi.importActual<typeof import('./caldav-client')>('./caldav-client')
      const { NextcloudResponseError } = await import('../files/nextcloud-client')
      const nc = {
        deleteEvent: vi.fn().mockRejectedValue(
          new NextcloudResponseError({ method: 'DELETE', path: '/x.ics', status: 500, contentType: null, bodySnippet: 'boom' }),
        ),
      }
      const pusher = new CalDavPusher(nc as never, 'admin', 'stura')
      vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
        makeEntry({ id: 'q-del', operation: 'delete', eventId: null, caldavUid: 'gone@stura' }),
      ])

      const result = await drainCaldavQueue(pusher)

      expect(result).toEqual({ succeeded: 0, failed: 1 })
      expect(recordCaldavSyncFailure).toHaveBeenCalledWith('q-del', expect.stringMatching(/500/))
    })
  })
})

function makePusher() {
  return {
    pushCreate: vi.fn().mockResolvedValue(undefined),
    pushUpdate: vi.fn().mockResolvedValue(undefined),
    pushDelete: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('./caldav-client').CalDavPusher & {
    pushCreate: ReturnType<typeof vi.fn>
    pushUpdate: ReturnType<typeof vi.fn>
    pushDelete: ReturnType<typeof vi.fn>
  }
}

// H06 twin: each tenant drains into its own collection; unconfigured → refused.
describe('drainTenantCaldav — per-tenant target (H06)', () => {
  const env = { NEXTCLOUD_ADMIN_USER: 'admin', CALDAV_TENANT_CALENDARS: JSON.stringify({ default: 'stura', beta: 'beta-kalender' }) }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listPendingCaldavSync).mockResolvedValue([])
  })

  it('two tenants resolve two different collections', async () => {
    const targets: Array<{ user: string; calendar: string }> = []
    const makeTenantPusher = (t: { user: string; calendar: string }) => {
      targets.push(t)
      return makePusher()
    }
    await drainTenantCaldav({ slug: 'default' }, { env, makePusher: makeTenantPusher })
    await drainTenantCaldav({ slug: 'beta' }, { env, makePusher: makeTenantPusher })

    expect(targets).toEqual([
      { user: 'admin', calendar: 'stura' },
      { user: 'admin', calendar: 'beta-kalender' },
    ])
  })

  it('refuses an unconfigured tenant without reading its queue', async () => {
    const makeTenantPusher = vi.fn()
    const result = await drainTenantCaldav({ slug: 'gamma' }, { env, makePusher: makeTenantPusher, log: () => {} })

    expect(result.refused).toMatch(/gamma/)
    expect(makeTenantPusher).not.toHaveBeenCalled()
    expect(listPendingCaldavSync).not.toHaveBeenCalled()
    expect(enqueuePrivateCaldavCleanup).not.toHaveBeenCalled()
  })

  // Round 2 (D-2 cleanup, in-process twin of leaf migration 004): private
  // events an earlier push left in the shared calendar are queued for removal
  // before the batch is read, so in-process mode cleans them up too.
  it('queues the D-2 cleanup of already-pushed private events before reading the batch', async () => {
    const order: string[] = []
    vi.mocked(enqueuePrivateCaldavCleanup).mockImplementationOnce(async () => {
      order.push('cleanup')
      return 2
    })
    vi.mocked(listPendingCaldavSync).mockImplementationOnce(async () => {
      order.push('list')
      return []
    })

    await drainTenantCaldav({ slug: 'default' }, { env, makePusher: () => makePusher() })

    expect(order).toEqual(['cleanup', 'list'])
  })
})
