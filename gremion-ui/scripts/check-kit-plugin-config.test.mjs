#!/usr/bin/env node
// node --test suite for the kit-3 plugin-config guard (TASK-032 integration
// with CAP-BASE). Kit 3 no longer auto-discovers svelte.config.js: a Vite or
// vitest config that calls `sveltekit()` with no argument runs WITHOUT the
// app's kit config, so the `$lib` alias is gone ("`$lib` has been removed"),
// the adapter is unset and the build stamp is missing. The F1 merge brought
// in test/f1-defect/vitest.config.ts with exactly that shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkConfigText, collectConfigFiles, runCheck } from './check-kit-plugin-config.mjs'

// -- checkConfigText: synthetic fixtures (the RED half) ----------------------

test('flags a bare sveltekit() call', () => {
  const problems = checkConfigText('vite.config.ts', 'plugins: [sveltekit()],\n')
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.ok(problems[0].includes('vite.config.ts'), problems[0])
})

test('flags a bare sveltekit( ) call with inner whitespace and a sibling plugin', () => {
  const problems = checkConfigText('x.config.ts', 'plugins: [sveltekit( ), svelteTesting()],\n')
  assert.equal(problems.length, 1, problems.join('\n'))
})

test('flags every bare call, not just the first', () => {
  const problems = checkConfigText('x.config.ts', 'a = sveltekit()\nb = sveltekit()\n')
  assert.equal(problems.length, 2, problems.join('\n'))
})

test('passes a sveltekit(createKitConfig()) call', () => {
  assert.deepEqual(checkConfigText('vite.config.ts', 'plugins: [sveltekit(createKitConfig())],\n'), [])
})

test('ignores a bare sveltekit() that only appears in a line comment', () => {
  assert.deepEqual(checkConfigText('x.config.ts', '// The sveltekit() vite plugin is required\n'), [])
})

test('ignores a bare sveltekit() that only appears in a block comment line', () => {
  assert.deepEqual(checkConfigText('x.config.ts', ' * we call sveltekit() here\n'), [])
})

// -- collectConfigFiles / runCheck: vacuity and the live tree ----------------

test('collectConfigFiles finds the known vite/vitest configs of both apps and test/', () => {
  const files = collectConfigFiles()
  for (const expected of [
    'gremion-ui/vite.config.ts',
    'gremion-ui/vitest.integration.config.ts',
    'gremion-ui/vitest.deselection.config.ts',
    'gremion-public/vite.config.ts',
    'test/f1-defect/vitest.config.ts',
  ]) {
    assert.ok(files.includes(expected), `missing ${expected} in ${files.join(', ')}`)
  }
})

test('runCheck refuses to pass vacuously when it finds zero config files', () => {
  const result = runCheck({ files: [] })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.includes('zero')), result.problems.join('\n'))
})

test('the live repo is clean: every config passes its kit config into sveltekit()', () => {
  const result = runCheck()
  assert.equal(result.ok, true, result.problems.join('\n'))
})
