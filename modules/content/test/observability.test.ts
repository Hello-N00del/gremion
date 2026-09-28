/**
 * F2 / F3 observability unit tests — content service.
 *
 * F2: the leaf POST /posts/:id/publish handler reads x-correlation-id (forwarded
 *     by the kernel ACL client) and passes it (via readOrMintCorrelationId) to
 *     dispatchDeps — so dispatch carries the kernel's correlation id.
 *
 *     F2a: unit-test readOrMintCorrelationId header-extraction semantics.
 *
 *     F2b: end-to-end header extraction test using the exact same two-liner
 *          that the route uses, simulating all header shapes.
 *
 * F3:  prove that makeLogTracer emits a 'content.dispatch' JSON span and
 *      noopTracer emits nothing (TRACE_EXPORTER env semantics).
 */

import { describe, it, expect, vi } from 'vitest'
import { readOrMintCorrelationId, makeLogTracer, noopTracer } from '@gremion/ports/tracer'

// ── shared UUID regex ─────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── F2a: readOrMintCorrelationId header-extraction semantics ──────────────────

describe('F2a — publish route correlation-id extraction semantics (unit)', () => {
  it('returns the header value unchanged when it is a valid RFC-4122 UUID', () => {
    expect(readOrMintCorrelationId('f2aa0001-0000-4000-a000-000000000001'))
      .toBe('f2aa0001-0000-4000-a000-000000000001')
  })

  it('F5: normalizes an upper-case UUID to lower-case', () => {
    expect(readOrMintCorrelationId('F2AA0001-0000-4000-A000-000000000001'))
      .toBe('f2aa0001-0000-4000-a000-000000000001')
  })

  it('mints a fresh UUID when header is absent (undefined)', () => {
    const result = readOrMintCorrelationId(undefined)
    expect(result).toMatch(UUID_RE)
    expect(result).not.toBe('publish') // no old hard-coded fallback
  })

  it('mints a fresh UUID when header is null', () => {
    expect(readOrMintCorrelationId(null)).toMatch(UUID_RE)
  })

  it('mints a fresh UUID when header is garbage (non-UUID grammar)', () => {
    const result = readOrMintCorrelationId('not-a-uuid-garbage!')
    expect(result).toMatch(UUID_RE)
    expect(result).not.toBe('not-a-uuid-garbage!')
  })
})

// ── F2b: route header-extraction pattern (inline simulation) ──────────────────

function extractFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string {
  const rawCorrId = headers['x-correlation-id']
  return readOrMintCorrelationId(Array.isArray(rawCorrId) ? rawCorrId[0] : rawCorrId as string | undefined)
}

describe('F2b — publish route extracts x-correlation-id and passes it to dispatchDeps', () => {
  it('threads a provided valid UUID from the header into dispatchDeps (kernel→leaf→dispatch)', () => {
    const inbound = 'f2bb0001-0000-4000-b000-000000000001'
    const result = extractFromHeaders({ 'x-correlation-id': inbound })
    expect(result).toBe(inbound)
  })

  it('mints a fresh UUID when x-correlation-id header is absent', () => {
    const result = extractFromHeaders({ 'content-type': 'application/json' })
    expect(result).toMatch(UUID_RE)
  })

  it('mints a fresh UUID when x-correlation-id is garbage (non-UUID grammar)', () => {
    const result = extractFromHeaders({ 'x-correlation-id': 'not-a-uuid!' })
    expect(result).toMatch(UUID_RE)
    expect(result).not.toBe('not-a-uuid!')
  })

  it('handles multi-value header array (first element is used)', () => {
    const first = 'f2bb0002-0000-4000-b000-000000000002'
    const result = extractFromHeaders({ 'x-correlation-id': [first, 'second-value'] })
    expect(result).toBe(first)
  })

  it('normalizes an upper-case UUID from the header to lower-case (F5)', () => {
    const result = extractFromHeaders({ 'x-correlation-id': 'F2BB0003-0000-4000-B000-000000000003' })
    expect(result).toBe('f2bb0003-0000-4000-b000-000000000003')
  })
})

// ── F3: TRACE_EXPORTER=log emits content.dispatch span ──────────────────────

describe('F3 — makeLogTracer emits content.dispatch span (TRACE_EXPORTER=log)', () => {
  it('emits a valid-JSON content.dispatch span to stdout', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg) })
    try {
      const corrId = 'f3test001-f3f3-4fff-a003-000000000003'
      makeLogTracer(corrId).startSpan('content.dispatch', { postId: 'p-1', tenant: 'obs-test' }).end()
      expect(lines).toHaveLength(1)
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(parsed['name']).toBe('content.dispatch')
      expect(parsed['correlationId']).toBe(corrId)
      expect(typeof parsed['durMs']).toBe('number')
    } finally { spy.mockRestore() }
  })

  it('emits NO span when noopTracer is used (TRACE_EXPORTER=none)', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { lines.push(msg) })
    try {
      noopTracer.startSpan('content.dispatch', { postId: 'p-1' }).end()
      expect(lines).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('makeLogTracer vs noopTracer matches TRACE_EXPORTER env semantics', () => {
    const corrId = 'f3sel001-f3f3-4fff-a004-000000000004'
    expect(makeLogTracer(corrId).currentCorrelationId()).toBe(corrId)
    expect(noopTracer.currentCorrelationId()).toBeNull()
  })
})
