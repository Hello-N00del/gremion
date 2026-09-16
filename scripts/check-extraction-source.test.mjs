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
  collectModuleJson,
  checkExtractionSourceAgreement,
  checkVacuity,
  runChecks,
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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const FIXTURES = join(ROOT, 'test/fixtures/extraction-source/agree')

function scratchModules(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'b00-modules-'))
  for (const [id, body] of Object.entries(spec)) {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(
      join(dir, id, 'module.json'),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    )
  }
  return dir
}

test('the committed fixture pair agrees with the frozen source', () => {
  const entries = collectModuleJson(FIXTURES)
  assert.equal(entries.length, 2, 'fixture must carry two module.json, or the RED case is untestable')
  assert.deepEqual(entries.map((e) => e.id), ['calendar', 'users'])
  assert.deepEqual(checkExtractionSourceAgreement(entries, FROZEN), [])
})

test('checkExtractionSourceAgreement(manifests) defaults to the kernel doc — the form D2 calls', () => {
  // Spec D D.1.2: exactly one validator. D2's validateDistManifest in
  // scripts/validate-module-schemas.mjs imports THIS function and has no root
  // of its own to pass, so the one-argument form must read DOC_PATH itself.
  // The entry shape below is what D2 maps each module.json it validates onto.
  assert.deepEqual(checkExtractionSourceAgreement(collectModuleJson(FIXTURES)), [])
  const bad = [{ id: 'x', path: 'x/module.json', extractionSource: OTHER, parseError: null }]
  assert.match(
    checkExtractionSourceAgreement(bad).join('\n'),
    /disagrees with the frozen source f276af5925abacdcfd05f6613fc11afff2d804c5/
  )
})

test('checkExtractionSourceAgreement goes RED when one module.json carries a different SHA', (t) => {
  const dir = scratchModules({
    users: { schemaVersion: 1, id: 'users', extractionSource: FROZEN },
    calendar: { schemaVersion: 1, id: 'calendar', extractionSource: OTHER },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const problems = checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN)
  assert.ok(problems.length >= 2, problems.join('\n'))
  assert.match(problems.join('\n'), /calendar\/module\.json: extractionSource 0123456789abcdef/)
  assert.match(problems.join('\n'), /two module\.json disagree on extractionSource/)
})

test('checkExtractionSourceAgreement goes RED on an absent key', (t) => {
  const dir = scratchModules({ users: { schemaVersion: 1, id: 'users' } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.match(
    checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN).join('\n'),
    /extractionSource absent/
  )
})

test('checkExtractionSourceAgreement goes RED on an uppercase, short or non-string value', (t) => {
  const dir = scratchModules({
    a: { id: 'a', extractionSource: FROZEN.toUpperCase() },
    b: { id: 'b', extractionSource: FROZEN.slice(0, 12) },
    c: { id: 'c', extractionSource: 12345 },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const problems = checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN)
  assert.equal(problems.filter((p) => /is not 40 lowercase hex/.test(p)).length, 3, problems.join('\n'))
})

test('unparseable module.json is a problem, not a crash', (t) => {
  const dir = scratchModules({ users: '{ not json' })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.match(
    checkExtractionSourceAgreement(collectModuleJson(dir), FROZEN).join('\n'),
    /not parseable JSON/
  )
})

test('a zero-module run is refused unless allowZero — it would pass vacuously', (t) => {
  const dir = scratchModules({})
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const entries = collectModuleJson(dir)
  assert.deepEqual(entries, [])
  assert.match(checkVacuity(entries, {}).join('\n'), /would pass vacuously/)
  assert.deepEqual(checkVacuity(entries, { allowZero: true }), [])
})

test('runChecks reports zero problems for the committed repo state plus the fixture pair', () => {
  assert.deepEqual(runChecks(ROOT, { modulesRoot: FIXTURES }).problems, [])
  assert.equal(runChecks(ROOT, { modulesRoot: FIXTURES }).frozen, FROZEN)
})
