// P2.1c (T10) — provision-pipeline unit tests over fully-mocked deps.
// No DB, no KC, no network, no filesystem. Exercises the fail-closed ordering,
// idempotent ledger sequencing, the half-onboarded retry, and the #239 pin.
import { describe, it, expect, vi } from 'vitest'
import { provisionTenant } from './pipeline'
import type { ProvisionDeps } from './pipeline'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_MANIFESTS } from '$lib/modules/registry'

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

type Row = {
  id: string
  slug: string
  status: string
  realmName: string
  issuer: string
  kcInternal: string
  kcClientId: string
  kcClientRef: string
  authClientRef: string
  dbConnRef: string
  blueprintRef: string
}
type Resource = { status: string }

/** A stateful in-memory harness that backs the ProvisionDeps with mutable
 *  registry + ledger state, so a retry sees the prior run's persisted rows. */
function harness(opts: { realmFailsOnce?: boolean; multi?: boolean } = {}) {
  const rows = new Map<string, Row>()
  const resources = new Map<string, Map<string, Resource>>() // tenantId -> subsystem -> status
  const secrets = new Map<string, string>()
  let realmCreated = false
  let realmCalls = 0
  let dbCreated = false
  const ensureRes = (tid: string, sub: string) => {
    if (!resources.has(tid)) resources.set(tid, new Map())
    const m = resources.get(tid)!
    if (!m.has(sub)) m.set(sub, { status: 'pending' })
  }
  const cfg = opts.multi === false ? {} : { deployment: { mode: 'multi' } }

  const deps: ProvisionDeps = {
    manifests: MODULE_MANIFESTS,
    apexDomain: 'council.example',
    loadDefaultConfig: () => cfg as never,
    loadBaseRealm: () => JSON.parse(JSON.stringify(base)),
    loadTenantConfig: () => ({ modules: { finance: false, elections: true } }) as never,
    tenantDbUrl: (role: string, password: string, dbName: string) =>
      `postgresql://${role}:${password}@db:6432/${dbName}`,
    genSecret: (() => {
      let n = 0
      return () => `gen-${n++}`
    })(),
    writeSecretFile: vi.fn(async (hostPath: string, value: string) => {
      secrets.set(hostPath, value)
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
        if (opts.realmFailsOnce && realmCalls === 1) throw new Error('boom: KC down')
        realmCreated = true
        return { alreadyExisted: false }
      }),
      configureStepupFlow: vi.fn(async () => {}),
      assignServiceAccountRealmRoles: vi.fn(async () => {}),
    } as never,
    registry: {
      getTenantBySlug: async (slug) => (rows.has(slug) ? ({ ...rows.get(slug)! } as never) : null),
      registerTenant: vi.fn(async (input: any) => {
        if (!rows.has(input.slug)) {
          rows.set(input.slug, { id: `id-${input.slug}`, ...input })
        }
        return { ...rows.get(input.slug)! } as never
      }),
      updateTenantProvisioning: vi.fn(async (slug: string, patch: any) => {
        const r = rows.get(slug)
        if (!r) return null
        Object.assign(r, patch)
        return { ...r } as never
      }),
      updateTenantStatus: vi.fn(async (tenantId: string, status: string) => {
        const r = [...rows.values()].find((x) => x.id === tenantId)
        if (!r) return null
        r.status = status
        return { ...r } as never
      }),
      ensureTenantResource: async (tid, sub) => ensureRes(tid, sub),
      markTenantResourceOk: async (tid, sub) => {
        ensureRes(tid, sub)
        resources.get(tid)!.set(sub, { status: 'ok' })
      },
      markTenantResourceFailed: async (tid, sub) => {
        ensureRes(tid, sub)
        resources.get(tid)!.set(sub, { status: 'failed' })
      },
      getTenantResources: async (tid) =>
        [...(resources.get(tid)?.entries() ?? [])].map(([subsystem, r]) => ({
          subsystem,
          status: r.status,
        })) as never,
    },
  }
  return { deps, rows, resources, secrets }
}

