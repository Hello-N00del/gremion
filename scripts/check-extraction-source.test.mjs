#!/usr/bin/env node
// node --test suite for the frozen extraction-source guard
// (spec B 2.4, unit B00-extraction-source-freeze).
//
// Same idiom as scripts/check-cve-floors.test.mjs: assert POST-CONDITIONS on
// real file content, never an exit code. Every helper is exercised against the
// REAL committed state (must be clean) and against a synthetic broken state
// (must produce a problem) — a guard that cannot be shown failing is not a guard.
//
// The helpers are imported through scripts/check-extraction-source.mjs, which
// re-exports scripts/lib/extraction-source.mjs. The lib is the single
// implementation D2's validateDistManifest imports; the re-export is not a
// second one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOC_PATH,
  SHA_RE,
  parseFrozenExtractionSource,
  readFrozenExtractionSource,
} from './check-extraction-source.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FROZEN = 'f276af5925abacdcfd05f6613fc11afff2d804c5'
const OTHER = '0123456789abcdef0123456789abcdef01234567'

test('the committed kernel doc records the frozen extraction source', () => {
  assert.equal(readFrozenExtractionSource(ROOT), FROZEN)
  assert.match(readFrozenExtractionSource(ROOT), SHA_RE)
})

test('DOC_PATH is the one place the SHA is recorded', () => {
  assert.equal(DOC_PATH, 'docs/ops/extraction-source.md')
})

test('the parser reads the canonical line', () => {
  assert.equal(
    parseFrozenExtractionSource(`# heading\n\nextraction-source: ${FROZEN}\n\ntrailing prose\n`),
    FROZEN
  )
})

test('the parser refuses a doc with no canonical line', () => {
  assert.throws(
    () => parseFrozenExtractionSource(`# heading\n\nfrozen at ${FROZEN}\n`),
    /no canonical line/
  )
})

test('the parser refuses a doc that records the SHA twice — "recorded once" is the contract', () => {
  assert.throws(
    () => parseFrozenExtractionSource(`extraction-source: ${FROZEN}\nextraction-source: ${OTHER}\n`),
    /2 canonical lines/
  )
})

test('the parser refuses an uppercase or short SHA', () => {
  assert.throws(
    () => parseFrozenExtractionSource(`extraction-source: ${FROZEN.toUpperCase()}\n`),
    /no canonical line/
  )
  assert.throws(
    () => parseFrozenExtractionSource(`extraction-source: ${FROZEN.slice(0, 12)}\n`),
    /no canonical line/
  )
})
