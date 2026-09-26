#!/usr/bin/env node
// node --test suite for the third-party font/icon <link> guard (TASK-007).
//
// Same idiom as scripts/check-postgres-major.test.mjs: prove the checker
// against a synthetic PLANTED violation first (the RED proof — it must not
// depend on mutating a real file), then run it over the real, committed
// app.html of both apps, where it passes trivially today (brief Sec6.3:
// "grepped gremion-public/src for icon usage, zero matches" — proven here,
// not just asserted by inspection).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findThirdPartyAssetLinks, checkFile } from './check-no-third-party-asset-links.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('a planted third-party <link href> (jsdelivr icon CDN) is flagged — the guard bites', () => {
  const planted =
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lucide-static/font/lucide.css" />'
  const problems = findThirdPartyAssetLinks(planted, 'fixture')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cdn\.jsdelivr\.net/)
  assert.match(problems[0], /TASK-007 \/ TRD-337/)
})

test('a planted Google Fonts <link href> is flagged the same way', () => {
  const planted = '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet" />'
  assert.equal(findThirdPartyAssetLinks(planted).length, 1)
})

test('a same-origin or relative <link href> is not flagged', () => {
  const clean = [
    '<link rel="icon" href="%sveltekit.assets%/brand/favicon-32.png" />',
    '<link rel="stylesheet" href="/static/app.css" />',
  ].join('\n')
  assert.deepEqual(findThirdPartyAssetLinks(clean), [])
})

test('an empty input has nothing to flag (not a vacuous pass — no <link> at all still returns [])', () => {
  assert.deepEqual(findThirdPartyAssetLinks(''), [])
})

for (const app of ['gremion-ui', 'gremion-public']) {
  test(`${app}/src/app.html carries no third-party asset <link> (real file, post-fix)`, () => {
    const file = join(ROOT, app, 'src/app.html')
    assert.deepEqual(checkFile(file), [], `expected no problems in ${file}`)
  })
}
