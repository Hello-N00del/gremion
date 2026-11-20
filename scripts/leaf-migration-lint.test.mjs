#!/usr/bin/env node
// node --test suite: the cross-leaf migration lint of the CD leaf step.
//
// Why. The leaves (calendar, content, publishing) read no migration ledger. Each one re-runs EVERY file
// of its own image on a customer database at first contact, with no lock, and the old colour keeps
// serving while the new image's `--migrate-only` entry runs. So during that overlap an OLD file can run
// after a NEW file did. A file that is only `IF NOT EXISTS` DDL does no harm that way; a file that
// redefines an object an older file creates does: `CREATE OR REPLACE FUNCTION f` in file 004 followed by
// the old image running file 002 puts the OLD body of f back.
//
// The rule: a file of a leaf must not run CREATE OR REPLACE, DROP or ALTER on a function, trigger or view
// that an EARLIER file of the same leaf creates. A changed body is a new object under a new name (and the
// old one is left alone). The two definitions that exist today (content 002 and publishing 001) are each
// the FIRST definition of their object, so the lint passes today.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THIS_FILE = 'scripts/leaf-migration-lint.test.mjs'

/** A leaf is a module that carries the CD `--migrate-only` entry. */
function leafDirs(root) {
  const modules = path.join(root, 'modules')
  return readdirSync(modules, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(modules, d.name, 'src', 'migrate-only.ts')))
    .map((d) => d.name)
    .sort()
}

function migrationFiles(root, leaf) {
  const dir = path.join(root, 'modules', leaf, 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }))
}

/** SQL without comments (a comment that names CREATE OR REPLACE is not a definition). */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

const NAME = String.raw`((?:"[^"]+"|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z0-9_$]+))*)`
const KINDS = {
  function: String.raw`FUNCTION`,
  trigger: String.raw`TRIGGER`,
  view: String.raw`(?:MATERIALIZED\s+)?VIEW`,
}
const CREATE_PREFIX = {
  function: String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?`,
  trigger: String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?`,
  view: String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|RECURSIVE)\s+)*`,
}

/** The unqualified, unquoted, lower-case name: `content.Posts_Set` and `"posts_set"` are one object. */
function normalise(raw) {
  const last = raw.split('.').pop().trim()
  return last.replace(/^"|"$/g, '').toLowerCase()
}

function matches(sql, re) {
  return [...sql.matchAll(re)].map((m) => normalise(m[1]))
}

/** Objects a file creates (CREATE or CREATE OR REPLACE), as `kind:name`. */
function created(sql) {
  const text = stripComments(sql)
  const out = new Set()
  for (const kind of Object.keys(KINDS)) {
    const re = new RegExp(String.raw`\b${CREATE_PREFIX[kind]}${KINDS[kind]}\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, 'gi')
    for (const name of matches(text, re)) out.add(`${kind}:${name}`)
  }
  return out
}

/** Objects a file redefines: CREATE OR REPLACE, DROP or ALTER of a function, trigger or view. */
function redefined(sql) {
  const text = stripComments(sql)
  const out = new Set()
  for (const kind of Object.keys(KINDS)) {
    const replace = new RegExp(String.raw`\bCREATE\s+OR\s+REPLACE\s+${kind === 'trigger' ? String.raw`(?:CONSTRAINT\s+)?` : kind === 'view' ? String.raw`(?:(?:TEMP|TEMPORARY|RECURSIVE)\s+)*` : ''}${KINDS[kind]}\s+${NAME}`, 'gi')
    const drop = new RegExp(String.raw`\bDROP\s+${KINDS[kind]}\s+(?:IF\s+EXISTS\s+)?${NAME}`, 'gi')
    const alter = new RegExp(String.raw`\bALTER\s+${KINDS[kind]}\s+(?:IF\s+EXISTS\s+)?${NAME}`, 'gi')
    for (const re of [replace, drop, alter]) for (const name of matches(text, re)) out.add(`${kind}:${name}`)
  }
  return out
}

/**
 * The problems of one leaf: files in order, each one's redefinitions checked against what STRICTLY EARLIER
 * files created. (A file may redefine its own object; only the overlap of an old runner is dangerous.)
 */
function lintFiles(files) {
  const problems = []
  const createdBy = new Map()
  for (const { name, text } of files) {
    for (const obj of redefined(text)) {
      const origin = createdBy.get(obj)
      if (origin !== undefined && origin !== name) {
        problems.push(`${name}: redefines ${obj.replace(':', ' ')} that ${origin} creates (a new body needs a new name)`)
      }
    }
    for (const obj of created(text)) if (!createdBy.has(obj)) createdBy.set(obj, name)
  }
  return problems
}

function lintLeaf(root, leaf) {
  return lintFiles(migrationFiles(root, leaf)).map((p) => `modules/${leaf}/migrations/${p}`)
}

// ── the real tree ────────────────────────────────────────────────────────────

test('collected: the three leaves are found, each with migration files (a lint that saw nothing would pass)', () => {
  assert.deepEqual(leafDirs(ROOT), ['calendar', 'content', 'publishing'])
  for (const leaf of leafDirs(ROOT)) assert.ok(migrationFiles(ROOT, leaf).length >= 1, `${leaf} has migration files`)
})

test('the parser sees the two definitions that exist today (content 002 and publishing 001)', () => {
  const content = Object.fromEntries(migrationFiles(ROOT, 'content').map((f) => [f.name, created(f.text)]))
  assert.ok(content['002_posts_status.sql'].has('function:posts_set_updated_at'))
  assert.ok(content['002_posts_status.sql'].has('trigger:trg_content_posts_updated_at'))
  const publishing = Object.fromEntries(migrationFiles(ROOT, 'publishing').map((f) => [f.name, created(f.text)]))
  assert.ok(publishing['001_init.sql'].has('function:newsletters_updated_at_bump'))
  assert.ok(publishing['001_init.sql'].has('trigger:newsletters_updated_at_bump'))
})

