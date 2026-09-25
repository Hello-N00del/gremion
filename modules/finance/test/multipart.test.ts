// test/multipart.test.ts — the multipart/form-data byte-in primitive (#383 Lane E, (c)).
//
// uploadReceipt (and csvImport) receive a raw binary body the JSON-only leaf surface
// cannot parse. parseMultipart must recover EACH part's bytes EXACTLY — the pooled-
// buffer lesson: node concatenates request chunks into a pooled Buffer, so a part's
// data MUST be copied out (Buffer.from) rather than aliased, or a later write clobbers
// it and the stored receipt is silently corrupted. This test round-trips a binary
// payload and asserts exact size + byte-equality.

import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { parseMultipart, parseBoundary } from '../src/http/multipart.ts'

const CRLF = '\r\n'

/** Build a multipart/form-data body (framing symmetric with the parser). */
function buildBody(
  boundary: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>,
): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    let head = `--${boundary}${CRLF}Content-Disposition: form-data; name="${p.name}"`
    if (p.filename !== undefined) head += `; filename="${p.filename}"`
    head += CRLF
    if (p.contentType !== undefined) head += `Content-Type: ${p.contentType}${CRLF}`
    head += CRLF
    chunks.push(Buffer.from(head, 'utf8'), p.data, Buffer.from(CRLF, 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'))
  return Buffer.concat(chunks)
}

describe('http/multipart — parseBoundary', () => {
  it('extracts the boundary token from a content-type header', () => {
    expect(parseBoundary('multipart/form-data; boundary=abc123')).toBe('abc123')
  })
  it('handles a quoted boundary and trailing params', () => {
    expect(parseBoundary('multipart/form-data; boundary="a b c"; charset=utf-8')).toBe('a b c')
  })
  it('returns null when absent / not multipart', () => {
    expect(parseBoundary('application/json')).toBeNull()
    expect(parseBoundary(undefined)).toBeNull()
  })
})

describe('http/multipart — parseMultipart binary round-trip (exact size)', () => {
  const boundary = '----financeLeafBoundaryXYZ'

  it('recovers a binary file part byte-for-byte with the EXACT size', () => {
    const N = 1024 * 7 + 13 // deliberately not a round number
    const payload = randomBytes(N)
    const body = buildBody(boundary, [
      { name: 'file', filename: 'receipt.pdf', contentType: 'application/pdf', data: payload },
    ])
    const parts = parseMultipart(body, boundary)
    expect(parts).toHaveLength(1)
    const part = parts[0]!
    expect(part.name).toBe('file')
    expect(part.filename).toBe('receipt.pdf')
    expect(part.contentType).toBe('application/pdf')
    expect(part.data.length).toBe(N) // exact size
    expect(part.data.equals(payload)).toBe(true) // byte-identical
  })

  it('does not alias the pooled input buffer (defensive copy)', () => {
    const payload = randomBytes(64)
    const body = buildBody(boundary, [{ name: 'file', filename: 'a.bin', data: payload }])
    const parts = parseMultipart(body, boundary)
    // Zero the source body; the extracted part must be unaffected (was copied out).
    body.fill(0)
    expect(parts[0]!.data.equals(payload)).toBe(true)
  })

  it('preserves data that itself ends in CRLF bytes (only the framing CRLF is stripped)', () => {
    const payload = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x0d, 0x0a]) // trailing CRLFs are DATA
    const body = buildBody(boundary, [{ name: 'file', filename: 'crlf.bin', data: payload }])
    const parts = parseMultipart(body, boundary)
    expect(parts[0]!.data.length).toBe(payload.length)
    expect(parts[0]!.data.equals(payload)).toBe(true)
  })

  it('parses multiple parts (a field + a file)', () => {
    const file = randomBytes(200)
    const body = buildBody(boundary, [
      { name: 'beleg_nr', data: Buffer.from('B-42', 'utf8') },
      { name: 'file', filename: 'r.png', contentType: 'image/png', data: file },
    ])
    const parts = parseMultipart(body, boundary)
    expect(parts.map((p) => p.name)).toEqual(['beleg_nr', 'file'])
    expect(parts[0]!.data.toString('utf8')).toBe('B-42')
    expect(parts[0]!.filename).toBeUndefined()
    expect(parts[1]!.data.equals(file)).toBe(true)
  })

  it('returns [] for a body with no recognisable parts', () => {
    expect(parseMultipart(Buffer.from('not multipart at all'), boundary)).toEqual([])
  })
})
