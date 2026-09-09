import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { createRemoteJWKSet } from 'jose'
import { getControlDb } from './control-db'

// P2.1b T6 (D-JWKS): passthrough spy — resolution must NOT construct a JWKS
// eagerly; the lazy per-tenant cache in jwt-verify.ts owns that on first Bearer.
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>()
  return { ...actual, createRemoteJWKSet: vi.fn(actual.createRemoteJWKSet) }
})
import { runControlMigrations } from './control-migrations'
import {
  registerTenant, getTenantBySlug, getTenantById, listTenants, listActiveTenants,
  ensureTenantResource, markTenantResourceOk, markTenantResourceFailed,
  getTenantResources, resolveTenantBySlug, type TenantInput,
  startTenantMigrationRun, finishTenantMigrationRun,
  updateTenantProvisioning,
  resumeTenant, suspendTenant, TenantStatusTransitionError,
  _resetResolutionCacheForTests,
} from './registry'

const input: TenantInput = {
  slug: 'default', status: 'active',
  dbConnRef: 'env:DATABASE_URL', realmName: 'sturaos',
  issuer: 'https://council.example/auth/realms/sturaos',
  kcInternal: 'http://keycloak:8080/auth/realms/sturaos',
  kcClientId: 'gremion-admin', kcClientRef: 'env:KEYCLOAK_ADMIN_CLIENT_SECRET',
  authClientRef: 'env:AUTH_KEYCLOAK_SECRET',
  ncTarget: { url: 'https://council.example/cloud' },
  matrixSpace: { serverName: 'council.example', aliasNamespace: 'stura-' },
  domainProfile: { subdomain: 'default', residencyZone: 'eu' },
  brandRef: 'config:default', blueprintRef: 'STURA_BLUEPRINT@1',
  connProfile: { perTenantMax: 4, prepare: true },
  backupKeyRef: 'file:/run/secrets/tenant_default_backup_key',
  audiences: ['gremion-ui', 'gremion-mobile'],
}

