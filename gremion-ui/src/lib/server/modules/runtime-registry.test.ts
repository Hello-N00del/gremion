// src/lib/server/modules/runtime-registry.test.ts
// Session-A inversion A1 — the runtime-registry seam. Three registries
// let a module SELF-REGISTER its boot worker, its per-tenant eviction hook, and
// its provisioning subsystem factory, so the kernel composition roots
// (hooks.server.ts / tenant/registry.ts / governance orchestrator) no longer
// statically import any module's server internals. This file pins the
// register/run round-trip + deterministic registration order for each registry.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerServerInitHook,
  runServerInitHooks,
  registerTenantEvictHook,
  runTenantEvictHooks,
  registerProvisioningSubsystem,
  buildModuleProvisioningSubsystems,
  registerDataProvider,
  getDataProvider,
  registerProtocolDocumentPort,
  getProtocolDocumentPort,
  registerSetupHealthProbe,
  getSetupHealthProbes,
  _resetRuntimeRegistryForTests,
} from './runtime-registry'
import type { ProtocolDocumentPort, SetupHealthProbe } from './runtime-registry'
import type { KeycloakAdminClient } from '$lib/server/keycloak-admin'
import type { ProvisioningSubsystem } from '$lib/server/governance/provisioning/types'

// A bare ProtocolDocumentPort stub — only identity/round-trip is asserted in the
// registry-seam tests (the port's NC behavior is owned by files/protocol-documents).
const stubPort = (): ProtocolDocumentPort =>
  ({
    createDraftFile: vi.fn(),
    getDraftWopiToken: vi.fn(),
    downloadDraft: vi.fn(),
    publishFile: vi.fn(),
    uploadPublishedPdf: vi.fn(),
    downloadPublishedPdf: vi.fn(),
    deleteDraftFile: vi.fn(),
  }) as unknown as ProtocolDocumentPort

// A bare ProvisioningSubsystem stub — only `name` is read in these registry-seam
// tests (the adapter behavior is owned by the moved subsystem unit tests).
const stubSubsystem = (name: ProvisioningSubsystem['name']): ProvisioningSubsystem =>
  ({ name }) as unknown as ProvisioningSubsystem

beforeEach(() => {
  _resetRuntimeRegistryForTests()
})

