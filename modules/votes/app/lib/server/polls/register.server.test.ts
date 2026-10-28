// @vitest-environment node
// TRD-196: the votes module registers its erasure hook at server init.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ erasure: [] as { moduleId: string }[] }))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
}))

await import('./register.server')

describe('votes register.server', () => {
  it('registers the votes erasure hook', async () => {
    const { votesErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([votesErasureHook])
  })
})
