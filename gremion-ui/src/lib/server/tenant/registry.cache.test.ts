// src/lib/server/tenant/registry.cache.test.ts
// P2.1b T8 — resolution cache + lifecycle eviction (unit contract).
//
// resolveTenantBySlug runs on EVERY request (sequence element 0) and once per
// tenant per worker-fleet tick; each cold resolution costs a control-DB SELECT
// plus a readConfig() (readFileSync). T8 puts a short-TTL cache keyed by slug
// in front of it, and gives the registry ONE lifecycle seam —
// evictTenantRuntime(tenantId) — that drops every per-tenant keyed runtime
// handle (pool, KC-admin, JWKS, display-names, Matrix/Synapse/Helios/LiveKit/
// newsletter, resolution cache). updateTenantStatus is the status-transition
// fn that wires the two together (suspend/delete → evict), even though the
// operator script arrives in P2.1c.
//
// Everything below the registry seam is mocked: this file pins the CACHE and
// EVICTION contracts, not the resolution plumbing (registry.integration.test.ts
// owns that against the real control DB).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ env: {} }))

const { sqlSpy } = vi.hoisted(() => ({ sqlSpy: vi.fn() }))
vi.mock('./control-db', () => ({ getControlDb: () => sqlSpy }))
vi.mock('./secrets', () => ({ resolveSecret: vi.fn(() => 'postgres://resolved') }))
vi.mock('$lib/server/db/pool-registry', () => ({
  getPoolForTenant: vi.fn(() => ({ __pool: true }) as never),
  evictTenantPool: vi.fn(),
}))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: vi.fn(() => ({ __kcAdmin: true }) as never),
  evictKeycloakAdminClient: vi.fn(),
}))
vi.mock('$lib/server/config', () => ({ readConfig: vi.fn(() => ({ __cfg: true }) as never) }))
vi.mock('$lib/server/brand', () => ({ brandFromConfig: vi.fn(() => ({ __brand: true }) as never) }))
vi.mock('$lib/server/jwt-verify', () => ({ evictJwks: vi.fn() }))
vi.mock('$lib/server/identity/display-names', () => ({ evictDisplayNameResolver: vi.fn() }))
vi.mock('$lib/server/mail/tenant-mail', () => ({ evictTenantMail: vi.fn() }))

import {
  resolveTenantBySlug,
  invalidateResolvedTenant,
  evictTenantRuntime,
  updateTenantStatus,
  getTenantStatusBySlug,
  RESOLUTION_CACHE_TTL_MS,
  _resetResolutionCacheForTests,
} from './registry'
import { readConfig } from '$lib/server/config'
import { evictTenantPool, getPoolForTenant } from '$lib/server/db/pool-registry'
import { evictKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { evictJwks } from '$lib/server/jwt-verify'
import { evictDisplayNameResolver } from '$lib/server/identity/display-names'
import { evictTenantMail } from '$lib/server/mail/tenant-mail'
// Session-A inversion A1 + carve: module-owned evictors (the
// Matrix/Synapse/Helios/LiveKit ones) register into the runtime-registry
// eviction-hook seam from each module's register.server.ts and run via
// runTenantEvictHooks(). In the governance-only kernel those feature modules are
// carved out, so this test exercises ONLY the kernel evictors that
// evictTenantRuntime drives directly (pool/KC-admin/JWKS/display-names/mail). The
// module-hook seam itself is still reset between tests so no stale hooks leak.
import {
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry'

// A full active control-DB row for slug `alpha` (NON-default: no env reads in
// configPathForTenant / authExternalBaseForTenant — env stays untouched).
const tenantRow = (over: Record<string, unknown> = {}) => ({
  id: 'tid-alpha',
  slug: 'alpha',
  status: 'active',
  db_conn_ref: 'env:DATABASE_URL',
  realm_name: 'alpha-realm',
  issuer: 'https://alpha.example.org/auth/realms/alpha',
  kc_internal: 'http://keycloak:8080/auth/realms/alpha',
  kc_client_id: 'gremion-admin',
  kc_client_ref: 'env:KC_SECRET',
  auth_client_ref: 'env:AUTH_SECRET',
  nc_target: {},
  matrix_space: {},
  domain_profile: {},
  brand_ref: 'config:alpha',
  blueprint_ref: 'STURA_BLUEPRINT@1',
  conn_profile: { perTenantMax: 4, prepare: true },
  backup_key_ref: 'env:BACKUP_KEY',
  audiences: ['gremion-ui'],
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  ...over,
})

let selectRows: unknown[]
let updateRows: unknown[]

/** Control-DB SELECT-by-slug calls (the cost a cache HIT must avoid). */
const slugSelects = () =>
  sqlSpy.mock.calls.filter((c) => (c[0] as readonly string[]).join('?').includes('WHERE slug')).length
const statusUpdates = () =>
  sqlSpy.mock.calls.filter((c) => (c[0] as readonly string[]).join('?').includes('UPDATE tenant SET')).length
/** G-XPROC: cross-process eviction NOTIFY calls (pg_notify on the tx handle). */
const notifyCalls = () =>
  sqlSpy.mock.calls.filter((c) => (c[0] as readonly string[]).join('?').includes('pg_notify'))

beforeEach(() => {
  vi.clearAllMocks()
  _resetResolutionCacheForTests()
  // Reset the module eviction-hook seam between tests so no stale hooks leak.
  // The governance-only kernel registers no module evict hooks here — feature
  // modules (carved out) would register theirs from their register.server.ts.
  _resetRuntimeRegistryForTests()
  selectRows = [tenantRow()]
  updateRows = []
  sqlSpy.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join('?')
    if (q.includes('UPDATE tenant')) return updateRows
    return selectRows
  })
  // postgres.js sql.begin(cb): run the callback with the same tag spy as the
  // transaction handle, so UPDATE + pg_notify both record on sqlSpy.mock.calls.
  ;(sqlSpy as unknown as { begin: ReturnType<typeof vi.fn> }).begin = vi.fn(
    async (cb: (tx: typeof sqlSpy) => unknown) => cb(sqlSpy),
  )
})
afterEach(() => {
  vi.useRealTimers()
})

