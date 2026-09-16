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
// D.1.2 allows one validator, and D2-module-json-and-dist-schema's
// validateDistManifest IMPORTS checkExtractionSourceAgreement from here
// instead of re-implementing the refusal row. One validator, one imported
// helper. scripts/check-extraction-source.mjs re-exports these names; a
// re-export is not a second implementation.
//
// D2 MUST RECONCILE THE VALIDATOR'S PATH BEFORE IT DECIDES WHERE IT LIVES.
// The two authorities disagree and neither the plan's cross-unit contract
// table nor anything in this repo adjudicates:
//   - the B00 unit file names scripts/validate-module-schemas.mjs;
//   - the plan's decision record for this exact question names
//     scripts/lib/gremion-manifest-schema.mjs.
// Nothing here depends on which wins — this module is imported by path, not
// by its importer's name — but D2 checks spec D D.1.2's "exactly one
// validator" against a file, and checking it against the wrong file would
// pass while a second implementation sat in the other one.

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

/**
 * Absent, malformed, or not equal to the frozen SHA — and the explicit pairwise
 * report. `manifests` is a list of
 * { id, path, extractionSource, parseError, missing?, readError? }:
 * collectModuleJson produces it from disk, and D2's validateDistManifest maps
 * each module.json it is validating onto the same shape. The second argument is
 * optional so the one-argument form `checkExtractionSourceAgreement(manifests)`
 * — the form D2 calls, having no kernel root of its own — reads the committed
 * record in DOC_PATH.
 */
export function checkExtractionSourceAgreement(manifests, frozen = readFrozenExtractionSource()) {
  const problems = []
  const seen = new Map() // sha -> first module.json that carried it
  for (const e of manifests) {
    // A module directory the collector could not stat, and a module directory
    // that carries NO module.json, are both refusals — never skips. "The
    // extraction wrote no manifest" is the strongest form of the straddle this
    // contract exists to refuse: nothing in that module echoes the frozen
    // source, so nothing downstream would notice it came from another commit.
    if (e.readError) {
      problems.push(`${e.path}: unreadable — ${e.readError}`)
      continue
    }
    if (e.missing) {
      problems.push(
        `${e.id}/: no module.json — the extraction wrote no manifest, so nothing in that module echoes the frozen source ${frozen}`
      )
      continue
    }
    if (e.parseError) {
      problems.push(`${e.path}: not parseable JSON — ${e.parseError}`)
      continue
    }
    const v = e.extractionSource
    if (v === undefined) {
      problems.push(`${e.path}: extractionSource absent`)
      continue
    }
    if (typeof v !== 'string' || !SHA_RE.test(v)) {
      problems.push(`${e.path}: extractionSource ${JSON.stringify(v)} is not 40 lowercase hex`)
      continue
    }
    if (v !== frozen)
      problems.push(
        `${e.path}: extractionSource ${v} disagrees with the frozen source ${frozen} recorded in ${DOC_PATH}`
      )
    if (!seen.has(v)) seen.set(v, e.path)
  }
  if (seen.size > 1) {
    const [[a, pa], [b, pb]] = [...seen.entries()].slice(0, 2)
    problems.push(`two module.json disagree on extractionSource: ${pa} says ${a}, ${pb} says ${b}`)
  }
  return problems
}
