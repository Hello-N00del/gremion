// TASK-036 TDD item 9 (brief Q4): leaf-blast-radius.json rows.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { checkBlastRadius, runCensus } from './census.mjs'

const projects = [{ project: 'state', render: { ok: true, services: { leaf: { image: 'l' } } }, exempt: [], notes: [] }]
const images = new Map([['state/leaf', { ok: true, healthcheck: { Test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/healthz'] } }]])

test('the shipped leaf-blast-radius.json is the empty schemaVersion 1 document', () => {
  const doc = JSON.parse(readFileSync(path.join(import.meta.dirname, 'leaf-blast-radius.json'), 'utf8'))
  assert.deepEqual(doc, { schemaVersion: 1, rows: {} })
  assert.deepEqual(checkBlastRadius(doc, projects, images), { unparseable: null, failures: [] })
})

test('a row naming a rendered service whose image probes its path passes', () => {
  assert.deepEqual(checkBlastRadius({ schemaVersion: 1, rows: { leaf: { probePath: '/healthz' } } }, projects, images).failures, [])
})

test('a row naming no rendered service fails', () => {
  const r = checkBlastRadius({ schemaVersion: 1, rows: { ghost: { probePath: '/healthz' } } }, projects, images)
  assert.deepEqual(r.failures, ['leaf-blast-radius row ghost names no rendered service'])
})

test('a row whose image HEALTHCHECK lacks the probe path fails, and so does a compose-only probe', () => {
  const r = checkBlastRadius({ schemaVersion: 1, rows: { leaf: { probePath: '/readyz' } } }, projects, images)
  assert.match(r.failures.join('\n'), /leaf \[state\]: the image HEALTHCHECK does not probe \/readyz/)
  const noImg = new Map([['state/leaf', { ok: true, healthcheck: null }]])
  assert.equal(checkBlastRadius({ schemaVersion: 1, rows: { leaf: { probePath: '/healthz' } } }, projects, noImg).failures.length, 1)
})

test('a malformed document is unparseable, and a failing row fails the census', () => {
  assert.ok(checkBlastRadius({ schemaVersion: 2, rows: {} }, projects, images).unparseable)
  assert.ok(checkBlastRadius({ schemaVersion: 1, rows: [] }, projects, images).unparseable)
  const withProbe = [{ ...projects[0], render: { ok: true, services: { leaf: { image: 'l', healthcheck: { test: ['CMD', 'true'] } } } } }]
  const r = runCensus({ projects: withProbe, images, blastRadius: { schemaVersion: 1, rows: { ghost: { probePath: '/x' } } } })
  assert.equal(r.failed, 1)
  assert.equal(r.passed, 1)
})