describe('T8 — short-TTL resolution cache in resolveTenantBySlug', () => {
  it('a second resolve within the TTL is a HIT: no control-DB SELECT, no config read, SAME context', async () => {
    const a = await resolveTenantBySlug('alpha')
    const b = await resolveTenantBySlug('alpha')
    expect(a).not.toBeNull()
    expect(b).toBe(a) // identity — the cached context, not a rebuilt one
    expect(slugSelects()).toBe(1)
    expect(vi.mocked(readConfig)).toHaveBeenCalledTimes(1)
  })

  it('the entry expires after RESOLUTION_CACHE_TTL_MS and re-resolves from the registry', async () => {
    vi.useFakeTimers()
    await resolveTenantBySlug('alpha')
    vi.advanceTimersByTime(RESOLUTION_CACHE_TTL_MS - 1)
    await resolveTenantBySlug('alpha')
    expect(slugSelects()).toBe(1) // still inside the TTL → hit
    vi.advanceTimersByTime(2)
    await resolveTenantBySlug('alpha')
    expect(slugSelects()).toBe(2) // expired → fresh SELECT
  })

  it('invalidateResolvedTenant(slug) explicitly drops the entry', async () => {
    await resolveTenantBySlug('alpha')
    invalidateResolvedTenant('alpha')
    await resolveTenantBySlug('alpha')
    expect(slugSelects()).toBe(2)
  })

  it('a null resolution (unknown/non-active) is NEVER cached — the next request re-checks (D-READY)', async () => {
    selectRows = []
    expect(await resolveTenantBySlug('ghost')).toBeNull()
    expect(await resolveTenantBySlug('ghost')).toBeNull()
    expect(slugSelects()).toBe(2)
    // …and the moment the registry row appears/activates, it resolves.
    selectRows = [tenantRow({ id: 'tid-ghost', slug: 'ghost' })]
    expect(await resolveTenantBySlug('ghost')).not.toBeNull()
  })
})

describe('T8 — evictTenantRuntime(tenantId)', () => {
  it('drops the cached resolution for that tenant id (keyed by slug internally)', async () => {
    await resolveTenantBySlug('alpha')
    evictTenantRuntime('tid-alpha')
    await resolveTenantBySlug('alpha')
    expect(slugSelects()).toBe(2)
  })

  it('clears EVERY keyed per-tenant KERNEL runtime registry', () => {
    evictTenantRuntime('tid-x')
    for (const fn of [
      evictTenantPool, // immediate drain (explicit eviction, #256-4)
      evictKeycloakAdminClient,
      evictJwks,
      evictDisplayNameResolver,
      evictTenantMail, // SP-2: per-tenant SMTP transport
    ]) {
      expect(vi.mocked(fn)).toHaveBeenCalledWith('tid-x')
    }
  })

  it('leaves OTHER tenants cached resolutions intact', async () => {
    await resolveTenantBySlug('alpha')
    evictTenantRuntime('tid-unrelated')
    await resolveTenantBySlug('alpha')
    expect(slugSelects()).toBe(1) // alpha entry survived the unrelated eviction
  })
})

