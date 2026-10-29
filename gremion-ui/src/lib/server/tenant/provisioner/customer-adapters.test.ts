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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const lc = vi.hoisted(() => ({
  ensureKernelDatabase: vi.fn(),
  ensureKernelPurgeGrants: vi.fn(),
  ensureKernelAuditAppendOnly: vi.fn(),
  kernelAuditAppendOnlyProblems: vi.fn(),
}))
vi.mock('@gremion/tenant-store/lifecycle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureKernelDatabase: lc.ensureKernelDatabase,
  ensureKernelPurgeGrants: lc.ensureKernelPurgeGrants,
  ensureKernelAuditAppendOnly: lc.ensureKernelAuditAppendOnly,
  kernelAuditAppendOnlyProblems: lc.kernelAuditAppendOnlyProblems,
}))

// the real driver (pools connect lazily), recorded: kernelServer's startup parameters
const pg = vi.hoisted(() => ({ calls: [] as { url: string; opts: Record<string, unknown> }[] }))
vi.mock('postgres', async (orig) => {
  const real = ((await orig()) as { default: (url: string, opts: Record<string, unknown>) => unknown }).default
  return {
    default: (url: string, opts: Record<string, unknown>) => {
      pg.calls.push({ url, opts })
      return real(url, opts)
    },
  }
})

const { customerAdapters, kernelServer, ensureKernelPostMigrationPrivileges, reconcileKernelAudit } = await import('./customer-adapters')
const { runWithTenant } = await import('$lib/server/tenant/context')
const { runMigrations } = await import('$lib/server/db')

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')
const BASE = JSON.parse(readFileSync(join(REPO, 'docker', 'keycloak', 'realm-export.base.json'), 'utf8')) as Record<string, unknown>
const C = { id: '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6', slug: 'musterstadt', token: 'musterstadt', realm: 'musterstadt', host: 'rat.musterstadt.example' }

// held: the realm-management roles the gremion-admin SA holds, as read back
// (before, and after a grant). Default: none held, and a grant makes them held.
function kcFake(exists: boolean, held: string[][] = [[], ['realm-admin']]) {
  const reads = [...held]
  return {
    realmExists: vi.fn(async () => exists),
    // typed with the parameter it receives, so mock.calls[0][0] type-checks (review B2-HIGH, r2)
    createRealm: vi.fn(async (_doc: Record<string, unknown>) => {}),
    configureStepupFlow: vi.fn(async () => {}),
    assignServiceAccountRealmRoles: vi.fn(async (_realm: string, _client: string, _roles: readonly string[]) => {}),
    getServiceAccountRealmRoleNames: vi.fn(async (_realm: string, _client: string) => (reads.length > 1 ? reads.shift()! : reads[0]!)),
  }
}

