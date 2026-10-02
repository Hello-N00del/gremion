import { describe, it, expect } from 'vitest'
import { sanitizeRelPath, validatePublishedPdfPath } from './webdav-path'

describe('sanitizeRelPath (#257-2 loop-decode + residual-% reject)', () => {
  it('passes a plain relative path through unchanged (sans leading slash)', () => {
    expect(sanitizeRelPath('Docs/big.zip')).toBe('Docs/big.zip')
    expect(sanitizeRelPath('/Docs/big.zip')).toBe('Docs/big.zip')
  })

  it('decodes a single-encoded traversal and rejects it', () => {
    expect(() => sanitizeRelPath('%2e%2e/secret')).toThrow()
  })

  it('rejects an OVER-encoded traversal that a one-shot decode would miss', () => {
    // %25252e%25252e%25252f → decode¹ %252e%252e%252f → decode² %2e%2e%2f →
    // decode³ ../  — a single decodeURIComponent would stop at %2e%2e%2f (no ..)
    expect(() => sanitizeRelPath('%25252e%25252e%25252fetc/passwd')).toThrow()
  })

  it('rejects an encoding that decodes down to a bare malformed percent', () => {
    // %2525 → %25 → % (a lone % is not a valid escape) — refused, not guessed.
    expect(() => sanitizeRelPath('a/%2525')).toThrow()
  })

  it('rejects a malformed percent-escape rather than guessing', () => {
    expect(() => sanitizeRelPath('a/%zz')).toThrow()
  })

  it('fully resolves benign multi-encoded segments (no residual escape, no traversal)', () => {
    // %2541 → %41 → A: legitimate, fully decodable, contains no `..` or `%`.
    expect(sanitizeRelPath('a/%2541.txt')).toBe('a/A.txt')
  })

  it('rejects a literal `..` segment', () => {
    expect(() => sanitizeRelPath('../../etc/passwd')).toThrow()
  })
})

describe('validatePublishedPdfPath (#241)', () => {
  const good = '/protocols/published/11111111-1111-4111-8111-111111111111/protocol.pdf'

  it('accepts a well-formed published-protocol PDF path unchanged', () => {
    expect(validatePublishedPdfPath(good)).toBe(good)
  })

  it('rejects a path outside the /protocols/published/ prefix (allowlist)', () => {
    expect(() => validatePublishedPdfPath('/admin-only/secret.pdf')).toThrow()
    expect(() => validatePublishedPdfPath('/protocols/drafts/x/protocol.pdf')).toThrow()
  })

  it('rejects a .. traversal segment', () => {
    expect(() => validatePublishedPdfPath('/protocols/published/../../etc/passwd')).toThrow()
  })

  it('rejects a raw percent so an encoded traversal cannot be decoded into ..', () => {
    expect(() => validatePublishedPdfPath('/protocols/published/%2e%2e/x.pdf')).toThrow()
  })
})
