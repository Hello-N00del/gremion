// @vitest-environment node
// TRD-196: the elections module registers its erasure hook at server init (next to
// its tenant-evict hook).
// Module Karenz (phase 2, Task 14): and its Karenz participant, its election-results extractor and, while
// Helios offers no pause, the switch-off guard.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  erasure: [] as { moduleId: string }[],
  evict: [] as unknown[],
  participants: [] as unknown[],
  extractors: [] as unknown[],
  guards: [] as Array<[string, unknown]>,
}))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
  registerTenantEvictHook: (fn: unknown) => h.evict.push(fn),
}))
vi.mock('$lib/server/module-karenz/participants', async (orig) => ({
  ...(await orig<typeof import('$lib/server/module-karenz/participants')>()),
  registerKarenzParticipant: (p: unknown) => h.participants.push(p),
}))
vi.mock('$lib/server/module-karenz/retained/extractors', async (orig) => ({
  ...(await orig<typeof import('$lib/server/module-karenz/retained/extractors')>()),
  registerRetentionExtractor: (e: unknown) => h.extractors.push(e),
}))
vi.mock('$lib/server/module-switch/guards', () => ({
  registerSwitchOffGuard: (id: string, g: unknown) => h.guards.push([id, g]),
}))
vi.mock('./helios-client', async (orig) => ({ ...(await orig<typeof import('./helios-client')>()), evictHeliosSession: vi.fn() }))
vi.mock('./election-db', () => ({ ElectionDb: {} }))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: vi.fn() }))

await import('./register.server')

describe('elections register.server', () => {
  it('registers the elections erasure hook and keeps the evict hook', async () => {
    const { electionsErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([electionsErasureHook])
    expect(h.evict).toHaveLength(1)
  })

  it('registers the Karenz participant and the election-results extractor', async () => {
    const { electionsKarenz, electionResultsExtractor } = await import('./karenz')
    expect(h.participants).toEqual([electionsKarenz])
    expect(h.extractors).toEqual([electionResultsExtractor])
  })

  it('registers the switch-off guard while the pause port is unsupported', async () => {
    const { electionsSwitchOffGuard } = await import('./karenz')
    const { heliosPause } = await import('./helios-pause')
    expect(heliosPause().mode).toBe('unsupported')
    expect(h.guards).toEqual([['elections', electionsSwitchOffGuard]])
  })
})
