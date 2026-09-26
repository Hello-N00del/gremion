// UX-030: the token file validates against the DTCG 2025.10 schema and no
// token carries more than one $value. TASK-082 brief section 6 item 2.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findDuplicateKeys, parseStrictJson } from '../src/strict-json.js'
import { validateTokenDocument, validateResolverDocument } from '../src/validate.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** @param {string} rel */
const read = (rel) => readFileSync(join(root, rel), 'utf8')

test('schema: a token with two $value keys is a violation naming the token', () => {
  const text = read('test/fixtures/two-values.tokens.json')
  const dups = findDuplicateKeys(text)
  assert.deepEqual(dups, [{ path: 'core.space.s-1', key: '$value' }])
  const res = validateTokenDocument(text, 'two-values.tokens.json')
  assert.equal(res.ok, false)
  assert.ok(
    res.errors.some((e) => e.includes('core.space.s-1') && e.includes('$value')),
    `expected a duplicate-$value error, got:\n${res.errors.join('\n')}`,
  )
})

test('schema: a CSS-string colour is a violation (colours are {colorSpace, components})', () => {
  const res = validateTokenDocument(read('test/fixtures/css-string-color.tokens.json'), 'css-string-color.tokens.json')
  assert.equal(res.ok, false)
  assert.ok(
    res.errors.some((e) => e.includes('core.color.graphite.42')),
    `expected an error naming core.color.graphite.42, got:\n${res.errors.join('\n')}`,
  )
})

test('schema: a CSS-string dimension is a violation (dimensions are {value, unit})', () => {
  const doc = {
    core: { space: { 's-1': { $type: 'dimension', $value: '4px' } } },
  }
  const res = validateTokenDocument(JSON.stringify(doc), 'inline')
  assert.equal(res.ok, false)
  assert.ok(res.errors.some((e) => e.includes('core.space.s-1')), res.errors.join('\n'))
})

test('schema: a token without an explicit $type is a violation (the schema only type-checks tokens that carry one)', () => {
  const doc = { core: { space: { 's-1': { $value: { value: 4, unit: 'px' } } } } }
  const res = validateTokenDocument(JSON.stringify(doc), 'inline')
  assert.equal(res.ok, false)
  assert.ok(res.errors.some((e) => e.includes('core.space.s-1') && e.includes('$type')), res.errors.join('\n'))
})

test('schema: the real base document and the dark set validate against DTCG 2025.10', () => {
  for (const rel of ['tokens/gremion.tokens.json', 'tokens/modes/dark.tokens.json']) {
    const res = validateTokenDocument(read(rel), rel)
    assert.deepEqual(res.errors, [], `${rel} must validate`)
    assert.equal(res.ok, true)
    assert.ok(res.tokenCount > 0, `${rel} holds no tokens -- a vacuous pass`)
  }
})

test('schema: the real resolver document validates against the DTCG 2025.10 resolver schema', () => {
  const res = validateResolverDocument(read('tokens/gremion.resolver.json'), 'gremion.resolver.json')
  assert.deepEqual(res.errors, [])
  assert.equal(res.ok, true)
})

test('schema: the validator rejects what the vendored schema rejects (it is wired, not a stub)', () => {
  // An unknown $type value is outside the 2025.10 type list.
  const doc = { core: { x: { $type: 'colour', $value: 1 } } }
  const res = validateTokenDocument(JSON.stringify(doc), 'inline')
  assert.equal(res.ok, false)
})

test('strict JSON: duplicate keys anywhere are reported with their path; valid JSON parses', () => {
  assert.deepEqual(findDuplicateKeys('{"a":{"b":1,"b":2},"c":[{"d":1,"d":1}]}'), [
    { path: 'a', key: 'b' },
    { path: 'c.0', key: 'd' },
  ])
  assert.deepEqual(parseStrictJson('{"a":"{b}"}', 'x'), { a: '{b}' })
  assert.throws(() => parseStrictJson('{"a":1,"a":2}', 'x.json'), /x\.json.*duplicate key "a"/)
})
