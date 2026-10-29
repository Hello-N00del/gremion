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
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { findThirdPartyAssetLinks, checkFile } from './check-no-third-party-asset-links.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts', 'check-no-third-party-asset-links.mjs')

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

// One test, a loop inside it: scripts/verify/suites/unit.mjs compares node's collected count with the
// number of `test(` declarations, and a `test(` inside a loop declares 1 and collects N (judged
// unparseable). The message names the file that failed.
test('gremion-ui and gremion-public src/app.html carry no third-party asset <link> (real files, post-fix)', () => {
  for (const app of ['gremion-ui', 'gremion-public']) {
    const file = join(ROOT, app, 'src/app.html')
    assert.deepEqual(checkFile(file), [], `expected no problems in ${file}`)
  }
})

// ── CLI entry-point (isMain) proof ──────────────────────────────────────────
// review finding (TASK-007 r1, MEDIUM): the old guard compared
// `import.meta.url === file://${process.argv[1]}` — a raw string concat that
// never matches on Windows (drive-letter + backslash paths never round-trip
// through a bare `file://` prefix) nor on POSIX when the path needs
// percent-encoding, so the CLI silently exited 0 with no output no matter
// what was fed to it. These tests actually SPAWN the CLI as a subprocess
// (not just import its exports) so the isMain branch itself is exercised,
// which is exactly the code path the bug lived in.
test('CLI: a planted third-party <link> in a real file exits 1 and prints the problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-asset-link-'))
  try {
    const fixture = join(dir, 'planted.html')
    writeFileSync(
      fixture,
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lucide-static/font/lucide.css" />'
    )
    const result = spawnSync(process.execPath, [CLI, fixture], { encoding: 'utf8' })
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr=${result.stderr}`)
    assert.match(result.stderr, /cdn\.jsdelivr\.net/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: a clean real file exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-asset-link-'))
  try {
    const fixture = join(dir, 'clean.html')
    writeFileSync(fixture, '<link rel="stylesheet" href="/static/app.css" />')
    const result = spawnSync(process.execPath, [CLI, fixture], { encoding: 'utf8' })
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI: no file arguments exits 2 with a usage message', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' })
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}; stderr=${result.stderr}`)
  assert.match(result.stderr, /usage/i)
})
