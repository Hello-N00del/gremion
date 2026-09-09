import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tenant } from '$lib/server/tenant/registry'
import type { TenantContext } from '$lib/server/tenant/context'

// P2.1b T4 — the provisioning worker's cron tick iterates the ACTIVE tenant
// fleet: BOTH drivers (the org-unit reconcile loop AND P0.3a's
// drainDueMemberOps, which run within provisionDuePending) execute inside each
// tenant's EXPLICIT runWithTenant scope, with per-(worker, tenant)
// single-flight replacing the old process-global `_running` boolean. The
// tenant CONTEXT module is deliberately REAL so currentTenantId() recording
// proves the explicit per-tenant ALS scope
// ([[als-default-tenant-test-harness-masks-fail-closed]]).

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

vi.mock('./ledger', () => ({
  listDueOrgUnitIds: vi.fn(),
  getResource: vi.fn(),
}))
vi.mock('./member-ops', () => ({
  listDueMemberOps: vi.fn(),
  markMemberOpOk: vi.fn(),
  markMemberOpFailed: vi.fn(),
}))
vi.mock('./orchestrator', () => ({
  provisionOrgUnit: vi.fn(),
  defaultAdapters: vi.fn(() => ({})),
}))
vi.mock('../org-units-db', () => ({
  isMemberOf: vi.fn(),
}))

import { listActiveTenants, resolveTenantBySlug } from '$lib/server/tenant/registry'
import { currentTenantId } from '$lib/server/tenant/context'
import { _resetWorkerFleetForTests } from '$lib/server/tenant/worker-fleet'
import {
  setTenantReadinessFromFleet,
  _resetReadinessForTests,
} from '$lib/server/tenant/readiness'
import { listDueOrgUnitIds } from './ledger'
import { listDueMemberOps } from './member-ops'
import { startProvisioningWorker } from './worker'

const tenantRow = (id: string, slug: string) =>
  ({ id, slug, status: 'active' }) as unknown as Tenant
const ctxFor = (id: string, slug: string) => ({ id, slug }) as unknown as TenantContext

// Register the cron job ONCE (startProvisioningWorker latches `_started`);
// the captured callback is re-invoked per test below.
startProvisioningWorker()
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
  vi.mocked(listDueOrgUnitIds).mockResolvedValue([])
  vi.mocked(listDueMemberOps).mockResolvedValue([])
})

describe('provisioning worker tick — P2.1b T4 fleet wrap', () => {
  it('registers the once-a-minute schedule', () => {
    expect(tick).toBeDefined()
    expect(cronJobs[0].pattern).toBe('* * * * *')
  })

  it('drains BOTH drivers (org-units AND member-ops) for tenant A and B under explicit contexts', async () => {
    const unitScopes: string[] = []
    const memberOpScopes: string[] = []
    vi.mocked(listDueOrgUnitIds).mockImplementation(async () => {
      unitScopes.push(currentTenantId()) // throws outside an ALS scope
      return []
    })
    vi.mocked(listDueMemberOps).mockImplementation(async () => {
      memberOpScopes.push(currentTenantId())
      return []
    })

    await tick!()

    expect(unitScopes).toEqual(['tid-default', 'tid-beta'])
    // P0.3a's drainDueMemberOps ran per tenant too (inside provisionDuePending).
    expect(memberOpScopes).toEqual(['tid-default', 'tid-beta'])
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
    vi.mocked(listDueOrgUnitIds).mockImplementation(async () => {
      const id = currentTenantId()
      scopes.push(id)
      if (id === 'tid-default') {
        enterDefault()
        await gate
      }
      return []
    })

    const tick1 = tick!() as Promise<void>
    await entered // tick1 is blocked inside the default tenant's drain
    const tick2 = tick!() as Promise<void>
    await tick2 // tick2 skipped default (in flight) and drained beta
    release()
    await tick1

    expect(scopes.filter((id) => id === 'tid-default')).toHaveLength(1)
    expect(scopes.filter((id) => id === 'tid-beta')).toHaveLength(2)
  })

  it("tenant A's throw does not stop tenant B", async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scopes: string[] = []
    vi.mocked(listDueOrgUnitIds).mockImplementation(async () => {
      const id = currentTenantId()
      if (id === 'tid-default') throw new Error('default-db down')
      scopes.push(id)
      return []
    })

    await tick!()

    expect(scopes).toEqual(['tid-beta'])
    const lines = errSpy.mock.calls.map((c) => c.join(' '))
    expect(lines.some((l) => l.includes('provisioning-worker') && l.includes('default'))).toBe(true)
    errSpy.mockRestore()
  })
})
