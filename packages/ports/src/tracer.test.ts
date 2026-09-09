// packages/ports/src/tracer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { noopTracer, newCorrelationId, CORRELATION_HEADER } from './tracer'

describe('tracer port', () => {
  it('exposes the canonical header name', () => {
    expect(CORRELATION_HEADER).toBe('x-correlation-id')
  })
  it('newCorrelationId yields unique uuids', () => {
    expect(newCorrelationId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(newCorrelationId()).not.toBe(newCorrelationId())
  })
  it('noopTracer spans are inert and never throw', () => {
    const span = noopTracer.startSpan('op', { any: 'attr' })
    expect(() => { span.setAttribute('k', 'v'); span.end() }).not.toThrow()
    expect(() => noopTracer.startSpan('op2').end(new Error('boom'))).not.toThrow()
    expect(noopTracer.currentCorrelationId()).toBeNull()
  })
})

// ── logTracer (D-P1-8) tests ───────────────────────────────────────────────────
// TDD RED→GREEN: written BEFORE the implementation lands.
// makeLogTracer(correlationId) → TracerPort whose startSpan().end() emits
// one valid-JSON line to console.log with {name, durMs, correlationId}.

describe('logTracer (D-P1-8)', () => {
  const lines: string[] = []
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    lines.length = 0
    spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      lines.push(msg)
    })
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it('emits exactly ONE valid-JSON line per span with {name, durMs, correlationId}', async () => {
    const { makeLogTracer } = await import('./tracer')
    const tracer = makeLogTracer('corr-uuid-001')

    const span = tracer.startSpan('test.op', { foo: 'bar' })
    span.end()

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['name']).toBe('test.op')
    expect(typeof parsed['durMs']).toBe('number')
    expect(parsed['durMs']).toBeGreaterThanOrEqual(0)
    expect(parsed['correlationId']).toBe('corr-uuid-001')
  })

  it('durMs reflects elapsed time (at least 0 ms)', async () => {
    const { makeLogTracer } = await import('./tracer')
    const tracer = makeLogTracer('corr-timing')
    const span = tracer.startSpan('timing.op')
    await new Promise((r) => setTimeout(r, 5))
    span.end()

    const parsed = JSON.parse(lines[0]!) as { durMs: number }
    expect(parsed.durMs).toBeGreaterThanOrEqual(0)
  })

  it('currentCorrelationId returns the id the tracer was created with', async () => {
    const { makeLogTracer } = await import('./tracer')
    const tracer = makeLogTracer('corr-abc-123')
    expect(tracer.currentCorrelationId()).toBe('corr-abc-123')
  })

  it('span error is captured in the JSON line', async () => {
    const { makeLogTracer } = await import('./tracer')
    const tracer = makeLogTracer('corr-err')
    const span = tracer.startSpan('err.op')
    span.end(new Error('boom'))

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as { error?: string }
    expect(parsed['error']).toBe('boom')
  })

  it('attributes set via setAttribute appear in the emitted JSON', async () => {
    const { makeLogTracer } = await import('./tracer')
    const tracer = makeLogTracer('corr-attrs')
    const span = tracer.startSpan('attr.op')
    span.setAttribute('key1', 'value1')
    span.setAttribute('count', 42)
    span.end()

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed['key1']).toBe('value1')
    expect(parsed['count']).toBe(42)
  })
})

// ── readOrMintCorrelationId tests ──────────────────────────────────────────────
// Propagation-point 1 helper: read-or-mint (rule 5 — never trust client id for auth).

describe('readOrMintCorrelationId', () => {
  it('returns the header value when it is a valid UUID', async () => {
    const { readOrMintCorrelationId } = await import('./tracer')
    const validUuid = '550e8400-e29b-41d4-a716-446655440000'
    expect(readOrMintCorrelationId(validUuid)).toBe(validUuid)
  })

  it('mints a fresh UUID when header is absent (null)', async () => {
    const { readOrMintCorrelationId } = await import('./tracer')
    expect(readOrMintCorrelationId(null)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('mints a fresh UUID when header is absent (undefined)', async () => {
    const { readOrMintCorrelationId } = await import('./tracer')
    expect(readOrMintCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('mints a fresh UUID when header is empty string', async () => {
    const { readOrMintCorrelationId } = await import('./tracer')
    expect(readOrMintCorrelationId('')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('mints a fresh UUID when header is garbage (non-UUID grammar)', async () => {
    const { readOrMintCorrelationId } = await import('./tracer')
    const result = readOrMintCorrelationId('garbage-not-a-uuid')
    expect(result).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).not.toBe('garbage-not-a-uuid')
  })

  it('mints a fresh UUID when header is oversized (> 36 chars)', async () => {
    const { readOrMintCorrelationId } = await import('./tracer')
    const oversized = '550e8400-e29b-41d4-a716-446655440000-EXTRA-STUFF'
    const result = readOrMintCorrelationId(oversized)
    expect(result).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).not.toBe(oversized)
  })

  // F5: upper-case UUID is accepted but normalized to lower-case (canonical RFC-4122).
  it('normalizes an upper-case UUID to lower-case (F5)', async () => {
    const { readOrMintCorrelationId } = await import('./tracer')
    const upper = '550E8400-E29B-41D4-A716-446655440000'
    const result = readOrMintCorrelationId(upper)
    expect(result).toBe('550e8400-e29b-41d4-a716-446655440000')
  })
})
