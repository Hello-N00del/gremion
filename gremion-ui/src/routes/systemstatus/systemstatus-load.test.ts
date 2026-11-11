import { describe, it, expect, vi, beforeEach } from 'vitest'

// E3: the load assembles live probe results from what the app already holds: the
// tenant's own database handle and realm address, the module switches and the
// probes the files and messaging modules register. No ledger read.
const h = vi.hoisted(() => ({
  modules: { files: true, messages: true } as Record<string, boolean>,
  probes: [] as { moduleId?: string; service: string; validate: () => Promise<boolean> }[],
  fetchImpl: vi.fn(),
}))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ modules: h.modules }) }))
vi.mock('$lib/server/modules/runtime-registry', () => ({ getSetupHealthProbes: () => h.probes }))

import { load } from './+page.server'

function tenant(over: Record<string, unknown> = {}) {
  const db = vi.fn(async () => [{ '?column?': 1 }])
  return {
    slug: 'example',
    kcInternal: 'https://kc.example.org/auth/realms/example',
    db,
    ...over,
  }
}

async function run(t: unknown) {
  return (await (load as unknown as (e: unknown) => Promise<Record<string, unknown>>)({ locals: { tenant: t } })) as {
    services: { key: string; status: string }[]
    realm: string | null
    tenantActive: boolean
    modules: Record<string, boolean>
  }
}

describe('systemstatus load (E3)', () => {
  beforeEach(() => {
    h.modules = { files: true, messages: true }
    h.probes = [
      { moduleId: 'files', service: 'nextcloud', validate: async () => true },
      { moduleId: 'messages', service: 'synapse', validate: async () => true },
    ]
    h.fetchImpl.mockReset()
    h.fetchImpl.mockResolvedValue({ ok: true, json: async () => ({ issuer: 'x' }) })
    vi.stubGlobal('fetch', h.fetchImpl)
  })

  it('an active tenant with answering services loads every service as ok', async () => {
    const t = tenant()
    const d = await run(t)
    expect(d.tenantActive).toBe(true)
    expect(d.realm).toBe('example')
    expect(Object.fromEntries(d.services.map((s) => [s.key, s.status]))).toEqual({
      db: 'ok',
      keycloak: 'ok',
      nextcloud: 'ok',
      matrix: 'ok',
    })
    expect(h.fetchImpl.mock.calls[0]?.[0]).toBe('https://kc.example.org/auth/realms/example/.well-known/openid-configuration')
  })

  it('a database that rejects loads as unreachable and the load does not throw', async () => {
    const t = tenant({
      db: vi.fn(async () => {
        throw new Error('down')
      }),
    })
    const d = await run(t)
    expect(d.services.find((s) => s.key === 'db')?.status).toBe('unreachable')
  })

  it('a realm discovery answering with an error status is unreachable', async () => {
    h.fetchImpl.mockResolvedValue({ ok: false, json: async () => ({}) })
    const d = await run(tenant())
    expect(d.services.find((s) => s.key === 'keycloak')?.status).toBe('unreachable')
  })

  it('a realm discovery that throws is unreachable', async () => {
    h.fetchImpl.mockRejectedValue(new Error('refused'))
    const d = await run(tenant())
    expect(d.services.find((s) => s.key === 'keycloak')?.status).toBe('unreachable')
  })

  it('without a resolved tenant nothing is probed and no realm is invented', async () => {
    const d = await run(null)
    expect(d.tenantActive).toBe(false)
    expect(d.realm).toBeNull()
    expect(d.services).toEqual([])
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
})