describe('tenant registry', () => {
  beforeAll(async () => { await runControlMigrations() })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
  })

  it('registers a tenant idempotently and reads it back by slug and id', async () => {
    const t1 = await registerTenant(input)
    const t2 = await registerTenant(input)
    expect(t1.id).toBe(t2.id)
    expect((await getTenantBySlug('default'))?.id).toBe(t1.id)
    expect((await getTenantById(t1.id))?.slug).toBe('default')
    expect((await listTenants()).length).toBe(1)
  })
  it('hydrates jsonb / array columns into typed fields', async () => {
    const t = await registerTenant(input)
    expect(t.audiences).toEqual(['gremion-ui', 'gremion-mobile'])
    expect(t.matrixSpace).toEqual({ serverName: 'council.example', aliasNamespace: 'stura-' })
    expect(t.domainProfile.residencyZone).toBe('eu')
  })
  it('rejects an invalid slug before touching the DB', async () => {
    await expect(registerTenant({ ...input, slug: 'Bad_Slug' })).rejects.toThrow(/invalid slug/i)
  })
  // T7 — registry-write hardening: a second tenant must not claim an
  // already-registered realm_name (KC realm-cache collision seam).
  it('rejects a second tenant that reuses an existing realm_name (loud, names the column)', async () => {
    await registerTenant(input) // default → realm sturaos
    await expect(
      registerTenant({ ...input, slug: 't2', issuer: 'https://t2.council.example/auth/realms/sturaos' }),
    ).rejects.toThrow(/realm_name/)
  })
  // T7 — same for issuer (JWKS / issuer-resolution collision seam).
  it('rejects a second tenant that reuses an existing issuer (loud, names the column)', async () => {
    await registerTenant(input) // default → issuer https://council.example/...
    await expect(
      registerTenant({ ...input, slug: 't2', realmName: 't2' }),
    ).rejects.toThrow(/issuer/)
  })
  // T7 — the write-time guard must not break idempotent SAME-slug re-register
  // (registerTenant is ON CONFLICT (slug) DO NOTHING): re-registering `default`
  // collides with its own realm_name/issuer but is the same row, so it is allowed.
  it('still allows idempotent re-register of the SAME slug despite the uniqueness guard', async () => {
    const a = await registerTenant(input)
    const b = await registerTenant(input)
    expect(a.id).toBe(b.id)
  })
  it('returns null for an unknown slug', async () => {
    expect(await getTenantBySlug('nope')).toBeNull()
  })
  it('tenant ledger: ensure is idempotent and starts pending', async () => {
    const t = await registerTenant(input)
    await ensureTenantResource(t.id, 'realm')
    await ensureTenantResource(t.id, 'realm')
    const rs = await getTenantResources(t.id)
    expect(rs.length).toBe(1)
    expect(rs[0].status).toBe('pending')
  })
  it('listActiveTenants returns ONLY active tenants (fleet input, P2.1b T2)', async () => {
    // T7: each tenant carries a distinct realm_name/issuer (the write-time
    // uniqueness guard now forbids reuse), reflecting the real per-tenant realm.
    await registerTenant(input) // active `default`
    await registerTenant({ ...input, slug: 'susp', status: 'suspended', realmName: 'susp', issuer: 'https://susp.council.example/auth/realms/susp' })
    await registerTenant({ ...input, slug: 'prov', status: 'provisioning', realmName: 'prov', issuer: 'https://prov.council.example/auth/realms/prov' })
    const active = await listActiveTenants()
    expect(active.map((t) => t.slug)).toEqual(['default'])
  })
  it('fleet ledger: start opens an in-flight run row; finish records ok + last_applied (P2.1b T2)', async () => {
    const t = await registerTenant(input)
    const runId = await startTenantMigrationRun(t.id)
    let rows = await getControlDb()`SELECT * FROM tenant_migration_run WHERE id = ${runId}`
    expect(rows.length).toBe(1)
    expect(rows[0].tenant_id).toBe(t.id)
    expect(rows[0].started_at).not.toBeNull()
    // In-flight: a crashed run stays visible as finished_at IS NULL.
    expect(rows[0].finished_at).toBeNull()
    expect(rows[0].ok).toBeNull()
    await finishTenantMigrationRun(runId, { ok: true, lastApplied: '039_x.sql' })
    rows = await getControlDb()`SELECT * FROM tenant_migration_run WHERE id = ${runId}`
    expect(rows[0].ok).toBe(true)
    expect(rows[0].finished_at).not.toBeNull()
    expect(rows[0].last_applied).toBe('039_x.sql')
    expect(rows[0].error).toBeNull()
  })
  it('fleet ledger: a failed run stores ok=false + the capped error (P2.1b T2)', async () => {
    const t = await registerTenant(input)
    const runId = await startTenantMigrationRun(t.id)
    await finishTenantMigrationRun(runId, { ok: false, error: 'x'.repeat(3000) })
    const rows = await getControlDb()`SELECT * FROM tenant_migration_run WHERE id = ${runId}`
    expect(rows[0].ok).toBe(false)
    expect(rows[0].error?.length).toBe(2000) // bounded like markTenantResourceFailed
    expect(rows[0].last_applied).toBeNull()
  })
  // P2.1c (T10) — the provisioner write-back path. registerTenant is
  // ON CONFLICT (slug) DO NOTHING, so the provisioner needs an explicit
  // slug-guarded UPDATE; updateTenantProvisioning patches ONLY the columns it
  // owns (COALESCE leaves omitted columns intact) and never touches slug/status.
  it('updateTenantProvisioning patches provisioner-owned columns; omitted columns unchanged', async () => {
    await registerTenant({ ...input, slug: 't2', status: 'provisioning', realmName: 't2', issuer: 'https://t2.council.example/auth/realms/placeholder' })
    const patched = await updateTenantProvisioning('t2', {
      realmName: 'verein',
      issuer: 'https://t2.council.example/auth/realms/verein',
      kcClientId: 'gremion-ui',
      authClientRef: 'file:/run/secrets/tenants/tenant_t2_client_gremion-ui',
    })
    expect(patched).not.toBeNull()
    expect(patched!.realmName).toBe('verein')
    expect(patched!.issuer).toBe('https://t2.council.example/auth/realms/verein')
    expect(patched!.kcClientId).toBe('gremion-ui')
    expect(patched!.authClientRef).toBe('file:/run/secrets/tenants/tenant_t2_client_gremion-ui')
    // status untouched (transitions go through updateTenantStatus)
    expect(patched!.status).toBe('provisioning')
    // an omitted column (dbConnRef) keeps its prior value (COALESCE)
    expect(patched!.dbConnRef).toBe(input.dbConnRef)
  })
  it('updateTenantProvisioning returns null for an unknown slug; throws on an invalid slug', async () => {
    expect(await updateTenantProvisioning('ghost', { realmName: 'x' })).toBeNull()
    await expect(updateTenantProvisioning('Bad_Slug', { realmName: 'x' })).rejects.toThrow(/invalid slug/i)
  })
  it('tenant ledger: ok stores external id; failed increments attempts', async () => {
    const t = await registerTenant(input)
    await ensureTenantResource(t.id, 'db')
    await markTenantResourceOk(t.id, 'db', 't_default')
    let rs = await getTenantResources(t.id)
    expect(rs[0].status).toBe('ok'); expect(rs[0].external_id).toBe('t_default')
    await ensureTenantResource(t.id, 'matrix')
    await markTenantResourceFailed(t.id, 'matrix', 'boom')
    rs = await getTenantResources(t.id)
    const matrix = rs.find((r) => r.subsystem === 'matrix')!
    expect(matrix.status).toBe('failed'); expect(matrix.attempts).toBe(1); expect(matrix.last_error).toBe('boom')
  })
})

