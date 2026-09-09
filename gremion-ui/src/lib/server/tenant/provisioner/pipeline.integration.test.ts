// P2.1c (T10) — provision pipeline against the REAL control DB (p21a-test-pg)
// with the DB-create + KC legs MOCKED. Exercises the genuine registry write
// path (registerTenant INSERT-FIRST as 'provisioning', updateTenantProvisioning
// write-back, updateTenantStatus -> active, the ledger fns) so the persisted
// row VALUES and ledger states are asserted end-to-end, catching a silently
// no-op'd write-back. The KC leg is mocked (no local KC in S3); the live KC
// evidence is the S4 dress-rehearsal (D-87-SLIP carry-over).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getControlDb } from '../control-db'
import { runControlMigrations } from '../control-migrations'
import {
  getTenantBySlug,
  registerTenant,
  updateTenantProvisioning,
  updateTenantStatus,
  ensureTenantResource,
  markTenantResourceOk,
  markTenantResourceFailed,
  getTenantResources,
  resolveTenantBySlug,
  _resetResolutionCacheForTests,
} from '../registry'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { provisionTenant, type ProvisionDeps } from './pipeline'

const KC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'docker', 'keycloak')
// The shipped base template carries the deployment apex host as the
// `__APEX_DOMAIN__` sentinel (resolved at Keycloak boot by
// docker/keycloak/substitute-realm-secrets.sh, and by loadBaseRealmDoc() in
// scripts/tenant-provision.ts). Resolve it to this suite's example apex so the
// fixtures exercise the same shape a real deployment gets.
const TEST_APEX = 'council.example'
const base = JSON.parse(
  readFileSync(join(KC, 'realm-export.base.json'), 'utf-8').split('__APEX_DOMAIN__').join(TEST_APEX),
)

/** Deps with the REAL registry, a fake DB executor and a fake KC. State the
 *  fakes carry so a retry sees the prior run. */
function makeDeps(opts: { realmFailsOnce?: boolean } = {}) {
  let dbCreated = false
  let realmCreated = false
  let realmCalls = 0
  const writtenSecrets: string[] = []
  const deps: ProvisionDeps = {
    manifests: MODULE_MANIFESTS,
    apexDomain: 'council.example',
    loadDefaultConfig: () => ({ deployment: { mode: 'multi' } }),
    loadBaseRealm: () => JSON.parse(JSON.stringify(base)),
    loadTenantConfig: () => ({ modules: { finance: false, elections: true } }),
    tenantDbUrl: (role: string, password: string, dbName: string) =>
      `postgresql://${role}:${password}@db:6432/${dbName}`,
    genSecret: (() => {
      let n = 0
      return () => `gen-${n++}`
    })(),
    writeSecretFile: vi.fn(async (hostPath: string) => {
      writtenSecrets.push(hostPath)
    }),
    db: {
      databaseExists: async () => dbCreated,
      createDatabaseAndRole: vi.fn(async () => {
        dbCreated = true
      }),
    },
    kc: {
      realmExists: async () => realmCreated,
      createRealm: vi.fn(async () => {
        realmCalls++
        if (opts.realmFailsOnce && realmCalls === 1) throw new Error('boom: KC down (mocked)')
        realmCreated = true
        return { alreadyExisted: false }
      }),
      configureStepupFlow: vi.fn(async () => {}),
      assignServiceAccountRealmRoles: vi.fn(async () => {}),
    } as never,
    registry: {
      getTenantBySlug,
      registerTenant,
      updateTenantProvisioning,
      updateTenantStatus,
      ensureTenantResource,
      markTenantResourceOk,
      markTenantResourceFailed,
      getTenantResources,
    },
  }
  return { deps, writtenSecrets }
}

