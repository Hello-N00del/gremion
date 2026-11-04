#!/usr/bin/env node
// node --test suite for the Node runtime floor guard.
//
// Same idiom as scripts/check-cve-floors.test.mjs: assert POST-CONDITIONS on
// real file content, never an exit code. Every rule is exercised against a
// synthetic broken Dockerfile (must produce a problem) and the real repo state
// (must be clean): a guard that cannot be shown failing is not a guard.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NODE_FLOORS, parseNodeFroms, checkDockerfile, runChecks } from './check-node-floor.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIGEST = 'sha256:' + 'a'.repeat(64)
const check = (text) => checkDockerfile('Dockerfile', text)

// ── the committed floor table itself ───────────────────────────────────────

test('NODE_FLOORS is a non-empty table, each line floored at an exact patched release', () => {
  const majors = Object.keys(NODE_FLOORS)
  assert.ok(majors.length > 0, 'an empty floor table would vacuously pass every check')
  for (const major of majors) {
    const f = NODE_FLOORS[major]
    assert.match(f.floor, /^\d+\.\d+\.\d+$/, `node ${major}: floor must be an exact version`)
    assert.equal(f.floor.split('.')[0], major, `node ${major}: floor ${f.floor} is on another major`)
    assert.ok(f.advisory && f.advisory.length > 8, `node ${major}: needs an advisory note`)
  }
})

test('Node 26 is floored at or above 26.12.1 (CVE-2026-111497, Brotli decoder OOB write)', () => {
  const [maj, min, pat] = NODE_FLOORS['26'].floor.split('.').map(Number)
  assert.equal(maj, 26)
  assert.ok(min > 12 || (min === 12 && pat >= 1), `floor ${NODE_FLOORS['26'].floor} is below 26.12.1`)
})

// ── parsing ────────────────────────────────────────────────────────────────

test('parseNodeFroms finds node bases in every spelling and ignores other images and stage refs', () => {
  const froms = parseNodeFroms(
    [
      `FROM node:26.13.0-alpine@${DIGEST} AS builder`,
      'from --platform=$BUILDPLATFORM docker.io/library/node:26-alpine AS b2',
      'FROM library/node:22-bookworm-slim',
      'FROM builder AS runner',
      'FROM nginx:alpine',
      'FROM nodered/node-red:4',
      '# FROM node:10',
    ].join('\n')
  )
  assert.deepEqual(
    froms.map((f) => [f.tag, f.digest]),
    [
      ['26.13.0-alpine', DIGEST],
      ['26-alpine', null],
      ['22-bookworm-slim', null],
    ]
  )
})

// ── rules: each one shown RED on a synthetic Dockerfile ────────────────────

test('a digest pin at the floor or above passes', () => {
  assert.deepEqual(check(`FROM node:26.13.0-alpine@${DIGEST} AS runner`), [])
  assert.deepEqual(check(`FROM node:26.12.1-alpine@${DIGEST}`), [])
})

test('a digest pin below the floor fails (the kernel-api 26.2.0 / control-panel 26.12.0 case)', () => {
  for (const v of ['26.2.0', '26.12.0']) {
    const p = check(`FROM node:${v}-alpine@${DIGEST}`)
    assert.equal(p.length, 1, `${v} must be refused`)
    assert.match(p[0], /BELOW the floor 26\.12\.1/)
  }
})

test('a digest pin whose tag states no full version fails: its Node version is unreadable', () => {
  const p = check(`FROM node:26-alpine@${DIGEST}`)
  assert.equal(p.length, 1)
  assert.match(p[0], /states no x\.y\.z/)
  assert.equal(check(`FROM node@${DIGEST}`).length, 1)
})

test('a floating major tag on a supported line passes: the registry moves it to the patched release', () => {
  assert.deepEqual(check('FROM node:26-alpine AS builder'), [])
  assert.deepEqual(check('FROM node:22-alpine'), [])
})

test('a tag-pinned full version below the floor fails even without a digest', () => {
  const p = check('FROM node:22.23.3-alpine')
  assert.equal(p.length, 1)
  assert.match(p[0], /BELOW the floor 22\.23\.4/)
})

test('a major with no floor (end-of-life or unknown line) fails closed', () => {
  for (const ref of ['node:20-alpine', 'node:25.1.0-alpine', 'node:10.15']) {
    const p = check(`FROM ${ref}`)
    assert.equal(p.length, 1, `${ref} must be refused`)
    assert.match(p[0], /no floor/)
  }
})

test('an untagged, latest, lts or codename node base fails closed', () => {
  for (const ref of ['node', 'node:latest', 'node:lts-alpine', 'node:current', 'node:jod']) {
    assert.equal(check(`FROM ${ref}`).length, 1, `${ref} must be refused`)
  }
})

// ── the real tree ──────────────────────────────────────────────────────────

test('the kernel tree: every node base is at or above its floor, and the scan is not vacuous', () => {
  const { problems, scanned } = runChecks(ROOT)
  assert.ok(scanned >= 5, `only ${scanned} node FROM line(s) found: the discovery is broken`)
  assert.deepEqual(problems, [])
})
