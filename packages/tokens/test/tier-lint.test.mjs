// UX-031: three tiers, aliases point downward only. A lint over the token
// file finds zero component tokens that alias a core token directly and zero
// semantic or core tokens that alias upward. TASK-082 brief section 6 item 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lintTiers } from '../src/lint.js'
import { parseStrictJson } from '../src/strict-json.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** @param {string} rel */
const load = (rel) => parseStrictJson(readFileSync(join(root, rel), 'utf8'), rel)

test('tier lint: a component token aliasing a core token is a violation', () => {
  const v = lintTiers(load('test/fixtures/component-to-core.tokens.json'))
  assert.deepEqual(
    v.map((x) => [x.rule, x.path, x.target]),
    [['component-to-core', 'component.dialog.focus-ring', 'core.color.graphite.42']],
  )
})

test('tier lint: a semantic token aliasing a component token (upward) is a violation', () => {
  const v = lintTiers(load('test/fixtures/semantic-to-component.tokens.json'))
  assert.deepEqual(
    v.map((x) => [x.rule, x.path, x.target]),
    [['upward-alias', 'semantic.color.accent.default', 'component.dialog.focus-ring']],
  )
})

test('tier lint: a core token aliasing semantic (upward) is a violation', () => {
  const doc = {
    core: { a: { $type: 'number', $value: '{semantic.b}' }, c: { $type: 'number', $value: 1 } },
    semantic: { b: { $type: 'number', $value: '{core.c}' } },
  }
  const v = lintTiers(doc)
  assert.deepEqual(v.map((x) => [x.rule, x.path]), [['upward-alias', 'core.a']])
})

test('tier lint: an alias nested inside a composite value is linted too', () => {
  const doc = {
    core: { font: { body: { $type: 'fontFamily', $value: ['Inter'] } } },
    semantic: { font: { body: { $type: 'fontFamily', $value: '{core.font.body}' } } },
    component: {
      dialog: {
        title: {
          $type: 'typography',
          $value: {
            fontFamily: '{core.font.body}',
            fontSize: { value: 15, unit: 'px' },
            fontWeight: 600,
            letterSpacing: { value: 0, unit: 'px' },
            lineHeight: 1.3,
          },
        },
      },
    },
  }
  const rules = lintTiers(doc).map((x) => `${x.rule}:${x.path}`)
  assert.ok(rules.includes('component-to-core:component.dialog.title'), rules.join('\n'))
})

test('tier lint: an alias to a token that does not exist fails (no fallback to a raw value)', () => {
  const doc = { semantic: { a: { $type: 'number', $value: '{core.missing}' } }, core: {} }
  const v = lintTiers(doc)
  assert.deepEqual(v.map((x) => [x.rule, x.path, x.target]), [['unknown-alias', 'semantic.a', 'core.missing']])
})

test('tier lint: a raw value in the semantic or component tier is a violation (only core holds raw values)', () => {
  const doc = {
    core: {},
    semantic: { a: { $type: 'number', $value: 3 } },
    component: { b: { $type: 'number', $value: 4 } },
  }
  assert.deepEqual(
    lintTiers(doc).map((x) => [x.rule, x.path]),
    [
      ['raw-value-outside-core', 'semantic.a'],
      ['raw-value-outside-core', 'component.b'],
    ],
  )
})

test('tier lint: a top-level group outside core/semantic/component is a violation', () => {
  const doc = { core: {}, brand: { a: { $type: 'number', $value: 1 } } }
  assert.deepEqual(lintTiers(doc).map((x) => [x.rule, x.path]), [['unknown-tier', 'brand']])
})

test('tier lint: the real base document and the dark set (merged) are clean', () => {
  const base = load('tokens/gremion.tokens.json')
  assert.deepEqual(lintTiers(base), [])
  const dark = load('tokens/modes/dark.tokens.json')
  assert.deepEqual(lintTiers(dark, { against: base }), [])
})
