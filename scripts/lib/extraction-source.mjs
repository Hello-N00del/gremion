// Frozen extraction source — THE implementation (spec B 2.4, unit
// B00-extraction-source-freeze).
//
// The module split extracts ten repositories from ONE commit of the StuRa tree.
// Spread over days, it could straddle two source states and no artefact would
// say which. So the SHA is recorded ONCE — docs/ops/extraction-source.md — the
// StuRa tree carries an annotated `extraction-source` tag at it, and every
// module.json echoes it under "extractionSource".
//
// This file exists so there is exactly ONE agreement check in the tree: spec D
// D.1.2 allows one validator, and D2's validateDistManifest in
// scripts/validate-module-schemas.mjs IMPORTS checkExtractionSourceAgreement
// from here instead of re-implementing the refusal row. One validator, one
// imported helper. scripts/check-extraction-source.mjs re-exports these names;
// a re-export is not a second implementation.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DOC_PATH = 'docs/ops/extraction-source.md'
export const SHA_RE = /^[0-9a-f]{40}$/

// scripts/lib/ -> the kernel root. Callers with no root of their own (D2's
// validator is one) get the committed record by default.
export const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

// Deliberately anchored and case-sensitive. "40 lowercase hex" is the contract
// D2's module.json schema restates; a doc that records an uppercase or
// abbreviated SHA must fail here rather than propagate a second spelling.
const CANONICAL_RE = /^extraction-source: ([0-9a-f]{40})$/gm

export function parseFrozenExtractionSource(docText) {
  const hits = [...docText.matchAll(CANONICAL_RE)]
  if (hits.length === 0)
    throw new Error(`${DOC_PATH}: no canonical line "extraction-source: <40 lowercase hex>"`)
  if (hits.length > 1)
    throw new Error(`${DOC_PATH}: ${hits.length} canonical lines — the SHA is recorded once`)
  return hits[0][1]
}

export function readFrozenExtractionSource(root = KERNEL_ROOT) {
  return parseFrozenExtractionSource(readFileSync(join(root, DOC_PATH), 'utf8'))
}
