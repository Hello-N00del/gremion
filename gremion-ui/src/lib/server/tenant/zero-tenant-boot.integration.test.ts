// TASK-042 TDD 2 (PRD-PLAT-012, TRD-075): the REAL boot() on fresh, empty
// registries writes NOTHING into the tenant registry and completes healthy.
// Before TASK-042 boot inserted the env-derived `default` tenant (count 1) and
// then threw when it could not resolve it.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('../../../auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
// $lib/server/db, control-db, control-migrations, registry, context stay REAL.

import { getControlDb } from './control-db'
import { _getAls } from './context'
import { _resetResolutionCacheForTests } from './registry'

async function count(table: 'tenant' | 'tenant_domain' | 'tenant_migration_run'): Promise<number> {
  const rows = await getControlDb().unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`)
  return rows[0].n
}

describe('zero-tenant boot (TASK-042): boot writes nothing and serves with zero tenants', () => {
  beforeAll(async () => {
    const { runControlMigrations } = await import('./control-migrations')
    await runControlMigrations()
  })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
    process.exitCode = 0
    vi.resetModules()
  })

  it('after boot() on an empty registry: tenant count 0, exitCode 0, boot complete', async () => {
    expect(await count('tenant')).toBe(0)

    // Production boots with no ambient tenant: import (and so boot) outside ALS.
    const mod = await _getAls().exit(async () => {
      const m = await import('../../../hooks.server')
      await m.boot()
      return m
    })

    const status = mod.getBootStatus()
    expect(status.error).toBeNull()
    expect(status.complete).toBe(true)
    expect(process.exitCode).toBe(0)
    expect(await count('tenant')).toBe(0)
    expect(await count('tenant_domain')).toBe(0)
    expect(await count('tenant_migration_run')).toBe(0)

    const readiness = await import('./readiness')
    expect(readiness.isFleetPopulated()).toBe(true)
  })
})