const args = { slug: 't2', realmName: 'verein', configFile: '/tmp/verein.json' }

describe('provisionTenant — fail-closed ordering', () => {
  it('refuses when the deployment is single-tenant (D-WIZARD gate, before any write)', async () => {
    const h = harness({ multi: false })
    await expect(provisionTenant(args, h.deps)).rejects.toThrow(/single-tenant|deployment\.mode/i)
    expect(h.deps.registry.registerTenant).not.toHaveBeenCalled()
  })

  it('inserts the row with status=provisioning FIRST, flips to active only at the end', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    const insertArg = (h.deps.registry.registerTenant as any).mock.calls[0][0]
    expect(insertArg.status).toBe('provisioning') // NEVER active at insert
    // final state is active
    expect(h.rows.get('t2')!.status).toBe('active')
    // status was flipped via updateTenantStatus (evicts runtime)
    expect(h.deps.registry.updateTenantStatus).toHaveBeenCalledWith('id-t2', 'active')
  })

  it('writes generated per-client + db secrets to host files (D-SECMOUNT) and a file: db ref', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    // db password file written
    expect([...h.secrets.keys()].some((p) => p.includes('tenant_t2_db'))).toBe(true)
    // registry db_conn_ref is the CONTAINER path
    expect(h.rows.get('t2')!.dbConnRef).toMatch(/^file:\/run\/secrets\/tenants\/tenant_t2_db$/)
    // realm client secrets written (gremion-ui among them)
    expect([...h.secrets.keys()].some((p) => p.includes('tenant_t2_client_gremion-ui'))).toBe(true)
    // §8.7: the per-tenant backup KEY file is written on the CREATE path (without
    // it, backupKeyRef is a phantom file and crypto-shred targets nothing).
    expect([...h.secrets.keys()].some((p) => p.includes('tenant_t2_backup_key'))).toBe(true)
  })

  it('keeps kc_client_id at the KC-admin client (gremion-admin), never overwrites it with the UI client', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    // the INSERT value MUST survive step (6): gremion-admin is the service-account
    // client resolveTenantBySlug feeds into getKeycloakAdminClient; gremion-ui (the
    // public UI client) has no service account and would break every KC Admin op.
    expect(h.rows.get('t2')!.kcClientId).toBe('gremion-admin')
    // step (6)'s write-back MUST NOT carry kc_client_id at all.
    const patch = (h.deps.registry.updateTenantProvisioning as any).mock.calls[0][1]
    expect(patch.kcClientId).toBeUndefined()
    // the UI client's OWN secret ref is the gremion-ui ref (authClientRef), distinct
    // from the admin client ref (kcClientRef).
    expect(h.rows.get('t2')!.authClientRef).toMatch(/tenant_t2_client_gremion-ui$/)
    expect(h.rows.get('t2')!.kcClientRef).toMatch(/tenant_t2_client_gremion-admin$/)
  })

  it('runs the step-up contract apply against the new realm', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    expect(h.deps.kc.configureStepupFlow).toHaveBeenCalledWith('verein')
  })

  it('(A) grants the gremion-admin SA its realm-management role(s) after step-up (imports drop SA mappings)', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    // The provisioner MUST grant realm-admin to the gremion-admin service account —
    // without it the tenant's gremion-admin client_credentials grant succeeds but
    // every Admin REST op 403s (governance sync / newsletter / #164 freshness).
    expect(h.deps.kc.assignServiceAccountRealmRoles).toHaveBeenCalledWith('verein', 'gremion-admin', ['realm-admin'])
  })

  it('(admin-assist) routes the gremion-admin SA-role grant through adminKc when provided, NOT the least-privilege kc', async () => {
    const h = harness()
    const adminAssign = vi.fn(async () => {})
    h.deps.adminKc = { assignServiceAccountRealmRoles: adminAssign }
    await provisionTenant(args, h.deps)
    // KC forbids the create-realm SA from granting realm-management roles to the
    // new realm's gremion-admin SA, so this one grant must run as admin.
    expect(adminAssign).toHaveBeenCalledWith('verein', 'gremion-admin', ['realm-admin'])
    expect(h.deps.kc.assignServiceAccountRealmRoles).not.toHaveBeenCalled()
  })

  it('writes the tenant DB secret as a FULL connection URL (resolver reads it as dbUrl), not a bare password', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    const key = [...h.secrets.keys()].find((p) => p.includes('tenant_t2_db'))!
    const stored = h.secrets.get(key)
    // a bare password would make resolveTenantBySlug throw "Invalid URL" live.
    expect(stored).toMatch(/^postgresql:\/\/t_t2:.+@.+\/t_t2$/)
  })

  it('NC/Matrix subsystems are left pending (satellite spaces ride org-unit provisioning)', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    const res = h.resources.get('id-t2')!
    expect(res.get('nextcloud')!.status).toBe('pending')
    expect(res.get('matrix')!.status).toBe('pending')
    expect(res.get('db')!.status).toBe('ok')
    expect(res.get('realm')!.status).toBe('ok')
  })
})

