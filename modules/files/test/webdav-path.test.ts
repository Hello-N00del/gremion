// services/files/test/webdav-path.test.ts
// Ports the sanitizeRelPath vectors from the kernel oracle
// gremion-ui/src/lib/server/files/webdav-path.test.ts. The files leaf runs
// sanitizeRelPath in a SEPARATE process (the guard is DUPLICATED, not imported), so
// these cases pin the leaf copy (src/nextcloud/webdav-path.ts) to the same contract:
// loop-decode → reject any residual `%` → reject a `..` segment → strip the leading `/`.
//
// The vectors are a shared table (input → expected | throws) rather than a
// source-parity check — the value here is exercising the leaf's own runtime, most
// importantly the #257-2 over-encoding vector (%25252e…) that a single-shot
// decodeURIComponent would slip through.
//
// validatePublishedPdfPath is DELIBERATELY not ported: the leaf omits it (published-PDF
// path validation lives only kernel-side).

import { describe, it, expect } from 'vitest'
import { buildWebdavPath, sanitizeRelPath, WebdavPathError } from '../src/nextcloud/webdav-path.ts'

interface Vector {
  name: string
  input: string
  /** The canonicalised output, or the sentinel `'throws'` for a rejected path. */
  expected: string | 'throws'
}

// The 7 kernel sanitizeRelPath cases. The pass-through case carries two assertions
// (plain + leading-slash), so it contributes two rows here.
const VECTORS: Vector[] = [
  { name: 'passes a plain relative path through unchanged', input: 'Docs/big.zip', expected: 'Docs/big.zip' },
  { name: 'strips the leading slash', input: '/Docs/big.zip', expected: 'Docs/big.zip' },
  { name: 'decodes a single-encoded traversal and rejects it', input: '%2e%2e/secret', expected: 'throws' },
  // #257-2: %25252e%25252e%25252f → decode¹ %252e%252e%252f → decode² %2e%2e%2f →
  // decode³ ../ — a single decodeURIComponent stops at %2e%2e%2f (no `..` yet) and
  // would let this through; the loop-decode is what catches it.
  { name: 'rejects an OVER-encoded traversal a one-shot decode would miss (#257-2)', input: '%25252e%25252e%25252fetc/passwd', expected: 'throws' },
  // %2525 → %25 → % : a lone % is not a valid escape — refused, not guessed.
  { name: 'rejects an encoding that decodes down to a bare malformed percent', input: 'a/%2525', expected: 'throws' },
  { name: 'rejects a malformed percent-escape rather than guessing', input: 'a/%zz', expected: 'throws' },
  // %2541 → %41 → A: legitimate, fully decodable, no residual `..` or `%`.
  { name: 'fully resolves benign multi-encoded segments', input: 'a/%2541.txt', expected: 'a/A.txt' },
  { name: 'rejects a literal `..` segment', input: '../../etc/passwd', expected: 'throws' },
]

describe('sanitizeRelPath (files leaf) — #257-2 loop-decode + residual-% reject', () => {
  for (const v of VECTORS) {
    it(v.name, () => {
      if (v.expected === 'throws') {
        expect(() => sanitizeRelPath(v.input)).toThrow(WebdavPathError)
      } else {
        expect(sanitizeRelPath(v.input)).toBe(v.expected)
      }
    })
  }

  // Mirrors the kernel copy: fetch's URL parser treats a backslash as `/` and deletes
  // tab and newline, so each of these becomes a `..` segment only after the `..` check.
  it('rejects a backslash, a raw or encoded tab or newline, and any other control character', () => {
    const BS = String.fromCharCode(92)
    for (const p of [`..${BS}x`, `a${BS}b`, '.\n./x', '.%0a./x', '%2e%09%2e/x', 'a\u0000b', 'a\u007fb', 'a%250ab']) {
      expect(() => sanitizeRelPath(p), JSON.stringify(p)).toThrow(WebdavPathError)
    }
  })
})

// A segment that fetch's URL parser reduces to `.` or `..`: the query or fragment cut-off
// (`..?x`, `..#x`) and surrounding whitespace (`.. `) all leave a dot segment that climbs out
// of /remote.php/dav/files/<caller>/. The three copies of this guard (kernel app, files leaf,
// finance leaf) must agree on every vector below.
describe('sanitizeRelPath (files leaf) — dot segments hidden behind ?, # or whitespace', () => {
  const REFUSED = ['..?x', '..#x', '.. ', ' ..', '.?x', '. #y', 'a/..?x/b', 'a/..#/b', '%2e%2e%3fx', '%2e%2e%23x', '..%20', '. ', 'a/./b']
  for (const p of REFUSED) {
    it(`refuses ${JSON.stringify(p)}`, () => {
      expect(() => sanitizeRelPath(p)).toThrow(WebdavPathError)
    })
  }

  it('keeps a ? or # inside an ordinary name, and buildWebdavPath percent-encodes it', () => {
    expect(sanitizeRelPath('a?b/c#d.txt')).toBe('a?b/c#d.txt')
    expect(sanitizeRelPath('..a/b..')).toBe('..a/b..')
    expect(buildWebdavPath('stura', 'a?b/c#d e.txt')).toBe('/remote.php/dav/files/stura/a%3Fb/c%23d%20e.txt')
  })
})
