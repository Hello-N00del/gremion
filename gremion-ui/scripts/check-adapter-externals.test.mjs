#!/usr/bin/env node
// node --test suite for the adapter-node 6 externals guard (TASK-032).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkManifest, runCheck } from './check-adapter-externals.mjs'

const noDeps = () => null

test('flags a workspace package in dependencies', () => {
  const problems = checkManifest('app', { dependencies: { '@gremion/db': 'workspace:*' } }, noDeps)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.ok(problems[0].includes("'@gremion/db'"), problems[0])
})

test('flags a package that peers on @sveltejs/kit', () => {
  const read = (n) => (n === '@auth/sveltekit' ? { peerDependencies: { '@sveltejs/kit': '^1 || ^2' } } : null)
  const problems = checkManifest('app', { dependencies: { '@auth/sveltekit': '^1.11.3' } }, read)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.ok(problems[0].includes('peers on @sveltejs/kit'), problems[0])
})

test("does not flag kit's own @sveltejs/* tooling", () => {
  const read = () => ({ peerDependencies: { '@sveltejs/kit': '^3.0.0-next.0' } })
  assert.deepEqual(checkManifest('app', { dependencies: { '@sveltejs/adapter-node': '6.0.0-next.13' } }, read), [])
})

test('passes plain runtime packages and ignores devDependencies', () => {
  const manifest = {
    dependencies: { postgres: '^3.4.9', zod: '^4.6.5' },
    devDependencies: { '@gremion/db': 'workspace:*', '@auth/sveltekit': '^1.11.3' },
  }
  assert.deepEqual(checkManifest('app', manifest, () => ({ peerDependencies: {} })), [])
})

test('runCheck refuses to pass vacuously when it finds zero manifests', () => {
  const result = runCheck({ apps: [] })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.includes('zero')), result.problems.join('\n'))
})

test('runCheck reports a missing manifest', () => {
  const result = runCheck({ apps: ['no-such-app'] })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((p) => p.includes('not found')), result.problems.join('\n'))
})

test('the live repo is clean: both apps keep workspace and kit-coupled packages out of dependencies', () => {
  const result = runCheck()
  assert.deepEqual(result.checked, ['gremion-ui', 'gremion-public'])
  assert.equal(result.ok, true, result.problems.join('\n'))
})