describe('T8 — updateTenantStatus: the suspend/delete lifecycle seam', () => {
  it('updates the control row and evicts the ENTIRE tenant runtime', async () => {
    await resolveTenantBySlug('alpha') // warm the resolution cache
    updateRows = [tenantRow({ status: 'suspended' })]
    const t = await updateTenantStatus('tid-alpha', 'suspended')
    expect(t?.status).toBe('suspended')
    expect(statusUpdates()).toBe(1)
    expect(vi.mocked(evictTenantPool)).toHaveBeenCalledWith('tid-alpha')
    expect(vi.mocked(evictJwks)).toHaveBeenCalledWith('tid-alpha')
    // the warmed resolution is gone too — the next resolve re-queries (and the
    // now-suspended row resolves to null immediately, not after the TTL).
    selectRows = [tenantRow({ status: 'suspended' })]
    expect(await resolveTenantBySlug('alpha')).toBeNull()
    expect(slugSelects()).toBe(2)
  })

  it('returns null for an unknown tenant id and evicts NOTHING', async () => {
    updateRows = []
    expect(await updateTenantStatus('tid-ghost', 'suspended')).toBeNull()
    expect(vi.mocked(evictTenantPool)).not.toHaveBeenCalled()
    expect(vi.mocked(evictTenantMail)).not.toHaveBeenCalled()
  })
})

describe('G-XPROC — updateTenantStatus fires a cross-process eviction NOTIFY', () => {
  it('issues pg_notify on the tenant_evict channel with the tenant id, in the SAME tx as the status UPDATE', async () => {
    updateRows = [tenantRow({ status: 'suspended' })]
    await updateTenantStatus('tid-alpha', 'suspended')
    // the UPDATE + NOTIFY are wrapped in one transaction so the notify is
    // delivered exactly on commit, never for an un-committed status change.
    expect((sqlSpy as unknown as { begin: ReturnType<typeof vi.fn> }).begin).toHaveBeenCalledTimes(1)
    const notifies = notifyCalls()
    expect(notifies).toHaveLength(1)
    expect(notifies[0][1]).toBe('tenant_evict') // channel (wire contract)
    expect(notifies[0][2]).toBe('tid-alpha') // payload = the evicted tenant id
    expect(statusUpdates()).toBe(1)
  })

  it('does NOT notify when the tenant id is unknown (no row updated)', async () => {
    updateRows = []
    expect(await updateTenantStatus('tid-ghost', 'suspended')).toBeNull()
    expect(notifyCalls()).toHaveLength(0)
  })
})

describe('T6 — getTenantStatusBySlug: status-only control-DB read (no data-plane)', () => {
  it('returns the status for a present row WITHOUT touching the data plane', async () => {
    selectRows = [{ status: 'suspended' }]
    expect(await getTenantStatusBySlug('alpha')).toBe('suspended')
    // status-only read: no pool / config / brand hydration (the data plane).
    expect(vi.mocked(getPoolForTenant)).not.toHaveBeenCalled()
    expect(vi.mocked(readConfig)).not.toHaveBeenCalled()
  })

  it('returns null for an absent row', async () => {
    selectRows = []
    expect(await getTenantStatusBySlug('ghost')).toBeNull()
  })

  it('returns null for an INVALID slug WITHOUT querying the control DB', async () => {
    expect(await getTenantStatusBySlug('Bad Slug!')).toBeNull()
    expect(sqlSpy).not.toHaveBeenCalled()
  })

  it('returns null for a RESERVED slug (validateSlug guard) without querying', async () => {
    expect(await getTenantStatusBySlug('keycloak')).toBeNull()
    expect(sqlSpy).not.toHaveBeenCalled()
  })

  it('SELECTs only the status column, never SELECT *', async () => {
    selectRows = [{ status: 'active' }]
    await getTenantStatusBySlug('alpha')
    const lastSelect = sqlSpy.mock.calls.at(-1)![0] as readonly string[]
    const q = lastSelect.join('?')
    expect(q).toContain('SELECT status FROM tenant')
    expect(q).not.toContain('SELECT *')
  })
})
