#!/usr/bin/env node
// node --test suite: the three `--migrate-only` copies of the CD leaf step stay identical.
//
// Why. calendar, content and publishing each carry their own copy of src/migrate-only.ts (a leaf imports no
// shared package, so the step cannot live in one place), and each copy has the same two test files. The
// copies differ only in the leaf's name: its directory, its environment-variable prefix, its database prefix.
// A fix made in one copy and not in the others (the lock bound, the exit codes, the diagnostic line) is a
// defect the other two leaves still have, and nothing else would notice: each copy passes its own tests.
//
// The rule: after the leaf's own tokens are replaced by a placeholder, the three copies of each file are
// byte for byte the same (line endings ignored). A drift names the file and the first line that differs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The leaves that carry the step: directory, the name the source calls the leaf, its env-variable prefix. */
export const LEAVES = [
  { dir: 'calendar', leaf: 'calendar', env: 'CALENDAR' },
  { dir: 'content', leaf: 'content', env: 'CONTENT' },
  { dir: 'publishing', leaf: 'newsletter', env: 'NEWSLETTER' },
]

/** Every file that is a copy across the leaves, relative to modules/<dir>/. */
export const COPIED = ['src/migrate-only.ts', 'test/migrate-only.test.ts', 'test/migrate-only.integration.test.ts']

/** One copy with its line endings made LF and the leaf's own tokens replaced by placeholders. */
export function normalized(text, { dir, leaf, env }) {
  return text
    .replace(/\r\n/g, '\n')
    .split(`modules/${dir}/`)
    .join('modules/@DIR@/')
    .split(`${env}_`)
    .join('@ENV@_')
    .split(`${leaf}_`)
    .join('@LEAF@_')
    .split(`LEAF = '${leaf}'`)
    .join("LEAF = '@LEAF@'")
}

/**
 * The drift between copies: [] when every copy equals the first, else one finding per copy that differs,
 * naming the leaf and the first line (1-based) where it departs from the first copy.
 */
export function driftOf(copies) {
  const [first, ...rest] = copies
  const base = normalized(first.text, first.leaf).split('\n')
  const findings = []
  for (const c of rest) {
    const lines = normalized(c.text, c.leaf).split('\n')
    const n = Math.max(base.length, lines.length)
    for (let i = 0; i < n; i++) {
      if (base[i] !== lines[i]) {
        findings.push(`${c.leaf.dir} differs from ${first.leaf.dir} at line ${i + 1}: ${JSON.stringify(lines[i] ?? '<missing>')} vs ${JSON.stringify(base[i] ?? '<missing>')}`)
        break
      }
    }
  }
  return findings
}

const copiesOf = (rel, root = ROOT) =>
  LEAVES.map((leaf) => ({ leaf, text: readFileSync(path.join(root, 'modules', leaf.dir, rel), 'utf8') }))

for (const rel of COPIED) {
  test(`the three copies of ${rel} are identical apart from the leaf's own names`, () => {
    assert.deepEqual(driftOf(copiesOf(rel)), [])
  })
}

test('guard efficacy: a copy that drifts by one line is reported, with the leaf and the line', () => {
  const copies = copiesOf('src/migrate-only.ts')
  assert.deepEqual(driftOf(copies), [])
  const drifted = copies.map((c, i) =>
    i === 1 ? { ...c, text: c.text.replace('export const MAX_ATTEMPTS = 4', 'export const MAX_ATTEMPTS = 5') } : c,
  )
  const findings = driftOf(drifted)
  assert.equal(findings.length, 1)
  assert.match(findings[0], /^content differs from calendar at line \d+:/)
})

test('guard efficacy: a leaf name that is not replaced is a drift, not a pass (the substitution does not hide a hard-coded name)', () => {
  const copies = copiesOf('src/migrate-only.ts')
  const drifted = copies.map((c, i) =>
    i === 2 ? { ...c, text: c.text.replace("process.stderr.write(`[${LEAF}]", "process.stderr.write(`[calendar]") } : c,
  )
  assert.equal(driftOf(drifted).length, 1)
})

test('the step names its leaf once, as LEAF, and every diagnostic goes through it', () => {
  for (const { leaf, text } of copiesOf('src/migrate-only.ts')) {
    assert.match(text, new RegExp(`const LEAF = '${leaf.leaf}'`))
    assert.match(text, new RegExp(`const PG_URL_ENV = '${leaf.env}_PG_URL'`))
    assert.match(text, new RegExp(`const DEFAULT_DB_PREFIX = '${leaf.leaf}_'`))
  }
})
