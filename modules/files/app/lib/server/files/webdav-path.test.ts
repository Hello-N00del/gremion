import { describe, it, expect } from 'vitest'
import { buildWebdavPath, sanitizeRelPath, validatePublishedPdfPath } from './webdav-path'

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

  // fetch's URL parser treats a backslash as `/` and DELETES tab and newline, so each of these
  // becomes a `..` segment only after the `..` check (pilot wave 2 isolation evidence).
  it('rejects a backslash, a raw or encoded tab or newline, and any other control character', () => {
    const BS = String.fromCharCode(92)
    for (const p of [`..${BS}x`, `a${BS}b`, '.\n./x', '.%0a./x', '%2e%09%2e/x', 'a\u0000b', 'a\u007fb', 'a%250ab']) {
      expect(() => sanitizeRelPath(p), JSON.stringify(p)).toThrow()
    }
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

  // fetch's URL parser reads a backslash as `/` and deletes tab and newline, so
  // each of these becomes a `..` segment only after the `..` check.
  it('rejects a backslash and control characters (they normalise into a .. segment)', () => {
    const BS = String.fromCharCode(92)
    for (const p of [`/protocols/published/..${BS}x.pdf`, '/protocols/published/.\n./x.pdf', '/protocols/published/.\t./x.pdf', '/protocols/published/a\u0000b.pdf']) {
      expect(() => validatePublishedPdfPath(p), JSON.stringify(p)).toThrow()
    }
  })

  it('rejects a dot segment hidden behind ?, # or whitespace', () => {
    for (const s of ['..?x', '..#x', '.. ', '.?x']) {
      const p = `/protocols/published/${s}/x.pdf`
      expect(() => validatePublishedPdfPath(p), JSON.stringify(p)).toThrow()
    }
  })
})

// A segment that fetch's URL parser reduces to `.` or `..`: the query or fragment cut-off
// (`..?x`, `..#x`) and surrounding whitespace (`.. `) all leave a dot segment that climbs out
// of /remote.php/dav/files/<caller>/. The three copies of this guard (kernel app, files leaf,
// finance leaf) must agree on every vector below.
describe('sanitizeRelPath — dot segments hidden behind ?, # or whitespace', () => {
  const REFUSED = ['..?x', '..#x', '.. ', ' ..', '.?x', '. #y', 'a/..?x/b', 'a/..#/b', '%2e%2e%3fx', '%2e%2e%23x', '..%20', '. ', 'a/./b']
  for (const p of REFUSED) {
    it(`refuses ${JSON.stringify(p)}`, () => {
      expect(() => sanitizeRelPath(p)).toThrow()
    })
  }

  it('keeps a ? or # inside an ordinary name, and buildWebdavPath percent-encodes it', () => {
    expect(sanitizeRelPath('a?b/c#d.txt')).toBe('a?b/c#d.txt')
    expect(sanitizeRelPath('..a/b..')).toBe('..a/b..')
    expect(buildWebdavPath('stura', 'a?b/c#d e.txt')).toBe('/remote.php/dav/files/stura/a%3Fb/c%23d%20e.txt')
  })
})