test('GREEN: no leaf file redefines a function, trigger or view an earlier file of its leaf creates', () => {
  for (const leaf of leafDirs(ROOT)) assert.deepEqual(lintLeaf(ROOT, leaf), [])
})

// ── seeded fixtures ──────────────────────────────────────────────────────────

const FN = (body) => `CREATE OR REPLACE FUNCTION public.bump() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END; $$;\n`
const FIRST = { name: '001_init.sql', text: FN('NEW.a := 1;') }

for (const [label, later] of [
  ['CREATE OR REPLACE FUNCTION again', FN('NEW.a := 2;')],
  ['CREATE OR REPLACE FUNCTION, other case and a quoted schema', 'create or replace function "public"."BUMP"() returns trigger language sql as $$ select 1 $$;'],
  ['DROP FUNCTION IF EXISTS', 'DROP FUNCTION IF EXISTS bump();'],
  ['ALTER FUNCTION', 'ALTER FUNCTION bump() RENAME TO bump_old;'],
])
  test(`RED: a later file with ${label} is a problem`, () => {
    const problems = lintFiles([FIRST, { name: '002_next.sql', text: later }])
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0], /^002_next\.sql: redefines function bump that 001_init\.sql creates/)
  })

test('RED: a trigger dropped or recreated, and a view replaced or altered, by a later file', () => {
  const base = {
    name: '001_init.sql',
    text:
      'CREATE TABLE IF NOT EXISTS t (a int);\n' +
      'CREATE VIEW v1 AS SELECT a FROM t;\n' +
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_x') THEN CREATE TRIGGER trg_x BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION bump(); END IF; END $$;\n",
  }
  for (const later of [
    'DROP TRIGGER IF EXISTS trg_x ON t;',
    'CREATE OR REPLACE TRIGGER trg_x BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION bump();',
    'CREATE OR REPLACE VIEW v1 AS SELECT a, a AS b FROM t;',
    'ALTER VIEW v1 RENAME TO v1_old;',
    'DROP VIEW v1;',
  ]) {
    assert.equal(lintFiles([base, { name: '002_next.sql', text: later }]).length, 1, later)
  }
})

test('GREEN: new objects under new names, IF NOT EXISTS tables and columns, an object redefined inside its own file, and comments', () => {
  const files = [
    FIRST,
    {
      name: '002_next.sql',
      text:
        '-- CREATE OR REPLACE FUNCTION bump() would be wrong here, so it is a new name\n' +
        '/* DROP TRIGGER trg_old ON t; */\n' +
        'CREATE TABLE IF NOT EXISTS u (a int);\n' +
        'ALTER TABLE u ADD COLUMN IF NOT EXISTS b int;\n' +
        'CREATE INDEX IF NOT EXISTS u_a ON u (a);\n' +
        FN('NEW.a := 3;').replace('bump', 'bump_v2') +
        FN('NEW.a := 4;').replace('bump', 'bump_v2'),
    },
  ]
  assert.deepEqual(lintFiles(files), [])
})

test('RED on a copy of the real tree: a file added to a real leaf that redefines its function', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'leaf-lint-'))
  try {
    mkdirSync(path.join(root, 'modules'))
    for (const leaf of leafDirs(ROOT)) {
      mkdirSync(path.join(root, 'modules', leaf, 'src'), { recursive: true })
      writeFileSync(path.join(root, 'modules', leaf, 'src', 'migrate-only.ts'), '')
      cpSync(path.join(ROOT, 'modules', leaf, 'migrations'), path.join(root, 'modules', leaf, 'migrations'), { recursive: true })
    }
    assert.deepEqual(leafDirs(root).flatMap((l) => lintLeaf(root, l)), [])

    writeFileSync(
      path.join(root, 'modules', 'content', 'migrations', '004_redefine.sql'),
      'CREATE OR REPLACE FUNCTION content.posts_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;\n',
    )
    writeFileSync(path.join(root, 'modules', 'publishing', 'migrations', '002_drop.sql'), 'DROP TRIGGER IF EXISTS newsletters_updated_at_bump ON newsletters;\n')
    const problems = leafDirs(root).flatMap((l) => lintLeaf(root, l))
    assert.equal(problems.length, 2, problems.join('\n'))
    assert.match(problems.join('\n'), /content\/migrations\/004_redefine\.sql: redefines function posts_set_updated_at that 002_posts_status\.sql creates/)
    assert.match(problems.join('\n'), /publishing\/migrations\/002_drop\.sql: redefines trigger newsletters_updated_at_bump that 001_init\.sql creates/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── this file runs in the unit:node suite ────────────────────────────────────

test('unit:node collects this file: the suite sweeps scripts/**/*.test.mjs and the glob finds it', () => {
  const suite = readFileSync(path.join(ROOT, 'scripts', 'verify', 'suites', 'unit.mjs'), 'utf8')
  assert.ok(suite.includes("globSync('scripts/**/*.test.mjs'"), 'the unit suite no longer sweeps scripts/**/*.test.mjs')
  const collected = globSync('scripts/**/*.test.mjs', { cwd: ROOT }).map((f) => f.split(path.sep).join('/'))
  assert.ok(collected.includes(THIS_FILE), `${THIS_FILE} is not matched by the unit:node glob`)
})