describe('runtime-registry — server-init hooks', () => {
  it('runs every registered hook ONCE, in registration order', async () => {
    const calls: string[] = []
    registerServerInitHook(() => {
      calls.push('a')
    })
    registerServerInitHook(() => {
      calls.push('b')
    })
    registerServerInitHook(() => {
      calls.push('c')
    })
    await runServerInitHooks()
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('awaits async hooks before resolving (sequential)', async () => {
    const calls: string[] = []
    registerServerInitHook(async () => {
      await Promise.resolve()
      calls.push('async-1')
    })
    registerServerInitHook(() => {
      calls.push('sync-2')
    })
    await runServerInitHooks()
    expect(calls).toEqual(['async-1', 'sync-2'])
  })

  it('with no hooks registered, runServerInitHooks resolves to a no-op', async () => {
    await expect(runServerInitHooks()).resolves.toBeUndefined()
  })
})

describe('runtime-registry — tenant-evict hooks', () => {
  it('runTenantEvictHooks(tenantId) calls EVERY registered fn with that tenantId', () => {
    const f1 = vi.fn()
    const f2 = vi.fn()
    const f3 = vi.fn()
    registerTenantEvictHook(f1)
    registerTenantEvictHook(f2)
    registerTenantEvictHook(f3)

    runTenantEvictHooks('tid-x')

    for (const f of [f1, f2, f3]) {
      expect(f).toHaveBeenCalledTimes(1)
      expect(f).toHaveBeenCalledWith('tid-x')
    }
  })

  it('threads the SAME tenantId on a subsequent eviction', () => {
    const f = vi.fn()
    registerTenantEvictHook(f)
    runTenantEvictHooks('tid-a')
    runTenantEvictHooks('tid-b')
    expect(f.mock.calls).toEqual([['tid-a'], ['tid-b']])
  })

  it('with no hooks registered, runTenantEvictHooks is a no-op', () => {
    expect(() => runTenantEvictHooks('tid-none')).not.toThrow()
  })
})

describe('runtime-registry — provisioning subsystem factories', () => {
  const kc = { __kc: true } as unknown as KeycloakAdminClient

  it('builds each registered subsystem by name from its factory, passing the kc client', () => {
    const matrixFactory = vi.fn((_kc: KeycloakAdminClient) => stubSubsystem('matrix'))
    const ncFactory = vi.fn((_kc: KeycloakAdminClient) => stubSubsystem('nextcloud'))
    registerProvisioningSubsystem('matrix', matrixFactory)
    registerProvisioningSubsystem('nextcloud', ncFactory)

    const built = buildModuleProvisioningSubsystems(kc)

    expect(Object.keys(built).sort()).toEqual(['matrix', 'nextcloud'])
    // buildModuleProvisioningSubsystems returns a Partial record (only registered
    // names are present), so narrow with optional chaining before reading `name`.
    expect(built.matrix?.name).toBe('matrix')
    expect(built.nextcloud?.name).toBe('nextcloud')
    expect(matrixFactory).toHaveBeenCalledWith(kc)
    expect(ncFactory).toHaveBeenCalledWith(kc)
  })

  it('a re-registration under the same name replaces the prior factory (idempotent module re-import)', () => {
    registerProvisioningSubsystem('matrix', () => stubSubsystem('matrix'))
    const second = vi.fn(() => stubSubsystem('matrix'))
    registerProvisioningSubsystem('matrix', second)

    const built = buildModuleProvisioningSubsystems(kc)
    expect(Object.keys(built)).toEqual(['matrix'])
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('with nothing registered, buildModuleProvisioningSubsystems returns an empty record', () => {
    expect(buildModuleProvisioningSubsystems(kc)).toEqual({})
  })
})

describe('runtime-registry — request-time data providers', () => {
  it('register/get round-trips a provider per key (the SAME fn comes back, callable)', async () => {
    const eventsProvider = vi.fn(async (_range: { from: Date; to: Date }) => [
      { id: 'e1', startAt: new Date('2026-01-01T10:00:00Z'), title: 'X', location: null, committeeIds: [] },
    ])
    const unreadProvider = vi.fn(async (_token: string | null) => 7)
    registerDataProvider('calendar:upcoming-events', eventsProvider)
    registerDataProvider('messages:unread-count', unreadProvider)

    const gotEvents = getDataProvider('calendar:upcoming-events')
    const gotUnread = getDataProvider('messages:unread-count')

    // The exact registered fn is returned (not a wrapper) ...
    expect(gotEvents).toBe(eventsProvider)
    expect(gotUnread).toBe(unreadProvider)
    // ... and is callable with its typed args, threading through to the impl.
    const range = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') }
    const rows = await gotEvents!(range)
    expect(rows).toHaveLength(1)
    expect(eventsProvider).toHaveBeenCalledWith(range)
    await expect(gotUnread!(null)).resolves.toBe(7)
  })

  it('returns undefined for an unregistered key (kernel caller degrades to its empty state)', () => {
    expect(getDataProvider('finance:committee-expense-budgets')).toBeUndefined()
    expect(getDataProvider('finance:pending-approvals-count')).toBeUndefined()
  })

  it('a re-registration under the same key replaces the prior provider (idempotent module re-import)', async () => {
    registerDataProvider('finance:pending-approvals-count', async () => 1)
    const second = vi.fn(async () => 2)
    registerDataProvider('finance:pending-approvals-count', second)
    await expect(getDataProvider('finance:pending-approvals-count')!()).resolves.toBe(2)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('_resetRuntimeRegistryForTests clears the data-provider registry', () => {
    registerDataProvider('messages:unread-count', async () => 3)
    expect(getDataProvider('messages:unread-count')).toBeDefined()
    _resetRuntimeRegistryForTests()
    expect(getDataProvider('messages:unread-count')).toBeUndefined()
  })

  // boundary rule A3c S1: the finance step-up master switch (#164) is a SYNC boolean
  // provider — the settings layout reads it via getDataProvider('finance:step-up-
  // enforced')?.() ?? false, so the kernel no longer imports $lib/server/finance/
  // finance-flags. Mirrors the async providers but returns a plain boolean.
  it('round-trips a SYNC boolean provider (register returns a boolean, getDataProvider()?.() reads it)', () => {
    const flag = vi.fn((): boolean => true)
    registerDataProvider('finance:step-up-enforced', flag)
    const got = getDataProvider('finance:step-up-enforced')
    expect(got).toBe(flag)
    // Called with no args, returns the boolean synchronously (no await).
    expect(got!()).toBe(true)
    expect(flag).toHaveBeenCalledTimes(1)
  })

  it('finance:step-up-enforced is undefined when unregistered (kernel read yields ?? false)', () => {
    expect(getDataProvider('finance:step-up-enforced')).toBeUndefined()
    // The exact kernel-side degrade: an absent provider reads as `false`.
    expect(getDataProvider('finance:step-up-enforced')?.() ?? false).toBe(false)
  })
})

describe('runtime-registry — protocol document port', () => {
  // boundary rule A3a-2: the files module self-registers ONE ProtocolDocumentPort
  // (the Nextcloud document ops the protocol routes drive), so those routes no
  // longer statically import $lib/server/files. A single port, not a keyed map.
  it('register/get round-trips the registered port (the SAME impl comes back)', () => {
    const port = stubPort()
    registerProtocolDocumentPort(port)
    expect(getProtocolDocumentPort()).toBe(port)
  })

  it('returns undefined before any port is registered (kernel caller degrades)', () => {
    expect(getProtocolDocumentPort()).toBeUndefined()
  })

  it('a re-registration replaces the prior port (idempotent module re-import)', () => {
    const first = stubPort()
    const second = stubPort()
    registerProtocolDocumentPort(first)
    registerProtocolDocumentPort(second)
    expect(getProtocolDocumentPort()).toBe(second)
  })

  it('_resetRuntimeRegistryForTests clears the registered port', () => {
    registerProtocolDocumentPort(stubPort())
    expect(getProtocolDocumentPort()).toBeDefined()
    _resetRuntimeRegistryForTests()
    expect(getProtocolDocumentPort()).toBeUndefined()
  })
})

describe('runtime-registry — setup-health probes', () => {
  // boundary rule A3c S2: each module that exposes an admin client to the setup wizard
  // (messages → synapse, files → nextcloud) self-registers a named credential
  // probe here, so the /api/setup/health route no longer imports the module
  // clients ($lib/server/messages/synapse-admin, $lib/server/files/nextcloud-
  // client). A list (not a keyed map) so the route can iterate; registration order
  // is preserved for deterministic iteration.
  const probe = (service: string, ok: boolean): SetupHealthProbe => ({
    service,
    validate: vi.fn(async () => ok),
  })

  it('registerSetupHealthProbe/getSetupHealthProbes round-trips every probe, callable', async () => {
    const syn = probe('synapse', true)
    const nc = probe('nextcloud', false)
    registerSetupHealthProbe(syn)
    registerSetupHealthProbe(nc)

    const got = getSetupHealthProbes()
    expect(got).toEqual([syn, nc])
    // The exact registered probes come back, and each validate() is callable.
    await expect(got[0].validate()).resolves.toBe(true)
    await expect(got[1].validate()).resolves.toBe(false)
    expect(syn.validate).toHaveBeenCalledTimes(1)
    expect(nc.validate).toHaveBeenCalledTimes(1)
  })

  it('preserves registration order', () => {
    const a = probe('a', true)
    const b = probe('b', true)
    const c = probe('c', true)
    registerSetupHealthProbe(a)
    registerSetupHealthProbe(b)
    registerSetupHealthProbe(c)
    expect(getSetupHealthProbes().map((p) => p.service)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty list before anything is registered (route runs no module probes)', () => {
    expect(getSetupHealthProbes()).toEqual([])
  })

  it('_resetRuntimeRegistryForTests clears the setup-health probes', () => {
    registerSetupHealthProbe(probe('synapse', true))
    expect(getSetupHealthProbes()).toHaveLength(1)
    _resetRuntimeRegistryForTests()
    expect(getSetupHealthProbes()).toEqual([])
  })
})
