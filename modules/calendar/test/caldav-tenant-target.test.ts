// modules/calendar/test/caldav-tenant-target.test.ts
//
// F1-FIX-08-K / H06 (K4#30): the CalDAV drain used to push EVERY tenant's events
// into one env-fixed Nextcloud collection. The target is now resolved per tenant
// and the drain refuses when no per-tenant target is configured.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DbCalDavQueueEntry, DbEvent } from '../src/store/index.js'
import type { Sql } from '../src/tenant-store.js'

const mocks = vi.hoisted(() => ({
  listPendingCaldavSync: vi.fn(),
  removeCaldavSyncEntry: vi.fn().mockResolvedValue(undefined),
  recordCaldavSyncFailure: vi.fn().mockResolvedValue(undefined),
  markCaldavSynced: vi.fn().mockResolvedValue(undefined),
  getEvent: vi.fn(),
}))
vi.mock('../src/store/index.js', () => mocks)

import { resolveCaldavTarget } from '../src/caldav/target.js'
import { drainCaldavForTenant, _resetTenantDrainWarnings } from '../src/caldav/tenant-drain.js'
import { createCalDavPusher } from '../src/caldav/pusher.js'

const fakeSql = {} as Sql

describe('resolveCaldavTarget (H06)', () => {
  it('maps each tenant slug to its own calendar via CALDAV_TENANT_CALENDARS', () => {
    const env = { CALDAV_TENANT_CALENDARS: JSON.stringify({ alpha: 'cal-a', beta: 'cal-b' }) }
    const a = resolveCaldavTarget({ slug: 'alpha' }, env)
    const b = resolveCaldavTarget({ slug: 'beta' }, env)
    expect(a).toMatchObject({ ok: true, target: { calendar: 'cal-a' } })
    expect(b).toMatchObject({ ok: true, target: { calendar: 'cal-b' } })
  })

  it('derives a per-tenant calendar from CALDAV_CALENDAR_TEMPLATE containing {slug}', () => {
    const env = { CALDAV_CALENDAR_TEMPLATE: 'stura-{slug}' }
    expect(resolveCaldavTarget({ slug: 'alpha' }, env)).toMatchObject({ ok: true, target: { calendar: 'stura-alpha' } })
    expect(resolveCaldavTarget({ slug: 'beta' }, env)).toMatchObject({ ok: true, target: { calendar: 'stura-beta' } })
  })

  it('an explicit map entry wins over the template', () => {
    const env = { CALDAV_CALENDAR_TEMPLATE: 'stura-{slug}', CALDAV_TENANT_CALENDARS: '{"alpha":"legacy"}' }
    expect(resolveCaldavTarget({ slug: 'alpha' }, env)).toMatchObject({ ok: true, target: { calendar: 'legacy' } })
    expect(resolveCaldavTarget({ slug: 'beta' }, env)).toMatchObject({ ok: true, target: { calendar: 'stura-beta' } })
  })

  it('REFUSES when only the legacy shared calendar is configured: one collection for all tenants is the defect', () => {
    const r = resolveCaldavTarget({ slug: 'alpha' }, { CALDAV_SHARED_CALENDAR: 'stura', CALDAV_SHARED_USER: 'admin' })
    expect(r.ok).toBe(false)
  })

  it('REFUSES with no configuration at all', () => {
    expect(resolveCaldavTarget({ slug: 'alpha' }, {}).ok).toBe(false)
  })

  it('REFUSES a template without {slug} (it would still be one shared collection)', () => {
    expect(resolveCaldavTarget({ slug: 'alpha' }, { CALDAV_CALENDAR_TEMPLATE: 'stura' }).ok).toBe(false)
  })

  it('REFUSES (for every tenant) when two tenants are mapped to the same calendar', () => {
    const env = { CALDAV_TENANT_CALENDARS: JSON.stringify({ alpha: 'shared', beta: 'shared' }) }
    expect(resolveCaldavTarget({ slug: 'alpha' }, env).ok).toBe(false)
    expect(resolveCaldavTarget({ slug: 'beta' }, env).ok).toBe(false)
  })

  it('REFUSES an unparseable map, a non-string entry and a path-shaped calendar name', () => {
    expect(resolveCaldavTarget({ slug: 'alpha' }, { CALDAV_TENANT_CALENDARS: '{nope' }).ok).toBe(false)
    expect(resolveCaldavTarget({ slug: 'alpha' }, { CALDAV_TENANT_CALENDARS: '{"alpha":7}' }).ok).toBe(false)
    expect(resolveCaldavTarget({ slug: 'alpha' }, { CALDAV_TENANT_CALENDARS: '{"alpha":"../other"}' }).ok).toBe(false)
  })

  it('a tenant with no entry and no template is refused even when others are mapped', () => {
    const env = { CALDAV_TENANT_CALENDARS: '{"alpha":"cal-a"}' }
    expect(resolveCaldavTarget({ slug: 'gamma' }, env).ok).toBe(false)
  })
})

