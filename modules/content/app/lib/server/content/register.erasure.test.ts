// @vitest-environment node
// TRD-196: the content module registers its erasure hook (CONTENT_BACKEND does not
// gate it: the hook itself reports skipped under the service backend).
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ erasure: [] as { moduleId: string }[] }))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
  registerServerInitHook: vi.fn(),
}))
vi.mock('$lib/server/tenant/worker-fleet', () => ({ forEachActiveTenant: vi.fn() }))
vi.mock('./instagram/drain', () => ({ drainInstagramPublishOps: vi.fn() }))
vi.mock('./worker', () => ({ drainScheduledPublishes: vi.fn() }))
vi.mock('$lib/server/ports/tracer', () => ({ makeLogTracer: vi.fn(), noopTracer: {} }))
vi.mock('$lib/server/env/platform-env', () => ({ platformEnv: vi.fn() }))
vi.mock('$lib/server/events/content-audit-consumer', () => ({
  startContentAuditConsumer: vi.fn(),
  CONTENT_AUDIT_WORKER: 'content-audit',
}))
vi.mock('$lib/server/events/consumer-state', () => ({ superviseWorker: vi.fn(), markWorkerOff: vi.fn() }))

await import('./register.server')

describe('content register.server (erasure)', () => {
  it('registers the content erasure hook', async () => {
    const { contentErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([contentErasureHook])
  })
})
