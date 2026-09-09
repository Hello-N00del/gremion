import { describe, it, expect, vi } from 'vitest'

// --- module stubs (must precede the ./hooks.server import) ---
vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion' } }))
vi.mock('$lib/server/db', () => ({ waitForDbReady: vi.fn(async () => {}), runMigrations: vi.fn(async () => {}), getDb: () => ({}) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ smtp: { configured: false }, modules: { finance: true }, retention: { security_logs_days: 90 } }) }))
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('./auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => null) }))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
vi.mock('$lib/server/tenant/register-default', () => ({ registerDefaultTenant: vi.fn(async () => ({ id: 'tid-1' })) }))
// P2.1b T2: boot's fleet runner lists active tenants (id must match the
// registerDefaultTenant mock above) and ledgers each run.
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async () => ({ id: 'default', slug: 'default', issuer: 'https://kc/realms/sturaos' })),
  listActiveTenants: vi.fn(async () => [{ id: 'tid-1', slug: 'default', status: 'active' }]),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: (_ctx: unknown, fn: () => unknown) => fn() }))
vi.mock('$lib/server/tenant/default-tenant', () => ({ DEFAULT_TENANT: { id: 'default', configPath: '/tmp/config.json' } }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
// --- end stubs ---

import { bearerTenantMatches } from './hooks.server'

describe('bearer path: header-tenant == token-issuer-tenant cross-check', () => {
  it('accepts when the token issuer matches the resolved tenant issuer', () => {
    expect(bearerTenantMatches({ issuer: 'https://kc/realms/tenant-a' }, { iss: 'https://kc/realms/tenant-a' })).toBe(true)
  })
  it('rejects when the token issuer is a DIFFERENT tenant realm', () => {
    expect(bearerTenantMatches({ issuer: 'https://kc/realms/tenant-a' }, { iss: 'https://kc/realms/tenant-b' })).toBe(false)
  })
  it('rejects a token with no iss', () => {
    expect(bearerTenantMatches({ issuer: 'https://kc/realms/tenant-a' }, {})).toBe(false)
  })
})