describe('resolveTenantBySlug — builds a full TenantContext', () => {
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    // T8: each case re-registers rows with NEW tenant ids — a cached
    // resolution from the previous case would be stale.
    _resetResolutionCacheForTests()
  })
  it('returns a fully-built context for an active tenant', async () => {
    await registerTenant(input) // the `default` row from the top of this file
    const ctx = await resolveTenantBySlug('default')
    expect(ctx).not.toBeNull()
    expect(ctx!.id).toBeTruthy()
    expect(ctx!.slug).toBe('default')
    expect(ctx!.issuer).toBe('https://council.example/auth/realms/sturaos')
    expect(ctx!.realmName).toBe('sturaos')
    expect(Array.from(ctx!.audiences)).toEqual(['gremion-ui', 'gremion-mobile'])
    expect(ctx!.aliasNamespace).toBe('stura-')
    expect(typeof ctx!.dbUrl).toBe('string')
    expect(ctx!.dbMax).toBeGreaterThan(0)
    // MJ-secret: the Auth.js (UI) client is wired from authClientRef, NOT kcClientRef.
    expect(ctx!.authClientId).toBe('gremion-ui')
    expect(ctx!.authClientSecretRef).toBe('env:AUTH_KEYCLOAK_SECRET')
    expect(ctx!.kcClientSecretRef).toBe('env:KEYCLOAK_ADMIN_CLIENT_SECRET')
    expect(ctx!.authClientSecretRef).not.toBe(ctx!.kcClientSecretRef)
    // MJ1: no per-tenant accent/logo data source in P2.1a — always null.
    expect(ctx!.accent).toBeNull()
    expect(ctx!.logoUrl).toBeNull()
  })

  // D-UICLIENT pin (P2.1c T13): the UI client id is FROZEN to `gremion-ui` for
  // EVERY tenant row — resolution hardcodes it (registry.ts ~:339) regardless of
  // the row's kc_client_id (the ADMIN client). A non-default tenant carrying a
  // different kc_client_id still resolves authClientId === 'gremion-ui'. A future
  // per-tenant UI-client-id column would break this; that is the revisit trigger.
  it('D-UICLIENT: authClientId is frozen to gremion-ui for every row, independent of kc_client_id', async () => {
    // default row (kc_client_id = gremion-admin) — UI client is gremion-ui
    await registerTenant(input)
    const def = await resolveTenantBySlug('default')
    expect(def!.kcClientId).toBe('gremion-admin')
    expect(def!.authClientId).toBe('gremion-ui')
    // a second tenant with a DIFFERENT kc_client_id still resolves UI = gremion-ui
    await registerTenant({
      ...input, slug: 't2', realmName: 't2',
      issuer: 'https://t2.council.example/auth/realms/t2',
      kcInternal: 'http://keycloak:8080/auth/realms/t2',
      kcClientId: 'other-admin',
    })
    const t2 = await resolveTenantBySlug('t2')
    expect(t2!.kcClientId).toBe('other-admin')
    expect(t2!.authClientId).toBe('gremion-ui')
  })

  it('point 6: default authExternalBase derives from AUTH_KEYCLOAK_BASE (byte-identical)', async () => {
    // The integration env sets AUTH_KEYCLOAK_BASE distinct from the issuer; the
    // default tenant's authExternalBase must equal AUTH_KEYCLOAK_BASE, matching
    // auth.ts:19. (If the env lacks AUTH_KEYCLOAK_BASE, it falls back to the issuer.)
    await registerTenant(input)
    const ctx = await resolveTenantBySlug('default')
    const expected = (process.env.AUTH_KEYCLOAK_BASE ?? process.env.AUTH_KEYCLOAK_ISSUER ?? ctx!.issuer).replace(/\/$/, '')
    expect(ctx!.authExternalBase).toBe(expected)
  })
  it('T6 (D-JWKS/#256-6): resolution builds NO eager JWKS and carries no dead fields', async () => {
    await registerTenant(input)
    vi.mocked(createRemoteJWKSet).mockClear()
    const ctx = await resolveTenantBySlug('default')
    expect(ctx).not.toBeNull()
    // No eager createRemoteJWKSet during resolution — first Bearer verify owns it.
    expect(createRemoteJWKSet).not.toHaveBeenCalled()
    // #256-6: the dead carrier fields are gone, not just unused.
    expect('jwks' in ctx!).toBe(false)
    expect('enabledModules' in ctx!).toBe(false)
  })
  it('returns null for an unknown slug', async () => {
    expect(await resolveTenantBySlug('ghost')).toBeNull()
  })
  it('returns null for a non-active tenant (suspended)', async () => {
    await registerTenant({ ...input, slug: 'susp', status: 'suspended' })
    expect(await resolveTenantBySlug('susp')).toBeNull()
  })
})

