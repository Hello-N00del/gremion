// @vitest-environment node
// TRD-196: the files module registers its erasure hook at server init.
// Module Karenz (phase 2, Task 16): and its Karenz participant, its "retains nothing" declaration and its
// retained sink, into the kernel's REAL registries (the registrations are the behaviour under test).
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  erasure: [] as { moduleId: string }[],
  factories: {} as Record<string, (kc: unknown) => unknown>,
  env: {} as Record<string, string | undefined>,
}))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
  registerProvisioningSubsystem: (name: string, factory: (kc: unknown) => unknown) => { h.factories[name] = factory },
  registerProtocolDocumentPort: vi.fn(),
  registerSetupHealthProbe: vi.fn(),
}))
// the participant and the sink read the tenant database, the config and Keycloak only when they RUN
vi.mock('$lib/server/governance/org-units-db', () => ({ getOrgUnit: vi.fn(), listOrgUnits: vi.fn(), setSubsystemWanted: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ enqueueResources: vi.fn(), getResource: vi.fn(), markResourceOk: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({ releaseSubsystem: vi.fn() }))
vi.mock('$lib/server/governance/role-holders', () => ({ listRoleHolders: vi.fn() }))
vi.mock('$lib/server/db', () => ({ getDb: vi.fn() }))
vi.mock('$lib/server/config', () => ({ readConfig: vi.fn() }))
// the provisioning factory under test: what it hands the subsystem is the behaviour, not the Nextcloud client
vi.mock('$lib/server/env/service-env', () => ({ serviceEnv: (name: string) => h.env[name] }))
vi.mock('./nextcloud-client', () => ({ createNextcloudClient: () => ({ __nc: true }) }))
vi.mock('./provisioning/nextcloud-subsystem', () => ({
  createNextcloudSubsystem: (_deps: unknown, providerId: number) => ({ providerId }),
}))

await import('./register.server')

describe('files register.server', () => {
  it('registers the files erasure hook', async () => {
    const { filesErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([filesErasureHook])
  })

  it('registers the files Karenz participant under the catalogue id files', async () => {
    const { karenzParticipantsFor } = await import('$lib/server/module-karenz/participants')
    const { filesKarenz } = await import('./karenz')
    expect(karenzParticipantsFor('files')).toEqual([filesKarenz])
  })

  it('declares that the files module retains no records of its own (otherwise its retained step fails)', async () => {
    const { hasRetentionDeclaration, extractorsFor } = await import('$lib/server/module-karenz/retained/extractors')
    expect(hasRetentionDeclaration('files')).toBe(true)
    expect(extractorsFor('files')).toEqual([]) // by declaration, not by an extractor
  })

  it('registers the files retained sink', async () => {
    const { retainedSinks } = await import('$lib/server/module-karenz/retained/extractors')
    const { filesRetainedSink } = await import('./retained-sink')
    expect(retainedSinks()).toEqual([filesRetainedSink])
  })

  // The user_oidc provider id of the Nextcloud accounts the provisioning adapter creates: one process-wide
  // env value used to be handed to every customer, so customer B's members were created under customer A's
  // provider. A customer that was wired with its own provider carries its id in its registry row.
  describe('the Nextcloud provisioning adapter and the user_oidc provider id', () => {
    const tenant = (slug: string, ncProviderId?: number) =>
      ({ id: `id-${slug}`, slug, services: { ncProviderId } }) as unknown as import('$lib/server/tenant/context').TenantContext
    const build = async (ctx: import('$lib/server/tenant/context').TenantContext | null) => {
      const { runWithTenant } = await import('$lib/server/tenant/context')
      const factory = h.factories['nextcloud']
      return (ctx ? runWithTenant(ctx, () => factory({})) : factory({})) as { providerId: number }
    }

    it('two customers with their own provider ids each get their own', async () => {
      h.env.NEXTCLOUD_OIDC_PROVIDER_ID = '1'
      expect((await build(tenant('alpha', 2))).providerId).toBe(2)
      expect((await build(tenant('beta', 5))).providerId).toBe(5)
    })

    it('a customer without one (the primary, or a secondary not wired since) keeps the env value, default 1', async () => {
      h.env.NEXTCLOUD_OIDC_PROVIDER_ID = '3'
      expect((await build(tenant('primary')))).toEqual({ providerId: 3 })
      h.env.NEXTCLOUD_OIDC_PROVIDER_ID = undefined
      expect((await build(tenant('primary')))).toEqual({ providerId: 1 })
    })

    it('outside a tenant scope the env value is used and nothing throws (the factory read no tenant before)', async () => {
      h.env.NEXTCLOUD_OIDC_PROVIDER_ID = '4'
      expect(await build(null)).toEqual({ providerId: 4 })
    })
  })
})
