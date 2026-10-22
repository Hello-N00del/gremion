import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = { complete: true, modules: { files: true, messages: true } as Record<string, boolean>, probes: [] as unknown[] }
vi.mock('../../../hooks.server', () => ({ getBootStatus: () => ({ complete: state.complete }) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ modules: state.modules }) }))
vi.mock('$lib/server/modules/runtime-registry', () => ({ getSetupHealthProbes: () => state.probes }))
import { GET } from './+server'

const nc = (ok: boolean) => ({ service: 'nextcloud', moduleId: 'files', validate: async () => ok })
const call = async () => {
  const res = await (GET as unknown as () => Promise<Response>)()
  return { status: res.status, body: await res.json() }
}

describe('GET /api/health module outages (F7)', () => {
  beforeEach(() => { state.complete = true; state.modules = { files: true, messages: true }; state.probes = [] })
  it('enabled NC down -> 200, ok, degraded lists it', async () => {
    state.probes = [nc(false)]
    expect(await call()).toEqual({ status: 200, body: { status: 'ok', degraded: ['nextcloud'] } })
  })
  it('disabled NC down -> not listed', async () => {
    state.probes = [nc(false)]; state.modules = { files: false, messages: true }
    expect((await call()).body.degraded).toEqual([])
  })
  it('still 503 booting before boot completes', async () => {
    state.complete = false
    expect(await call()).toEqual({ status: 503, body: { status: 'booting' } })
  })
})