// P2.3 (#202) T3 — the registry row's blueprint_ref is the per-tenant seed
// path's selector. It must be DRIVEN by the provision arg (so musterstadt carries
// MUNICIPAL_BLUEPRINT@1), defaulting to the StuRa ref so the default/existing
// path stays byte-identical (criterion 4).
describe('provisionTenant — blueprintRef threading (T3)', () => {
  it('stores the StuRa ref by default when no blueprintRef arg is given (byte-identical)', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    expect(h.rows.get('t2')!.blueprintRef).toBe('STURA_BLUEPRINT@1')
    const insertArg = (h.deps.registry.registerTenant as any).mock.calls[0][0]
    expect(insertArg.blueprintRef).toBe('STURA_BLUEPRINT@1')
  })

  it('stores the blueprintRef from the arg (e.g. MUNICIPAL_BLUEPRINT@1 for musterstadt)', async () => {
    const h = harness()
    await provisionTenant({ ...args, blueprintRef: 'MUNICIPAL_BLUEPRINT@1' }, h.deps)
    expect(h.rows.get('t2')!.blueprintRef).toBe('MUNICIPAL_BLUEPRINT@1')
    const insertArg = (h.deps.registry.registerTenant as any).mock.calls[0][0]
    expect(insertArg.blueprintRef).toBe('MUNICIPAL_BLUEPRINT@1')
  })
})

// T12 cross-test: the REAL config layer's default (single) drives the gate to
// refuse — i.e. `provision t2` against a freshly-set-up (default) tenant config
// exits 1 naming the toggle. Uses parseConfig (not a hand-rolled `{}`) so a
// regression in the config default would surface here.
describe('provisionTenant — D-WIZARD cross-test against the real config default', () => {
  it('a default (single) tenant config makes provision t2 refuse, naming deployment.mode', async () => {
    const { parseConfig } = await import('$lib/server/config')
    const defaultConfig = parseConfig({}) // the T12 default → deployment.mode === 'single'
    expect((defaultConfig as { deployment: { mode: string } }).deployment.mode).toBe('single')
    const h = harness()
    h.deps.loadDefaultConfig = () => defaultConfig
    await expect(provisionTenant(args, h.deps)).rejects.toThrow(/deployment\.mode/)
    // exit-1 semantics: refused BEFORE any registry write (the CLI maps the throw
    // to process.exitCode = 1 in its main().catch).
    expect(h.deps.registry.registerTenant).not.toHaveBeenCalled()
  })

  it('flipping the real config to multi lets provision t2 proceed', async () => {
    const { parseConfig } = await import('$lib/server/config')
    const multiConfig = parseConfig({ deployment: { mode: 'multi' } })
    const h = harness()
    h.deps.loadDefaultConfig = () => multiConfig
    await provisionTenant(args, h.deps)
    expect(h.rows.get('t2')!.status).toBe('active')
  })
})

