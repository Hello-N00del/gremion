// src/lib/server/tenant/evict-listener.test.ts
// G-XPROC (SP-4) — the cross-process tenant-eviction LISTEN subscriber.
//
// A CLI `suspend`/`delete` runs in a SEPARATE process from the long-running app
// and issues NOTIFY tenant_evict, '<tenantId>' (registry.updateTenantStatus).
// Every app process subscribes here and calls evictTenantRuntime locally on
// receipt, so a suspended/deleted tenant stops resolving FLEET-WIDE immediately
// instead of after the ~30s resolution-cache TTL. This pins the subscribe +
// dispatch contract; the real NOTIFY round-trip is proven live in the SP-4 proof.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ env: {} }))

const { listenSpy, evictSpy } = vi.hoisted(() => ({ listenSpy: vi.fn(), evictSpy: vi.fn() }))
vi.mock('./control-db', () => ({ getControlDb: () => ({ listen: listenSpy }) }))
vi.mock('./registry', () => ({ evictTenantRuntime: evictSpy, TENANT_EVICT_CHANNEL: 'tenant_evict' }))

import { startTenantEvictListener, _resetEvictListenerForTests } from './evict-listener'

beforeEach(() => {
  vi.clearAllMocks()
  _resetEvictListenerForTests()
  listenSpy.mockResolvedValue({ unlisten: vi.fn() })
})

describe('G-XPROC — tenant-evict LISTEN subscriber', () => {
  it('subscribes to the tenant_evict channel on the control DB', async () => {
    await startTenantEvictListener()
    expect(listenSpy).toHaveBeenCalledTimes(1)
    expect(listenSpy.mock.calls[0][0]).toBe('tenant_evict')
  })

  it('evicts the tenant runtime for the id in a received NOTIFY payload', async () => {
    await startTenantEvictListener()
    const onNotify = listenSpy.mock.calls[0][1] as (payload: string) => void
    onNotify('tid-xyz')
    expect(evictSpy).toHaveBeenCalledWith('tid-xyz')
  })

  it('ignores an empty/blank payload (no eviction)', async () => {
    await startTenantEvictListener()
    const onNotify = listenSpy.mock.calls[0][1] as (payload: string) => void
    onNotify('')
    onNotify('   ')
    expect(evictSpy).not.toHaveBeenCalled()
  })

  it('subscribes only ONCE even if started repeatedly (idempotent boot)', async () => {
    await startTenantEvictListener()
    await startTenantEvictListener()
    expect(listenSpy).toHaveBeenCalledTimes(1)
  })
})