describe('provision pipeline — real control DB, mocked DB-create + KC', () => {
  beforeAll(async () => {
    await runControlMigrations()
  })
  beforeEach(async () => {
    await getControlDb()`TRUNCATE tenant, tenant_provisioning_resource RESTART IDENTITY CASCADE`
    _resetResolutionCacheForTests()
  })

  it('provisions verein end-to-end; the persisted row + ledger reflect the §4 contract', async () => {
    const { deps } = makeDeps()
    const res = await provisionTenant({ slug: 't2', realmName: 'verein', configFile: 'verein.json' }, deps)
    expect(res.realmCreated).toBe(true)

    const row = await getTenantBySlug('t2')
    expect(row).not.toBeNull()
    expect(row!.status).toBe('active') // resolvable only after every step
    expect(row!.realmName).toBe('verein')
    expect(row!.issuer).toBe('https://t2.council.example/auth/realms/verein')
    // (A) #139/G-080: the persisted in-cluster admin URL is internal-TLS (https,
    // not plaintext :8080) so the admin client can reach a realm stamped
    // sslRequired:'all'. makeDeps leaves kcInternalBase unset -> the TLS default.
    expect(row!.kcInternal).toBe('https://keycloak:8443/auth/realms/verein')
    expect(row!.kcInternal.startsWith('https://')).toBe(true)
    // kc_client_id is the KC-ADMIN service-account client — NOT overwritten with
    // the public UI client (gremion-ui has no service account, so an overwrite would
    // break EVERY KC Admin REST op the resolver feeds it into). The admin secret
    // ref and the UI secret ref are distinct, per-client files.
    expect(row!.kcClientId).toBe('gremion-admin')
    expect(row!.kcClientRef).toBe('file:/run/secrets/tenants/tenant_t2_client_gremion-admin')
    expect(row!.authClientRef).toBe('file:/run/secrets/tenants/tenant_t2_client_gremion-ui')
    expect(row!.dbConnRef).toBe('file:/run/secrets/tenants/tenant_t2_db')

    // The §8.7 per-tenant backup key ref is persisted (its file is written on the
    // CREATE path; this row is the registry's pointer to it).
    expect(row!.backupKeyRef).toBe('file:/run/secrets/tenants/tenant_t2_backup_key')

    // The UI client id is frozen to gremion-ui via the registry's resolver, INDEPENDENT
    // of the row's kc_client_id (the ADMIN client). resolveTenantBySlug here would
    // also eagerly read the (mocked-away) db secret file, so the dedicated D-UICLIENT
    // resolve assertion lives in registry.integration.test.ts ('authClientId is frozen
    // to gremion-ui for every row, independent of kc_client_id'); this test pins the
    // persisted column the resolver consumes (kcClientId = gremion-admin).

    // (A) the gremion-admin SA got its realm-management role(s) on the new realm —
    // KC 26 imports drop SA mappings, so the provisioner MUST grant them post-create
    // or every tenant Admin REST op 403s. (Mocked KC here; the live verify is the S4
    // dress-rehearsal carry-over.)
    expect(deps.kc.assignServiceAccountRealmRoles).toHaveBeenCalledWith('verein', 'gremion-admin', ['realm-admin'])

    const ledger = new Map((await getTenantResources(row!.id)).map((r) => [r.subsystem, r.status]))
    expect(ledger.get('db')).toBe('ok')
    expect(ledger.get('realm')).toBe('ok')
    expect(ledger.get('nextcloud')).toBe('pending')
    expect(ledger.get('matrix')).toBe('pending')
  })

  it('a fail-closed mid-pipeline tenant (provisioning) is NOT resolvable', async () => {
    const { deps } = makeDeps({ realmFailsOnce: true })
    await expect(
      provisionTenant({ slug: 't2', realmName: 'verein', configFile: 'verein.json' }, deps),
    ).rejects.toThrow(/boom/)
    const row = await getTenantBySlug('t2')
    expect(row!.status).toBe('provisioning')
    // resolveTenantBySlug resolves ONLY active rows -> a half-provisioned tenant
    // is structurally non-resolvable (review round 1 fail-closed pin).
    expect(await resolveTenantBySlug('t2')).toBeNull()
  })

  it('double-provision is idempotent: second run short-circuits, row id stable, no duplicate', async () => {
    const { deps } = makeDeps()
    const first = await provisionTenant({ slug: 't2', realmName: 'verein', configFile: 'verein.json' }, deps)
    const idAfterFirst = (await getTenantBySlug('t2'))!.id
    ;(deps.db.createDatabaseAndRole as any).mockClear()
    ;(deps.kc.createRealm as any).mockClear()
    const second = await provisionTenant({ slug: 't2', realmName: 'verein', configFile: 'verein.json' }, deps)
    // already-present everywhere
    expect(deps.db.createDatabaseAndRole).not.toHaveBeenCalled()
    expect(deps.kc.createRealm).not.toHaveBeenCalled()
    expect(second.realmCreated).toBe(false)
    // row id unchanged, exactly one tenant row exists
    expect((await getTenantBySlug('t2'))!.id).toBe(idAfterFirst)
    const count = await getControlDb()<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant`
    expect(count[0].n).toBe(1)
    expect(first.realmCreated).toBe(true)
  })

  it('half-onboarded retry: DB ok + realm failed -> re-run completes; row VALUES persisted', async () => {
    const { deps } = makeDeps({ realmFailsOnce: true })
    await expect(
      provisionTenant({ slug: 't2', realmName: 'verein', configFile: 'verein.json' }, deps),
    ).rejects.toThrow(/boom/)
    const mid = await getTenantBySlug('t2')
    expect(mid!.status).toBe('provisioning')
    const midLedger = new Map((await getTenantResources(mid!.id)).map((r) => [r.subsystem, r.status]))
    expect(midLedger.get('db')).toBe('ok')
    expect(midLedger.get('realm')).toBe('failed')

    ;(deps.db.createDatabaseAndRole as any).mockClear()
    await provisionTenant({ slug: 't2', realmName: 'verein', configFile: 'verein.json' }, deps)
    // DB not re-created (already ok)
    expect(deps.db.createDatabaseAndRole).not.toHaveBeenCalled()
    const done = await getTenantBySlug('t2')
    expect(done!.status).toBe('active')
    // persisted write-back VALUES (not just ledger states)
    expect(done!.realmName).toBe('verein')
    expect(done!.issuer).toBe('https://t2.council.example/auth/realms/verein')
    // kc_client_id stays at the KC-admin service-account client across the retry.
    expect(done!.kcClientId).toBe('gremion-admin')
    expect(done!.authClientRef).toBe('file:/run/secrets/tenants/tenant_t2_client_gremion-ui')
  })
})
