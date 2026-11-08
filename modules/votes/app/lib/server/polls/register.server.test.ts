// @vitest-environment node
// TRD-196: the votes module registers its erasure hook at server init.
// Module Karenz (phase 2, Task 13): and its Karenz participant, its poll-results extractor and its
// deletion preview provider.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  erasure: [] as { moduleId: string }[],
  participants: [] as unknown[],
  extractors: [] as unknown[],
  previews: [] as Array<[string, unknown]>,
}))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
}))
vi.mock('$lib/server/module-karenz/participants', async (orig) => ({
  ...(await orig<typeof import('$lib/server/module-karenz/participants')>()),
  registerKarenzParticipant: (p: unknown) => h.participants.push(p),
}))
vi.mock('$lib/server/module-karenz/retained/extractors', async (orig) => ({
  ...(await orig<typeof import('$lib/server/module-karenz/retained/extractors')>()),
  registerRetentionExtractor: (e: unknown) => h.extractors.push(e),
}))
vi.mock('$lib/server/module-switch/preview', () => ({
  registerDeletionPreviewProvider: (id: string, p: unknown) => h.previews.push([id, p]),
}))

await import('./register.server')

describe('votes register.server', () => {
  it('registers the votes erasure hook', async () => {
    const { votesErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([votesErasureHook])
  })

  it('registers the Karenz participant, the poll-results extractor and the deletion preview', async () => {
    const { votesKarenz, votesDeletionPreview } = await import('./karenz')
    const { pollResultsExtractor } = await import('./retained')
    expect(h.participants).toEqual([votesKarenz])
    expect(h.extractors).toEqual([pollResultsExtractor])
    expect(h.previews).toEqual([['votes', votesDeletionPreview]])
  })
})
