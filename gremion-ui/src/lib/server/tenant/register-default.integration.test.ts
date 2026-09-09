import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { getControlDb } from './control-db'
import { runControlMigrations } from './control-migrations'
import { registerDefaultTenant } from './register-default'
import { getTenantBySlug, listTenants } from './registry'

// P2.1b T5 (#243): the reconcile tests need to CHANGE env between two boots.
// $env/dynamic/private snapshots process.env at module init, so swap it for a
// mutable copy (vi.hoisted runs before the hoisted vi.mock factories fire on
// the static imports above). Initialised from process.env => the existing
// tests see byte-identical values.
const envMock = vi.hoisted(() => ({ ...process.env }) as Record<string, string | undefined>)
vi.mock('$env/dynamic/private', () => ({ env: envMock }))

const DRIFT_TAG = '[tenant-registry] env/registry drift:'

// vitest 4 widened vi.spyOn's generic constraint to `Procedure | Constructable`
// (to support mocking constructors), so `ReturnType<typeof vi.spyOn>` now
// resolves to a union whose construct-only branch has no call signature —
// `Mock` (default `Procedure`) pins this back to the plain callable spy shape
// these console.warn spies actually are.
function driftLogs(spy: Mock) {
  return spy.mock.calls.filter((c) => String(c[0]).includes(DRIFT_TAG))
}

describe('registerDefaultTenant', () => {
  beforeAll(async () => { await runControlMigrations() })
  beforeEach(async () => {
    // Restore the env baseline a previous test may have mutated.
    for (const k of Object.keys(envMock)) delete envMock[k]
    Object.assign(envMock, process.env)
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('inserts a `default` row pointing at the existing gremion DB + sturaos realm + env config', async () => {
    await registerDefaultTenant()
    const t = await getTenantBySlug('default')
    expect(t).not.toBeNull()
    expect(t!.status).toBe('active')
    expect(t!.realmName).toBe('sturaos')
    expect(t!.dbConnRef).toBe('env:DATABASE_URL') // tenant #1 keeps env secrets — no content move
    expect(t!.issuer).toContain('/realms/sturaos')
  })

  it('is idempotent — running it twice leaves exactly one default row with a stable id', async () => {
    await registerDefaultTenant()
    const id1 = (await getTenantBySlug('default'))!.id
    await registerDefaultTenant()
    expect((await getTenantBySlug('default'))!.id).toBe(id1)
    expect((await listTenants()).filter((t) => t.slug === 'default').length).toBe(1)
  })

  // ── P2.1b T5 — reconcile-on-boot (#243): env is tenant #1's source of truth ──

  it('reconciles a changed env into the existing row and logs each drifted column (old -> new)', async () => {
    await registerDefaultTenant()
    const before = await getTenantBySlug('default')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    envMock.AUTH_KEYCLOAK_ISSUER = 'https://next.example.org/auth/realms/next'
    envMock.AUTH_KEYCLOAK_INTERNAL = 'https://kc-next:8443/auth/realms/next'
    envMock.KEYCLOAK_REALM = 'next'
    envMock.AUTH_JWT_AUDIENCES = 'gremion-ui,extra-svc'
    await registerDefaultTenant()

    const t = await getTenantBySlug('default')
    expect(t!.id).toBe(before!.id) // reconciled IN PLACE — same tenant id
    expect(t!.issuer).toBe('https://next.example.org/auth/realms/next')
    expect(t!.kcInternal).toBe('https://kc-next:8443/auth/realms/next')
    expect(t!.realmName).toBe('next')
    expect(t!.audiences).toEqual(['gremion-ui', 'extra-svc'])

    const logs = driftLogs(warn)
    expect(logs.length).toBe(1)
    const msg = String(logs[0][0])
    for (const col of ['issuer', 'kc_internal', 'realm_name', 'audiences']) {
      expect(msg).toContain(col)
    }
    // old -> new: the message carries BOTH the stale and the fresh issuer
    expect(msg).toContain(before!.issuer)
    expect(msg).toContain('https://next.example.org/auth/realms/next')
  })

  // Clobber pin (adversarial review): the reconcile upsert's DO UPDATE SET
  // list must touch ONLY the 7 env-derived columns (+ updated_at). Operator-
  // managed columns mutated after registration (conn_profile clamp tuning,
  // a custom brand_ref, …) must SURVIVE a re-boot — even one whose env drift
  // actually fires the UPDATE. A future "SET everything" refactor would
  // silently reset them to the INSERT defaults; this test fails first.
  it('reconcile never clobbers NON-env columns (conn_profile, brand_ref survive an env-drift re-run)', async () => {
    await registerDefaultTenant()
    const sql = getControlDb()
    await sql`
      UPDATE tenant
      SET conn_profile = ${sql.json({ perTenantMax: 2, prepare: false } as never) as never},
          brand_ref = 'config:custom-brand'
      WHERE slug = 'default'`

    // Drift one env-derived column so the ON CONFLICT DO UPDATE really fires.
    envMock.KEYCLOAK_REALM = 'drifted-realm'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await registerDefaultTenant()

    const t = await getTenantBySlug('default')
    expect(t!.realmName).toBe('drifted-realm') // the UPDATE path ran…
    // …but the operator-managed columns survived untouched.
    expect(t!.connProfile).toEqual({ perTenantMax: 2, prepare: false })
    expect(t!.brandRef).toBe('config:custom-brand')
  })

  it('fresh insert and unchanged-env re-boot: row untouched, no drift log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await registerDefaultTenant() // fresh insert — nothing to reconcile
    expect(driftLogs(warn).length).toBe(0)

    const before = await getTenantBySlug('default')
    await registerDefaultTenant() // same env — must be a no-op
    const after = await getTenantBySlug('default')
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime()) // no gratuitous row write
    expect(driftLogs(warn).length).toBe(0)
  })
})