// FIX2-LIFECYCLE (§7.8) — the GUARDED suspend/resume state machine over the live
// control DB. resumeTenant/suspendTenant read the CURRENT row status and refuse
// any illegal source so a crypto-shredded `deleted` tombstone can NEVER be flipped
// back to `active` (resolveTenantBySlug would otherwise resolve it LIVE again,
// defeating the §7.8 subdomain-takeover defence), and a half-provisioned
// `provisioning` row can never be promoted straight to active.
describe('resumeTenant/suspendTenant — guarded status transitions (§7.8)', () => {
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
  })

  it('RESUME of a deleted tombstone THROWS and leaves status unchanged (never resurrected, §7.8)', async () => {
    const t = await registerTenant({
      ...input, slug: 't2', status: 'deleted', realmName: 't2',
      issuer: 'https://t2.council.example/auth/realms/t2',
    })
    await expect(resumeTenant('t2')).rejects.toThrow(TenantStatusTransitionError)
    // the tombstone row is untouched — still 'deleted'
    expect((await getTenantById(t.id))!.status).toBe('deleted')
    // and it does NOT resolve live (resolveTenantBySlug still 404s it)
    expect(await resolveTenantBySlug('t2')).toBeNull()
  })

  it('RESUME of a deleting tombstone THROWS and leaves status unchanged', async () => {
    const t = await registerTenant({
      ...input, slug: 't2', status: 'deleting', realmName: 't2',
      issuer: 'https://t2.council.example/auth/realms/t2',
    })
    await expect(resumeTenant('t2')).rejects.toThrow(TenantStatusTransitionError)
    expect((await getTenantById(t.id))!.status).toBe('deleting')
  })

  it('RESUME of a half-provisioned (provisioning) row THROWS and leaves status unchanged', async () => {
    const t = await registerTenant({
      ...input, slug: 't2', status: 'provisioning', realmName: 't2',
      issuer: 'https://t2.council.example/auth/realms/t2',
    })
    await expect(resumeTenant('t2')).rejects.toThrow(/half-provisioned|provision pipeline/i)
    expect((await getTenantById(t.id))!.status).toBe('provisioning')
  })

  it('SUSPEND of a non-active tenant THROWS and leaves status unchanged', async () => {
    const t = await registerTenant({
      ...input, slug: 't2', status: 'suspended', realmName: 't2',
      issuer: 'https://t2.council.example/auth/realms/t2',
    })
    await expect(suspendTenant('t2')).rejects.toThrow(TenantStatusTransitionError)
    expect((await getTenantById(t.id))!.status).toBe('suspended')
  })

  it('the normal suspend(active) -> resume(suspended) path still works end-to-end', async () => {
    await registerTenant({
      ...input, slug: 't2', status: 'active', realmName: 't2',
      issuer: 'https://t2.council.example/auth/realms/t2',
    })
    // active -> suspended
    const suspended = await suspendTenant('t2')
    expect(suspended.status).toBe('suspended')
    expect(await resolveTenantBySlug('t2')).toBeNull() // suspended doesn't resolve
    // suspended -> active
    _resetResolutionCacheForTests()
    const resumed = await resumeTenant('t2')
    expect(resumed.status).toBe('active')
    expect(await resolveTenantBySlug('t2')).not.toBeNull() // resolves live again
  })

  it('throws on an unknown slug (no row to flip)', async () => {
    await expect(resumeTenant('ghost')).rejects.toThrow(/unknown tenant/i)
    await expect(suspendTenant('ghost')).rejects.toThrow(/unknown tenant/i)
  })
})
