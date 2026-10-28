// @vitest-environment node
// TRD-196: the files module registers its erasure hook at server init.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ erasure: [] as { moduleId: string }[] }))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
  registerProvisioningSubsystem: vi.fn(),
  registerProtocolDocumentPort: vi.fn(),
  registerSetupHealthProbe: vi.fn(),
}))

await import('./register.server')

describe('files register.server', () => {
  it('registers the files erasure hook', async () => {
    const { filesErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([filesErasureHook])
  })
})
