// @vitest-environment node
// TRD-196: the elections module registers its erasure hook at server init (next to
// its tenant-evict hook).
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ erasure: [] as { moduleId: string }[], evict: [] as unknown[] }))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
  registerTenantEvictHook: (fn: unknown) => h.evict.push(fn),
}))
vi.mock('./helios-client', () => ({ evictHeliosSession: vi.fn() }))

await import('./register.server')

describe('elections register.server', () => {
  it('registers the elections erasure hook and keeps the evict hook', async () => {
    const { electionsErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([electionsErasureHook])
    expect(h.evict).toHaveLength(1)
  })
})
