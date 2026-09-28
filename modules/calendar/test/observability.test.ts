/**
 * Observability unit tests (mirrors services/newsletter/test/observability.test.ts).
 *
 * Proves that makeLogTracer emits a 'calendar.dispatch' JSON span and
 * noopTracer emits nothing (TRACE_EXPORTER env semantics) — the same
 * @gremion/ports/tracer contract the calendar leaf's index.ts and relay.ts
 * already rely on.
 */

import { describe, it, expect, vi } from 'vitest'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'

describe('makeLogTracer emits a JSON span (TRACE_EXPORTER=log)', () => {
  it('emits a valid-JSON calendar.dispatch span to stdout', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg) })
    try {
      const corrId = 'f3test001-f3f3-4fff-a003-000000000003'
      makeLogTracer(corrId).startSpan('calendar.dispatch', { eventId: '1', tenant: 'obs-test' }).end()
      expect(lines).toHaveLength(1)
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(parsed['name']).toBe('calendar.dispatch')
      expect(parsed['correlationId']).toBe(corrId)
      expect(typeof parsed['durMs']).toBe('number')
    } finally { spy.mockRestore() }
  })

  it('emits NO span when noopTracer is used (TRACE_EXPORTER=none)', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg) })
    try {
      noopTracer.startSpan('calendar.dispatch', { eventId: '1' }).end()
      expect(lines).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('makeLogTracer vs noopTracer matches TRACE_EXPORTER env semantics', () => {
    const corrId = 'f3sel001-f3f3-4fff-a004-000000000004'
    expect(makeLogTracer(corrId).currentCorrelationId()).toBe(corrId)
    expect(noopTracer.currentCorrelationId()).toBeNull()
  })
})
