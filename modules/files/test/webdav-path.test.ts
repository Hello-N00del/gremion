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
import { sanitizeRelPath, WebdavPathError } from '../src/nextcloud/webdav-path.ts'

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
})
