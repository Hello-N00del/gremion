// TASK-045 round 2 (TRD-343 meta-test): carve-lint must stay a SUPERSET of
// every lint target the Makefile defines. Round 2 found the drift this
// catches: TASK-005 merged `lint-compliance` into main (and into `make
// lint`) after carve-lint's list was written, and verify silently did not
// run it. It also pins the guards the CAP-BASE audit found no gate running:
// TASK-017's lint-toolchain (deliberately NOT in `make lint`) and the
// frozen-lockfile check the release-1 gate ran as `pnpm install
// --frozen-lockfile` (round-1 MEDIUM, dropped by verify).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { CARVE_LINT_TARGETS } from './suites/carve-lint.mjs'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const MAKEFILE = readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8')
const NAMES = CARVE_LINT_TARGETS.map((t) => t.name)

test('carve-lint runs every lint-* target the Makefile defines', () => {
  const defined = [...MAKEFILE.matchAll(/^(lint-[a-z0-9-]+):/gm)].map((m) => m[1])
  assert.ok(defined.length >= 10, `expected the Makefile to define its lint-* targets, found ${defined.length}`)
  const missing = defined.filter((t) => !NAMES.includes(t))
  assert.deepEqual(missing, [], `carve-lint does not run: ${missing.join(', ')}`)
})

test('carve-lint runs every prerequisite of the Makefile `lint` aggregate', () => {
  const m = MAKEFILE.match(/^lint:([^\n]*)$/m)
  assert.ok(m, 'the Makefile has no lint: aggregate')
  const prereqs = m[1].trim().split(/\s+/).filter(Boolean)
  const missing = prereqs.filter((t) => !NAMES.includes(t))
  assert.deepEqual(missing, [], `carve-lint does not run: ${missing.join(', ')}`)
})

test('carve-lint pins lint-toolchain (TASK-017), which make lint deliberately leaves out', () => {
  assert.ok(NAMES.includes('lint-toolchain'))
})

test('carve-lint pins a frozen-lockfile check (the release-1 gate ran pnpm install --frozen-lockfile)', () => {
  const t = CARVE_LINT_TARGETS.find((x) => x.name === 'lockfile-frozen')
  assert.ok(t, 'no lockfile-frozen target')
  assert.deepEqual(t.args.slice(0, 2), ['install', '--frozen-lockfile'])
  assert.ok(t.args.includes('--lockfile-only'), 'the lockfile check must not touch node_modules')
})
