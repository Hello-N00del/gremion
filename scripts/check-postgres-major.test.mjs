#!/usr/bin/env node
// node --test suite for the Postgres-major pin guard (spec B §8, B37).
//
// Same idiom as scripts/check-cve-floors.test.mjs: assert POST-CONDITIONS on
// real file content, never an exit code, and exercise every helper against BOTH
// the committed repo (must be clean) and a synthetic broken state (must produce
// a problem). A guard that cannot be shown failing is not a guard.
//
// NOTE ON LITERALS: this file is itself a tracked text file that the real-repo
// scan below reads. A stale tag written out in full here would be a real finding
// for the guard, so every stale/floating tag in this suite is BUILT at runtime
// from POSTGRES_MAJOR instead of spelled out. That is not a dodge — it is what
// keeps the "the committed kernel tree carries the pinned tag everywhere" test
// honest about its own source file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POSTGRES_MAJOR,
  POSTGRES_IMAGE_TAG,
  S14_CONSUMERS,
  EVIDENCE_PATH,
  checkEvidence,
} from './check-postgres-major.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = readFileSync(join(ROOT, EVIDENCE_PATH), 'utf8')

test('the pin is an integer major and a concrete alpine tag', () => {
  assert.ok(Number.isInteger(POSTGRES_MAJOR), 'POSTGRES_MAJOR must be an integer')
  assert.ok(POSTGRES_MAJOR >= 16, 'the pin may never go below the major release 1 runs on today')
  assert.equal(POSTGRES_IMAGE_TAG, `postgres:${POSTGRES_MAJOR}-alpine`)
})

test('the evidence record is docs/ops/postgres-major.md', () => {
  assert.equal(EVIDENCE_PATH, 'docs/ops/postgres-major.md')
})

test('the record carries one S14 evidence row per consumer, each with a source URL', () => {
  assert.deepEqual(checkEvidence(EVIDENCE), [])
  assert.ok(S14_CONSUMERS.length >= 5, 'an empty consumer list would pass vacuously')
})

test('checkEvidence goes RED when a consumer has no evidence row', () => {
  const rows = EVIDENCE.split('\n').filter((l) => l.toLowerCase().includes('pgbouncer'))
  assert.ok(rows.length > 0, 'fixture precondition: the record mentions pgbouncer')
  const stripped = EVIDENCE.split('\n').filter((l) => !l.toLowerCase().includes('pgbouncer')).join('\n')
  const problems = checkEvidence(stripped)
  assert.ok(problems.length > 0)
  assert.match(problems.join('\n'), /no S14 evidence row for pgbouncer/)
})

test('checkEvidence goes RED when the record pins a different major from the code', () => {
  const drifted = EVIDENCE.replace(
    /^- \*\*Pinned major\*\*: \d+$/m,
    `- **Pinned major**: ${POSTGRES_MAJOR + 1}`,
  )
  assert.notEqual(drifted, EVIDENCE, 'fixture did not apply')
  assert.match(
    checkEvidence(drifted).join('\n'),
    /postgres-major\.md pins \d+, check-postgres-major\.mjs exports/,
  )
})

test('checkEvidence goes RED when the later-bump rule is missing', () => {
  const noRule = EVIDENCE.replace(/measured RTO/g, 'best effort')
  assert.notEqual(noRule, EVIDENCE, 'fixture did not apply')
  assert.match(checkEvidence(noRule).join('\n'), /no later-bump rule/)
})
