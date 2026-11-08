// @vitest-environment node
// TRD-196: the files module registers its erasure hook at server init.
// Module Karenz (phase 2, Task 16): and its Karenz participant, its "retains nothing" declaration and its
// retained sink, into the kernel's REAL registries (the registrations are the behaviour under test).
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ erasure: [] as { moduleId: string }[] }))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
  registerProvisioningSubsystem: vi.fn(),
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
})
