// TASK-012-FU2: the committed suites.json must claim EVERY test file in the
// real tree it ships with. The snapshot's post-condition (b) ("a test file no
// suite claims is a FAIL") is only meaningful if main is clean against it; the
// manifest had drifted to 342 of 778 kernel test files unclaimed because each
// new package added its tests without touching suites.json, and nothing
// failed until a snapshot was run. This test is that missing tripwire: add a
// test file no suite's testGlobs reach, and this goes RED in the ordinary
// `node --test` run, not weeks later in a reading.
//
// The kernel tree is always this repo. The vertical (StuRaOS) tree is a
// sibling checkout this repo cannot assume, so it is checked when
// CI_LOCAL_VERTICAL names one (snapshot.mjs --vertical does the same census
// on every real reading).

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverTestFiles } from './lib/discover.mjs'
import { loadManifest, validateManifest } from './lib/manifest.mjs'
import { findUnclaimed, claimedFiles } from './lib/snapshot-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KERNEL_ROOT = resolve(HERE, '..', '..')
const manifest = loadManifest(resolve(HERE, 'suites.json'))

function report(unclaimed) {
  const sample = unclaimed.slice(0, 25).join('\n  ')
  const more = unclaimed.length > 25 ? `\n  ... and ${unclaimed.length - 25} more` : ''
  return `${unclaimed.length} test file(s) claimed by no suite in suites.json:\n  ${sample}${more}`
}

test('suites.json is a valid manifest (every category, every repo)', () => {
  assert.deepEqual(validateManifest(manifest), [])
})

test('every kernel test file in the real tree is claimed by a suite', () => {
  const discovered = discoverTestFiles(KERNEL_ROOT)
  assert.ok(discovered.length > 100, `discovery found only ${discovered.length} kernel test files; the walk is broken`)
  const unclaimed = findUnclaimed(discovered, manifest.kernel)
  assert.equal(unclaimed.length, 0, report(unclaimed))
})

test('every kernel suite owns at least one real file (no manifest entry for files that do not exist)', () => {
  const discovered = discoverTestFiles(KERNEL_ROOT)
  const absent = manifest.kernel.filter((suite) => claimedFiles(suite, discovered).length === 0).map((s) => s.id)
  assert.deepEqual(absent, [], `kernel suites whose testGlobs (minus excludeGlobs) match no file: ${absent.join(', ')}`)
})

const VERTICAL_ROOT = process.env.CI_LOCAL_VERTICAL
test(
  'every vertical test file is claimed by a suite (CI_LOCAL_VERTICAL)',
  { skip: VERTICAL_ROOT && existsSync(VERTICAL_ROOT) ? false : 'CI_LOCAL_VERTICAL not set; snapshot.mjs --vertical runs the same census' },
  () => {
    const discovered = discoverTestFiles(VERTICAL_ROOT)
    assert.ok(discovered.length > 100, `discovery found only ${discovered.length} vertical test files`)
    const unclaimed = findUnclaimed(discovered, manifest.vertical)
    assert.equal(unclaimed.length, 0, report(unclaimed))
    const absent = manifest.vertical.filter((suite) => claimedFiles(suite, discovered).length === 0).map((s) => s.id)
    assert.deepEqual(absent, [], `vertical suites whose testGlobs (minus excludeGlobs) match no file: ${absent.join(', ')}`)
  },
)
