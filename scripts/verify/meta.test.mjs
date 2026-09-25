// TASK-045 (TRD-343): the guard must actually run. Modeled on B3's
// check-do-not-overwrite.test.mjs "the guard is wired to something that runs
// it" style (9338a58): a meta-test that reads the Makefile, the root
// package.json and required-suites.txt as TEXT/JSON and fails if the
// `verify` target, the root `verify` script, or any of the five required
// suites is dropped -- a merge conflict on the Makefile's single `.PHONY:`
// line or the `lint:` aggregate is exactly the shape that has silently
// dropped a guard from this repo before (see B3's own commit message).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { loadRequiredSuites, SUITE_REGISTRY } from './verify.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const MAKEFILE = readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8')
const PKG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const REQUIRED = loadRequiredSuites()

// The five suites the brief fixes as required now (S5). If PRD-UXQ-001a or a
// future task adds a sixth line to required-suites.txt that is a real
// addition, not a drop -- this list only pins the FLOOR, not the ceiling.
const MUST_BE_PRESENT = ['typecheck', 'unit', 'integration', 'migration-hash', 'carve-lint']

test('required-suites.txt still names all five required suites', () => {
  for (const name of MUST_BE_PRESENT) {
    assert.ok(REQUIRED.includes(name), `required-suites.txt dropped "${name}"`)
  }
})

test('every line in required-suites.txt has a real runner in SUITE_REGISTRY', () => {
  for (const name of REQUIRED) {
    assert.ok(typeof SUITE_REGISTRY[name] === 'function', `required-suites.txt names "${name}" but SUITE_REGISTRY has no runner for it`)
  }
})

test('the Makefile has a verify target that calls scripts/verify/verify.mjs', () => {
  const lines = MAKEFILE.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('verify:'))
  assert.notEqual(start, -1, 'the Makefile has no verify target')
  const recipe = []
  for (let i = start + 1; i < lines.length && lines[i].startsWith('\t'); i++) {
    recipe.push(lines[i])
  }
  const body = recipe.join('\n')
  assert.match(body, /node scripts[/]verify[/]verify\.mjs/, `verify target does not call verify.mjs:\n${body}`)
})

test('.PHONY still lists verify (a continuation-line drop is silent otherwise)', () => {
  const lines = MAKEFILE.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('.PHONY:'))
  assert.notEqual(start, -1, 'the Makefile has no .PHONY line')
  let block = lines[start]
  for (let i = start; block.trimEnd().endsWith('\\'); ) {
    block = block.trimEnd().slice(0, -1) + ' ' + lines[++i]
  }
  assert.match(block, /(^|\s)verify(\s|$)/, `.PHONY dropped verify: ${block}`)
})

test('the root package.json still has "verify": "make verify" (Q1 grant)', () => {
  assert.equal(PKG.scripts?.verify, 'make verify', 'root package.json is missing (or changed) the verify script')
})
