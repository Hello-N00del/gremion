#!/usr/bin/env node
// node --test suite for the removed-kit-3-API guard (TASK-032, brief §6 item 3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { existsSync, readFileSync } from 'node:fs'

import { checkFileText, checkAppSrc, ENV_DYNAMIC_FIXTURE_FILES } from './check-removed-kit-apis.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── checkFileText — synthetic broken fixtures (the RED half) ────────────────

test('flags a bare $app/stores import', () => {
  const problems = checkFileText('routes/+layout.svelte', "import { page } from '$app/stores'\n")
  assert.ok(problems.some((p) => p.includes("removed '$app/stores'")), problems.join('\n'))
})

test('flags base/assets/resolveRoute imported from $app/paths', () => {
  const problems = checkFileText(
    'lib/components/Nav.svelte',
    "import { base, resolve } from '$app/paths'\n"
  )
  assert.ok(problems.some((p) => p.includes("removed 'base'")), problems.join('\n'))
  assert.ok(!problems.some((p) => p.includes("'resolve'")), 'resolve() is not removed, should not be flagged')
})

test('flags resolveRoute and assets too, each independently', () => {
  const problems = checkFileText(
    'lib/x.ts',
    "import { resolveRoute } from '$app/paths'\nimport { assets } from '$app/paths'\n"
  )
  assert.ok(problems.some((p) => p.includes("removed 'resolveRoute'")), problems.join('\n'))
  assert.ok(problems.some((p) => p.includes("removed 'assets'")), problems.join('\n'))
})

test('is clean for a file using only surviving APIs', () => {
  const problems = checkFileText(
    'lib/x.ts',
    "import { page } from '$app/state'\nimport { resolve, asset } from '$app/paths'\n"
  )
  assert.deepEqual(problems, [])
})

test('is clean for a file that mentions the banned words only in prose, not an import', () => {
  const problems = checkFileText('lib/x.ts', '// migrated off $app/stores and $app/paths base\n')
  assert.deepEqual(problems, [])
})

// ── $env/dynamic/* (round-1 MEDIUM) ─────────────────────────────────────────
// Kit 3's `$env/dynamic/*` re-exports only the vars declared through the kit
// env schema, so an undeclared var (DATABASE_URL, issuers, secrets) silently
// reads as undefined; a `vi.mock` of it no longer reaches migrated code either.

test('flags a static $env/dynamic/private import', () => {
  const problems = checkFileText('lib/server/db.ts', "import { env } from '$env/dynamic/private'\n")
  assert.ok(problems.some((p) => p.includes("'$env/dynamic/private'")), problems.join('\n'))
})

test('flags a static $env/dynamic/public import', () => {
  const problems = checkFileText('routes/+page.svelte', 'import { env } from "$env/dynamic/public"\n')
  assert.ok(problems.some((p) => p.includes("'$env/dynamic/public'")), problems.join('\n'))
})

test('flags a dynamic import() of $env/dynamic/*', () => {
  const problems = checkFileText('lib/x.ts', "const { env } = await import('$env/dynamic/private')\n")
  assert.ok(problems.some((p) => p.includes('$env/dynamic/private')), problems.join('\n'))
})

test('flags a vi.mock of $env/dynamic/* (inert under kit 3)', () => {
  const problems = checkFileText(
    'lib/server/x.test.ts',
    "vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'x' } }))\n"
  )
  assert.ok(problems.some((p) => p.includes('vi.mock') && p.includes('$env/dynamic/private')), problems.join('\n'))
})

test('does not flag $env/dynamic/* mentioned only in a comment', () => {
  assert.deepEqual(checkFileText('lib/x.ts', '// no longer reads $env/dynamic/private\n'), [])
})

test('the $env/dynamic exemption list names only existing files, each with a reason', () => {
  for (const [rel, reason] of ENV_DYNAMIC_FIXTURE_FILES) {
    assert.ok(reason.trim().length > 0, `${rel} has no reason`)
    assert.ok(existsSync(join(REPO_ROOT, rel)), `${rel} does not exist`)
  }
})

// ── wiring (round-1 MEDIUM: a guard nothing runs protects nothing) ──────────
// `pnpm check` runs in both apps' CI workflows (gremion-ui.yml,
// gremion-public.yml), each path-filtered to its own app, so EACH app's check
// script must invoke the kit-3 guards itself.

test("both apps' `check` scripts run the kit-3 guards and the build-stamp test", () => {
  const scriptOf = (app) => JSON.parse(readFileSync(join(REPO_ROOT, app, 'package.json'), 'utf8')).scripts?.check ?? ''
  const ui = scriptOf('gremion-ui')
  for (const needle of ['check-sveltekit-major.mjs', 'check-removed-kit-apis.mjs', 'scripts/build-stamp.test.mjs', 'check-sveltekit-major.test.mjs', 'check-removed-kit-apis.test.mjs']) {
    assert.ok(ui.includes(needle), `gremion-ui check does not run ${needle}: ${ui}`)
  }
  const pub = scriptOf('gremion-public')
  for (const needle of ['../gremion-ui/scripts/check-sveltekit-major.mjs', '../gremion-ui/scripts/check-removed-kit-apis.mjs', 'scripts/build-stamp.test.mjs']) {
    assert.ok(pub.includes(needle), `gremion-public check does not run ${needle}: ${pub}`)
  }
})

// ── the live repo (the actual acceptance check) ──────────────────────────────
// Falsifying half: RED before the TASK-032 migration (18 files per the brief's
// estimate — the actual count found was 10, see the migration commit), GREEN
// once every source file is migrated off the removed APIs.

test('the live repo imports no kit-3-removed API in either app', () => {
  const problems = [
    ...checkAppSrc(join(REPO_ROOT, 'gremion-ui', 'src')),
    ...checkAppSrc(join(REPO_ROOT, 'gremion-public', 'src')),
  ]
  assert.deepEqual(problems, [], problems.join('\n'))
})
