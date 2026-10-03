import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tenant } from '$lib/server/tenant/registry'
import type { TenantContext } from '$lib/server/tenant/context'

// P2.1b T4 — the notification scheduler's weekly cron tick iterates the ACTIVE
// tenant fleet: each tenant's due-notification drain runs inside its own
// EXPLICIT runWithTenant scope with per-(worker, tenant) single-flight. The
// tenant CONTEXT module is deliberately REAL
// ([[als-default-tenant-test-harness-masks-fail-closed]]). Lives in its own
// file: notification-scheduler.test.ts exercises processDueNotifications
// directly and its node-cron mock does not capture callbacks.

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

vi.mock('../governance/governance-db', () => ({
  listDueNotifications: vi.fn(),
  markNotificationSent: vi.fn().mockResolvedValue(undefined),
  markNotificationFailed: vi.fn().mockResolvedValue(undefined),
}))

// SP-2: the tick now resolves the sender per-tenant from the mail seam. Default
// mock = configured transport; individual tests override for the skip case.
vi.mock('$lib/server/mail/tenant-mail', () => ({
  getTenantMailContext: vi.fn(() => ({
    transport: { sendMail: vi.fn().mockResolvedValue({ messageId: 'mid' }) },
    from: 'F <f@x.de>',
    configured: true,
  })),
}))

import { listActiveTenants, resolveTenantBySlug } from '$lib/server/tenant/registry'
import { currentTenantId } from '$lib/server/tenant/context'
import { _resetWorkerFleetForTests } from '$lib/server/tenant/worker-fleet'
import {
  setTenantReadinessFromFleet,
  _resetReadinessForTests,
} from '$lib/server/tenant/readiness'
import { listDueNotifications } from '../governance/governance-db'
import { getTenantMailContext } from '$lib/server/mail/tenant-mail'
import { startNotificationScheduler } from './notification-scheduler'

const tenantRow = (id: string, slug: string) =>
  ({ id, slug, status: 'active' }) as unknown as Tenant
const ctxFor = (id: string, slug: string) => ({ id, slug }) as unknown as TenantContext

// Register the cron job ONCE (startNotificationScheduler latches `_started`).
// SP-2: no boot sender — the tick resolves a per-tenant sender from the mail seam.
startNotificationScheduler()
const tick = cronJobs[0]?.cb

beforeEach(() => {
  vi.clearAllMocks()
  // SP-2: every test starts with a configured per-tenant transport; the skip
  // test overrides this. (clearAllMocks clears call history, not implementations,
  // but a prior mockReturnValue would otherwise leak — restore the default here.)
  vi.mocked(getTenantMailContext).mockReturnValue({
    transport: { sendMail: vi.fn().mockResolvedValue({ messageId: 'mid' }) } as never,
    from: 'F <f@x.de>',
    configured: true,
  })
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
  vi.mocked(listDueNotifications).mockResolvedValue([])
})

describe('notification scheduler tick — P2.1b T4 fleet wrap', () => {
  it('registers the weekly Monday-07:00 schedule', () => {
    expect(tick).toBeDefined()
    expect(cronJobs[0].pattern).toBe('0 7 * * 1')
  })

  it('drains tenant A AND B under explicit contexts', async () => {
    const scopes: string[] = []
    vi.mocked(listDueNotifications).mockImplementation(async () => {
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
    vi.mocked(listDueNotifications).mockImplementation(async () => {
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
    vi.mocked(listDueNotifications).mockImplementation(async () => {
      const id = currentTenantId()
      if (id === 'tid-default') throw new Error('default-db down')
      scopes.push(id)
      return []
    })

    await tick!()

    expect(scopes).toEqual(['tid-beta'])
    const lines = errSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('notification-scheduler') && l.includes('default'))).toBe(true)
    errSpy.mockRestore()
  })

  it('SP-2: skips a tenant whose SMTP is unconfigured (no drain attempted)', async () => {
    // Every active tenant resolves to an unconfigured transport → no drain.
    vi.mocked(getTenantMailContext).mockReturnValue({
      transport: { sendMail: vi.fn() } as never,
      from: '',
      configured: false,
    })

    await tick!()

    expect(listDueNotifications).not.toHaveBeenCalled()
  })
})
