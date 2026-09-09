import { describe, it, expect, vi, beforeEach } from 'vitest'
// @ts-expect-error — runtime-only internal entry (the same one respond.js uses);
// its `types` field points at the top-level kit module decl, so svelte-check
// reports "not a module". The import resolves and runs at test time; the store
// shape is enforced locally via the `state` literal + `as never` below.
import { with_request_store } from '@sveltejs/kit/internal/server'

// SvelteKit 2.61's `sequence()` reads the framework request store
// (`get_request_store()` → `state.tracing.record_span`) at the TOP of the
// composed handle, BEFORE any handler runs. Outside a real server request that
// store is unset, so invoking `mod.handle(...)` directly throws "Could not get
// the request store". The runtime itself (respond.js) wraps handle execution in
// `with_request_store({ event, state }, …)` with a `state` carrying a
// `tracing.record_span` — we provide the same minimal store here. This does NOT
// touch the ordering assertions; it only supplies the request-store the
// framework expects when `sequence()` is exercised in isolation.
function withRequestStore<T>(event: unknown, fn: () => T): T {
  const state = {
    tracing: { record_span: <R>({ fn }: { fn: (span: unknown) => Promise<R> }) => fn({}) },
  }
  return with_request_store({ event, state } as never, fn)
}

const callOrder: string[] = []
vi.mock('$lib/server/tenant/resolve', () => ({
  tenantResolveHandle: async ({ event, resolve }: any) => {
    callOrder.push('tenant')
    event.locals.tenant = { id: 'tid-1', slug: 'stura', issuer: 'https://kc/realms/sturaos' }
    return resolve(event)
  },
  // hooks.server.ts also wires tenantForwardFetch as `handleFetch` (gremion#22
  // finding 1) — stub so the module loads; its own behavior is pinned in
  // forward-fetch.test.ts.
  tenantForwardFetch: vi.fn(),
}))
// MJ1: no brand-ssr handle in P2.1a — not imported, not mocked.
vi.mock('./auth', () => ({
  handle: async ({ event, resolve }: any) => {
    callOrder.push('auth')
    expect(event.locals.tenant).toEqual({ id: 'tid-1', slug: 'stura', issuer: 'https://kc/realms/sturaos' })
    return resolve(event)
  },
}))
vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'x' } }))
vi.mock('$lib/server/db', () => ({ waitForDbReady: vi.fn(async () => {}), runMigrations: vi.fn(async () => {}), getDb: () => ({}) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ smtp: { configured: false }, modules: {}, retention: { security_logs_days: 90 } }) }))
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => null) }))
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
vi.mock('$lib/server/tenant/register-default', () => ({ registerDefaultTenant: vi.fn(async () => ({ id: 'tid-1' })) }))
// boot() fleet-migrates the active tenants (P2.1b T2) then resolves the default
// context for the audit-purge interval; the listActiveTenants id must match the
// registerDefaultTenant mock above.
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async () => ({ id: 'default', slug: 'default', issuer: 'https://kc/realms/sturaos' })),
  listActiveTenants: vi.fn(async () => [{ id: 'tid-1', slug: 'default', status: 'active' }]),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: (_ctx: unknown, fn: () => unknown) => fn() }))
vi.mock('$lib/server/tenant/default-tenant', () => ({ DEFAULT_TENANT: { id: 'default', configPath: '/tmp/config.json' } }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))

beforeEach(() => { callOrder.length = 0; vi.resetModules() })

describe('hooks.server tenant wiring', () => {
  it('runs tenantResolveHandle as sequence element 0, before authHandle', async () => {
    const mod = await import('./hooks.server')
    await mod.boot()
    const url = new URL('http://internal/auth/login')
    const event = { url, request: new Request(url), locals: {} as Record<string, unknown>, params: {} }
    await withRequestStore(event, () =>
      mod.handle({ event: event as never, resolve: async () => new Response('ok', { status: 200 }) } as never),
    )
    expect(callOrder[0]).toBe('tenant')
    expect(callOrder.indexOf('tenant')).toBeLessThan(callOrder.indexOf('auth'))
  })
})
