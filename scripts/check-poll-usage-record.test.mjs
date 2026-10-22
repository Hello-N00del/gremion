#!/usr/bin/env node
// node --test lint of the poll-usage record schema (TASK-058-A, step 3) against the
// DB-MSG-POLL-USAGE columns of SCHEMA-gremion.md. The schema must stay counts-only:
// a content-bearing property, a lost constraint or a drifted enum goes RED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'pilot', 'poll-usage')
const load = (n) => JSON.parse(readFileSync(join(DIR, n), 'utf8'))
const COLUMNS = ['customer_id', 'body_id', 'period_start', 'period_end', 'polls_opened', 'answers_recorded', 'count_source']
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Lint of the schema document itself; returns the list of problems.
export function lintSchema(s) {
  const bad = []
  const props = s.properties ?? {}
  if (JSON.stringify(Object.keys(props).sort(byStr)) !== JSON.stringify([...COLUMNS].sort(byStr))) bad.push(`properties differ from the table columns: ${Object.keys(props).join(',')}`)
  if (s.additionalProperties !== false) bad.push('additionalProperties is not false (a content field could ride along)')
  if (JSON.stringify([...(s.required ?? [])].sort(byStr)) !== JSON.stringify([...COLUMNS].sort(byStr))) bad.push('required is not exactly the column set')
  for (const c of ['polls_opened', 'answers_recorded']) {
    if (props[c]?.type !== 'integer' || props[c]?.minimum !== 0) bad.push(`${c} must be an integer with minimum 0`)
  }
  const src = props.count_source?.enum
  if (JSON.stringify(src) !== JSON.stringify(['homeserver_aggregate', 'operator_count'])) bad.push('count_source enum drifted')
  if (!Array.isArray(props.body_id?.type) || !props.body_id.type.includes('null')) bad.push('body_id must be nullable (customer-wide count)')
  return bad
}

// Minimal validator for a record against the columns' rules (period order is a table CHECK).
export function validateRecord(r) {
  const bad = []
  for (const k of Object.keys(r)) if (!COLUMNS.includes(k)) bad.push(`unknown field ${k}`)
  for (const k of COLUMNS) if (!(k in r)) bad.push(`missing ${k}`)
  if (!UUID.test(String(r.customer_id))) bad.push('customer_id is not a uuidv7')
  if (r.body_id !== null && !UUID.test(String(r.body_id))) bad.push('body_id is neither null nor a uuidv7')
  for (const k of ['polls_opened', 'answers_recorded']) if (!Number.isInteger(r[k]) || r[k] < 0) bad.push(`${k} is not an integer >= 0`)
  if (!['homeserver_aggregate', 'operator_count'].includes(r.count_source)) bad.push('count_source not allowed')
  const a = Date.parse(r.period_start)
  const b = Date.parse(r.period_end)
  if (Number.isNaN(a) || Number.isNaN(b) || !(b > a)) bad.push('period_end must be after period_start')
  return bad
}

test('the schema is exactly the DB-MSG-POLL-USAGE operator columns and counts-only', () => {
  assert.deepEqual(lintSchema(load('record.schema.json')), [])
})

test('the example record validates', () => {
  assert.deepEqual(validateRecord(load('record.example.json')), [])
})

test('RED: a content-bearing property in the schema fails the lint', () => {
  const s = load('record.schema.json')
  s.properties.poll_question = { type: 'string' }
  assert.match(lintSchema(s).join('\n'), /properties differ/)
  const t = load('record.schema.json')
  t.additionalProperties = true
  assert.match(lintSchema(t).join('\n'), /additionalProperties/)
  const u = load('record.schema.json')
  u.properties.count_source.enum.push('estimate')
  assert.match(lintSchema(u).join('\n'), /enum drifted/)
})

test('RED: records the table would refuse', () => {
  const ok = load('record.example.json')
  assert.match(validateRecord({ ...ok, period_end: ok.period_start }).join(), /after period_start/)
  assert.match(validateRecord({ ...ok, polls_opened: -1 }).join(), /polls_opened/)
  assert.match(validateRecord({ ...ok, count_source: 'estimate' }).join(), /count_source/)
  assert.match(validateRecord({ ...ok, poll_question: 'Mensa?' }).join(), /unknown field poll_question/)
  const noBody = { ...ok }
  delete noBody.body_id
  assert.match(validateRecord(noBody).join(), /missing body_id/)
})
