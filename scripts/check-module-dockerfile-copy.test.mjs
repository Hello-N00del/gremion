#!/usr/bin/env node
// node --test suite for the module Dockerfile COPY-source guard.
//
// Fixture trees prove the guard refuses the exact defect it exists for (a leaf
// Dockerfile COPYing services/<svc> and upstream/gremion/packages/ports that the
// kernel does not hold); the last test runs it over the real tree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { checkModuleDockerfiles, findModuleDockerfiles, KERNEL_ROOT } from './check-module-dockerfile-copy.mjs'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'mod-df-copy-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('refuses a module Dockerfile that COPYs the StuRa-only services/<svc> and upstream/ paths', () => {
  const t = tree({
    'package.json': '{}',
    'modules/finance/package.json': '{}',
    'modules/finance/Dockerfile':
      'FROM node:26-alpine\nCOPY package.json ./\nCOPY upstream/gremion/packages/ports ./p/\nCOPY services/finance ./s/\n',
  })
  try {
    const r = checkModuleDockerfiles(t.root)
    assert.equal(r.problems.length, 2)
    assert.match(r.problems[0], /modules\/finance\/Dockerfile:3 .*upstream\/gremion\/packages\/ports/)
    assert.match(r.problems[1], /modules\/finance\/Dockerfile:4 .*services\/finance/)
  } finally {
    t.cleanup()
  }
})

test('passes in-tree sources, --from stage copies, globs under an existing directory, and sidecar-local files', () => {
  const t = tree({
    'package.json': '{}',
    'packages/ports/package.json': '{}',
    'modules/finance/package.json': '{}',
    'modules/finance/Dockerfile':
      'FROM node:26-alpine AS b\nCOPY package.json ./\nCOPY packages/ports ./p/\nCOPY modules/finance ./m/\n' +
      'COPY packages/*/package.json ./pk/\nFROM node:26-alpine\nCOPY --from=b /repo/modules/finance/dist ./dist\n',
    'modules/side/car/Dockerfile': 'FROM alpine\nCOPY entrypoint.sh /e.sh\n',
    'modules/side/car/entrypoint.sh': '#!/bin/sh\n',
  })
  try {
    const r = checkModuleDockerfiles(t.root)
    assert.deepEqual(r.problems, [])
    assert.equal(r.dockerfiles, 2)
  } finally {
    t.cleanup()
  }
})

test('refuses a glob whose literal directory is missing and a sidecar source that is missing', () => {
  const t = tree({
    'modules/a/Dockerfile': 'FROM alpine\nCOPY upstream/*/package.json ./\n',
    'modules/b/Dockerfile': 'FROM alpine\nCOPY missing.sh /m.sh\n',
  })
  try {
    assert.equal(checkModuleDockerfiles(t.root).problems.length, 2)
  } finally {
    t.cleanup()
  }
})

test('refuses to pass over zero Dockerfiles', () => {
  const t = tree({ 'modules/a/package.json': '{}' })
  try {
    assert.match(checkModuleDockerfiles(t.root).problems[0], /gone blind/)
  } finally {
    t.cleanup()
  }
})

test('the real kernel tree: every module Dockerfile COPY source exists', () => {
  assert.ok(findModuleDockerfiles(KERNEL_ROOT).length >= 9, 'the nine leaf Dockerfiles plus sidecars are discovered')
  assert.deepEqual(checkModuleDockerfiles(KERNEL_ROOT).problems, [])
})
