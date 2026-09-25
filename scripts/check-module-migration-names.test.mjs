#!/usr/bin/env node
// node --test suite for the module migration basename guard (TASK-200, Q8).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { collectMigrationNames, checkMigrationNames } from './check-module-migration-names.mjs'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 't200-mig-'))
  for (const rel of files) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), '-- sql\n')
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const BASE = [
  'gremion-ui/migrations/001_governance_schema.sql',
  'gremion-ui/migrations/058_public_reader_grants.sql',
  'modules/finance/migrations/001_init.sql',
  'modules/content/migrations/001_init.sql',
  'modules/content/app/migrations/1200_content_news_posts.sql',
]

test('collects kernel basenames and every module migrations/ directory at any depth (app/migrations included)', () => {
  const t = tree([...BASE, 'modules/finance/node_modules/x/migrations/058_public_reader_grants.sql'])
  try {
    const { kernel, modules } = collectMigrationNames(t.root)
    assert.deepEqual(kernel.sort(), ['001_governance_schema.sql', '058_public_reader_grants.sql'])
    assert.deepEqual(
      modules.map((m) => m.path).sort(),
      [
        'modules/content/app/migrations/1200_content_news_posts.sql',
        'modules/content/migrations/001_init.sql',
        'modules/finance/migrations/001_init.sql',
      ],
    )
  } finally {
    t.cleanup()
  }
})

test('GREEN: no module basename equals a kernel basename', () => {
  const t = tree(BASE)
  try {
    assert.deepEqual(checkMigrationNames(t.root).problems, [])
  } finally {
    t.cleanup()
  }
})

test('RED: a seeded modules/finance/migrations/058_public_reader_grants.sql collides with kernel 058', () => {
  const t = tree([...BASE, 'modules/finance/migrations/058_public_reader_grants.sql'])
  try {
    const { problems } = checkMigrationNames(t.root)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /modules\/finance\/migrations\/058_public_reader_grants\.sql/)
    assert.match(problems[0], /gremion-ui\/migrations\/058_public_reader_grants\.sql/)
  } finally {
    t.cleanup()
  }
})

test('RED: the same collision inside an app/migrations chain', () => {
  const t = tree([...BASE, 'modules/content/app/migrations/001_governance_schema.sql'])
  try {
    assert.equal(checkMigrationNames(t.root).problems.length, 1)
  } finally {
    t.cleanup()
  }
})

test('RED: zero kernel migrations or zero module migrations refuse instead of passing vacuously', () => {
  const a = tree(['modules/finance/migrations/001_init.sql'])
  try {
    assert.ok(checkMigrationNames(a.root).problems.some((p) => /kernel/.test(p) && /zero/.test(p)))
  } finally {
    a.cleanup()
  }
  const b = tree(['gremion-ui/migrations/001_governance_schema.sql'])
  try {
    assert.ok(checkMigrationNames(b.root).problems.some((p) => /module/.test(p) && /zero/.test(p)))
  } finally {
    b.cleanup()
  }
})