function adapters(kc: ReturnType<typeof kcFake>, adminKc?: { assignServiceAccountRealmRoles: ReturnType<typeof vi.fn> }, tenantSecretsDir = '/secrets') {
  const written: string[] = []
  const a = customerAdapters({
    apexDomain: 'platform.example',
    tenantSecretsDir,
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

// Review B2 MEDIUM (r2): the first-body projection passed `{keycloak} as
// unknown as Adapters`, so an orchestrator call into matrix or nextcloud was a
// TypeError on undefined. firstBodyAdapters is a complete Adapters whose two
// unwanted subsystems refuse BY NAME.
describe('firstBodyAdapters', () => {
  it('carries the given keycloak subsystem and refuses matrix and nextcloud by name, on every method', async () => {
    const { firstBodyAdapters } = await import('./customer-adapters')
    const keycloak = { name: 'keycloak' } as never
    const a = firstBodyAdapters(keycloak)
    expect(a.keycloak).toBe(keycloak)
    for (const s of [a.matrix, a.nextcloud]) {
      expect(['matrix', 'nextcloud']).toContain(s.name)
      await expect(s.ensureResource({} as never, { parentKeycloakGroupId: null }, null)).rejects.toThrow(new RegExp(`first body wants no ${s.name}`))
      await expect(s.removeResource('x')).rejects.toThrow(/first body wants no/)
      await expect(s.addMember('x', 'u')).rejects.toThrow(/first body wants no/)
      await expect(s.removeMember('x', 'u')).rejects.toThrow(/first body wants no/)
      await expect(s.reconcileMembers('x', [])).rejects.toThrow(/first body wants no/)
    }
  })
})

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

  // TASK-043b F3: the live proof's 403. The provisioner may READ the SA's
  // mappings (measured 200) but never map realm-admin (measured 403); the
  // import carries realm-admin, so a provisioner-created realm needs no grant.
  it('the SA already holds the roles (the import carried them): no grant at all, neither the provisioner nor adminKc (TASK-043b F3)', async () => {
    const kc = kcFake(false, [['manage-users', 'realm-admin']])
    const adminKc = { assignServiceAccountRealmRoles: vi.fn(async () => {}) }
    const { a } = adapters(kc, adminKc)
    await a.realm.ensureRealm(C)
    expect(kc.getServiceAccountRealmRoleNames).toHaveBeenCalledWith('musterstadt', 'gremion-admin')
    expect(kc.assignServiceAccountRealmRoles).not.toHaveBeenCalled()
    expect(adminKc.assignServiceAccountRealmRoles).not.toHaveBeenCalled()
    expect(reg.markTenantResourceOk).toHaveBeenCalledWith(C.id, 'realm', 'musterstadt')
  })

  it('a refused grant (the provisioner\'s 403 on an older realm) fails the step by name, with the remedy, and the realm is not marked ok (TASK-043b F3)', async () => {
    const kc = kcFake(true, [['manage-users']])
    kc.assignServiceAccountRealmRoles.mockRejectedValueOnce(new Error('Keycloak Admin API error: 403 on POST /admin/realms/musterstadt/users/u/role-mappings/clients/rm: {"error":"HTTP 403 Forbidden"}'))
    const { a } = adapters(kc)
    const err: unknown = await a.realm.ensureRealm(C).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toMatch(/gremion-admin service account of realm musterstadt lacks \[realm-admin\].*403/)
    // The remedy must be one an operator can actually take: `gremion-tenant
    // create` never passes a master-admin credential to the one-shot (only
    // `init`'s bootstrap-provisioner gets one), so "rerun with
    // KEYCLOAK_ADMIN in the one-shot" is not a remedy (r2 verifier, LOW).
    expect(msg).toMatch(/admin console/)
    expect(msg).toMatch(/service-account-gremion-admin/)
    expect(msg).not.toMatch(/KEYCLOAK_ADMIN/)
    expect(reg.markTenantResourceOk).not.toHaveBeenCalled()
  })

  it('a grant that "succeeds" but does not read back fails the step (the post-condition, not the exit) (TASK-043b F3)', async () => {
    const kc = kcFake(true, [[], []])
    const { a } = adapters(kc)
    await expect(a.realm.ensureRealm(C)).rejects.toThrow(/still lacks \[realm-admin\]/)
    expect(reg.markTenantResourceOk).not.toHaveBeenCalled()
  })
})

describe('customerAdapters.kernel.ensureDatabase: the PgBouncer grant (review B1, r2)', () => {
  beforeEach(() => vi.clearAllMocks())
  const made = (grant: 'applied' | 'skipped-no-role') => ({
    dbName: 't_0192f1a23b4c7d5e8f60718293a4b5c6__kernel',
    created: true,
    owner: 'k_x_owner',
    app: 'k_x_app',
    purger: 'k_x_purger',
    pgbouncerGrant: grant,
  })

  it('on a pooled host (DATABASE_URL is PgBouncer) a missing pgbouncer_auth role FAILS the step loudly, before the db secret is written', async () => {
    lc.ensureKernelDatabase.mockResolvedValueOnce(made('skipped-no-role'))
    const { a, written } = adapters(kcFake(true))
    await expect(a.kernel.ensureDatabase(C)).rejects.toThrow(/pgbouncer_auth/)
    expect(written).toEqual([])
    expect(reg.markTenantResourceOk).not.toHaveBeenCalled()
  })

  it('with the grant applied the step completes and records the database', async () => {
    lc.ensureKernelDatabase.mockResolvedValueOnce(made('applied'))
    const { a, written } = adapters(kcFake(true))
    await a.kernel.ensureDatabase(C)
    expect(written.some((p) => p.endsWith('tenant_musterstadt_db'))).toBe(true)
    expect(reg.markTenantResourceOk).toHaveBeenCalledWith(C.id, 'db', 't_0192f1a23b4c7d5e8f60718293a4b5c6__kernel')
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

// TASK-033-a: after the kernel chain created the tables, provisioning takes the purger's grants AND
// makes audit_log append-only (a governance record, RC-GOV-CHAIN). The second is not optional:
// a customer whose app role can still DELETE from audit_log is not a provisioned customer.
describe('ensureKernelPostMigrationPrivileges: purge grants, then the append-only audit record', () => {
  beforeEach(() => vi.clearAllMocks())
  const server = {} as never
  const T = '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6'

  it('grants the purger, revokes the audit privileges, then checks the post-condition (in that order)', async () => {
    const order: string[] = []
    lc.ensureKernelPurgeGrants.mockImplementation(async () => (order.push('grants'), { granted: ['event_consumption'], absent: [] }))
    lc.ensureKernelAuditAppendOnly.mockImplementation(async () => (order.push('append-only'), { revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] }))
    lc.kernelAuditAppendOnlyProblems.mockImplementation(async () => (order.push('check'), []))
    await ensureKernelPostMigrationPrivileges(server, T, () => {})
    expect(order).toEqual(['grants', 'append-only', 'check'])
    expect(lc.ensureKernelAuditAppendOnly).toHaveBeenCalledWith(server, T)
  })

  it('FAILS the step when audit_log is absent after the kernel chain (nothing silently stays unprotected)', async () => {
    lc.ensureKernelPurgeGrants.mockResolvedValue({ granted: [], absent: [] })
    lc.ensureKernelAuditAppendOnly.mockResolvedValue({ revoked: ['audit_log_chain_anchor'], absent: ['audit_log'] })
    lc.kernelAuditAppendOnlyProblems.mockResolvedValue([])
    await expect(ensureKernelPostMigrationPrivileges(server, T, () => {})).rejects.toThrow(/audit_log/)
  })

  it('FAILS the step when the effective privileges still allow a write (the post-condition is read, not assumed)', async () => {
    lc.ensureKernelPurgeGrants.mockResolvedValue({ granted: [], absent: [] })
    lc.ensureKernelAuditAppendOnly.mockResolvedValue({ revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] })
    lc.kernelAuditAppendOnlyProblems.mockResolvedValue(['audit_log: k_x_app still holds DELETE (the kernel audit record is append-only)'])
    await expect(ensureKernelPostMigrationPrivileges(server, T, () => {})).rejects.toThrow(/still holds DELETE/)
  })

  it('an absent purge table is logged, not fatal (the pre-existing behaviour)', async () => {
    lc.ensureKernelPurgeGrants.mockResolvedValue({ granted: [], absent: ['event_consumption'] })
    lc.ensureKernelAuditAppendOnly.mockResolvedValue({ revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] })
    lc.kernelAuditAppendOnlyProblems.mockResolvedValue([])
    const logs: string[] = []
    await ensureKernelPostMigrationPrivileges(server, T, (m) => logs.push(m))
    expect(logs.join(' | ')).toContain('event_consumption')
  })
})

// TASK-033-a r1 MED: the helper above is proven in isolation; this proves the REAL provisioning step
// calls it. customerAdapters().kernel.migrate is what `gremion-tenant create` runs after the kernel
// chain; if the REVOKE were unwired from it, every test above would stay green and a new customer's
// app role would keep DELETE on the governance record.
describe('customerAdapters.kernel.migrate: the append-only REVOKE is wired into the real step', () => {
  let secretsDir: string
  beforeEach(() => {
    vi.clearAllMocks()
    secretsDir = mkdtempSync(join(tmpdir(), 'gremion-adapters-'))
    writeFileSync(join(secretsDir, `tenant_${C.slug}_db`), 'postgresql://k_app:pw@pgbouncer:6432/t_x__kernel\n')
    vi.stubEnv('GREMION_DISABLE_SEEDS', 'true')
    reg.getTenantById.mockResolvedValue({ id: C.id, slug: C.slug, status: 'provisioning' })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(secretsDir, { recursive: true, force: true })
  })

  it('runs the kernel chain, THEN the purger grants, THEN the audit REVOKE, THEN reads the post-condition', async () => {
    const order: string[] = []
    vi.mocked(runWithTenant).mockImplementation(async (_ctx, fn) => (order.push('chain'), fn()))
    vi.mocked(runMigrations).mockImplementation(async () => void order.push('runMigrations'))
    lc.ensureKernelPurgeGrants.mockImplementation(async () => (order.push('grants'), { granted: [], absent: [] }))
    lc.ensureKernelAuditAppendOnly.mockImplementation(async () => (order.push('append-only'), { revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] }))
    lc.kernelAuditAppendOnlyProblems.mockImplementation(async () => (order.push('check'), []))
    const { a } = adapters(kcFake(true), undefined, secretsDir)
    await a.kernel.migrate(C)
    expect(order).toEqual(['chain', 'runMigrations', 'grants', 'append-only', 'check'])
    expect(lc.ensureKernelAuditAppendOnly).toHaveBeenCalledWith(expect.anything(), C.id)
  })

  it('a privilege still held after the REVOKE fails the migrate step itself (the customer is not marked provisioned)', async () => {
    vi.mocked(runWithTenant).mockImplementation(async (_ctx, fn) => fn())
    lc.ensureKernelPurgeGrants.mockResolvedValue({ granted: [], absent: [] })
    lc.ensureKernelAuditAppendOnly.mockResolvedValue({ revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] })
    lc.kernelAuditAppendOnlyProblems.mockResolvedValue(['audit_log: k_x_app still holds DELETE (the kernel audit record is append-only)'])
    const { a } = adapters(kcFake(true), undefined, secretsDir)
    await expect(a.kernel.migrate(C)).rejects.toThrow(/still holds DELETE/)
  })

  it('a failing chain never reaches the REVOKE (nothing to revoke from; the step fails on the chain)', async () => {
    vi.mocked(runWithTenant).mockImplementation(async () => {
      throw new Error('migration 0059 failed')
    })
    const { a } = adapters(kcFake(true), undefined, secretsDir)
    await expect(a.kernel.migrate(C)).rejects.toThrow(/0059 failed/)
    expect(lc.ensureKernelAuditAppendOnly).not.toHaveBeenCalled()
  })
})