// §7.8 — identifier reuse is forbidden on delete: a deleted/deleting slug is a
// tombstone the provisioner must REFUSE (registerTenant's ON CONFLICT DO NOTHING
// would otherwise silently provision over the tombstone row).
describe('provisionTenant — §7.8 tombstone refusal', () => {
  it('refuses to provision a slug whose row is a deleted tombstone (before any write)', async () => {
    const h = harness()
    h.rows.set('t2', { id: 'id-t2', slug: 't2', status: 'deleted' } as never)
    await expect(provisionTenant(args, h.deps)).rejects.toThrow(/tombstone|§7\.8|identifier reuse/i)
    expect(h.deps.registry.registerTenant).not.toHaveBeenCalled()
  })

  it('refuses to provision a slug that is mid-delete (status=deleting)', async () => {
    const h = harness()
    h.rows.set('t2', { id: 'id-t2', slug: 't2', status: 'deleting' } as never)
    await expect(provisionTenant(args, h.deps)).rejects.toThrow(/tombstone|deleting/i)
    expect(h.deps.registry.registerTenant).not.toHaveBeenCalled()
  })
})

describe('provisionTenant — idempotency + half-onboarded retry (§6-P2.1)', () => {
  it('a second clean run short-circuits everywhere (already-present)', async () => {
    const h = harness()
    await provisionTenant(args, h.deps)
    ;(h.deps.db.createDatabaseAndRole as any).mockClear()
    ;(h.deps.kc.createRealm as any).mockClear()
    await provisionTenant(args, h.deps)
    // DB already exists -> no CREATE DATABASE re-run
    expect(h.deps.db.createDatabaseAndRole).not.toHaveBeenCalled()
    // realm already exists -> createRealm not called (reconcile path)
    expect(h.deps.kc.createRealm).not.toHaveBeenCalled()
    expect(h.rows.get('t2')!.status).toBe('active')
  })

  it('DB ok + realm failed -> re-run completes; nothing duplicated; row VALUES persisted', async () => {
    const h = harness({ realmFailsOnce: true })
    // First run: DB succeeds, realm throws -> pipeline surfaces the error, row stays provisioning.
    await expect(provisionTenant(args, h.deps)).rejects.toThrow(/boom/)
    expect(h.rows.get('t2')!.status).toBe('provisioning') // NOT active (fail-closed)
    expect(h.resources.get('id-t2')!.get('db')!.status).toBe('ok')
    expect(h.resources.get('id-t2')!.get('realm')!.status).toBe('failed')
    ;(h.deps.db.createDatabaseAndRole as any).mockClear()
    ;(h.deps.registry.registerTenant as any).mockClear()
    // Second run: completes.
    await provisionTenant(args, h.deps)
    expect(h.rows.get('t2')!.status).toBe('active')
    // DB not re-created (already ok)
    expect(h.deps.db.createDatabaseAndRole).not.toHaveBeenCalled()
    // No duplicate insert (registerTenant is ON CONFLICT DO NOTHING; row id stable)
    expect(h.rows.size).toBe(1)
    // Persisted write-back VALUES (catches a silently no-op'd write-back)
    const row = h.rows.get('t2')!
    expect(row.realmName).toBe('verein')
    expect(row.issuer).toBe('https://t2.council.example/auth/realms/verein')
    // kc_client_id is the KC-ADMIN service-account client (gremion-admin), fed into
    // getKeycloakAdminClient for the client_credentials grant — it must NOT be
    // overwritten with the public UI client (gremion-ui has no service account).
    expect(row.kcClientId).toBe('gremion-admin')
    // the UI client id is FROZEN to gremion-ui (D-UICLIENT) at the registry, not via
    // a kc_client_id column — its OWN secret ref is authClientRef.
    expect(row.authClientRef).toMatch(/^file:\/run\/secrets\/tenants\/tenant_t2_client_gremion-ui$/)
  })
})
