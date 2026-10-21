// TASK-053: G-053-build-absence, render half (brief S1, TDD 5).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAbsenceViolations, firstPartyServices, loadAllowances, summaryLine, validateAllowances } from './build-absence.mjs'

const P = 'ghcr.io/hello-n00del/gremion-'
const build = { context: '.', dockerfile: 'gremion-ui/Dockerfile' }
const ROWS = validateAllowances({
  rows: [
    { project: 'app', service: 'tenant-create', date: '2026-09-28', retiresWith: 'TASK-048b', reason: 'not pinned by the release fixture yet' },
    { project: 'state', service: 'legal', date: '2026-09-28', retiresWith: 'TASK-048b', reason: 'state pins arrive with TASK-048b' },
  ],
})

/** The released app render: three pinned, tenant-create still building. */
const pinnedApp = () => ({
  services: {
    'gremion-ui': { image: `${P}ui@sha256:1111` },
    'gremion-public': { image: `${P}public@sha256:2222` },
    migrate: { image: `${P}migrate@sha256:3333` },
    'tenant-create': { image: `${P}migrate:dist`, build },
  },
})
const stateRender = () => ({
  services: { postgres: { image: 'postgres:18' }, legal: { image: `${P}legal:dist`, build: { context: 'docker/legal' } } },
})

test('the pinned app render is clean: 3 judged, 1 allowance', () => {
  const r = buildAbsenceViolations(pinnedApp(), 'app-blue', ROWS)
  assert.deepEqual(r.problems, [])
  assert.equal(r.judged, 3)
  assert.equal(r.allowance, 1)
  assert.equal(summaryLine('app-blue', r), 'app-blue: judged 3, allowance 1 (first-party 4)')
})

test('an unpinned app render (TASK-040 services: {} pins) fails naming gremion-ui', () => {
  const r = pinnedApp()
  r.services['gremion-ui'] = { image: `${P}ui:dist`, build }
  const v = buildAbsenceViolations(r, 'app-green', ROWS)
  assert.equal(v.problems.length, 1, v.problems.join('\n'))
  assert.match(v.problems[0], /^app-green\/gremion-ui: first-party service renders a build: key/)
})

test('build: null is no build (the release pins reset it with !reset null)', () => {
  const r = pinnedApp()
  r.services['gremion-ui'].build = null
  assert.deepEqual(buildAbsenceViolations(r, 'app-blue', ROWS).problems, [])
})

test('a build with no first-party image is still first-party', () => {
  assert.deepEqual(firstPartyServices({ services: { x: { build: '.' }, y: { image: 'traefik:v3' } } }), [{ name: 'x', build: true }])
})

test('an all-allowance app render is vacuous', () => {
  const v = buildAbsenceViolations({ services: { 'tenant-create': { image: `${P}migrate:x`, build } } }, 'app-blue', ROWS)
  assert.match(v.problems.join('\n'), /judged 0 non-allowance first-party service\(s\), fewer than 2/)
})

test('an all-third-party app render is vacuous (and its allowance row is absent)', () => {
  const v = buildAbsenceViolations({ services: { traefik: { image: 'traefik:v3' } } }, 'app-blue', ROWS)
  assert.match(v.problems.join('\n'), /fewer than 2/)
})

test('a state render with 0 first-party services fails', () => {
  const v = buildAbsenceViolations({ services: { postgres: { image: 'postgres:18' } } }, 'state', [])
  assert.match(v.problems.join('\n'), /state: 0 first-party services rendered/)
})

test('state reports judged N, allowance M; an all-allowance state is fine', () => {
  const v = buildAbsenceViolations(stateRender(), 'state', ROWS)
  assert.deepEqual(v.problems, [])
  assert.equal(summaryLine('state', v), 'state: judged 0, allowance 1 (first-party 1)')
})

test('a new first-party state build with no row fails (adders clause)', () => {
  const r = stateRender()
  r.services.matrix = { image: `${P}matrix:dist`, build: { context: 'docker/matrix' } }
  assert.match(buildAbsenceViolations(r, 'state', ROWS).problems.join('\n'), /state\/matrix: first-party service renders a build: key/)
})

test('an allowance row whose service is now pinned fails (retire the row)', () => {
  const r = pinnedApp()
  r.services['tenant-create'] = { image: `${P}migrate@sha256:3333` }
  assert.match(buildAbsenceViolations(r, 'app-blue', ROWS).problems.join('\n'), /app-blue\/tenant-create: renders without build: but allowances\.json still carries its 2026-09-28 row/)
})

test('an allowance row whose service is absent fails', () => {
  const r = pinnedApp()
  delete r.services['tenant-create']
  assert.match(buildAbsenceViolations(r, 'app-blue', ROWS).problems.join('\n'), /app-blue\/tenant-create: allowances\.json row \(2026-09-28\) names a service this render does not contain/)
})

test('allowances.json: every row valid, dated, naming TASK-048b; malformed rows refused', () => {
  const rows = loadAllowances()
  assert.deepEqual(rows.map((r) => `${r.project}/${r.service}`).sort(), ['state/fallback', 'state/legal', 'state/matrix', 'state/vector'])
  for (const r of rows) assert.equal(r.retiresWith, 'TASK-048b')
  assert.throws(() => validateAllowances({ rows: [{ project: 'app', service: 'x', retiresWith: 'TASK-048b', reason: 'long enough reason' }] }), /date/)
  assert.throws(() => validateAllowances({}), /rows/)
  const dupe = { project: 'app', service: 'x', date: '2026-09-28', retiresWith: 'TASK-048b', reason: 'long enough reason' }
  assert.throws(() => validateAllowances({ rows: [dupe, dupe] }), /duplicate/)
})
