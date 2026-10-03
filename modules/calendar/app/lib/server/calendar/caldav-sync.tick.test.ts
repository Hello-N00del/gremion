import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tenant } from '$lib/server/tenant/registry'
import type { TenantContext } from '$lib/server/tenant/context'

// P2.1b T4 — the CalDAV sync worker's cron tick iterates the ACTIVE tenant
// fleet: each tenant's queue drain runs inside its own EXPLICIT runWithTenant
// scope with per-(worker, tenant) single-flight. The tenant CONTEXT module is
// deliberately REAL ([[als-default-tenant-test-harness-masks-fail-closed]]).
// Lives in its own file: caldav-sync.test.ts drains directly with an injected
// pusher and its node-cron mock does not capture callbacks.

type CronCallback = () => unknown
const cronJobs: Array<{ pattern: string; cb: CronCallback }> = []
vi.mock('node-cron', () => ({
  default: {
    schedule: (pattern: string, cb: CronCallback) => {
      cronJobs.push({ pattern, cb })
      return { stop: () => {}, start: () => {} }
    },
  },
}))

vi.mock('$lib/server/tenant/registry', () => ({
  listActiveTenants: vi.fn(),
  resolveTenantBySlug: vi.fn(),
}))

vi.mock('./calendar-db', () => ({
  listPendingCaldavSync: vi.fn(),
  removeCaldavSyncEntry: vi.fn().mockResolvedValue(undefined),
  recordCaldavSyncFailure: vi.fn().mockResolvedValue(undefined),
  markCaldavSynced: vi.fn().mockResolvedValue(undefined),
  getEvent: vi.fn(),
  // Round 2: the tenant drain queues the D-2 cleanup before reading its batch.
  enqueuePrivateCaldavCleanup: vi.fn().mockResolvedValue(0),
}))
vi.mock('./caldav-client', () => ({
  createCalDavPusher: vi.fn(() => ({})),
  dbEventToIcs: vi.fn(),
}))

import { listActiveTenants, resolveTenantBySlug } from '$lib/server/tenant/registry'
import { currentTenantId } from '$lib/server/tenant/context'
import { _resetWorkerFleetForTests } from '$lib/server/tenant/worker-fleet'
import {
  setTenantReadinessFromFleet,
  _resetReadinessForTests,
} from '$lib/server/tenant/readiness'
import { listPendingCaldavSync } from './calendar-db'
import { createCalDavPusher } from './caldav-client'
import { startCalDavSyncWorker } from './caldav-sync'

const tenantRow = (id: string, slug: string) =>
  ({ id, slug, status: 'active' }) as unknown as Tenant
const ctxFor = (id: string, slug: string) => ({ id, slug }) as unknown as TenantContext

// Register the cron job ONCE (startCalDavSyncWorker latches `_started`).
startCalDavSyncWorker()
const tick = cronJobs[0]?.cb

beforeEach(() => {
  vi.clearAllMocks()
  _resetWorkerFleetForTests()
  // D-READY worker gate: ticks only serve tenants the boot fleet marked ready.
  _resetReadinessForTests()
  setTenantReadinessFromFleet(
    new Map([
      ['tid-default', { ok: true }],
      ['tid-beta', { ok: true }],
    ]),
  )
  vi.mocked(listActiveTenants).mockResolvedValue([
    tenantRow('tid-default', 'default'),
    tenantRow('tid-beta', 'beta'),
  ])
  vi.mocked(resolveTenantBySlug).mockImplementation(async (slug: string) =>
    slug === 'default' ? ctxFor('tid-default', 'default') : ctxFor('tid-beta', 'beta'),
  )
  vi.mocked(listPendingCaldavSync).mockResolvedValue([])
  // F1-FIX-08 (H06): every drained tenant needs its own CalDAV collection. Kernel rules (TASK-042, no special tenant): both tenants are mapped explicitly.
  process.env.CALDAV_TENANT_CALENDARS = JSON.stringify({ default: 'stura', beta: 'beta-kalender' })
  delete process.env.CALDAV_CALENDAR_TEMPLATE
  delete process.env.CALDAV_SHARED_CALENDAR
})

describe('CalDAV sync worker tick — per-tenant target (F1-FIX-08 H06)', () => {
  it('drains each tenant into its own collection', async () => {
    await tick!()

    const targets = vi.mocked(createCalDavPusher).mock.calls.map((c) => (c as unknown[])[0])
    expect(targets).toEqual([
      expect.objectContaining({ calendar: 'stura' }),
      expect.objectContaining({ calendar: 'beta-kalender' }),
    ])
  })

  it('refuses a tenant without a configured collection (its queue is not read)', async () => {
    process.env.CALDAV_TENANT_CALENDARS = JSON.stringify({ default: 'stura' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scopes: string[] = []
    vi.mocked(listPendingCaldavSync).mockImplementation(async () => {
      scopes.push(currentTenantId())
      return []
    })

    await tick!()

    expect(scopes).toEqual(['tid-default'])
    expect(warn.mock.calls.some((c) => String(c[0]).includes("'beta'"))).toBe(true)
    warn.mockRestore()
  })
})

describe('CalDAV sync worker tick — P2.1b T4 fleet wrap', () => {
  it('registers the every-30-seconds schedule', () => {
    expect(tick).toBeDefined()
    expect(cronJobs[0].pattern).toBe('*/30 * * * * *')
  })

  it('drains tenant A AND B under explicit contexts', async () => {
    const scopes: string[] = []
    vi.mocked(listPendingCaldavSync).mockImplementation(async () => {
      scopes.push(currentTenantId()) // throws outside an ALS scope
      return []
    })

    await tick!()

    expect(scopes).toEqual(['tid-default', 'tid-beta'])
  })

  it('an overlapping tick skips the in-flight tenant but still drains the other (single-flight)', async () => {
    const scopes: string[] = []
    let enterDefault!: () => void
    const entered = new Promise<void>((r) => {
      enterDefault = r
    })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.mocked(listPendingCaldavSync).mockImplementation(async () => {
      const id = currentTenantId()
      scopes.push(id)
      if (id === 'tid-default') {
        enterDefault()
        await gate
      }
      return []
    })

    const tick1 = tick!() as Promise<void>
    await entered
    const tick2 = tick!() as Promise<void>
    await tick2
    release()
    await tick1

    expect(scopes.filter((id) => id === 'tid-default')).toHaveLength(1)
    expect(scopes.filter((id) => id === 'tid-beta')).toHaveLength(2)
  })

  it("tenant A's throw does not stop tenant B", async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scopes: string[] = []
    vi.mocked(listPendingCaldavSync).mockImplementation(async () => {
      const id = currentTenantId()
      if (id === 'tid-default') throw new Error('default-db down')
      scopes.push(id)
      return []
    })

    await tick!()

    expect(scopes).toEqual(['tid-beta'])
    const lines = errSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('caldav-sync') && l.includes('default'))).toBe(true)
    errSpy.mockRestore()
  })
})