// TASK-033-a r1 MED: the reconcile verb's DB-level half. scripts/tenant-provision.ts reconcileOne
// delegates to reconcileKernelAudit (reconcile-wiring.test.ts proves it does); here the helper is
// proven to call the tenant-store read for verify and the tenant-store REVOKE for apply.
describe('reconcileKernelAudit: the reconcile verb reads and re-asserts the audit privileges', () => {
  beforeEach(() => vi.clearAllMocks())
  const server = { marker: 'server' } as never
  const T = '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6'
  const green = { realm: 'musterstadt', ok: true, checks: [{ name: 'ssl-required' as const, ok: true, detail: '' }], applied: [], repairHost: [] }

  it('verify-only reads the effective privileges of THIS tenant and never revokes', async () => {
    lc.kernelAuditAppendOnlyProblems.mockResolvedValue(['audit_log: k_x_app still holds DELETE (the kernel audit record is append-only)'])
    const r = await reconcileKernelAudit(green, server, T, true)
    // requirePresent: an absent audit_log / chain anchor is a PROBLEM for reconcile, exactly as it is fatal at provisioning
    expect(lc.kernelAuditAppendOnlyProblems).toHaveBeenCalledWith(server, T, { requirePresent: true })
    expect(lc.ensureKernelAuditAppendOnly).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)).toMatchObject({ name: 'audit-append-only', ok: false })
  })

  it('verify-only turns red for an ABSENT audit table (the read asks for requirePresent and its problem surfaces)', async () => {
    lc.kernelAuditAppendOnlyProblems.mockImplementation(async (_s: unknown, _t: unknown, o?: { requirePresent?: boolean }) =>
      o?.requirePresent ? ['audit_log: table is absent (the kernel chain has not created it)'] : [],
    )
    const r = await reconcileKernelAudit(green, server, T, true)
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)!.detail).toContain('audit_log')
  })

  it('apply does not discard `absent`: a repair that finds the table missing stays RED even if the re-read is clean', async () => {
    lc.kernelAuditAppendOnlyProblems.mockResolvedValue([])
    lc.ensureKernelAuditAppendOnly.mockResolvedValue({ revoked: ['audit_log_chain_anchor'], absent: ['audit_log'] })
    // a first read with a problem triggers the repair; the repair reports audit_log absent
    lc.kernelAuditAppendOnlyProblems.mockResolvedValueOnce(['audit_log_chain_anchor: k_x_app still holds INSERT'])
    const r = await reconcileKernelAudit(green, server, T, false)
    expect(lc.ensureKernelAuditAppendOnly).toHaveBeenCalledWith(server, T)
    expect(r.ok).toBe(false)
    expect(r.checks.at(-1)!.detail).toContain('audit_log')
    expect(r.applied).not.toContain('audit-append-only')
  })

  it('apply runs the tenant-store REVOKE for THIS tenant, re-reads, and the report turns green', async () => {
    lc.kernelAuditAppendOnlyProblems.mockResolvedValueOnce(['audit_log: k_x_app still holds DELETE']).mockResolvedValue([])
    lc.ensureKernelAuditAppendOnly.mockResolvedValue({ revoked: ['audit_log', 'audit_log_chain_anchor'], absent: [] })
    const r = await reconcileKernelAudit(green, server, T, false)
    expect(lc.ensureKernelAuditAppendOnly).toHaveBeenCalledWith(server, T)
    expect(lc.kernelAuditAppendOnlyProblems).toHaveBeenCalledTimes(2)
    expect(lc.kernelAuditAppendOnlyProblems).toHaveBeenLastCalledWith(server, T, { requirePresent: true })
    expect(r.ok).toBe(true)
    expect(r.applied).toContain('audit-append-only')
  })
})

describe('kernelServer: every admin open of a customer database pins search_path (r33f CRIT)', () => {
  it('open() sends search_path=pg_catalog as a startup parameter (it overrides the owner\'s ALTER DATABASE SET)', async () => {
    const server = kernelServer('postgresql://postgres:x@postgres:5432/postgres')
    try {
      server.open('t_0192f1a23b4c7d5e8f60718293a4b5c6__kernel')
      const call = pg.calls.find((c) => c.url.endsWith('/t_0192f1a23b4c7d5e8f60718293a4b5c6__kernel'))
      expect(call?.opts.connection).toMatchObject({ search_path: 'pg_catalog' })
    } finally {
      await server.close()
    }
  })
})
