// TASK-043 deletion-aware pass: pipeline.test.ts went with the P2.1c pipeline,
// and with it the only unit tests of what customer-adapters.ts now does in its
// place. These restore them over the adapters themselves:
//   - a new realm is created WITHOUT a sender, then the #164 step-up contract
//     is applied and the gremion-admin SA gets realm-admin -- through adminKc
//     when given (admin-assist), never the least-privilege provisioner;
//   - the control row is registered `provisioning`, with the issuer minted
//     from the SUPPLIED host (TASK-042 Q2) and the KC-admin client id, and
//     exactly ONE primary tenant_domain row through addTenantDomain (the one
//     path with the reserved-host / owner refusals);
//   - status moves only along provisioning -> active, active <-> suspended.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reg = vi.hoisted(() => ({
  addTenantDomain: vi.fn(async () => {}),
  configPathForTenant: vi.fn((slug: string) => `/nonexistent/${slug}/config.json`),
  contextForProvisioningTenant: vi.fn(),
  ensureTenantResource: vi.fn(async () => {}),
  evictTenantRuntime: vi.fn(),
  getTenantById: vi.fn(),
  getTenantBySlug: vi.fn(),
  markTenantResourceOk: vi.fn(async () => {}),
  primaryHostForTenant: vi.fn(async () => 'rat.musterstadt.example'),
  registerTenant: vi.fn(async (input: { slug: string }) => ({ id: '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6', slug: input.slug, status: 'provisioning', realmName: input.slug })),
  resumeTenant: vi.fn(async () => {}),
  suspendTenant: vi.fn(async () => {}),
  updateTenantStatus: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/registry', () => reg)
