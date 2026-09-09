import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

// boot() (imported below via ./hooks.server) runs the data-plane runMigrations.
// GREMION_DISABLE_SEEDS=true (set in vitest.integration.config.ts, before the
// $env/dynamic/private snapshot) makes that a clean no-op — the integration DB
// has the schema migrations applied but not the *_seed.sql dev seeds.

// ── End-to-end iss-replay seam (FIX 4 / final review) ───────────────────────
//
// Every per-stage slice saw only ONE half of the resolver -> authGuard seam:
// the resolver tests proved resolveTenantBySlug builds a correct context, and
// the authGuard tests (hooks.iss-match.test.ts) fed authGuard a HAND-BUILT
// tenant literal. Nothing drove a REGISTRY-RESOLVED context through the REAL
// authGuard with a replayed cross-realm token. This test closes that gap: it
// registers two real tenants (A=default/sturaos, B=tenant-b) in the control DB,
// resolves B's REAL TenantContext via resolveTenantBySlug, and runs the REAL
// authGuard inside runWithTenant(b, …) against both a replayed A-realm session
// (expect 403 TenantMismatch) and a legitimate B-realm session (expect 200).
//
// We must import ./hooks.server to get the real authGuard. That import boots
// schedulers/workers/nodemailer as a side-effect, so — COPYING the vi.mock block
// from hooks.iss-match.test.ts — we stub the worker/scheduler dependency graph.
// CRUCIALLY we do NOT mock $lib/server/tenant/registry, $lib/server/tenant/context,
// or $lib/server/db: we want the REAL resolveTenantBySlug + real ALS + the real
// getDb fail-closed contract against the control+gremion test DBs.

import { vi } from 'vitest'

vi.mock('$app/environment', () => ({ building: true }))
// NB: do NOT mock $env/dynamic/private OR $lib/server/config here — the real
// registry/resolve path needs the integration config's CONTROL_DATABASE_URL /
// DATABASE_URL / KC placeholders (vitest.integration.config.ts) and the REAL
// readConfig (resolveTenantBySlug -> brandFromConfig(cfg) dereferences
// cfg.brand) to build a real TenantContext.
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
// Task 23: hooks.server.ts no longer boots a newsletter SQLite store or scheduler
// (the leaf service owns them), so there are no newsletter modules to mock here.
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('./auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
// NOTE: registry / context / db / control-migrations / register-default are
// DELIBERATELY left REAL — the whole point is to drive a real resolved context.

import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import { registerDefaultTenant } from './register-default'
import { registerTenant, resolveTenantBySlug, _resetResolutionCacheForTests } from './registry'
import { runWithTenant, type TenantContext } from './context'

const ISS_B = 'https://council.example/auth/realms/tenant-b'

/** Minimal SvelteKit RequestEvent shape authGuard reads (session path). */
function makeEvent(opts: { path: string; tenant: TenantContext; session: unknown }) {
  return {
    url: new URL(`http://localhost${opts.path}`),
    request: new Request(`http://localhost${opts.path}`),
    params: {},
    locals: {
      tenant: opts.tenant,
      user: null,
      accessToken: null,
      accessTokenExpires: null,
      auth: async () => opts.session,
    } as Record<string, unknown>,
  }
}
const RESOLVED = new Response('resolved-data-plane', { status: 200 })
const resolveSpy = async () => RESOLVED

describe('iss-replay e2e: registry-resolved tenant through the REAL authGuard', () => {
  beforeAll(async () => {
    await runControlMigrations()
  })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    // T8: re-registered rows get NEW tenant ids — drop cached resolutions.
    _resetResolutionCacheForTests()
    // A = default tenant (sturaos issuer, env-driven).
    await registerDefaultTenant()
    // B = a distinct tenant with its OWN realm/issuer.
    await registerTenant({
      slug: 'tenant-b', status: 'active', dbConnRef: 'env:DATABASE_URL',
      realmName: 'tenant-b', issuer: ISS_B,
      kcInternal: 'http://keycloak:8080/auth/realms/tenant-b', kcClientId: 'gremion-admin',
      kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET', authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
      ncTarget: {}, matrixSpace: { aliasNamespace: 'b-' },
      domainProfile: {}, brandRef: 'config:tenant-b', blueprintRef: 'STURA_BLUEPRINT@1',
      connProfile: { perTenantMax: 4, prepare: true }, backupKeyRef: 'env:BACKUP_KEY', audiences: ['gremion-ui'],
    })
  })

  it('REJECTS 403 TenantMismatch when an A-realm session is replayed on B (page)', async () => {
    const mod = await import('../../../hooks.server')
    await mod.boot()
    const a = await resolveTenantBySlug('default')
    const b = await resolveTenantBySlug('tenant-b')
    expect(a).not.toBeNull(); expect(b).not.toBeNull()
    expect(a!.issuer).not.toBe(b!.issuer)

    // event.locals.tenant = B (the host-resolved tenant), session minted by A.
    const event = makeEvent({
      path: '/dashboard',
      tenant: b!,
      session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: a!.issuer },
    })
    const res = await runWithTenant(b!, () =>
      mod.authGuard({ event: event as never, resolve: resolveSpy } as never),
    ) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Forbidden: tenant mismatch')
  })

  it('REJECTS 403 TenantMismatch (machine-readable JSON) on an API replay', async () => {
    const mod = await import('../../../hooks.server')
    await mod.boot()
    const a = await resolveTenantBySlug('default')
    const b = await resolveTenantBySlug('tenant-b')

    const event = makeEvent({
      path: '/api/finance/budgets',
      tenant: b!,
      session: { user: { id: 'u1', roles: ['finance'], groups: [] }, accessToken: 'kc', tokenIss: a!.issuer },
    })
    const res = await runWithTenant(b!, () =>
      mod.authGuard({ event: event as never, resolve: resolveSpy } as never),
    ) as Response
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'TenantMismatch', reason: 'iss_host_mismatch' })
  })

  it('SERVES 200 when the session iss matches the resolved tenant B issuer', async () => {
    const mod = await import('../../../hooks.server')
    await mod.boot()
    const b = await resolveTenantBySlug('tenant-b')

    const event = makeEvent({
      path: '/dashboard',
      tenant: b!,
      session: { user: { id: 'u1', roles: ['member'], groups: [] }, accessToken: 'kc', tokenIss: b!.issuer },
    })
    const res = await runWithTenant(b!, () =>
      mod.authGuard({ event: event as never, resolve: resolveSpy } as never),
    ) as Response
    expect(res.status).toBe(200)
  })
})
