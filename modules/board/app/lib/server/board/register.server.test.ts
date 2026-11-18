// @vitest-environment node
// TRD-196: the board module registers its erasure hook at server init, and the org-unit cascade the
// kernel asks for when it deletes an org unit (the board's own database has no cascade of its own).
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  registered: [] as { moduleId: string }[],
  providers: new Map<string, unknown>(),
}))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.registered.push(hook),
  registerDataProvider: (key: string, provider: unknown) => h.providers.set(key, provider),
}))

await import('./register.server')

describe('board register.server', () => {
  it('registers exactly the board erasure hook', async () => {
    const { boardErasureHook } = await import('./erasure')
    expect(h.registered).toEqual([boardErasureHook])
  })

  it('registers the org-unit boards cascade under the key the kernel delete asks for, and nothing else', async () => {
    const { deleteBoardsOfOrgUnit } = await import('./erasure')
    expect([...h.providers.keys()]).toEqual(['board:delete-org-unit-boards'])
    expect(h.providers.get('board:delete-org-unit-boards')).toBe(deleteBoardsOfOrgUnit)
  })

  it('declares that the board module seals no retained records (otherwise its retained step fails closed)', async () => {
    const { hasRetentionDeclaration, extractorsFor } = await import('$lib/server/module-karenz/retained/extractors')
    expect(hasRetentionDeclaration('board')).toBe(true)
    expect(extractorsFor('board')).toEqual([])
  })
})
