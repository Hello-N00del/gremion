// @vitest-environment node
// TRD-196: the publishing module registers its erasure hook next to its audit
// consumer start-up hook.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ erasure: [] as { moduleId: string }[], init: [] as unknown[] }))
vi.mock('$lib/server/modules/runtime-registry', () => ({
  registerErasureHook: (hook: { moduleId: string }) => h.erasure.push(hook),
  registerServerInitHook: (fn: unknown) => h.init.push(fn),
}))
vi.mock('$lib/server/ports/tracer', () => ({ makeLogTracer: vi.fn(), noopTracer: {} }))
vi.mock('$lib/server/env/platform-env', () => ({ platformEnv: vi.fn() }))
vi.mock('$lib/server/events/newsletter-audit-consumer', () => ({
  startNewsletterAuditConsumer: vi.fn(),
  NEWSLETTER_AUDIT_WORKER: 'newsletter-audit',
}))
vi.mock('$lib/server/events/consumer-state', () => ({ superviseWorker: vi.fn(), markWorkerOff: vi.fn() }))

await import('./register.server')

describe('publishing register.server', () => {
  it('registers the publishing erasure hook and keeps the audit start-up hook', async () => {
    const { publishingErasureHook } = await import('./erasure')
    expect(h.erasure).toEqual([publishingErasureHook])
    expect(h.init).toHaveLength(1)
  })
})
