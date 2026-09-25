#!/usr/bin/env node
// node --test suite for the SvelteKit-3 major-version guard (TASK-032).
//
// Same idiom as scripts/check-cve-floors.test.mjs: every pure helper is
// exercised against BOTH the real repo state (must be clean once migrated)
// and a synthetic broken state (must produce a problem) — a guard that
// cannot be shown failing is not a guard.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPS,
  readDep,
  hasRangeOperator,
  majorOf,
  checkManifest,
  findLockfile2xResolutions,
  checkLockfile,
  runAllChecks,
} from './check-sveltekit-major.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const UI_PKG = read('gremion-ui/package.json')
const PUBLIC_PKG = read('gremion-public/package.json')
const LOCK = read('pnpm-lock.yaml')

// ── readDep ─────────────────────────────────────────────────────────────────

test('readDep finds a declared dependency and returns its raw range text', () => {
  assert.equal(readDep('{"devDependencies":{"@sveltejs/kit":"^2.70.2"}}', '@sveltejs/kit'), '^2.70.2')
})

test('readDep returns null for an absent dependency', () => {
  assert.equal(readDep('{"devDependencies":{}}', '@sveltejs/kit'), null)
})

// ── hasRangeOperator ─────────────────────────────────────────────────────────

test('hasRangeOperator: false only for a bare exact version (prerelease or not)', () => {
  assert.equal(hasRangeOperator('3.0.0-next.28'), false)
  assert.equal(hasRangeOperator('2.70.2'), false)
})

test('hasRangeOperator: true for caret, tilde, comparator and OR ranges', () => {
  assert.equal(hasRangeOperator('^3.0.0-next.28'), true)
  assert.equal(hasRangeOperator('~3.0.0-next.28'), true)
  assert.equal(hasRangeOperator('>=2.70.2 <3'), true)
  assert.equal(hasRangeOperator('^1.0.0 || ^2.0.0'), true)
  assert.equal(hasRangeOperator('workspace:*'), true)
})

// ── majorOf ──────────────────────────────────────────────────────────────────

test('majorOf reads the semver major, ignoring a leading range operator', () => {
  assert.equal(majorOf('^2.70.2'), 2)
  assert.equal(majorOf('3.0.0-next.28'), 3)
  assert.equal(majorOf('6.0.0-next.13'), 6)
})

test('majorOf returns null when no version is present', () => {
  assert.equal(majorOf('workspace:*'), null)
})

// ── checkManifest — synthetic broken fixtures (the RED half) ────────────────

test('checkManifest flags a kit major that is not 3', () => {
  const pkg = JSON.stringify({
    devDependencies: { '@sveltejs/kit': '^2.70.2', '@sveltejs/adapter-node': '6.0.0-next.13' },
  })
  const problems = checkManifest('gremion-ui', pkg)
  assert.ok(problems.some((p) => p.includes('is major 2, not 3')), problems.join('\n'))
})

test('checkManifest flags a range operator on an exact-pin-required kit version', () => {
  const pkg = JSON.stringify({
    devDependencies: { '@sveltejs/kit': '^3.0.0-next.28', '@sveltejs/adapter-node': '6.0.0-next.13' },
  })
  const problems = checkManifest('gremion-ui', pkg)
  assert.ok(problems.some((p) => p.includes('range operator') && p.includes('@sveltejs/kit')), problems.join('\n'))
})

test('checkManifest flags adapter-node left on 5.x beside a kit-3 pin', () => {
  const pkg = JSON.stringify({
    devDependencies: { '@sveltejs/kit': '3.0.0-next.28', '@sveltejs/adapter-node': '^5.5.7' },
  })
  const problems = checkManifest('gremion-ui', pkg)
  assert.ok(problems.some((p) => p.includes('adapter-node') && p.includes('range operator')), problems.join('\n'))
  assert.ok(problems.some((p) => p.includes('is major 5, not 6')), problems.join('\n'))
})

test('checkManifest flags a missing kit or adapter-node dependency', () => {
  const problems = checkManifest('gremion-ui', JSON.stringify({ devDependencies: {} }))
  assert.ok(problems.some((p) => p.includes('declares no @sveltejs/kit dependency')))
  assert.ok(problems.some((p) => p.includes('declares no @sveltejs/adapter-node dependency')))
})

test('checkManifest is clean for a correctly pinned kit-3 + adapter-node-6 pair', () => {
  const pkg = JSON.stringify({
    devDependencies: { '@sveltejs/kit': '3.0.0-next.28', '@sveltejs/adapter-node': '6.0.0-next.13' },
  })
  assert.deepEqual(checkManifest('gremion-ui', pkg), [])
})

// ── lockfile ──────────────────────────────────────────────────────────────────

test('findLockfile2xResolutions finds a stale 2.x top-level lockfile entry', () => {
  const lock = "  '@sveltejs/kit@2.70.2':\n    resolution: {integrity: sha512-x}\n"
  assert.deepEqual(findLockfile2xResolutions(lock, '@sveltejs/kit'), ['2.70.2'])
})

test('findLockfile2xResolutions is clean once the lockfile only resolves 3.x', () => {
  const lock = "  '@sveltejs/kit@3.0.0-next.28':\n    resolution: {integrity: sha512-x}\n"
  assert.deepEqual(findLockfile2xResolutions(lock, '@sveltejs/kit'), [])
})

test('checkLockfile reports every stale 2.x resolution it finds', () => {
  const lock = "  '@sveltejs/kit@2.70.2':\n    resolution: {integrity: sha512-x}\n"
  const problems = checkLockfile(lock)
  assert.ok(problems.some((p) => p.includes('2.70.2')), problems.join('\n'))
})

// ── runAllChecks — the "zero manifests" defensive case ───────────────────────

test('runAllChecks refuses to pass vacuously when it finds zero manifests', () => {
  const problems = runAllChecks({ uiPkg: null, publicPkg: null, lock: '' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /zero package\.json manifests/)
})

test('runAllChecks reports a missing manifest for one app even if the other is present', () => {
  const goodPkg = JSON.stringify({
    devDependencies: { '@sveltejs/kit': '3.0.0-next.28', '@sveltejs/adapter-node': '6.0.0-next.13' },
  })
  const problems = runAllChecks({ uiPkg: goodPkg, publicPkg: null, lock: '' })
  assert.ok(problems.some((p) => p.includes('gremion-public/package.json: not found')))
})

// ── the live repo (the actual acceptance check) ──────────────────────────────
// This is the falsifying half: it must be RED on today's pre-migration tree
// (kit ^2.70.2 in both apps, adapter-node ^5.5.7) and flip GREEN only once
// the manifests + lockfile are actually migrated.

test('APPS names both real apps', () => {
  assert.deepEqual(APPS, ['gremion-ui', 'gremion-public'])
})

test('the live repo is clean: both apps pin kit 3 + adapter-node 6.x, no 2.x resolved', () => {
  const problems = runAllChecks({ uiPkg: UI_PKG, publicPkg: PUBLIC_PKG, lock: LOCK })
  assert.deepEqual(problems, [], problems.join('\n'))
})
