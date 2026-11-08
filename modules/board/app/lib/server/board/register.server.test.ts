// @vitest-environment node
// TRD-196: the board module registers its erasure hook at server init.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ registered: [] as { moduleId: string }[] }))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.registered.push(hook),
}))

await import('./register.server')

describe('board register.server', () => {
  it('registers exactly the board erasure hook', async () => {
    const { boardErasureHook } = await import('./erasure')
    expect(h.registered).toEqual([boardErasureHook])
  })

  it('declares that the board module seals no retained records (otherwise its retained step fails closed)', async () => {
    const { hasRetentionDeclaration, extractorsFor } = await import('$lib/server/module-karenz/retained/extractors')
    expect(hasRetentionDeclaration('board')).toBe(true)
    expect(extractorsFor('board')).toEqual([])
  })
})
