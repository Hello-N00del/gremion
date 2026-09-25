#!/usr/bin/env node
// node --test suite for the removed-kit-3-API guard (TASK-032, brief §6 item 3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkFileText, checkAppSrc } from './check-removed-kit-apis.mjs'

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