function publicEvent(id: string, uid: string): DbEvent {
  return {
    id,
    title: 'T',
    description: null,
    location: null,
    startAt: new Date('2026-01-01T10:00:00Z'),
    endAt: new Date('2026-01-01T11:00:00Z'),
    allDay: false,
    isPublic: true,
    eventTypeId: null,
    eventTypeColor: null,
    eventTypeName: null,
    isMultiCommittee: false,
    createdBy: 'u',
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
  } as DbEvent
}

describe('drainCaldavForTenant (H06)', () => {
  const ENV = {
    NEXTCLOUD_URL: 'http://nc.test',
    NEXTCLOUD_ADMIN_USER: 'admin',
    NEXTCLOUD_ADMIN_PASSWORD: 'pw',
    CALDAV_TENANT_CALENDARS: JSON.stringify({ alpha: 'cal-a', beta: 'cal-b' }),
  }
  let urls: string[]
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(String(url))
    return new Response(null, { status: 201 })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    _resetTenantDrainWarnings()
    urls = []
    const entry: DbCalDavQueueEntry = {
      id: 'q1',
      eventId: 'e1',
      caldavUid: 'uid-1@stura',
      operation: 'create',
      attempts: 0,
      lastError: null,
      createdAt: new Date(),
    }
    mocks.listPendingCaldavSync.mockResolvedValue([entry])
    mocks.getEvent.mockResolvedValue(publicEvent('e1', 'uid-1@stura'))
  })

  const makePusher = (t: { user: string; calendar: string }) =>
    createCalDavPusher({
      nextcloudUrl: 'http://nc.test',
      adminUser: 'admin',
      adminPassword: 'pw',
      sharedUser: t.user,
      sharedCalendar: t.calendar,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

  it('two tenants are drained into two DIFFERENT collections', async () => {
    const a = await drainCaldavForTenant(fakeSql, { slug: 'alpha' }, { env: ENV, makePusher })
    const b = await drainCaldavForTenant(fakeSql, { slug: 'beta' }, { env: ENV, makePusher })

    expect(a).toEqual({ succeeded: 1, failed: 0 })
    expect(b).toEqual({ succeeded: 1, failed: 0 })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/calendars/admin/cal-a/')
    expect(urls[1]).toContain('/calendars/admin/cal-b/')
    expect(urls[0]).not.toBe(urls[1])
  })

  it('REFUSES to drain when no per-tenant target is configured: nothing pushed, queue untouched', async () => {
    const legacyOnly = { ...ENV, CALDAV_TENANT_CALENDARS: undefined, CALDAV_SHARED_CALENDAR: 'stura' }
    const r = await drainCaldavForTenant(fakeSql, { slug: 'alpha' }, { env: legacyOnly, makePusher })

    expect(r.refused).toBeTruthy()
    expect(r).toMatchObject({ succeeded: 0, failed: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(mocks.listPendingCaldavSync).not.toHaveBeenCalled()
    expect(mocks.removeCaldavSyncEntry).not.toHaveBeenCalled()
    expect(mocks.recordCaldavSyncFailure).not.toHaveBeenCalled()
  })

  it('REFUSES when the Nextcloud admin password is empty (no opaque 401 loop)', async () => {
    const r = await drainCaldavForTenant(fakeSql, { slug: 'alpha' }, { env: { ...ENV, NEXTCLOUD_ADMIN_PASSWORD: '' } })
    expect(r.refused).toMatch(/NEXTCLOUD_ADMIN_PASSWORD/)
    expect(mocks.listPendingCaldavSync).not.toHaveBeenCalled()
  })

  it('logs a refusal once per tenant, not once per tick', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) await drainCaldavForTenant(fakeSql, { slug: 'alpha' }, { env: {}, makePusher })
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })
})
