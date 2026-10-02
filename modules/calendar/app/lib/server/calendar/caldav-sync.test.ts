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
  getEvent: vi.fn(),
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

import { drainCaldavQueue } from './caldav-sync'
import {
  listPendingCaldavSync,
  removeCaldavSyncEntry,
  recordCaldavSyncFailure,
  markCaldavSynced,
  getEvent,
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

  it('treats missing event as a failure for create/update', async () => {
    vi.mocked(listPendingCaldavSync).mockResolvedValueOnce([
      makeEntry({ id: 'q3', operation: 'create', eventId: 'missing' }),
    ])
    vi.mocked(getEvent).mockResolvedValueOnce(null)
    const pusher = {
      pushCreate: vi.fn(),
      pushUpdate: vi.fn(),
      pushDelete: vi.fn(),
    } as unknown as import('./caldav-client').CalDavPusher

    const result = await drainCaldavQueue(pusher)

    expect(result).toEqual({ succeeded: 0, failed: 1 })
    expect(recordCaldavSyncFailure).toHaveBeenCalledOnce()
  })
})