vi.mock('$lib/server/db', () => ({ runMigrations: vi.fn(), getDb: vi.fn() }))
vi.mock('$lib/server/governance/org-units-db', () => ({ createOrgUnit: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({ provisionOrgUnit: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/subsystems/keycloak', () => ({ createKeycloakSubsystem: vi.fn() }))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: vi.fn(), getTenant: vi.fn() }))
vi.mock('@gremion/nats-auth', () => ({ ensureTenantAccount: vi.fn() }))

const { customerAdapters } = await import('./customer-adapters')

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')
const BASE = JSON.parse(readFileSync(join(REPO, 'docker', 'keycloak', 'realm-export.base.json'), 'utf8')) as Record<string, unknown>
const C = { id: '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6', slug: 'musterstadt', token: 'musterstadt', realm: 'musterstadt', host: 'rat.musterstadt.example' }

function kcFake(exists: boolean) {
  return {
    realmExists: vi.fn(async () => exists),
    // typed with the parameter it receives, so mock.calls[0][0] type-checks (review B2-HIGH, r2)
    createRealm: vi.fn(async (_doc: Record<string, unknown>) => {}),
    configureStepupFlow: vi.fn(async () => {}),
    assignServiceAccountRealmRoles: vi.fn(async () => {}),
  }
}

function adapters(kc: ReturnType<typeof kcFake>, adminKc?: { assignServiceAccountRealmRoles: ReturnType<typeof vi.fn> }) {
  const written: string[] = []
  const a = customerAdapters({
    apexDomain: 'platform.example',
    tenantSecretsDir: '/secrets',
    runtimeDatabaseUrl: 'postgresql://gremion:x@pgbouncer:6432/gremion',
    kernelAdminUrl: 'postgresql://postgres:x@postgres:5432/postgres',
    configFile: '/nonexistent/config.json',
    bodyName: 'Rat',
    edge: null,
    storageRoot: null,
    manifests: [],
    loadBaseRealm: () => JSON.parse(JSON.stringify(BASE)) as Record<string, unknown>,
    genSecret: () => 'unit-generated',
    writeSecretFile: async (p) => void written.push(p),
    writeConfigFile: () => {},
    makePrivateDir: () => {},
    kc: kc as never,
    ...(adminKc ? { adminKc: adminKc as never } : {}),
  })
  return { a, written }
}

describe('customerAdapters.realm.ensureRealm', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates an absent realm without a sender, then applies the step-up contract and the gremion-admin SA grant', async () => {
    const kc = kcFake(false)
    const { a, written } = adapters(kc)
    await a.realm.ensureRealm(C)
    expect(kc.createRealm).toHaveBeenCalledOnce()
    const doc = kc.createRealm.mock.calls[0]![0]
    expect(doc.realm).toBe('musterstadt')
    expect(doc).not.toHaveProperty('smtpServer')
    expect(JSON.stringify(doc)).not.toMatch(/__[A-Z_]+__/)
    expect(kc.configureStepupFlow).toHaveBeenCalledWith('musterstadt')
    expect(kc.assignServiceAccountRealmRoles).toHaveBeenCalledWith('musterstadt', 'gremion-admin', ['realm-admin'])
    expect(written.length).toBeGreaterThan(0)
    expect(reg.markTenantResourceOk).toHaveBeenCalledWith(C.id, 'realm', 'musterstadt')
  })

  it('routes the SA grant through adminKc when given, never the least-privilege provisioner (admin-assist)', async () => {
    const kc = kcFake(false)
    const adminKc = { assignServiceAccountRealmRoles: vi.fn(async () => {}) }
    const { a } = adapters(kc, adminKc)
    await a.realm.ensureRealm(C)
    expect(adminKc.assignServiceAccountRealmRoles).toHaveBeenCalledWith('musterstadt', 'gremion-admin', ['realm-admin'])
    expect(kc.assignServiceAccountRealmRoles).not.toHaveBeenCalled()
  })

  it('an existing realm is never re-created (no second import), but step-up and the grant are re-asserted', async () => {
    const kc = kcFake(true)
    const { a, written } = adapters(kc)
    await a.realm.ensureRealm(C)
    expect(kc.createRealm).not.toHaveBeenCalled()
    expect(written).toEqual([])
    expect(kc.configureStepupFlow).toHaveBeenCalledWith('musterstadt')
    expect(kc.assignServiceAccountRealmRoles).toHaveBeenCalledOnce()
  })
})

describe('customerAdapters.control', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers the row provisioning, the issuer from the SUPPLIED host, the KC-admin client, and ONE primary domain', async () => {
    const { a } = adapters(kcFake(false))
    const row = await a.control.registerProvisioning({ slug: 'musterstadt', host: 'rat.musterstadt.example', realm: 'musterstadt' })
    expect(reg.registerTenant).toHaveBeenCalledOnce()
    const input = reg.registerTenant.mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(input).toMatchObject({
      slug: 'musterstadt',
      status: 'provisioning',
      realmName: 'musterstadt',
      issuer: 'https://rat.musterstadt.example/auth/realms/musterstadt',
      kcClientId: 'gremion-admin',
    })
    expect(String(input.issuer)).not.toContain('platform.example')
    expect(reg.addTenantDomain).toHaveBeenCalledOnce()
    expect(reg.addTenantDomain).toHaveBeenCalledWith(C.id, 'rat.musterstadt.example', { isPrimary: true })
    expect(row).toMatchObject({ id: C.id, slug: 'musterstadt', status: 'provisioning', host: 'rat.musterstadt.example' })
  })

  it('a refused host (reserved, or another customer owns it) fails the registration: addTenantDomain decides, nothing is bypassed', async () => {
    reg.addTenantDomain.mockRejectedValueOnce(new Error('host rat.musterstadt.example belongs to another tenant'))
    const { a } = adapters(kcFake(false))
    await expect(a.control.registerProvisioning({ slug: 'musterstadt', host: 'rat.musterstadt.example', realm: 'musterstadt' })).rejects.toThrow(/another tenant/)
    expect(reg.ensureTenantResource).not.toHaveBeenCalled()
  })

  it.each([
    ['provisioning', 'active', 'updateTenantStatus'],
    ['active', 'suspended', 'suspendTenant'],
    ['suspended', 'active', 'resumeTenant'],
  ] as const)('%s -> %s goes through %s', async (from, to, fn) => {
    reg.getTenantById.mockResolvedValueOnce({ id: C.id, slug: 'musterstadt', status: from })
    const { a } = adapters(kcFake(true))
    await a.control.setStatus(C.id, to)
    expect(reg[fn]).toHaveBeenCalledOnce()
  })

  it('refuses any other transition (a deleted tombstone never comes back)', async () => {
    reg.getTenantById.mockResolvedValueOnce({ id: C.id, slug: 'musterstadt', status: 'deleted' })
    const { a } = adapters(kcFake(true))
    await expect(a.control.setStatus(C.id, 'active')).rejects.toThrow(/refusing/)
    expect(reg.updateTenantStatus).not.toHaveBeenCalled()
  })
})
