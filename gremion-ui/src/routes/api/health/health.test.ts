import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { complete: true, modules: { files: true, messages: true } as Record<string, boolean>, probes: [] as unknown[] }
vi.mock('../../../hooks.server', () => ({ getBootStatus: () => ({ complete: state.complete }) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ modules: state.modules }) }))
vi.mock('$lib/server/modules/runtime-registry', () => ({ getSetupHealthProbes: () => state.probes }))
import { GET } from './+server'
import { moduleProbeCache } from '$lib/server/tenant/health'

const nc = (ok: boolean) => ({ service: 'nextcloud', moduleId: 'files', validate: async () => ok })
const call = async () => {
  const res = await (GET as unknown as () => Promise<Response>)()
  return { status: res.status, body: await res.json() }
}

describe('GET /api/health module outages (F7)', () => {
  beforeEach(() => { moduleProbeCache.clear(); vi.useRealTimers(); state.complete = true; state.modules = { files: true, messages: true }; state.probes = [] })
  it('enabled NC down -> 200, ok, degraded lists it', async () => {
    state.probes = [nc(false)]
    expect(await call()).toEqual({ status: 200, body: { status: 'ok', degraded: [{ name: 'nextcloud', errorClass: 'ModuleUnreachable', code: 'module-down' }] } })
  })
  it('disabled NC down -> not listed', async () => {
    state.probes = [nc(false)]; state.modules = { files: false, messages: true }
    expect((await call()).body.degraded).toEqual([])
  })
  it('still 503 booting before boot completes', async () => {
    state.complete = false
    expect(await call()).toEqual({ status: 503, body: { status: 'booting' } })
  })

  describe('probe result cache (public endpoint must not hammer admin APIs)', () => {
    const counted = (n: { c: number }, ok = true) => ({ service: 'nextcloud', moduleId: 'files', validate: async () => { n.c++; await Promise.resolve(); return ok } })
    it('concurrent calls share one in-flight probe', async () => {
      const n = { c: 0 }; state.probes = [counted(n)]
      await Promise.all(Array.from({ length: 10 }, () => call()))
      expect(n.c).toBe(1)
    })
    it('repeated calls within the TTL do not re-probe; after the TTL a new probe runs', async () => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const n = { c: 0 }; state.probes = [counted(n)]
      await call(); await call()
      vi.setSystemTime(new Date('2026-01-01T00:00:19Z')); await call()
      expect(n.c).toBe(1)
      vi.setSystemTime(new Date('2026-01-01T00:00:21Z')); await call()
      expect(n.c).toBe(2)
    })
    it('one probe per module, and a disabled module is never probed', async () => {
      const a = { c: 0 }, b = { c: 0 }
      state.probes = [counted(a), { service: 'matrix', moduleId: 'messages', validate: async () => { b.c++; return true } }]
      state.modules = { files: true, messages: false }
      await Promise.all([call(), call(), call()])
      expect(a.c).toBe(1); expect(b.c).toBe(0)
    })
  })
})
